import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod, rename, lstat, rm } from 'node:fs/promises';
import { models } from './model-catalog.mjs';
import { verifyRuntimeLock } from './runtime-lock.mjs';

export const runtimeDirectory = () => process.env.CODEX_ACCOUNTS_RUNTIME || join(homedir(), 'Library', 'Application Support', 'Claude Codex Bridge', 'pool');
export async function privateJSON(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}
function mayMatchManagedModel(matcher) {
  if (typeof matcher?.protocol === 'string' && !['', 'codex'].includes(matcher.protocol.trim().toLowerCase())) return false;
  if (typeof matcher?.name !== 'string') return true;
  const pattern = [...matcher.name.trim()];
  if (!pattern.length) return false;
  return models.some(model => [false, true].some(prefixed => {
    const digits = '0123456789';
    const tokens = [...(prefixed ? [...'conta-', digits, digits, '/'] : []), ...model.target];
    const pending = [[0, 0]], visited = new Set();
    while (pending.length) {
      const [patternIndex, tokenIndex] = pending.pop(), pair = `${patternIndex}:${tokenIndex}`;
      if (visited.has(pair)) continue;
      visited.add(pair);
      if (patternIndex === pattern.length && tokenIndex === tokens.length) return true;
      const character = pattern[patternIndex];
      if (character === '*') pending.push([patternIndex + 1, tokenIndex]);
      if (character === undefined || tokenIndex === tokens.length) continue;
      if (character === '*' || tokens[tokenIndex].includes(character)) {
        pending.push([character === '*' ? patternIndex : patternIndex + 1, tokenIndex + 1]);
      }
      if (prefixed && tokenIndex === 8 && (character === '*' || digits.includes(character))) {
        pending.push([character === '*' ? patternIndex : patternIndex + 1, tokenIndex]);
      }
    }
    return false;
  }));
}

function validateFinalTierRules(payload) {
  for (const kind of ['override-raw', 'filter']) {
    const rules = payload[kind] ?? [];
    if (!Array.isArray(rules)) throw new Error('As regras finais de modelos precisam ser revisadas.');
    for (const rule of rules) {
      const paths = kind === 'filter' ? rule.params : Object.keys(rule.params ?? {});
      if (!Array.isArray(paths)) throw new Error('As regras finais de modelos precisam ser revisadas.');
      const changesTier = paths.some(path => typeof path === 'string' && /^:?service_tier(?:\.|$)/.test(path.trim().replaceAll('\\', '')));
      if (changesTier && (!Array.isArray(rule.models) || rule.models.some(mayMatchManagedModel))) {
        throw new Error('Uma regra posterior altera a modalidade dos modelos gerenciados. Revise service_tier em override-raw ou filter.');
      }
    }
  }
}
export const temporaryModelInstructionMarker = '<!-- Claude Codex temporary model mapping v1 -->\n';

// Remove only the additive instruction used to bridge a running legacy service
// to this version. The new router supplies a fresh catalogue on every request.
export function removeTemporaryModelInstructions(config) {
  const next = structuredClone(config);
  const overrides = next.requests?.payload?.override;
  if (!Array.isArray(overrides)) return next;
  next.requests.payload.override = overrides.flatMap(rule => {
    const text = rule?.params?.instructions;
    const ownedScope = Array.isArray(rule?.models) && rule.models.length > 0 && rule.models.every(model =>
      model?.protocol === 'codex' && model['from-protocol'] === 'claude' && /^\*?gpt-(?:6\.1-sol|6-astra)(?:-fast)?$/.test(model.name ?? ''));
    if (!ownedScope || typeof text !== 'string' || !text.startsWith(temporaryModelInstructionMarker + '<claude_codex_model_mapping>\n') || !text.endsWith('</claude_codex_model_mapping>\n')) return [rule];
    const params = { ...rule.params }; delete params.instructions;
    if (!Object.keys(params).length) return [];
    const retained = { ...rule, params }; delete retained.codex_accounts_model_instructions;
    return [retained];
  });
  return next;
}

export function upgradeModelConfig(config) {
  const next = structuredClone(config);
  next.oauth ??= {};
  next.oauth['model-alias'] ??= {};
  const aliases = next.oauth['model-alias'].codex ?? [];
  if (!Array.isArray(aliases)) throw new Error('Os aliases existentes precisam ser revisados.');
  if (aliases.some(alias => models.some(model => model.mode === 'normal' && model.target === alias?.alias && alias.name !== model.baseModel))) {
    throw new Error('Um alias existente redireciona um modelo gerenciado para outro modelo.');
  }
  const ownedAliases = models.filter(model => model.mode !== 'normal');
  next.oauth['model-alias'].codex = [
    ...aliases.filter(alias => !ownedAliases.some(model => model.target === alias.alias)),
    ...ownedAliases.map(model => ({ ...aliases.find(alias => alias.alias === model.target), name: model.baseModel, alias: model.target, fork: true })),
  ];
  next.requests ??= {}; next.requests.payload ??= {};
  validateFinalTierRules(next.requests.payload);
  const overrides = next.requests.payload.override ?? [];
  if (!Array.isArray(overrides)) throw new Error('As regras de modelos existentes precisam ser revisadas.');
  const owned = matcher => matcher?.protocol === 'codex' && models.some(model => [model.target, `*${model.target}`].includes(matcher.name));
  const retained = overrides.flatMap(rule => {
    if (!Array.isArray(rule.models) || !rule.models.some(owned) || !Object.hasOwn(rule.params ?? {}, 'service_tier')) return [rule];
    const unrelated = rule.models.filter(matcher => !owned(matcher));
    const params = { ...rule.params }; delete params.service_tier;
    return [
      ...(unrelated.length ? [{ ...rule, models: unrelated }] : []),
      ...(Object.keys(params).length ? [{ ...rule, models: rule.models.filter(owned), params }] : []),
    ];
  });
  next.requests.payload.override = [...retained, ...['default', 'priority', 'ultrafast'].map(tier => ({
    models: models.filter(model => model.serviceTier === tier).map(model => ({ name: `*${model.target}`, protocol: 'codex' })),
    params: { service_tier: tier },
  }))];
  return next;
}
export function makeConfig(runtimeDir, hash, key) {
  return upgradeModelConfig({
    'config-version': 8,
    server: { host: '127.0.0.1', port: 18768, discovery: { enabled: false }, 'max-request-body-bytes': 67108864, 'commercial-mode': true },
    management: { 'allow-remote': false, 'secret-key': hash, 'disable-control-panel': true, 'disable-auto-update-panel': true },
    access: { 'api-keys': [key] },
    oauth: { 'auth-dir': join(runtimeDir, 'auth') },
    routing: { strategy: 'fill-first', 'session-affinity': false, 'force-model-prefix': true,
      retry: { 'request-retry': 0, 'max-retry-interval': 0, 'max-retry-credentials': 1 } },
    observability: { logs: { debug: false, 'request-log': false, 'logging-to-file': false } },
    requests: { streaming: { 'bootstrap-retries': 0, 'keepalive-seconds': 0, 'send-keepalive-before-ft': false } },
    multimedia: { 'disable-image-generation': true },
  });
}
export async function ensureRuntime(runtimeDir = runtimeDirectory(), {
  removeTemporaryInstructions = false,
  initializerHelper = fileURLToPath(new URL('../bin/BridgeService', import.meta.url)),
} = {}) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const info = await lstat(runtimeDir);
  if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error('O diretório de contas não pertence a este usuário.');
  await chmod(runtimeDir, 0o700);
  const owner = removeTemporaryInstructions ? verifyRuntimeLock(runtimeDir, process.env.CODEX_ACCOUNTS_LOCK_FD, 'service.lock') : null;
  const script = fileURLToPath(new URL('./runtime-bootstrap.mjs', import.meta.url));
  const args = ['--initialize', runtimeDir, process.execPath, script, ...(removeTemporaryInstructions ? ['--retire-model-map'] : [])];
  const env = { ...process.env };
  delete env.CODEX_ACCOUNTS_SERVICE_OWNER_FD;
  if (owner !== null) env.CODEX_ACCOUNTS_SERVICE_OWNER_FD = '3';
  await new Promise((resolve, reject) => {
    const child = spawn(initializerHelper, args, { stdio: owner === null ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'ignore', owner], env });
    let output = '', settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve(); };
    const timeout = setTimeout(() => { child.kill('SIGTERM'); finish(Object.assign(new Error('A preparação do serviço excedeu o tempo disponível.'), { code: 'setup.runtime_busy' })); }, 30000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) { child.kill('SIGTERM'); finish(Object.assign(new Error('A preparação do serviço retornou dados inválidos.'), { code: 'setup.runtime_invalid' })); } });
    child.once('error', error => finish(Object.assign(new Error('O inicializador nativo não está disponível.'), { code: 'setup.runtime_helper_unavailable', cause: error })));
    child.once('close', code => {
      let result;
      try { result = JSON.parse(output); } catch {}
      if (code === 0 && result?.ok === true) finish();
      else finish(Object.assign(new Error(typeof result?.message === 'string' ? result.message : 'Não foi possível preparar o serviço local.'), { code: typeof result?.code === 'string' ? result.code : 'setup.runtime_invalid' }));
    });
  });
  return JSON.parse(await readFile(join(runtimeDir, 'config.yaml'), 'utf8'));
}
