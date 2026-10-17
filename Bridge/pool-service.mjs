import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fstatSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PoolController } from './pool-controller.mjs';
import { createPoolRouter } from './pool-router.mjs';
import { ensureRuntime, runtimeDirectory } from './runtime.mjs';
import { readClientKey } from './client-auth.mjs';

process.umask(0o077);
const runtimeDir = runtimeDirectory();
const descriptor = Number(process.env.CODEX_ACCOUNTS_LOCK_FD);
if (!Number.isInteger(descriptor) || descriptor < 3) throw new Error('Start the service through BridgeService to hold the runtime lock.');
const lockInfo = fstatSync(descriptor), lockPath = statSync(join(runtimeDir, 'service.lock'));
if (!lockInfo.isFile() || lockInfo.uid !== process.getuid() || lockInfo.ino !== lockPath.ino || lockInfo.dev !== lockPath.dev) throw new Error('Invalid runtime lock.');
await ensureRuntime(runtimeDir);
const configPath = join(runtimeDir, 'config.yaml');
const child = spawn(fileURLToPath(new URL('../bin/cli-proxy-api', import.meta.url)), ['-config', configPath, '--local-model'], {
  cwd: runtimeDir, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, LANG: process.env.LANG ?? 'en_US.UTF-8' },
});
const controller = new PoolController({ runtimeDir });
controller.pausedForUpdate = (await controller.readState()).update_draining;
const server = createPoolRouter({ controller, getIngressKey: () => readClientKey(runtimeDir), getClientKey: async () => {
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  const key = current.access?.['api-keys']?.[0];
  if (typeof key !== 'string' || !key) throw new Error('Missing local client key');
  return key;
} });
let stopping = false;
let stopCode = 0;
const automaticTimer = setInterval(() => { controller.runAutomaticResets().catch(() => {}); }, 60000);
automaticTimer.unref();
function stop(code) {
  if (stopping) return; stopping = true; stopCode = code;
  controller.pausedForUpdate = true; clearInterval(automaticTimer);
  server.close(() => { child?.kill('SIGTERM'); if (!child?.pid || child.exitCode !== null || child.signalCode !== null) process.exit(code); });
  const deadline = setTimeout(() => { server.closeAllConnections(); child?.kill('SIGTERM'); }, 30000); deadline.unref();
  const kill = setTimeout(() => { if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); else process.exit(code); }, 35000); kill.unref();
}
process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0));
child?.on('error', () => stop(1));
child?.on('exit', () => { if (stopping) process.exit(stopCode); else stop(1); });
server.on('error', () => stop(1));
let ready = false;
const startupDeadline = Date.now() + 30000;
while (!stopping && Date.now() < startupDeadline) {
  try { await controller.credentials(true); ready = true; break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (ready && !stopping) server.listen(18765, '127.0.0.1');
else stop(1);
