import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod, rename, lstat, rm } from 'node:fs/promises';
import bcrypt from 'bcryptjs';

export const runtimeDirectory = () => process.env.CODEX_ACCOUNTS_RUNTIME || join(homedir(), 'Library', 'Application Support', 'Claude Codex Bridge', 'pool');
export async function privateJSON(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}
export function makeConfig(runtimeDir, hash, key) {
  return {
    'config-version': 8,
    server: { host: '127.0.0.1', port: 18768, discovery: { enabled: false }, 'max-request-body-bytes': 67108864, 'commercial-mode': true },
    management: { 'allow-remote': false, 'secret-key': hash, 'disable-control-panel': true, 'disable-auto-update-panel': true },
    access: { 'api-keys': [key] },
    oauth: { 'auth-dir': join(runtimeDir, 'auth'), 'model-alias': { codex: [
      { name: 'gpt-6.1-sol', alias: 'gpt-6.1-sol-fast', fork: true }, { name: 'gpt-6-astra', alias: 'gpt-6-astra-fast', fork: true },
    ] } },
    routing: { strategy: 'fill-first', 'session-affinity': false, 'force-model-prefix': true,
      retry: { 'request-retry': 0, 'max-retry-interval': 0, 'max-retry-credentials': 1 } },
    observability: { logs: { debug: false, 'request-log': false, 'logging-to-file': false } },
    requests: { payload: { override: [{ models: [ { name: '*gpt-6.1-sol-fast', protocol: 'codex' }, { name: '*gpt-6-astra-fast', protocol: 'codex' } ], params: { service_tier: 'priority' } }] },
      streaming: { 'bootstrap-retries': 0, 'keepalive-seconds': 0, 'send-keepalive-before-ft': false } },
    multimedia: { 'disable-image-generation': true },
  };
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
    return config;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = join(runtimeDir, '.initializing');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('A preparação do serviço já está em andamento ou precisa ser retomada.'); }
  try {
    for (const name of ['config.yaml', 'management.key', 'accounts-state.json']) {
      try { await lstat(join(runtimeDir, name)); throw new Error('A configuração local está incompleta. Os dados existentes foram preservados.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await mkdir(join(runtimeDir, 'auth'), { mode: 0o700 });
    const managementKey = randomBytes(40).toString('base64url');
    const config = makeConfig(runtimeDir, await bcrypt.hash(managementKey, 10), randomBytes(40).toString('base64url'));
    await writeFile(join(runtimeDir, 'management.key'), managementKey + '\n', { mode: 0o600, flag: 'wx' });
    await privateJSON(join(runtimeDir, 'accounts-state.json'), { accounts: [], priority_order: [], mode: 'automatic', fixed_email: null, revision: 0 });
    await privateJSON(configPath, config);
    return config;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
