import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod, rename, lstat, rm } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { models } from './model-catalog.mjs';
import { ensureClientKey } from './client-auth.mjs';

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
export async function ensureRuntime(runtimeDir = runtimeDirectory()) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const info = await lstat(runtimeDir);
  if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error('O diretório de contas não pertence a este usuário.');
  await chmod(runtimeDir, 0o700);
  const configPath = join(runtimeDir, 'config.yaml');
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (config.server?.host !== '127.0.0.1' || config.server?.port !== 18768 || !config.server?.['commercial-mode'] || config.management?.['allow-remote'] || config.oauth?.['auth-dir'] !== join(runtimeDir, 'auth')) throw new Error('A configuração existente precisa ser revisada.');
    await readFile(join(runtimeDir, 'management.key')); await readFile(join(runtimeDir, 'accounts-state.json'));
    const upgraded = upgradeModelConfig(config);
    await ensureClientKey(runtimeDir);
    if (JSON.stringify(upgraded) !== JSON.stringify(config)) await privateJSON(configPath, upgraded);
    return upgraded;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = join(runtimeDir, '.initializing');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('A preparação do serviço já está em andamento ou precisa ser retomada.'); }
  try {
    for (const name of ['config.yaml', 'management.key', 'accounts-state.json']) {
      try { await lstat(join(runtimeDir, name)); throw new Error('A configuração local está incompleta. Os dados existentes foram preservados.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await mkdir(join(runtimeDir, 'auth'), { mode: 0o700 });
    await ensureClientKey(runtimeDir);
    const managementKey = randomBytes(40).toString('base64url');
    const config = makeConfig(runtimeDir, await bcrypt.hash(managementKey, 10), randomBytes(40).toString('base64url'));
    await writeFile(join(runtimeDir, 'management.key'), managementKey + '\n', { mode: 0o600, flag: 'wx' });
    await privateJSON(join(runtimeDir, 'accounts-state.json'), { accounts: [], priority_order: [], mode: 'automatic', fixed_email: null, revision: 0, allow_extra_credits: false, auto_reset_emails: [], reset_journal: {} });
    await privateJSON(configPath, config);
    return config;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
