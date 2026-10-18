import { runtimeDirectory } from './runtime.mjs';
import { verifyRuntimeLock } from './runtime-lock.mjs';
import { runServiceMaintenance } from './service-lifecycle.mjs';

process.umask(0o077);
try {
  verifyRuntimeLock(runtimeDirectory(), process.env.CODEX_ACCOUNTS_MAINTENANCE_LOCK_FD, 'maintenance.lock');
  verifyRuntimeLock(runtimeDirectory(), process.env.CODEX_ACCOUNTS_UPDATE_LOCK_FD, 'update.lock');
  if (process.argv.length !== 3) throw new Error('Invalid maintenance invocation.');
  const result = await runServiceMaintenance(process.argv[2]);
  process.exitCode = result === 'complete' ? 0 : 75;
} catch {
  // launchd retries a failed owned transaction; credentials and request contents
  // never enter a worker log. The UI reads status through the authenticated path.
  process.exitCode = 75;
}
