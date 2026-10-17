import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const initializing = new Map();
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{64}$/.test(value);
const invalidKey = () => new Error('A chave local do aplicativo precisa ser revisada.');
const privateKeyFile = info => info.isFile() && info.uid === process.getuid() && info.nlink === 1 && (info.mode & 0o777) === 0o600;

async function privateDirectory(runtimeDir) {
  const handle = await open(runtimeDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw invalidKey();
    const current = await lstat(runtimeDir);
    if (!current.isDirectory() || current.dev !== info.dev || current.ino !== info.ino) throw invalidKey();
    return info;
  } finally { await handle.close(); }
}

export async function readClientKey(runtimeDir) {
  const directory = await privateDirectory(runtimeDir), path = join(runtimeDir, 'client.key');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!privateKeyFile(info) || ![64, 65].includes(info.size)) throw invalidKey();
    const raw = await handle.readFile('utf8'), key = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (!validKey(key)) throw invalidKey();
    const current = await lstat(path), parent = await privateDirectory(runtimeDir);
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1 ||
      current.uid !== info.uid || (current.mode & 0o777) !== 0o600 || parent.dev !== directory.dev || parent.ino !== directory.ino) throw invalidKey();
    return key;
  } finally { await handle.close(); }
}

async function readContendedClientKey(runtimeDir) {
  await privateDirectory(runtimeDir);
  const path = join(runtimeDir, 'client.key'), original = await lstat(path);
  if (!privateKeyFile(original) || original.size > 65) throw invalidKey();
  if (original.size >= 64) return readClientKey(runtimeDir);
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const current = await lstat(path);
    if (!privateKeyFile(current) || current.dev !== original.dev || current.ino !== original.ino || current.size > 65) throw invalidKey();
    if (current.size >= 64) return readClientKey(runtimeDir);
  }
  throw invalidKey();
}

export async function ensureClientKey(runtimeDir) {
  const location = resolve(runtimeDir);
  if (initializing.has(location)) return initializing.get(location);
  const pending = (async () => {
    await privateDirectory(location);
    try { return await readClientKey(location); }
    catch (error) { if (error.code !== 'ENOENT') return readContendedClientKey(location); }
    let handle;
    try {
      handle = await open(join(location, 'client.key'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(randomBytes(48).toString('base64url') + '\n');
      await handle.sync();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (handle) await handle.close(); }
    return readContendedClientKey(location);
  })();
  initializing.set(location, pending);
  try { return await pending; } finally { if (initializing.get(location) === pending) initializing.delete(location); }
}

export function authorizeClient(headers, key) {
  if (!validKey(key)) throw invalidKey();
  const authorization = headers.authorization, apiKey = headers['x-api-key'];
  const supplied = [];
  if (authorization !== undefined) {
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{64}$/i.test(authorization)) return false;
    supplied.push(authorization.slice(7));
  }
  if (apiKey !== undefined) {
    if (!validKey(apiKey)) return false;
    supplied.push(apiKey);
  }
  const expected = createHash('sha256').update(key).digest();
  return supplied.length > 0 && supplied.every(value => timingSafeEqual(expected, createHash('sha256').update(value).digest()));
}
