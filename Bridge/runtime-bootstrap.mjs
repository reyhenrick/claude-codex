import { constants } from 'node:fs';
import { open, lstat, readFile, readdir, mkdir, link, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ensureClientKey, readClientKey } from './client-auth.mjs';
import { makeConfig, privateJSON, removeTemporaryModelInstructions, runtimeDirectory, upgradeModelConfig } from './runtime.mjs';
import { verifyRuntimeLock } from './runtime-lock.mjs';

const names = ['client.key', 'management.key', 'accounts-state.json', 'config.yaml'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = info => [info.dev, info.ino, info.uid, info.mode & 0o777].join(':');
const fail = (code = 'setup.runtime_incomplete', message = 'A configuração local está incompleta. Os dados existentes foram preservados.') => Object.assign(new Error(message), { code });
const absent = error => error.code === 'ENOENT';
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

async function directory(path, expected) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || expected && identity(info) !== expected) throw fail();
  return info;
}

async function snapshot(path, { links = [1], limit = 4 * 1024 * 1024 } = {}) {
  let before;
  try { before = await lstat(path); } catch (error) { if (absent(error)) return null; throw error; }
  if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600 || !links.includes(before.nlink) || before.size > limit) throw fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(await file.stat()) !== identity(before)) throw fail();
    const bytes = await file.readFile();
    const after = await lstat(path);
    if (bytes.length > limit || identity(after) !== identity(before) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail();
    return { info: after, bytes, identity: identity(after), digest: hash(bytes) };
  } finally { await file.close(); }
}

async function writeNew(path, bytes) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  return snapshot(path);
}

async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (absent(error)) return null; throw error; }
}

async function loadTransaction(runtimeDir) {
  const file = await snapshot(join(runtimeDir, 'bootstrap.json'), { links: [1, 2], limit: 32768 });
  if (!file) return null;
  let record;
  try { record = JSON.parse(file.bytes); } catch { throw fail(); }
  if (record?.version !== 1 || !uuid.test(record.id ?? '') || record.uid !== process.getuid() || record.runtime !== runtimeDir ||
      typeof record.directoryIdentity !== 'string' || typeof record.authIdentity !== 'string' ||
      !Array.isArray(record.files) || record.files.length !== names.length ||
      record.files.some((entry, index) => entry?.name !== names[index] || typeof entry.identity !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.existing !== 'boolean')) throw fail();
  return { record, journal: file, stage: join(runtimeDir, `.bootstrap-${record.id}`) };
}

function matches(file, entry) { return file && file.identity === entry.identity && file.digest === entry.digest; }

async function prepareTransaction(runtimeDir, checkpoint) {
  // Legacy sentinels have no owner identity. Preserve them rather than guessing
  // that another version's initializer is dead or deleting unknown partials.
  if (await exists(join(runtimeDir, '.initializing'))) throw fail('setup.runtime_legacy_pending', 'Uma preparação anterior precisa ser retomada com segurança. Os dados foram preservados.');
  for (const name of names.slice(1)) if (await exists(join(runtimeDir, name))) throw fail();
  let client = await snapshot(join(runtimeDir, 'client.key'));
  if (client) await readClientKey(runtimeDir);
  const auth = join(runtimeDir, 'auth');
  try { await mkdir(auth, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const authInfo = await directory(auth);
  if ((await readdir(auth)).length) throw fail();
  await checkpoint('auth-created');
  const id = randomUUID(), stage = join(runtimeDir, `.bootstrap-${id}`);
  await mkdir(stage, { mode: 0o700 });
  const stageInfo = await directory(stage);
  const managementKey = randomBytes(40).toString('base64url');
  const config = makeConfig(runtimeDir, await bcrypt.hash(managementKey, 10), randomBytes(40).toString('base64url'));
  const content = {
    'client.key': Buffer.from(randomBytes(48).toString('base64url') + '\n'),
    'management.key': Buffer.from(managementKey + '\n'),
    'accounts-state.json': json({ accounts: [], priority_order: [], mode: 'automatic', fixed_email: null, revision: 0, allow_extra_credits: false, auto_reset_emails: [], reset_journal: {} }),
    'config.yaml': json(config),
  };
  const files = [];
  for (const name of names) {
    const existing = name === 'client.key' && client !== null;
    const file = existing ? client : await writeNew(join(stage, name), content[name]);
    files.push({ name, identity: file.identity, digest: file.digest, existing });
  }
  const record = { version: 1, id, uid: process.getuid(), runtime: runtimeDir, directoryIdentity: identity(stageInfo), authIdentity: identity(authInfo), files };
  await writeNew(join(stage, 'manifest.json'), json(record));
  await syncDirectory(stage);
  await checkpoint('staged');
  await link(join(stage, 'manifest.json'), join(runtimeDir, 'bootstrap.json'));
  await syncDirectory(runtimeDir);
  await checkpoint('journal-published');
  return loadTransaction(runtimeDir);
}

async function completeTransaction(runtimeDir, transaction, checkpoint) {
  const { record, journal, stage } = transaction;
  await directory(join(runtimeDir, 'auth'), record.authIdentity);
  const stageExists = await exists(stage);
  if (stageExists) await directory(stage, record.directoryIdentity);
  for (const entry of record.files) {
    const target = join(runtimeDir, entry.name), source = join(stage, entry.name);
    const published = await snapshot(target, { links: [1, 2] });
    const staged = stageExists ? await snapshot(source, { links: [1, 2] }) : null;
    if (published && !matches(published, entry) || staged && !matches(staged, entry)) throw fail();
    if (entry.existing) {
      if (!published || staged || published.info.nlink !== 1) throw fail();
    } else {
      if (!published) {
        if (!staged || staged.info.nlink !== 1) throw fail();
        await link(source, target);
        await syncDirectory(runtimeDir);
        await checkpoint(`published:${entry.name}`);
      }
      if (staged) {
        const sourceNow = await snapshot(source, { links: [2] }), targetNow = await snapshot(target, { links: [2] });
        if (!matches(sourceNow, entry) || !matches(targetNow, entry)) throw fail();
        await unlink(source);
      }
    }
    if (!matches(await snapshot(target), entry)) throw fail();
  }
  await readClientKey(runtimeDir);
  if (stageExists) {
    await directory(stage, record.directoryIdentity);
    const remaining = await readdir(stage);
    if (remaining.some(name => name !== 'manifest.json')) throw fail();
    const manifest = await snapshot(join(stage, 'manifest.json'), { links: [1, 2], limit: 32768 });
    if (manifest) {
      if (manifest.identity !== journal.identity || !manifest.bytes.equals(journal.bytes)) throw fail();
      await unlink(join(stage, 'manifest.json'));
    }
    await rmdir(stage);
  }
  const current = await snapshot(join(runtimeDir, 'bootstrap.json'), { limit: 32768 });
  if (!current || current.identity !== journal.identity || !current.bytes.equals(journal.bytes)) throw fail();
  await unlink(join(runtimeDir, 'bootstrap.json'));
  await syncDirectory(runtimeDir);
  await checkpoint('completed');
}

export async function initializeRuntime(runtimeDir, { removeTemporaryInstructions = false, checkpoint = async () => {} } = {}) {
  runtimeDir = resolve(runtimeDir);
  verifyRuntimeLock(runtimeDir, process.env.CODEX_ACCOUNTS_INIT_LOCK_FD, 'initialization.lock');
  await directory(runtimeDir);
  if (removeTemporaryInstructions) verifyRuntimeLock(runtimeDir, process.env.CODEX_ACCOUNTS_SERVICE_OWNER_FD, 'service.lock');
  const transaction = await loadTransaction(runtimeDir);
  if (transaction) await completeTransaction(runtimeDir, transaction, checkpoint);
  let config = await snapshot(join(runtimeDir, 'config.yaml'));
  if (!config) {
    await completeTransaction(runtimeDir, await prepareTransaction(runtimeDir, checkpoint), checkpoint);
    config = await snapshot(join(runtimeDir, 'config.yaml'));
  }
  let value;
  try { value = JSON.parse(config.bytes); } catch { throw fail('setup.runtime_invalid'); }
  if (value.server?.host !== '127.0.0.1' || value.server?.port !== 18768 || !value.server?.['commercial-mode'] || value.management?.['allow-remote'] || value.oauth?.['auth-dir'] !== join(runtimeDir, 'auth')) throw fail('setup.runtime_invalid', 'A configuração existente precisa ser revisada.');
  if (!await snapshot(join(runtimeDir, 'management.key')) || !await snapshot(join(runtimeDir, 'accounts-state.json'))) throw fail();
  await directory(join(runtimeDir, 'auth'));
  const upgraded = upgradeModelConfig(removeTemporaryInstructions ? removeTemporaryModelInstructions(value) : value);
  await ensureClientKey(runtimeDir);
  if (JSON.stringify(upgraded) !== JSON.stringify(value)) {
    const latest = await snapshot(join(runtimeDir, 'config.yaml'));
    if (!latest || latest.identity !== config.identity || !latest.bytes.equals(config.bytes)) throw fail('setup.runtime_changed');
    await privateJSON(join(runtimeDir, 'config.yaml'), upgraded);
  }
  return upgraded;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    if (process.argv.slice(2).some(arg => arg !== '--retire-model-map')) throw fail('setup.runtime_invalid');
    await initializeRuntime(runtimeDirectory(), { removeTemporaryInstructions: process.argv.includes('--retire-model-map') });
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: typeof error.code === 'string' && error.code.startsWith('setup.') ? error.code : 'setup.runtime_invalid',
      message: error instanceof SyntaxError ? 'A configuração existente precisa ser revisada.' : error.message }));
    process.exitCode = 1;
  }
}
