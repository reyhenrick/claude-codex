import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
const retry = Symbol('atomic-file-replacement');
const sameFile = (first, second) => first.dev === second.dev && first.ino === second.ino;
const email = value => typeof value === 'string' ? value.trim().toLowerCase() : null;

// CPA's credentials response omits prefix. Read only this routing metadata
// from its private auth file and cross-check the public management identity.
// Never return or persist any credential content from this reader.
async function readPrefix(runtimeDir, credential) {
  const name = credential?.name;
  if (typeof name !== 'string' || basename(name) !== name || name.startsWith('.') || !name.endsWith('.json') || name.includes('\\') || name.includes('\0')) return undefined;
  const directory = join(runtimeDir, 'auth');
  let handle, bytes;
  try {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700) return undefined;
    const path = join(directory, name);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 1024 * 1024) return undefined;
    bytes = Buffer.alloc(Math.min(before.size + 1, 1024 * 1024 + 1));
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    bytes = bytes.subarray(0, total);
    const after = await lstat(path), currentDir = await lstat(directory);
    if (!sameFile(dir, currentDir) || !sameFile(before, after) || before.size !== bytes.length || after.size !== before.size || before.mtimeMs !== after.mtimeMs) return retry;
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.type !== 'codex' || email(value.email) !== email(credential.email) ||
      value.account_id !== credential.id_token?.chatgpt_account_id || Boolean(value.disabled) !== Boolean(credential.disabled) || typeof value.prefix !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.prefix)) return undefined;
    return value.prefix;
  } catch { return undefined; }
  finally { bytes?.fill(0); await handle?.close(); }
}

export async function credentialPrefix(runtimeDir, credential) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await readPrefix(runtimeDir, credential);
    if (result !== retry) return result;
    await new Promise(resolve => setImmediate(resolve));
  }
  return undefined;
}
