import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fstatSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PoolController } from './pool-controller.mjs';
import { createPoolRouter } from './pool-router.mjs';
import { ensureRuntime, runtimeDirectory } from './runtime.mjs';
import { readClientKey } from './client-auth.mjs';
import { renderModelInstructions } from './model-instructions.mjs';
import { refreshManagedModelRules } from './model-rules.mjs';
import { loadServiceIdentity } from './service-contract.mjs';
import { TokenUsageStore } from './token-usage.mjs';

process.umask(0o077);
const runtimeDir = runtimeDirectory();
const serviceIdentity = await loadServiceIdentity(fileURLToPath(new URL('../', import.meta.url)));
const descriptor = Number(process.env.CODEX_ACCOUNTS_LOCK_FD);
if (!Number.isInteger(descriptor) || descriptor < 3) throw new Error('Start the service through BridgeService to hold the runtime lock.');
const lockInfo = fstatSync(descriptor), lockPath = statSync(join(runtimeDir, 'service.lock'));
if (!lockInfo.isFile() || lockInfo.uid !== process.getuid() || lockInfo.ino !== lockPath.ino || lockInfo.dev !== lockPath.dev) throw new Error('Invalid runtime lock.');
// Only the service owner may retire a legacy hot-reloaded mapping. Generic app
// preparation must leave it active until this process takes over routing.
await ensureRuntime(runtimeDir, { removeTemporaryInstructions: true });
const configPath = join(runtimeDir, 'config.yaml');
const child = spawn(fileURLToPath(new URL('../bin/cli-proxy-api', import.meta.url)), ['-config', configPath, '--local-model'], {
  cwd: runtimeDir, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, LANG: process.env.LANG ?? 'en_US.UTF-8' },
});
const tokenUsage = await TokenUsageStore.load({ runtimeDir });
const controller = new PoolController({ runtimeDir, tokenUsage, refreshAfterInference: true });
controller.pausedForUpdate = (await controller.readState()).update_draining;
const server = createPoolRouter({ controller, serviceIdentity, getIngressKey: () => readClientKey(runtimeDir), getClientKey: async () => {
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  const key = current.access?.['api-keys']?.[0];
  if (typeof key !== 'string' || !key) throw new Error('Missing local client key');
  return key;
} });
let stopping = false;
let stopCode = 0;
let modelRuleRefresh = Promise.resolve();
let resolveClosed;
const serverClosed = new Promise(resolve => { resolveClosed = resolve; });
let finishing;
const exitAfterWork = code => {
  finishing ??= (async () => {
    await serverClosed;
    // Let aborted response pipelines finalize their observers before the last
    // flush. The service lock remains held until every queued write settles.
    await new Promise(resolve => setImmediate(resolve));
    await Promise.allSettled([modelRuleRefresh, tokenUsage.flush()]);
    process.exit(code);
  })();
};
const automaticTimer = setInterval(() => { controller.runAutomaticResets().catch(() => {}); }, 60000);
automaticTimer.unref();
const quotaTimer = setInterval(() => { controller.refreshStaleQuotas().catch(() => {}); }, 15000);
quotaTimer.unref();
function stop(code) {
  if (stopping) return; stopping = true; stopCode = code;
  controller.pausedForUpdate = true; clearInterval(automaticTimer); clearInterval(quotaTimer); controller.stopNotifications();
  server.close(() => { resolveClosed(); child?.kill('SIGTERM'); if (!child?.pid || child.exitCode !== null || child.signalCode !== null) exitAfterWork(code); });
  const deadline = setTimeout(() => { server.closeAllConnections(); child?.kill('SIGTERM'); }, 30000); deadline.unref();
  const kill = setTimeout(() => { if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); else exitAfterWork(code); }, 35000); kill.unref();
}
process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0));
child?.on('error', () => stop(1));
child?.on('exit', () => { if (stopping) exitAfterWork(stopCode); else stop(1); });
server.on('error', () => stop(1));
let ready = false;
const startupDeadline = Date.now() + 30000;
while (!stopping && Date.now() < startupDeadline) {
  try { await controller.credentials(true); ready = true; break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (ready && !stopping) {
  server.listen(18765, '127.0.0.1');
  // Upgrade rules for installations with older copied launchers. Each request
  // also carries the current mapping, including agents that omit user rules.
  modelRuleRefresh = controller.availableModels().then(catalogue => stopping ? null : refreshManagedModelRules({
      base: join(homedir(), 'Library', 'Application Support', 'Codex Accounts', 'Managed Claudes'),
      text: renderModelInstructions(catalogue, { persistent: true }),
  })).then(result => {
    if (!result) return;
    if (result.errors.length || result.unmanaged) console.error('Some managed model rules were preserved or could not be refreshed; request instructions remain active.');
  }).catch(() => { console.error('Managed model rules could not be refreshed; request instructions remain active.'); });
}
else stop(1);
