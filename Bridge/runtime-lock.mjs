import { fstatSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export function verifyRuntimeLock(runtimeDir, descriptor, name) {
  const value = Number(descriptor);
  if (!Number.isInteger(value) || value < 3) throw Object.assign(new Error('O processo precisa do lock nativo do serviço.'), { code: 'setup.runtime_lock_required' });
  const held = fstatSync(value), current = lstatSync(join(runtimeDir, name));
  if (!held.isFile() || !current.isFile() || held.uid !== process.getuid() || held.nlink !== 1 ||
      (held.mode & 0o777) !== 0o600 || held.dev !== current.dev || held.ino !== current.ino) {
    throw Object.assign(new Error('O lock nativo do serviço não pôde ser confirmado.'), { code: 'setup.runtime_lock_required' });
  }
  return value;
}
