import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { OAuthSessionManager, OAuthSessionError, runOAuthWorker, createOAuthCallbackListener, inspectOAuthProcess, oauthCallbackLifetimeMs } from './oauth-session.mjs';

const modulePath = fileURLToPath(new URL('./oauth-session.mjs', import.meta.url));
const email = 'synthetic@example.invalid';
const oauthState = 'synthetic_state_01234567890123456789';
const login = { state: oauthState, url: 'https://auth.openai.com/oauth/authorize?' + new URLSearchParams({
  state: oauthState, redirect_uri: 'http://localhost:1455/auth/callback', code_challenge_method: 'S256', code_challenge: 'synthetic-challenge',
}) };
const content = (forEmail = email, accountID = 'synthetic-account') => JSON.stringify({
  type: 'codex', email: forEmail, account_id: accountID, plan_type: 'pro',
  id_token: 'synthetic.' + Buffer.from(JSON.stringify({ email: forEmail, 'https://api.openai.com/auth': { chatgpt_account_id: accountID, chatgpt_plan_type: 'pro' } })).toString('base64url') + '.synthetic',
  access_token: 'synthetic-access-token-not-real', refresh_token: 'synthetic-refresh-token-not-real',
});
async function fixture(t, options = {}) {
  const runtimeDir = await mkdtemp(join(process.env.CODEX_OAUTH_TEST_ROOT ?? tmpdir(), 'claude-codex-oauth-'));
  const beforeCleanup = [];
  t.after(async () => { for (const cleanup of beforeCleanup) await cleanup(); await rm(runtimeDir, { recursive: true, force: true }); });
  const manager = new OAuthSessionManager({ runtimeDir, proxyExecutable: '/synthetic/cli-proxy-api', inspectProcess: async () => null, ...options });
  const ref = await manager.create({ email });
  const sessionDir = manager.path(ref.id);
  const write = async (name, value) => {
    const destination = join(sessionDir, name), temporary = destination + '.synthetic-tmp';
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, destination);
  };
  return { runtimeDir, manager, ref, sessionDir, write, beforeCleanup };
}
async function until(predicate, description = 'condition') {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Timed out waiting for synthetic ' + description);
}
function workerFixture(f, options = {}) {
  const events = [], controls = { ready: options.ready ?? true, credentialEmail: options.credentialEmail ?? email, states: [] };
  let madeFile = false;
  const backend = {
    start: async () => { events.push('start'); return options.login ?? login; },
    status: async () => { events.push('status'); return options.providerStatus ?? { status: 'wait' }; },
    submit: async body => { controls.states.push(body); },
    credentials: async () => {
      if (!controls.ready) return [];
      if (!madeFile) { await writeFile(join(f.sessionDir, 'auth', 'synthetic.json'), content(controls.credentialEmail), { mode: 0o600 }); madeFile = true; }
      return [{ provider: 'codex', name: 'synthetic.json', email: controls.credentialEmail }];
    },
    stop: async () => { events.push('backend-stop'); if (options.onStop) await options.onStop(); },
  };
  const worker = () => runOAuthWorker(f.sessionDir, { backendFactory: options.backendFactory ?? (async () => backend),
    callbackFactory: async () => { events.push('callback-open'); return { close: async () => events.push('callback-close') }; },
    inspectProcess: async () => ({ pid: process.pid, ppid: process.ppid, uid: process.getuid(), started_at: 'synthetic-start', command: `${process.execPath} ${modulePath} --worker ${f.sessionDir}` }),
    pollIntervalMs: 5, ...(options.now ? { now: options.now } : {}), ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  return { worker, events, controls, backend };
}

test('create writes only a private durable intent; IDs, email and unsafe directories are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.status(f.ref.id)).status, 'created');
  assert.equal((await stat(f.sessionDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.sessionDir, 'intent.json'))).mode & 0o777, 0o600);
  assert.equal(Date.parse(f.ref.expires_at) - Date.parse(f.ref.started_at), oauthCallbackLifetimeMs);
  assert.throws(() => f.manager.path('../outside'), OAuthSessionError);
  await assert.rejects(f.manager.create({ email: 'bad-email' }), OAuthSessionError);
  await chmod(f.runtimeDir, 0o755);
  await assert.rejects(f.manager.create({ email }), OAuthSessionError);
});

test('ready receipt is durable without provider status; content is private and cleared after import callback', async t => {
  const f = await fixture(t), w = workerFixture(f);
  await w.worker();
  const ready = await f.manager.status(f.ref.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.credential.email, email);
  assert.equal(ready.auth_url, undefined);
  assert.equal(w.events.filter(event => event === 'status').length, 0);
  assert.equal(w.events.filter(event => event === 'backend-stop').length, 1);
  assert.equal(w.events.filter(event => event === 'callback-close').length, 1);
  const serialized = JSON.stringify(ready);
  assert.ok(!serialized.includes('synthetic-access-token') && !serialized.includes('id_token'));
  let borrowed;
  assert.equal(await f.manager.withValidatedCredential(f.ref.id, { expectedEmail: email }, async value => {
    borrowed = value.content; assert.equal(value.account_id, 'synthetic-account');
    assert.equal(JSON.parse(value.content).access_token, 'synthetic-access-token-not-real'); return 'imported';
  }), 'imported');
  assert.ok(borrowed.every(byte => byte === 0));
  const later = new OAuthSessionManager({ runtimeDir: f.runtimeDir, now: () => Date.now() + 86400000 });
  assert.equal((await later.recover(f.ref.id)).status, 'ready');
  assert.equal((await later.finish(f.ref.id)).status, 'consumed');
  assert.equal((await later.finish(f.ref.id)).status, 'consumed');
  await assert.rejects(readFile(join(f.sessionDir, 'auth', 'synthetic.json')), { code: 'ENOENT' });
});

test('failed import keeps ready evidence, clears borrowed buffer, and supports an explicit retry', async t => {
  const f = await fixture(t); await workerFixture(f).worker(); let borrowed;
  await assert.rejects(f.manager.withValidatedCredential(f.ref.id, { expectedEmail: email }, async value => {
    borrowed = value.content; throw new Error('synthetic import failure');
  }), /synthetic import failure/);
  assert.ok(borrowed.every(byte => byte === 0));
  assert.equal((await f.manager.status(f.ref.id)).status, 'ready');
  await f.manager.withValidatedCredential(f.ref.id, { expectedEmail: email }, async value => assert.ok(value.content.length > 0));
});

test('wrong account never enters ready and deletes only its isolated credential', async t => {
  const f = await fixture(t); await mkdir(join(f.runtimeDir, 'auth'));
  await writeFile(join(f.runtimeDir, 'auth', 'untouched.json'), 'preserve');
  await workerFixture(f, { credentialEmail: 'wrong@example.invalid' }).worker();
  const result = await f.manager.status(f.ref.id);
  assert.equal(result.status, 'error'); assert.equal(result.error_code, 'oauth.account_mismatch');
  assert.equal(await readFile(join(f.runtimeDir, 'auth', 'untouched.json'), 'utf8'), 'preserve');
  await assert.rejects(readFile(join(f.sessionDir, 'auth', 'synthetic.json')), { code: 'ENOENT' });
});

test('pending URL survives panel restart and cancellation before or after provider completion discards staging', async t => {
  const f = await fixture(t), w = workerFixture(f, { ready: false });
  const running = w.worker();
  await until(async () => (await f.manager.status(f.ref.id)).status === 'pending');
  const reopened = new OAuthSessionManager({ runtimeDir: f.runtimeDir, inspectProcess: async () => null });
  assert.equal((await reopened.status(f.ref.id)).auth_url, login.url);
  await f.write('cancel.json', { requested: true }); await running;
  assert.equal((await f.manager.status(f.ref.id)).status, 'cancelled');
  const completed = await fixture(t); await workerFixture(completed).worker();
  assert.equal((await completed.manager.cancel(completed.ref.id)).status, 'cancelled');
  assert.equal((await completed.manager.cancel(completed.ref.id)).status, 'cancelled');
  await assert.rejects(readFile(join(completed.sessionDir, 'auth', 'synthetic.json')), { code: 'ENOENT' });
});

test('cancel and finish serialize behind a borrowed credential without clearing it mid-import', async t => {
  const f = await fixture(t); await workerFixture(f).worker();
  let release, borrowed;
  const importing = f.manager.withValidatedCredential(f.ref.id, { expectedEmail: email }, async value => {
    borrowed = value.content; await new Promise(resolve => { release = resolve; }); assert.ok(value.content.some(byte => byte !== 0));
  });
  await until(() => release);
  const cancel = f.manager.cancel(f.ref.id); release(); await importing; await cancel;
  assert.ok(borrowed.every(byte => byte === 0)); assert.equal((await f.manager.status(f.ref.id)).status, 'cancelled');
});

test('expired, malformed URL and backend failures expose sanitized stable errors', async t => {
  for (const options of [
    { now: () => Date.now() + oauthCallbackLifetimeMs + 1000, expected: 'oauth.expired' },
    { login: { ...login, url: login.url.replace('auth.openai.com', 'evil.example.invalid') }, expected: 'oauth.session_unavailable' },
    { backendFactory: async () => { throw Error('synthetic-secret-that-must-not-escape'); }, expected: 'oauth.session_unavailable' },
  ]) {
    const f = await fixture(t); await workerFixture(f, options).worker();
    const status = await f.manager.status(f.ref.id); assert.equal(status.error_code, options.expected);
    assert.ok(!JSON.stringify(status).includes('synthetic-secret'));
    assert.ok(!String(await readFile(join(f.sessionDir, 'state.json'))).includes('synthetic-secret'));
  }
});

test('ready revalidation rejects swapped files, hardlinks, symlinks, directories and other identities', async t => {
  for (const kind of ['symlink', 'hardlink', 'changed', 'directory', 'email', 'auth-directory']) {
    const f = await fixture(t); await workerFixture(f).worker();
    const path = join(f.sessionDir, 'auth', 'synthetic.json');
    if (kind === 'symlink' || kind === 'hardlink') {
      const outside = join(f.runtimeDir, 'elsewhere.json'); await writeFile(outside, content(), { mode: 0o600 });
      await rm(path); await (kind === 'symlink' ? symlink(outside, path) : link(outside, path));
    } else if (kind === 'directory') { await rm(path); await mkdir(path); }
    else if (kind === 'changed') await writeFile(path, content(email, 'different-account'), { mode: 0o600 });
    else if (kind === 'auth-directory') {
      await rename(join(f.sessionDir, 'auth'), join(f.sessionDir, 'auth-old'));
      await mkdir(join(f.sessionDir, 'auth'), { mode: 0o700 }); await writeFile(path, content(), { mode: 0o600 });
    }
    await assert.rejects(f.manager.withValidatedCredential(f.ref.id, { expectedEmail: kind === 'email' ? 'other@example.invalid' : email }, async () => assert.fail('Must not import')), OAuthSessionError);
  }
});

test('callback accepts only its local host, exact state, nonduplicate parameters and a single submission', async t => {
  const submitted = [];
  const listener = await createOAuthCallbackListener({ port: 0, getSession: () => login, submitCallback: async body => submitted.push(body) });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${listener.port}`;
  for (const [path, options] of [
    ['/auth/callback?state=wrong&code=synthetic', {}],
    [`/auth/callback?state=${oauthState}&state=${oauthState}&code=synthetic`, {}],
    [`/auth/callback?state=${oauthState}&code=synthetic&error=access_denied`, {}],
    [`/other?state=${oauthState}&code=synthetic`, {}],
    [`/auth/callback?state=${oauthState}&code=synthetic`, { headers: { host: 'external.invalid', origin: 'https://evil.invalid' } }],
    [`/auth/callback?state=${oauthState}&code=synthetic`, { headers: { origin: 'https://evil.invalid' } }],
  ]) assert.equal((await fetch(base + path, options)).status, 400);
  assert.equal(submitted.length, 0);
  const response = await fetch(base + `/auth/callback?state=${oauthState}&code=synthetic-code`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!(await response.text()).includes('synthetic-code'));
  assert.deepEqual(submitted, [{ provider: 'codex', state: oauthState, code: 'synthetic-code' }]);
  assert.equal((await fetch(base + `/auth/callback?state=${oauthState}&code=synthetic-code`)).status, 409);
});

test('provider error is sanitized and occupied callback port never kills or replaces its listener', async t => {
  const submitted = [];
  const listener = await createOAuthCallbackListener({ port: 0, getSession: () => login, submitCallback: async body => submitted.push(body) });
  t.after(() => listener.close());
  await assert.rejects(createOAuthCallbackListener({ port: listener.port, getSession: () => login, submitCallback: async () => {} }), { code: 'EADDRINUSE' });
  const response = await fetch(`http://127.0.0.1:${listener.port}/auth/callback?state=${oauthState}&error=sensitive-remote-string&error_description=another-sensitive-string`);
  assert.equal(response.status, 200); assert.equal(submitted[0].error, 'authorization_failed');
  assert.ok(!(await response.text()).includes('sensitive'));
});

test('a completed credential survives provider session expiry and worker death before final receipt', async t => {
  const f = await fixture(t);
  await mkdir(join(f.sessionDir, 'auth'), { mode: 0o700 });
  await writeFile(join(f.sessionDir, 'auth', 'synthetic.json'), content(), { mode: 0o600 });
  const identity = await stat(join(f.sessionDir, 'auth'));
  await f.write('process.json', { auth_directory: { dev: identity.dev, ino: identity.ino } });
  await f.write('state.json', { status: 'pending', auth_url: login.url, oauth_state: login.state });
  assert.equal((await f.manager.recover(f.ref.id)).status, 'ready');
  await f.manager.withValidatedCredential(f.ref.id, { expectedEmail: email }, async credential => assert.equal(credential.email, email));
});

test('orphan cleanup refuses unrelated/reused PIDs and only signals the recorded CPA child identity', async t => {
  const signaled = [], identities = new Map();
  const f = await fixture(t, { inspectProcess: async pid => identities.get(pid) ?? null, signalProcess: (pid, signal) => { signaled.push([pid, signal]); identities.delete(pid); } });
  const worker = { pid: 900001, ppid: 1, uid: process.getuid(), started_at: 'test worker start', command: `${process.execPath} ${modulePath} --worker ${f.sessionDir}` };
  const cpa = { pid: 900002, ppid: worker.pid, uid: process.getuid(), started_at: 'test child start', command: `/synthetic/cli-proxy-api -config ${join(f.sessionDir, 'config.yaml')} --local-model` };
  await f.write('process.json', { worker, cpa }); await f.write('state.json', { status: 'starting' });
  identities.set(cpa.pid, { ...cpa, ppid: 1 });
  const recovered = await f.manager.recover(f.ref.id);
  assert.equal(recovered.error_code, 'oauth.session_unavailable'); assert.deepEqual(signaled, [[cpa.pid, 'SIGTERM']]);
  const reused = await fixture(t, { inspectProcess: async pid => pid === cpa.pid ? { ...cpa, command: '/unrelated/app', started_at: 'new process' } : null,
    signalProcess: () => assert.fail('Reused PID must not be signaled') });
  const oldWorker = { ...worker, command: `${process.execPath} ${modulePath} --worker ${reused.sessionDir}` };
  const oldCPA = { ...cpa, command: `/synthetic/cli-proxy-api -config ${join(reused.sessionDir, 'config.yaml')} --local-model` };
  await reused.write('process.json', { worker: oldWorker, cpa: oldCPA });
  assert.equal((await reused.manager.cancel(reused.ref.id)).status, 'cancelled');
});

test('SIGKILL of an owned worker is recoverable without killing an unrelated process', async t => {
  const f = await fixture(t, { inspectProcess: inspectOAuthProcess });
  // This fixture process contains no provider code, tokens or network. Its
  // arguments intentionally mirror the real worker identity contract.
  const wrapper = join(f.runtimeDir, 'synthetic-worker.mjs');
  await writeFile(wrapper, "setInterval(() => {}, 1000);\n", { mode: 0o600 });
  const child = spawn(process.execPath, [wrapper], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const owner = await inspectOAuthProcess(child.pid); assert.ok(owner);
  await f.write('process.json', { worker: owner, cpa: null });
  child.kill('SIGKILL'); await exited;
  assert.equal((await f.manager.recover(f.ref.id)).error_code, 'oauth.session_unavailable');
});

test('concurrent starts launch exactly one worker and return the same persisted login', async t => {
  let f, spawned = 0;
  f = await fixture(t, { spawnWorker: (_node, arguments_, options) => {
    spawned++;
    assert.equal(arguments_[0], modulePath); assert.equal(arguments_[1], '--worker'); assert.equal(arguments_[2], f.sessionDir);
    assert.equal(options.stdio, 'ignore'); assert.equal(options.detached, true);
    assert.ok(!JSON.stringify(arguments_).includes(oauthState));
    f.write('state.json', { status: 'pending', auth_url: login.url, oauth_state: login.state });
    return { pid: 900010, on() {}, unref() {} };
  } });
  const values = await Promise.all([f.manager.start(f.ref.id), f.manager.start(f.ref.id)]);
  assert.equal(spawned, 1); assert.equal(values[0].auth_url, login.url); assert.deepEqual(values[0], values[1]);
  const restored = new OAuthSessionManager({ runtimeDir: f.runtimeDir, spawnWorker: () => assert.fail('Existing attempt must not be relaunched') });
  assert.equal((await restored.start(f.ref.id)).status, 'pending');
});

test('cancellation requested before worker start and duplicate worker launches create no provider session', async t => {
  const f = await fixture(t), w = workerFixture(f);
  await f.write('cancel.json', { requested: true });
  await w.worker(); await w.worker();
  assert.equal((await f.manager.status(f.ref.id)).status, 'cancelled'); assert.deepEqual(w.events, []);
});

test('ambiguous staged credentials are rejected and a failed callback is never replayed', async t => {
  const f = await fixture(t), w = workerFixture(f);
  w.backend.credentials = async () => [{ provider: 'codex' }, { provider: 'codex' }];
  await w.worker(); assert.equal((await f.manager.status(f.ref.id)).error_code, 'oauth.session_unavailable');
  let calls = 0;
  const listener = await createOAuthCallbackListener({ port: 0, getSession: () => login, submitCallback: async () => { calls++; throw Error('synthetic-sensitive-provider-error'); } });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.port}/auth/callback?state=${oauthState}&code=synthetic`;
  const first = await fetch(url); assert.equal(first.status, 502); assert.ok(!(await first.text()).includes('sensitive'));
  assert.equal((await fetch(url)).status, 409); assert.equal(calls, 1);
});

test('completed private proof survives backend death and a worker shutdown without an explicit cancellation', async t => {
  const f = await fixture(t), w = workerFixture(f);
  w.backend.credentials = async () => {
    await writeFile(join(f.sessionDir, 'auth', 'synthetic.json'), content(), { mode: 0o600 });
    throw Error('synthetic CPA exited after token persistence');
  };
  await w.worker(); assert.equal((await f.manager.status(f.ref.id)).status, 'ready');
  const aborted = await fixture(t), abort = new AbortController();
  await workerFixture(aborted, { abortSignal: abort.signal, onStop: async () => abort.abort() }).worker();
  assert.equal((await aborted.manager.status(aborted.ref.id)).status, 'ready');
});

test('SIGKILL recovery terminates only the verified real orphan child and preserves unrelated processes', async t => {
  const f = await fixture(t);
  const source = join(f.runtimeDir, 'synthetic-cpa.c'), binary = join(f.runtimeDir, 'synthetic-cpa');
  await writeFile(source, '#include <unistd.h>\nint main(void) { for (;;) pause(); }\n', { mode: 0o600 });
  await promisify(execFile)('/usr/bin/cc', [source, '-o', binary], { timeout: 30000 });
  const manager = new OAuthSessionManager({ runtimeDir: f.runtimeDir, proxyExecutable: binary });
  const ref = await manager.create({ email }), sessionDir = manager.path(ref.id);
  const harness = join(f.runtimeDir, 'synthetic-harness.mjs');
  await writeFile(harness, `
    import { runOAuthWorker, inspectOAuthProcess } from ${JSON.stringify(new URL('./oauth-session.mjs', import.meta.url).href)};
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const sessionDir = process.argv.at(-1);
    await runOAuthWorker(sessionDir, {
      callbackFactory: async () => ({ close: async () => {} }),
      pollIntervalMs: 10,
      backendFactory: async ({ sessionDir, intent, onProcess }) => {
        const child = spawn(intent.proxy_executable, ['-config', join(sessionDir, 'config.yaml'), '--local-model'], { stdio: 'ignore' });
        let identity;
        for (let attempt=0; attempt<30 && !identity; attempt++) { identity=await inspectOAuthProcess(child.pid); if (!identity) await new Promise(r=>setTimeout(r,10)); }
        await onProcess(identity);
        return { start: async () => (${JSON.stringify(login)}), credentials: async () => [], status: async () => ({status:'wait'}),
          stop: async () => { child.kill('SIGTERM'); await new Promise(r=>child.once('exit',r)); } };
      },
    });
  `, { mode: 0o600 });
  const worker = spawn(process.execPath, [harness, modulePath, '--worker', sessionDir], { stdio: 'ignore' });
  const workerExited = once(worker, 'exit');
  f.beforeCleanup.push(async () => {
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await workerExited; }
    await manager.cancel(ref.id);
  });
  await until(async () => (await manager.status(ref.id)).status === 'pending', 'owned child startup');
  const processes = JSON.parse(await readFile(join(sessionDir, 'process.json'), 'utf8'));
  assert.equal(processes.cpa.ppid, worker.pid);
  assert.ok(await inspectOAuthProcess(processes.cpa.pid));
  worker.kill('SIGKILL'); await workerExited;
  assert.equal((await manager.recover(ref.id)).error_code, 'oauth.session_unavailable');
  assert.equal(await inspectOAuthProcess(processes.cpa.pid), null);
  assert.ok(await inspectOAuthProcess(process.pid), 'Test owner is still alive');
});
