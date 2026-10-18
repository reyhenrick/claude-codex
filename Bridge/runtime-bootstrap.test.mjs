import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ensureRuntime } from './runtime.mjs';
import { ensureTestRuntime, runtimeHelper } from './test-support/runtime-helper.mjs';

const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function pausedInitializer(t, root, phase) {
  const helper = await runtimeHelper();
  const source = `
    import {initializeRuntime} from ${JSON.stringify(new URL('./runtime-bootstrap.mjs', import.meta.url).href)};
    process.on('message',()=>{});
    await initializeRuntime(${JSON.stringify(root)}, {checkpoint:async phase=>{
      if(phase===${JSON.stringify(phase)}){process.send({phase,pid:process.pid});await new Promise(()=>{});}
    }});
  `;
  const child = spawn(helper, ['--initialize', root, process.execPath, '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-2048); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; } });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Initializer did not reach the crash checkpoint.')), 10000);
    child.once('message', message => { clearTimeout(timeout); resolve(message); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Initializer exited early (${code}): ${diagnostics}`)); });
  });
  assert.deepEqual(ready, { phase, pid: child.pid });
  return child;
}

test('kernel initialization recovers crashes at every bootstrap publication point without changing published keys', async t => {
  const phases = ['auth-created', 'staged', 'journal-published', ...['client.key', 'management.key', 'accounts-state.json', 'config.yaml'].map(name => `published:${name}`), 'completed'];
  for (const phase of phases) await t.test(phase, async t => {
    const root = await fixture(t), child = await pausedInitializer(t, root, phase);
    const before = {};
    for (const name of ['client.key', 'management.key']) {
      try { before[name] = digest(await readFile(join(root, name))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
    const first = await ensureTestRuntime(root);
    assert.deepEqual(await ensureTestRuntime(root), first);
    for (const name of ['client.key', 'management.key', 'accounts-state.json', 'config.yaml']) {
      const file = await stat(join(root, name));
      assert.equal(file.mode & 0o777, 0o600); assert.equal(file.nlink, 1);
      if (before[name]) assert.equal(digest(await readFile(join(root, name))), before[name]);
    }
    assert.equal((await stat(join(root, 'auth'))).mode & 0o777, 0o700);
    assert.ok(!(await readdir(root)).includes('bootstrap.json'));
    assert.ok(!(await readdir(root)).includes('.initializing'));
  });
});

test('an empty owned auth directory from interrupted preparation is adopted without replacing its identity', async t => {
  const root = await fixture(t); await mkdir(join(root, 'auth'), { mode: 0o700 });
  const before = await stat(join(root, 'auth'));
  await ensureTestRuntime(root);
  assert.equal((await stat(join(root, 'auth'))).ino, before.ino);
});

test('parallel initializers publish one set of credentials, even while the service lock is held', async t => {
  const root = await fixture(t), helper = await runtimeHelper();
  const holder = spawn(helper, [root, process.execPath, '-e', 'process.stdout.write("ready\\n");process.stdin.resume();'], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM'); });
  await once(holder.stdout, 'data');
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureTestRuntime(root)));
  results.forEach(result => assert.deepEqual(result, results[0]));
  const stopped = once(holder, 'exit'); holder.stdin.end(); await stopped;
  assert.equal(holder.exitCode, 0);
});

test('legacy sentinels, unknown partial files and nonempty auth are preserved rather than guessed away', async t => {
  for (const kind of ['sentinel', 'partial', 'auth', 'symlink']) {
    const root = await fixture(t);
    if (kind === 'sentinel') await mkdir(join(root, '.initializing'), { mode: 0o700 });
    if (kind === 'partial') await writeFile(join(root, 'management.key'), 'synthetic-private-partial', { mode: 0o600 });
    if (kind === 'auth') { await mkdir(join(root, 'auth'), { mode: 0o700 }); await writeFile(join(root, 'auth', 'account.json'), 'synthetic-auth-data', { mode: 0o600 }); }
    if (kind === 'symlink') { await writeFile(join(root, 'outside'), 'preserve', { mode: 0o600 }); await symlink(join(root, 'outside'), join(root, 'management.key')); }
    await assert.rejects(ensureTestRuntime(root), error => error.code === (kind === 'sentinel' ? 'setup.runtime_legacy_pending' : 'setup.runtime_incomplete'));
    if (kind === 'partial') assert.equal(await readFile(join(root, 'management.key'), 'utf8'), 'synthetic-private-partial');
    if (kind === 'auth') assert.equal(await readFile(join(root, 'auth', 'account.json'), 'utf8'), 'synthetic-auth-data');
    if (kind === 'symlink') assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'preserve');
    if (kind === 'sentinel') assert.deepEqual(await readdir(join(root, '.initializing')), []);
  }
});

test('temporary model-map retirement requires the actual service-owner descriptor', async t => {
  const root = await fixture(t);
  await assert.rejects(ensureRuntime(root, { initializerHelper: await runtimeHelper(), removeTemporaryInstructions: true }), { code: 'setup.runtime_lock_required' });
  assert.deepEqual(await readdir(root), []);
});

test('manual-maintenance and Sparkle guards exclude each other and release on EOF or crash', async t => {
  const root = await fixture(t), helper = await runtimeHelper();
  for (const termination of ['eof', 'crash']) {
    const guard = spawn(helper, ['--update-guard', root], { stdio: ['pipe', 'pipe', 'ignore'] });
    t.after(() => { if (guard.exitCode === null && guard.signalCode === null) guard.kill('SIGTERM'); });
    assert.equal((await once(guard.stdout, 'data'))[0].toString(), 'ready\n');
    await assert.rejects(run(helper, ['--maintain', root, process.execPath, '-e', 'process.exit(0)']), { code: 75 });
    const stopped = once(guard, 'exit');
    if (termination === 'eof') guard.stdin.end(); else guard.kill('SIGKILL');
    await stopped;
    await run(helper, ['--maintain', root, process.execPath, '-e', 'process.exit(0)']);
  }
  const result = await run(helper, ['--process-identity', String(process.pid)]);
  assert.match(result.stdout.trim(), new RegExp(`^${process.pid}:[1-9][0-9]*:[0-9]+$`));
});
