import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { modelRuleMarker, refreshManagedModelRules, writeModelRule } from './model-rules.mjs';

const rule = body => `${modelRuleMarker}\n${body}\n`;
const initial = rule('Astra Fast maps to its configured gateway identifier.');
const replacement = rule('Sol maps to its configured gateway identifier.');
const target = root => join(root, 'rules', 'claude-codex-models.md');

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'codex-model-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function putRule(root, text, mode = 0o600) {
  await mkdir(join(root, 'rules'), { mode: 0o700 });
  await writeFile(target(root), text, { mode });
}

async function installation(base, overrides = {}) {
  const id = randomUUID(), child = join(base, id), data = join(child, 'User Data'), code = join(data, 'claude-code');
  await mkdir(code, { recursive: true, mode: 0o700 });
  await writeFile(join(child, 'installation.json'), JSON.stringify({ version: 1, userDataDirectory: data, codeConfigDirectory: code, ...overrides }), { mode: 0o600 });
  return { id, child, data, code };
}

async function beforePublish(t, root, action) {
  const file = await open(root, 'r'), prototype = Object.getPrototypeOf(file), sync = prototype.sync;
  await file.close();
  let called = false;
  t.mock.method(prototype, 'sync', async function (...args) {
    const result = await sync.apply(this, args);
    const lock = await lstat(join(root, 'rules', '.claude-codex-models.lock')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!called && lock) { called = true; await action(); }
    return result;
  });
}

async function pausedWriter(t, root, phase) {
  const pauseAt = join(root, 'rules', phase === 'lock' ? '.claude-codex-models.lock' : 'claude-codex-models.md');
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    process.on('message', () => {});
    const link = fs.link;
    fs.link = async (...args) => {
      const result = await link(...args);
      if (args[1] === ${JSON.stringify(pauseAt)}) {
        process.send({ phase: ${JSON.stringify(phase)}, pid: process.pid });
        await new Promise(() => {});
      }
      return result;
    };
    syncBuiltinESMExports();
    const { writeModelRule } = await import(${JSON.stringify(new URL('./model-rules.mjs', import.meta.url).href)});
    await writeModelRule(${JSON.stringify(root)}, ${JSON.stringify(initial)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-4096); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Writer did not reach the requested crash point.')), 10000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Writer exited early: ${code}/${signal} ${diagnostics}`)); });
  });
  assert.deepEqual(message, { phase, pid: child.pid });
  return child;
}

test('creates a private rule without touching unrelated instructions or settings', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'CLAUDE.md'), 'Owner instructions');
  await writeFile(join(root, 'settings.json'), '{"synthetic":true}');
  assert.deepEqual(await writeModelRule(root, initial), { updated: true, reason: 'created' });
  assert.equal(await readFile(target(root), 'utf8'), initial);
  assert.equal((await lstat(target(root))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(root, 'rules'))).mode & 0o777, 0o700);
  assert.equal((await lstat(target(root))).nlink, 1);
  assert.equal(await readFile(join(root, 'CLAUDE.md'), 'utf8'), 'Owner instructions');
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), '{"synthetic":true}');
  assert.deepEqual(await readdir(join(root, 'rules')), ['claude-codex-models.md']);
});

test('identical managed contents preserve the inode and timestamps', async t => {
  const root = await fixture(t);
  await writeModelRule(root, initial);
  const before = await lstat(target(root), { bigint: true });
  assert.deepEqual(await writeModelRule(root, initial), { updated: false, reason: 'unchanged' });
  const after = await lstat(target(root), { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
});

test('a changed managed rule is replaced atomically with private permissions', async t => {
  const root = await fixture(t);
  await putRule(root, initial, 0o644);
  const reader = await open(target(root), 'r');
  try {
    assert.deepEqual(await writeModelRule(root, replacement), { updated: true, reason: 'updated' });
    assert.equal(await reader.readFile('utf8'), initial);
    assert.equal(await readFile(target(root), 'utf8'), replacement);
    assert.equal((await lstat(target(root))).mode & 0o777, 0o600);
    assert.notEqual((await reader.stat()).ino, (await lstat(target(root))).ino);
  } finally { await reader.close(); }
});

test('unmanaged files are preserved even when large or containing a marker later', async t => {
  for (const contents of ['Owner rules\n', `\n${initial}`, `owner ${initial}`, `${modelRuleMarker} extra\n`, 'x'.repeat(100000)]) {
    const root = await fixture(t);
    await putRule(root, contents, 0o644);
    const before = await lstat(target(root), { bigint: true });
    assert.deepEqual(await writeModelRule(root, initial), { updated: false, reason: 'unmanaged' });
    assert.equal(await readFile(target(root), 'utf8'), contents);
    assert.equal((await lstat(target(root), { bigint: true })).ctimeNs, before.ctimeNs);
    assert.deepEqual(await readdir(join(root, 'rules')), ['claude-codex-models.md']);
  }
});

test('invalid markers and oversized UTF-8 text fail before creating directories', async t => {
  const root = await fixture(t);
  for (const text of ['', 'Owner rules', `${modelRuleMarker}suffix\n`, `\ufeff${initial}`, `${modelRuleMarker}\rbody`, `${modelRuleMarker}\n\0`]) {
    await assert.rejects(writeModelRule(root, text), { code: 'model_rules.invalid_marker' });
  }
  await assert.rejects(writeModelRule(root, {}), { code: 'model_rules.invalid_text' });
  await assert.rejects(writeModelRule(root, rule('é'.repeat(32768))), { code: 'model_rules.file_limit' });
  assert.deepEqual(await readdir(root), []);
});

test('CRLF marker lines are managed and a bare exact marker remains valid', async t => {
  const root = await fixture(t);
  await putRule(root, `${modelRuleMarker}\r\nOld mapping\r\n`);
  assert.equal((await writeModelRule(root, modelRuleMarker)).updated, true);
  assert.equal(await readFile(target(root), 'utf8'), modelRuleMarker);
});

test('existing oversized managed rules are rejected without changing them', async t => {
  const root = await fixture(t), large = rule('x'.repeat(65536));
  await putRule(root, large);
  await assert.rejects(writeModelRule(root, initial), { code: 'model_rules.file_limit' });
  assert.equal(await readFile(target(root), 'utf8'), large);
});

test('relative roots and roots reached through symlinks are rejected', async t => {
  const root = await fixture(t), real = join(root, 'real'), alias = join(root, 'alias');
  await mkdir(join(real, 'nested'), { recursive: true });
  await symlink(real, alias);
  await assert.rejects(writeModelRule('relative', initial), { code: 'model_rules.invalid_path' });
  await assert.rejects(writeModelRule(alias, initial), { code: 'model_rules.unsafe_path' });
  await assert.rejects(writeModelRule(join(alias, 'nested'), initial), { code: 'model_rules.unsafe_path' });
  assert.deepEqual(await readdir(join(real, 'nested')), []);
});

test('symlinked rules directories cannot redirect the write', async t => {
  const root = await fixture(t), elsewhere = await fixture(t);
  await symlink(elsewhere, join(root, 'rules'));
  await assert.rejects(writeModelRule(root, initial), { code: 'model_rules.unsafe_path' });
  assert.deepEqual(await readdir(elsewhere), []);
});

test('symlink, hardlink and directory targets are rejected without altering the destination', async t => {
  for (const kind of ['symlink', 'hardlink', 'directory']) {
    const root = await fixture(t), elsewhere = join(root, 'elsewhere');
    await mkdir(join(root, 'rules'));
    await writeFile(elsewhere, initial, { mode: 0o600 });
    if (kind === 'symlink') await symlink(elsewhere, target(root));
    else if (kind === 'hardlink') await link(elsewhere, target(root));
    else await mkdir(target(root));
    await assert.rejects(writeModelRule(root, replacement), { code: 'model_rules.unsafe_path' });
    assert.equal(await readFile(elsewhere, 'utf8'), initial);
  }
});

test('writable roots, ancestors, rule directories and target files are rejected', async t => {
  for (const location of ['root', 'ancestor', 'rules', 'target']) {
    const outer = await fixture(t), root = join(outer, 'code');
    await mkdir(root);
    await putRule(root, initial);
    const path = { root, ancestor: outer, rules: join(root, 'rules'), target: target(root) }[location];
    await chmod(path, location === 'target' ? 0o666 : 0o777);
    await assert.rejects(writeModelRule(root, replacement), { code: 'model_rules.unsafe_path' });
    assert.equal(await readFile(target(root), 'utf8'), initial);
  }
});

test('a public managed rule with identical contents is not reported as private', async t => {
  const root = await fixture(t);
  await putRule(root, initial, 0o644);
  await assert.rejects(writeModelRule(root, initial), { code: 'model_rules.unsafe_permissions' });
  assert.equal((await lstat(target(root))).mode & 0o777, 0o644);
});

test('existing lock collisions are preserved and unsafe locks are rejected', async t => {
  for (const kind of ['file', 'symlink', 'hardlink', 'directory']) {
    const root = await fixture(t);
    await putRule(root, initial);
    const lock = join(root, 'rules', '.claude-codex-models.lock'), other = join(root, 'other');
    await writeFile(other, 'Owner bytes', { mode: 0o600 });
    if (kind === 'file') await writeFile(lock, 'Existing operation', { mode: 0o600 });
    else if (kind === 'symlink') await symlink(other, lock);
    else if (kind === 'hardlink') await link(other, lock);
    else await mkdir(lock);
    await assert.rejects(writeModelRule(root, replacement), { code: kind === 'file' ? 'model_rules.concurrent_change' : 'model_rules.unsafe_path' });
    assert.equal(await readFile(target(root), 'utf8'), initial);
    assert.equal(await readFile(other, 'utf8'), 'Owner bytes');
    if (kind === 'file') assert.equal(await readFile(lock, 'utf8'), 'Existing operation');
  }
});

test('concurrent cooperating writers never leave partial contents or temporary files', async t => {
  const root = await fixture(t);
  await putRule(root, initial);
  const candidates = Array.from({ length: 12 }, (_, index) => rule(`Mapping ${index}`));
  const outcomes = await Promise.allSettled(candidates.map(text => writeModelRule(root, text)));
  assert.ok(outcomes.some(outcome => outcome.status === 'fulfilled'));
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled' || outcome.reason.code === 'model_rules.concurrent_change'));
  assert.ok(candidates.includes(await readFile(target(root), 'utf8')));
  assert.deepEqual(await readdir(join(root, 'rules')), ['claude-codex-models.md']);
});

test('a live writer is preserved and a crash immediately after lock publication is recovered', async t => {
  const root = await fixture(t), child = await pausedWriter(t, root, 'lock');
  const lock = join(root, 'rules', '.claude-codex-models.lock');
  const record = JSON.parse(await readFile(lock, 'utf8'));
  assert.equal(record.pid, child.pid);
  assert.equal((await lstat(lock)).nlink, 2);
  await assert.rejects(writeModelRule(root, replacement), { code: 'model_rules.concurrent_change' });
  assert.equal((await lstat(lock)).nlink, 2);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  assert.deepEqual(await writeModelRule(root, replacement), { updated: true, reason: 'created' });
  assert.equal(await readFile(target(root), 'utf8'), replacement);
  assert.equal((await lstat(target(root))).nlink, 1);
  assert.deepEqual(await readdir(join(root, 'rules')), ['claude-codex-models.md']);
});

test('a crash between target linking and temporary unlinking is recovered without losing the published rule', async t => {
  const root = await fixture(t), child = await pausedWriter(t, root, 'target');
  const before = await lstat(target(root), { bigint: true });
  assert.equal(before.nlink, 2n);
  assert.equal(await readFile(target(root), 'utf8'), initial);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  assert.deepEqual(await writeModelRule(root, initial), { updated: false, reason: 'unchanged' });
  const after = await lstat(target(root), { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 1n);
  assert.equal(await readFile(target(root), 'utf8'), initial);
  assert.deepEqual(await readdir(join(root, 'rules')), ['claude-codex-models.md']);
});

test('abandoned operations with replaced temporary identities are preserved for review', async t => {
  const root = await fixture(t), child = await pausedWriter(t, root, 'lock');
  const record = JSON.parse(await readFile(join(root, 'rules', '.claude-codex-models.lock'), 'utf8'));
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const temporary = join(root, 'rules', `.claude-codex-models-${record.nonce}.tmp`);
  await rename(temporary, join(root, 'original-temporary'));
  await writeFile(temporary, 'Owner replacement', { mode: 0o600 });
  await assert.rejects(writeModelRule(root, initial), { code: 'model_rules.concurrent_change' });
  assert.equal(await readFile(temporary, 'utf8'), 'Owner replacement');
  assert.equal(JSON.parse(await readFile(join(root, 'rules', '.claude-codex-models.lock'), 'utf8')).nonce, record.nonce);
});

test('an external edit before publication is detected and preserved', async t => {
  const root = await fixture(t);
  await putRule(root, initial);
  await beforePublish(t, root, () => writeFile(target(root), 'User changed this rule.'));
  await assert.rejects(writeModelRule(root, replacement), { code: 'model_rules.concurrent_change' });
  assert.equal(await readFile(target(root), 'utf8'), 'User changed this rule.');
  assert.deepEqual(await readdir(join(root, 'rules')), ['claude-codex-models.md']);
});

test('an inode replacement with identical contents before publication is detected', async t => {
  const root = await fixture(t);
  await putRule(root, initial);
  const other = join(root, 'replacement');
  await writeFile(other, initial, { mode: 0o600 });
  const original = await lstat(other);
  await beforePublish(t, root, () => rename(other, target(root)));
  await assert.rejects(writeModelRule(root, replacement), { code: 'model_rules.concurrent_change' });
  assert.equal((await lstat(target(root))).ino, original.ino);
  assert.equal(await readFile(target(root), 'utf8'), initial);
});

test('a file created concurrently is never replaced by the initial publication', async t => {
  const root = await fixture(t);
  await beforePublish(t, root, () => writeFile(target(root), 'Owner-created rule', { mode: 0o600 }));
  await assert.rejects(writeModelRule(root, initial), { code: 'model_rules.concurrent_change' });
  assert.equal(await readFile(target(root), 'utf8'), 'Owner-created rule');
  assert.deepEqual(await readdir(join(root, 'rules')), ['claude-codex-models.md']);
});

test('temporary symlinks, hardlinks, directories and changed bytes never reach the target', async t => {
  for (const kind of ['symlink', 'hardlink', 'directory', 'contents']) {
    await t.test(kind, async t => {
      const root = await fixture(t), outside = join(root, 'outside');
      await putRule(root, initial);
      await writeFile(outside, 'Owner bytes', { mode: 0o600 });
      await beforePublish(t, root, async () => {
        const name = (await readdir(join(root, 'rules'))).find(name => name.endsWith('.tmp'));
        assert.ok(name);
        const temporary = join(root, 'rules', name);
        if (kind === 'hardlink') await link(temporary, join(root, 'linked-temporary'));
        else if (kind === 'contents') await writeFile(temporary, 'Unexpected rule');
        else {
          await rename(temporary, join(root, 'saved-temporary'));
          if (kind === 'symlink') await symlink(outside, temporary);
          else await mkdir(temporary);
        }
      });
      await assert.rejects(writeModelRule(root, replacement), error => ['model_rules.concurrent_change', 'model_rules.unsafe_path'].includes(error.code));
      assert.equal(await readFile(target(root), 'utf8'), initial);
      assert.equal(await readFile(outside, 'utf8'), 'Owner bytes');
    });
  }
});

test('a root owned by another user is rejected', async t => {
  const root = await fixture(t), uid = process.getuid();
  t.mock.method(process, 'getuid', () => uid + 1);
  await assert.rejects(writeModelRule(root, initial), { code: 'model_rules.unsafe_path' });
  assert.deepEqual(await readdir(root), []);
});

test('a changed ancestor is rejected without writing through its replacement', async t => {
  const root = await fixture(t), elsewhere = await fixture(t), saved = join(root, 'saved-rules');
  await putRule(root, initial);
  await beforePublish(t, root, async () => {
    await rename(join(root, 'rules'), saved);
    await symlink(elsewhere, join(root, 'rules'));
  });
  await assert.rejects(writeModelRule(root, replacement), { code: 'model_rules.concurrent_change' });
  assert.deepEqual(await readdir(elsewhere), []);
  assert.equal(await readFile(join(saved, 'claude-codex-models.md'), 'utf8'), initial);
});

test('batch refresh accepts only matching versioned metadata and derives destinations', async t => {
  const base = await fixture(t), outside = await fixture(t), valid = await installation(base);
  const wrongVersion = await installation(base, { version: 2 });
  const redirected = await installation(base, { codeConfigDirectory: outside });
  const wrongData = await installation(base, { userDataDirectory: outside });
  const result = await refreshManagedModelRules({ base, text: initial });
  assert.equal(result.updated, 1);
  assert.deepEqual(result.installations, [{ id: valid.id, updated: true, reason: 'created' }]);
  assert.deepEqual(new Set(result.errors.map(error => error.id)), new Set([wrongVersion.id, redirected.id, wrongData.id]));
  assert.ok(result.errors.every(error => error.code === 'model_rules.invalid_metadata'));
  assert.equal(await readFile(target(valid.code), 'utf8'), initial);
  assert.deepEqual(await readdir(outside), []);
  for (const item of [wrongVersion, redirected, wrongData]) assert.deepEqual(await readdir(item.code), []);
});

test('batch refresh accepts the original installation metadata and derives its code path', async t => {
  const base = await fixture(t), item = await installation(base);
  const metadata = { name: 'Original installation', launcher: '/synthetic/Original installation.app', source: '/synthetic/Claude.app', createdAt: '2026-10-17T12:00:00.000Z' };
  await writeFile(join(item.child, 'installation.json'), JSON.stringify(metadata));
  const before = await readFile(join(item.child, 'installation.json'), 'utf8');
  const result = await refreshManagedModelRules({ base, text: initial });
  assert.deepEqual(result.installations, [{ id: item.id, updated: true, reason: 'created' }]);
  assert.deepEqual(result.errors, []);
  assert.equal(await readFile(target(item.code), 'utf8'), initial);
  assert.equal(await readFile(join(item.child, 'installation.json'), 'utf8'), before);
});

test('legacy metadata rejects invalid identity fields and every contradictory modern field', async t => {
  const base = await fixture(t), outside = await fixture(t);
  const legacy = { name: 'Original', launcher: '/synthetic/Original.app', source: '/synthetic/Claude.app', createdAt: '2026-10-17T12:00:00.000Z' };
  const invalid = [{ name: '' }, { source: '../relative' }, { launcher: null }, { createdAt: 'not a date' }, { version: 2 }, { version: null }, { userDataDirectory: outside }, { codeConfigDirectory: outside }];
  for (const change of invalid) {
    const item = await installation(base);
    await writeFile(join(item.child, 'installation.json'), JSON.stringify({ ...legacy, ...change }));
  }
  const result = await refreshManagedModelRules({ base, text: initial });
  assert.equal(result.updated, 0);
  assert.equal(result.errors.length, invalid.length);
  assert.ok(result.errors.every(error => error.code === 'model_rules.invalid_metadata'));
  assert.deepEqual(await readdir(outside), []);
});

test('batch refresh leaves non-UUID directories and nested installations untouched', async t => {
  const base = await fixture(t), parent = join(base, 'owner-folder');
  await mkdir(parent);
  const nested = await installation(parent), result = await refreshManagedModelRules({ base, text: initial });
  assert.deepEqual(result, { updated: 0, unchanged: 0, unmanaged: 0, errors: [], installations: [] });
  assert.deepEqual(await readdir(nested.code), []);
});

test('batch refresh skips unsafe entries and continues with valid installations', async t => {
  const base = await fixture(t), outside = await fixture(t), valid = await installation(base), symlinkId = randomUUID();
  await symlink(outside, join(base, symlinkId));
  const linked = await installation(base), badJSON = await installation(base), dataLink = await installation(base);
  await link(join(linked.child, 'installation.json'), join(base, 'metadata-copy'));
  await writeFile(join(badJSON.child, 'installation.json'), '{SYNTHETIC_PRIVATE_VALUE}');
  await rm(dataLink.code, { recursive: true });
  await symlink(outside, dataLink.code);
  const result = await refreshManagedModelRules({ base, text: initial });
  assert.equal(result.updated, 1);
  assert.equal(result.errors.length, 4);
  assert.deepEqual(new Set(result.errors.map(error => error.id)), new Set([symlinkId, linked.id, badJSON.id, dataLink.id]));
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_VALUE'));
  assert.ok(!JSON.stringify(result).includes(outside));
  assert.equal(await readFile(target(valid.code), 'utf8'), initial);
  assert.deepEqual(await readdir(outside), []);
});

test('batch refresh reports unchanged and unmanaged installations independently', async t => {
  const base = await fixture(t), managed = await installation(base), unmanaged = await installation(base);
  await writeModelRule(managed.code, initial);
  await putRule(unmanaged.code, 'Owner mapping');
  const result = await refreshManagedModelRules({ base, text: initial });
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.unmanaged, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(await readFile(target(unmanaged.code), 'utf8'), 'Owner mapping');
});

test('missing bases are harmless while a symbolic base is rejected', async t => {
  const root = await fixture(t), alias = join(root, 'alias');
  const result = await refreshManagedModelRules({ base: join(root, 'missing'), text: initial });
  assert.deepEqual(result, { updated: 0, unchanged: 0, unmanaged: 0, errors: [], installations: [] });
  await symlink(root, alias);
  await assert.rejects(refreshManagedModelRules({ base: alias, text: initial }), { code: 'model_rules.unsafe_path' });
});
