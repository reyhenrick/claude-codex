import { constants } from 'node:fs';
import { open, lstat, mkdir, readdir, rename, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { modelRuleMarker } from './model-instructions.mjs';

export { modelRuleMarker };
const marker = Buffer.from(modelRuleMarker);
const maximumBytes = 64 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = code => Object.assign(new Error(code), { code });
const identity = info => [info.dev, info.ino, info.uid, info.mode].join(':');
const fingerprint = info => [identity(info), info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
const own = info => info.uid === BigInt(process.getuid());
const safeFile = (info, links = [1n]) => info.isFile() && own(info) && links.includes(info.nlink) && (info.mode & 0o022n) === 0n;
const missing = error => error.code === 'ENOENT';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function absolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw fail('model_rules.invalid_path');
  return resolve(value);
}

function hasMarker(bytes) {
  return bytes.subarray(0, marker.length).equals(marker) && (bytes.length === marker.length || bytes[marker.length] === 10 || bytes[marker.length] === 13 && bytes[marker.length + 1] === 10);
}

function ruleBytes(text) {
  if (typeof text !== 'string') throw fail('model_rules.invalid_text');
  const bytes = Buffer.from(text);
  if (bytes.length > maximumBytes) throw fail('model_rules.file_limit');
  if (!hasMarker(bytes) || bytes.includes(0)) throw fail('model_rules.invalid_marker');
  return bytes;
}

async function directoryChain(path) {
  const root = parse(path).root, chain = [];
  let current = root;
  for (const part of ['', ...path.slice(root.length).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = await lstat(current, { bigint: true });
    const trustedOwner = own(info) || info.uid === 0n;
    const trustedSticky = info.uid === 0n && (info.mode & 0o1000n) !== 0n && current !== path;
    if (!info.isDirectory() || !trustedOwner || (info.mode & 0o022n) !== 0n && !trustedSticky || current === path && !own(info)) throw fail('model_rules.unsafe_path');
    chain.push({ path: current, identity: identity(info) });
  }
  return chain;
}

async function verifyChain(chain) {
  for (const entry of chain) {
    let info;
    try { info = await lstat(entry.path, { bigint: true }); }
    catch (error) { if (missing(error)) throw fail('model_rules.concurrent_change'); throw error; }
    if (!info.isDirectory() || identity(info) !== entry.identity) throw fail('model_rules.concurrent_change');
  }
}

async function boundedRead(handle, limit, position = 0) {
  const buffer = Buffer.alloc(limit);
  let size = 0;
  while (size < limit) {
    const { bytesRead } = await handle.read(buffer, size, limit - size, position + size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  return buffer.subarray(0, size);
}

async function fileSnapshot(path, rule = false, links = [1n]) {
  let before;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (!safeFile(before, links)) throw fail('model_rules.unsafe_path');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) throw fail('model_rules.concurrent_change');
    let bytes = await boundedRead(handle, marker.length + 2);
    const managed = !rule || hasMarker(bytes);
    if (managed) {
      if (before.size > BigInt(maximumBytes)) throw fail('model_rules.file_limit');
      bytes = await boundedRead(handle, maximumBytes + 1);
      if (bytes.length > maximumBytes) throw fail('model_rules.file_limit');
    }
    const after = await lstat(path, { bigint: true });
    if (fingerprint(after) !== fingerprint(before) || fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) throw fail('model_rules.concurrent_change');
    return { bytes, managed, info: before, fingerprint: fingerprint(before) };
  } finally { await handle.close(); }
}

async function removeOwned(path, info, chain, links = 1n) {
  if (!info) return;
  await verifyChain(chain);
  let current;
  try { current = await lstat(path, { bigint: true }); }
  catch (error) { if (missing(error)) return; throw error; }
  if (identity(current) !== identity(info) || !current.isFile() || current.nlink !== links) throw fail('model_rules.concurrent_change');
  await unlink(path);
}

function operationPaths(rules, nonce) {
  return {
    temporary: join(rules, `.claude-codex-models-${nonce}.tmp`),
    owner: join(rules, `.claude-codex-models-${nonce}.owner`),
    lock: join(rules, '.claude-codex-models.lock'),
    target: join(rules, 'claude-codex-models.md'),
  };
}

function requireDeadProcess(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; }
  throw fail('model_rules.concurrent_change');
}

async function readOperation(lock, chain, dead = false) {
  const snapshot = await fileSnapshot(lock, false, [1n, 2n]);
  if (!snapshot) return null;
  let record;
  try { record = JSON.parse(snapshot.bytes.toString('utf8')); }
  catch { throw fail(snapshot.info.nlink === 1n ? 'model_rules.concurrent_change' : 'model_rules.unsafe_path'); }
  if (!record || record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 2147483647 || typeof record.nonce !== 'string' || !uuid.test(record.nonce) ||
    record.ownerIdentity !== identity(snapshot.info) || record.directoryIdentity !== chain.at(-1).identity ||
    typeof record.temporaryIdentity !== 'string' || !/^\d+(?::\d+){3}$/.test(record.temporaryIdentity) || typeof record.digest !== 'string' || !/^[a-f0-9]{64}$/.test(record.digest) ||
    (snapshot.info.mode & 0o777n) !== 0o600n) throw fail('model_rules.concurrent_change');
  if (dead) requireDeadProcess(record.pid);
  const paths = operationPaths(chain.at(-1).path, record.nonce);
  const owner = await fileSnapshot(paths.owner, false, [2n]);
  if (snapshot.info.nlink === 2n && !owner || owner && (owner.fingerprint !== snapshot.fingerprint || !owner.bytes.equals(snapshot.bytes))) throw fail('model_rules.unsafe_path');
  return { record, snapshot, paths, owner };
}

async function cleanOperation(operation, chain, dead = false) {
  const { record, snapshot, paths } = operation;
  await verifyChain(chain);
  if (dead) requireDeadProcess(record.pid);
  const temporary = await fileSnapshot(paths.temporary, false, [1n, 2n]);
  if (temporary && (identity(temporary.info) !== record.temporaryIdentity || (temporary.info.mode & 0o777n) !== 0o600n)) throw fail('model_rules.concurrent_change');
  if (temporary?.info.nlink === 2n) {
    const published = await fileSnapshot(paths.target, true, [2n]);
    if (!published || identity(published.info) !== record.temporaryIdentity || !published.managed || digest(published.bytes) !== record.digest || !published.bytes.equals(temporary.bytes)) throw fail('model_rules.unsafe_path');
  }
  const current = await readOperation(paths.lock, chain);
  if (!current || current.snapshot.fingerprint !== snapshot.fingerprint || !current.snapshot.bytes.equals(snapshot.bytes)) throw fail('model_rules.concurrent_change');
  if (dead) requireDeadProcess(record.pid);
  if (temporary) await removeOwned(paths.temporary, temporary.info, chain, temporary.info.nlink);
  if (current.owner) await removeOwned(paths.owner, current.owner.info, chain, 2n);
  const remaining = await readOperation(paths.lock, chain);
  if (!remaining || identity(remaining.snapshot.info) !== record.ownerIdentity || !remaining.snapshot.bytes.equals(snapshot.bytes)) throw fail('model_rules.concurrent_change');
  if (dead) requireDeadProcess(record.pid);
  await removeOwned(paths.lock, remaining.snapshot.info, chain);
}

async function publishLock(paths, chain) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await verifyChain(chain);
    try { await link(paths.owner, paths.lock); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const abandoned = await readOperation(paths.lock, chain, true);
    if (abandoned) await cleanOperation(abandoned, chain, true);
  }
  throw fail('model_rules.concurrent_change');
}

export async function writeModelRule(codeRoot, text) {
  const bytes = ruleBytes(text), root = absolutePath(codeRoot);
  const rootChain = await directoryChain(root), rules = join(root, 'rules');
  await verifyChain(rootChain);
  try { await mkdir(rules, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const chain = await directoryChain(rules);
  await verifyChain(rootChain);
  const nonce = randomUUID(), paths = operationPaths(rules, nonce), { target, lock, temporary, owner } = paths;
  let ownerInfo, temporaryInfo, operation, temporaryHandle;
  try {
    await verifyChain(chain);
    temporaryHandle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryInfo = await temporaryHandle.stat({ bigint: true });
    if (!safeFile(temporaryInfo) || (temporaryInfo.mode & 0o777n) !== 0o600n) throw fail('model_rules.unsafe_path');
    const ownerHandle = await open(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      ownerInfo = await ownerHandle.stat({ bigint: true });
      if (!safeFile(ownerInfo) || (ownerInfo.mode & 0o777n) !== 0o600n) throw fail('model_rules.unsafe_path');
      await ownerHandle.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce, ownerIdentity: identity(ownerInfo), temporaryIdentity: identity(temporaryInfo), directoryIdentity: chain.at(-1).identity, digest: digest(bytes) }));
      await ownerHandle.sync();
    } finally { await ownerHandle.close(); }
    await publishLock(paths, chain);
    operation = await readOperation(lock, chain);
    if (!operation || identity(operation.snapshot.info) !== identity(ownerInfo)) throw fail('model_rules.concurrent_change');
    await removeOwned(owner, ownerInfo, chain, 2n);
    operation = await readOperation(lock, chain);
    if (!operation || identity(operation.snapshot.info) !== identity(ownerInfo)) throw fail('model_rules.concurrent_change');
    const previous = await fileSnapshot(target, true);
    await verifyChain(chain);
    if (previous && !previous.managed) return { updated: false, reason: 'unmanaged' };
    if (previous?.bytes.equals(bytes)) {
      if ((previous.info.mode & 0o777n) !== 0o600n) throw fail('model_rules.unsafe_permissions');
      return { updated: false, reason: 'unchanged' };
    }
    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    temporaryInfo = await temporaryHandle.stat({ bigint: true });
    await temporaryHandle.close();
    temporaryHandle = null;
    await verifyChain(chain);
    const current = await fileSnapshot(target, true);
    if (current?.fingerprint !== previous?.fingerprint || current && (!current.managed || !current.bytes.equals(previous.bytes))) throw fail('model_rules.concurrent_change');
    const staged = await fileSnapshot(temporary);
    if (!staged || staged.fingerprint !== fingerprint(temporaryInfo) || !staged.bytes.equals(bytes)) throw fail('model_rules.concurrent_change');
    await verifyChain(chain);
    const currentLock = await lstat(lock, { bigint: true });
    if (!safeFile(currentLock) || fingerprint(currentLock) !== operation.snapshot.fingerprint) throw fail('model_rules.concurrent_change');
    let latest;
    try { latest = await lstat(target, { bigint: true }); }
    catch (error) { if (!missing(error)) throw error; }
    if ((latest ? fingerprint(latest) : undefined) !== previous?.fingerprint) throw fail('model_rules.concurrent_change');
    if (previous) await rename(temporary, target);
    else {
      try { await link(temporary, target); }
      catch (error) { if (error.code === 'EEXIST') throw fail('model_rules.concurrent_change'); throw error; }
      await removeOwned(temporary, temporaryInfo, chain, 2n);
    }
    temporaryInfo = null;
    await verifyChain(chain);
    const written = await fileSnapshot(target, true);
    if (!written || !written.bytes.equals(bytes) || (written.info.mode & 0o777n) !== 0o600n) throw fail('model_rules.concurrent_change');
    return { updated: true, reason: previous ? 'updated' : 'created' };
  } finally {
    await temporaryHandle?.close();
    if (operation) await cleanOperation(operation, chain);
    else {
      try { if (temporaryInfo) await removeOwned(temporary, temporaryInfo, chain); }
      finally { if (ownerInfo) await removeOwned(owner, ownerInfo, chain); }
    }
  }
}

function validMetadata(record, data, code) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (Object.hasOwn(record, 'version')) return record.version === 1 && record.userDataDirectory === data && record.codeConfigDirectory === code;
  const validPath = value => typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !value.includes('\0');
  return typeof record.name === 'string' && record.name.trim().length > 0 && record.name.length <= 80 &&
    validPath(record.source) && validPath(record.launcher) && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) &&
    (!Object.hasOwn(record, 'userDataDirectory') || record.userDataDirectory === data) && (!Object.hasOwn(record, 'codeConfigDirectory') || record.codeConfigDirectory === code);
}

export async function refreshManagedModelRules({ base, text }) {
  ruleBytes(text);
  const root = absolutePath(base), result = { updated: 0, unchanged: 0, unmanaged: 0, errors: [], installations: [] };
  let chain;
  try { chain = await directoryChain(root); }
  catch (error) { if (missing(error)) return result; throw error; }
  const entries = await readdir(root, { withFileTypes: true });
  await verifyChain(chain);
  for (const entry of entries.filter(entry => uuid.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name))) {
    const id = entry.name;
    try {
      await verifyChain(chain);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('model_rules.unsafe_path');
      const child = join(root, id), childChain = await directoryChain(child);
      const metadata = await fileSnapshot(join(child, 'installation.json'));
      if (!metadata) throw fail('model_rules.invalid_metadata');
      let record;
      try { record = JSON.parse(metadata.bytes.toString('utf8')); }
      catch { throw fail('model_rules.invalid_metadata'); }
      const data = join(child, 'User Data'), code = join(data, 'claude-code');
      if (!validMetadata(record, data, code)) throw fail('model_rules.invalid_metadata');
      await verifyChain(childChain);
      const latest = await fileSnapshot(join(child, 'installation.json'));
      if (latest?.fingerprint !== metadata.fingerprint || !latest.bytes.equals(metadata.bytes)) throw fail('model_rules.concurrent_change');
      const outcome = await writeModelRule(code, text);
      result.installations.push({ id, ...outcome });
      result[outcome.updated ? 'updated' : outcome.reason]++;
    } catch (error) {
      result.errors.push({ id, code: typeof error.code === 'string' && /^model_rules\.[a-z_]+$/.test(error.code) ? error.code : 'model_rules.update_failed' });
    }
  }
  return result;
}
