import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PoolController, evaluateQuota } from './pool-controller.mjs';
import { createPoolRouter } from './pool-router.mjs';
import { adaptMessage } from './model-adapter.mjs';

const root = fileURLToPath(new URL('../build/test-fixtures/', import.meta.url));
await mkdir(root, { recursive: true });
const emails = ['first@example.test', 'second@example.test', 'third@example.test'];
const available = (used = 0) => ({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 2000000000 }, secondary_window: null }, additional_rate_limits: null });
async function fixture(t) {
  const runtimeDir = await mkdtemp(root + 'controller-');
  const accounts = emails.map((email, i) => ({ email, name: `synthetic-${i}.json`, prefix: `conta-0${i + 1}`, plan: 'pro' }));
  await writeFile(runtimeDir + '/accounts-state.json', JSON.stringify({ accounts, priority_order: emails, mode: 'automatic', revision: 0 }));
  const calls = []; const quotas = new Map(emails.map(e => [e, available()]));
  const management = {
    models: async () => ({ models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'].map(slug => ({ slug, visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast' }] })) }),
    credentials: async () => accounts.map((a, i) => ({ ...a, provider: 'codex', auth_index: String(i), id_token: { chatgpt_account_id: `account-${i}`, plan_type: 'pro' } })),
    quota: async c => { calls.push(c.email); const result = quotas.get(c.email); if (result instanceof Error) throw result; return result; },
    resetCooldown: async () => {},
  };
  const controller = new PoolController({ runtimeDir, management });
  return { controller, calls, quotas, management, runtimeDir };
}
async function start(t, server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const message = { model: 'claude-sonnet-5-5-fast', max_tokens: 256, output_config: { effort: 'xhigh' }, messages: [
  { role: 'user', content: 'Calculate.' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'sum', input: { a: 17, b: 25 } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '42' }] },
] };
const post = (base, value = message, extra = {}) => fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) });

test('quota gate blocks exhausted paid-credit accounts, malformed results, and extra exhausted limits', () => {
  assert.equal(evaluateQuota(available()).eligible, true);
  assert.equal(evaluateQuota({ ...available(100), credits: { has_credits: true, balance: 500 } }).eligible, false);
  assert.equal(evaluateQuota({ ...available(), rate_limit: { ...available().rate_limit, allowed: false } }).eligible, false);
  for (const value of [null, {}, { rate_limit: { allowed: true, limit_reached: false } }, available(NaN), available('0')]) assert.equal(evaluateQuota(value).eligible, false);
  assert.equal(evaluateQuota({ ...available(), additional_rate_limits: [{ limit_name: 'another-model', rate_limit: available(100).rate_limit }] }).eligible, false);
});

test('automatic routing skips exhausted and unknown accounts; fixed mode stops instead of falling through', async t => {
  const f = await fixture(t); f.quotas.set(emails[0], available(100)); f.quotas.set(emails[1], new Error('offline'));
  const selected = []; for await (const a of f.controller.candidates({ model: 'claude-sonnet-5-5' })) selected.push(a.email);
  assert.deepEqual(selected, [emails[2]]); assert.deepEqual(f.calls, emails);
  await f.controller.update({ revision: 0, mode: 'fixed', fixed_email: emails[0] }); f.calls.length = 0;
  const fixed = []; for await (const a of f.controller.candidates({ model: 'claude-sonnet-5-5' })) fixed.push(a.email);
  assert.deepEqual(fixed, []); assert.deepEqual(f.calls, [emails[0]]);
});

test('manual order persists immediately, stale concurrent edits fail, state contains no credentials', async t => {
  const f = await fixture(t); const order = [emails[2], emails[0], emails[1]];
  const results = await Promise.allSettled([
    f.controller.update({ revision: 0, priority_order: order }), f.controller.update({ revision: 0, mode: 'fixed', fixed_email: emails[1] }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  for await (const account of f.controller.candidates({ model: 'claude-sonnet-5-5' })) { assert.equal(account.email, emails[2]); break; }
  const reloaded = new PoolController({ runtimeDir: f.runtimeDir, management: f.management });
  assert.deepEqual((await reloaded.readState()).priority_order, order);
  assert.equal((await stat(f.runtimeDir + '/accounts-state.json')).mode & 0o777, 0o600);
  const body = JSON.stringify(await f.controller.status(true));
  assert.ok(!body.includes('auth_index') && !body.includes('account-0') && !body.includes('synthetic-'));
  await assert.rejects(f.controller.update({ revision: 1, priority_order: [emails[0], emails[0], emails[1]] }), { status: 400 });
});

test('concurrent requests share only the in-flight quota lookup and recheck on the next request', async t => {
  const f = await fixture(t); let resolve; let lookups = 0;
  f.management.quota = async () => { lookups++; return await new Promise(r => { resolve = r; }); };
  const credential = (await f.controller.credentials())[0];
  const calls = Array.from({ length: 12 }, () => f.controller.quota(credential));
  resolve(available()); await Promise.all(calls); assert.equal(lookups, 1);
  const next = f.controller.quota(credential); resolve(available(100)); assert.equal((await next).eligible, false); assert.equal(lookups, 2);
});

test('normal and Fast mapping keeps explicit effort and complete tool history', () => {
  const result = adaptMessage(message, 'conta-02');
  assert.equal(result.model, 'conta-02/gpt-6.1-sol-fast'); assert.equal(result.thinking.type, 'adaptive'); assert.equal(result.output_config.effort, 'xhigh');
  assert.deepEqual(result.messages, message.messages); assert.equal(message.thinking, undefined);
  assert.equal(adaptMessage({ model: 'claude-opus-5-5', messages: [] }, 'conta-01').output_config.effort, 'xhigh');
  assert.equal(adaptMessage({ ...message, thinking: { type: 'disabled' } }, 'conta-01').thinking.type, 'disabled');
  assert.throws(() => adaptMessage({ ...message, output_config: { effort: 'ultracode' } }, 'conta-01'));
});

test('a pre-stream 429 moves to the next eligible account, with the same Fast model and tool history', async t => {
  const f = await fixture(t); const captures = [];
  const upstream = http.createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); captures.push({ body, headers: req.headers });
    if (body.model.startsWith('conta-01/')) { res.writeHead(429); res.end('quota'); } else { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private=1' }); res.end(JSON.stringify({ content: [{ type: 'text', text: '42' }] })); } });
  await start(t, upstream);
  const server = createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic-local-client-key' });
  const base = await start(t, server);
  const response = await post(base, message, { authorization: 'Bearer native-placeholder', cookie: 'session=secret', 'x-api-key': 'should-not-forward', 'x-claude-code-session-id': 'session-test' });
  assert.equal(response.status, 200); assert.equal((await response.json()).content[0].text, '42'); assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(captures.map(c => c.body.model), ['conta-01/gpt-6.1-sol-fast', 'conta-02/gpt-6.1-sol-fast']);
  for (const c of captures) { assert.deepEqual(c.body.messages, message.messages); assert.equal(c.body.output_config.effort, 'xhigh'); assert.equal(c.headers.authorization, 'Bearer synthetic-local-client-key'); assert.equal(c.headers.cookie, undefined); assert.equal(c.headers['x-api-key'], undefined); assert.equal(c.headers['x-claude-code-session-id'], 'session-test'); }
  assert.equal((await f.controller.status()).last_used.email, emails[1]);
});

test('an exhausted pool sends no inference even when purchased credits are available', async t => {
  const f = await fixture(t); for (const email of emails) f.quotas.set(email, { ...available(100), credits: { has_credits: true } });
  let hit = false; const upstream = http.createServer((_, res) => { hit = true; res.end('{}'); }); await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  assert.equal((await post(base)).status, 429); assert.equal(hit, false);
});

test('cross-origin actions and invalid host are rejected; token counting does not require quota', async t => {
  const f = await fixture(t); let count = 0;
  const upstream = http.createServer(async (req, res) => { for await (const c of req) {} count++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":42}'); }); await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const unsafe = await fetch(base + '/_bridge/settings', { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json', 'x-bridge-action': 'accounts' }, body: '{}' }); assert.equal(unsafe.status, 403);
  assert.equal((await fetch(base + '/_bridge/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const r = http.get(base + '/healthz', { headers: { host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(base + '/v8/management/credentials')).status, 404);
  const tokens = await fetch(base + '/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) }); assert.equal(tokens.status, 200); assert.deepEqual(await tokens.json(), { input_tokens: 42 }); assert.equal(f.calls.length, 0); assert.equal(count, 1);
});

test('disconnect cancels upstream streaming and never replays a started response', async t => {
  const f = await fixture(t); let calls = 0; let closed; const closedPromise = new Promise(r => { closed = r; });
  const upstream = http.createServer(async (req, res) => { for await (const c of req) {} calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: content_block_delta\ndata: {"delta":{"text":"first"}}\n\n'); res.on('close', closed); }); await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const abort = new AbortController(); const response = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...message, stream: true }), signal: abort.signal });
  const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /first/); abort.abort();
  await Promise.race([closedPromise, new Promise((_, reject) => { const timer=setTimeout(()=>reject(Error('upstream was not cancelled')),1500);timer.unref(); })]); assert.equal(calls, 1);
});

test('connection adds only the verified requested email and keeps OAuth data out of the account state', async t => {
  const f = await fixture(t); let completed = false; const patched = [];
  const original = f.management.credentials;
  const fresh = { email: 'new@example.test', name: 'synthetic-new.json', provider: 'codex', auth_index: 'new', id_token: { chatgpt_account_id: 'account-new', plan_type: 'pro' } };
  await mkdir(f.runtimeDir + '/auth'); await writeFile(f.runtimeDir + '/auth/' + fresh.name, '{}');
  f.management.credentials = async () => [...await original(), ...(completed ? [fresh] : [])];
  f.management.startLogin = async () => ({ state: 'synthetic-state', url: 'https://auth.openai.com/oauth/authorize?state=synthetic-state' });
  f.management.loginStatus = async () => ({ status: completed ? 'ok' : 'wait' });
  f.management.patchCredential = async (name, fields) => patched.push({ name, fields });
  const started = await f.controller.connect(' new@example.test ');
  assert.equal(started.email, 'new@example.test');
  await assert.rejects(f.controller.connect('other@example.test'), { status: 409 });
  assert.equal((await f.controller.status()).connection.email, fresh.email);
  completed = true; const status = await f.controller.status();
  assert.equal(status.connection, null); assert.equal(status.accounts.at(-1).email, fresh.email);
  assert.deepEqual(patched, [{ name: fresh.name, fields: { prefix: 'conta-04', priority: 0 } }]);
  const disk = await readFile(f.runtimeDir + '/accounts-state.json', 'utf8');
  assert.ok(!disk.includes('account-new') && !disk.includes('synthetic-state') && !disk.includes('access_token'));
  assert.equal((await stat(f.runtimeDir + '/auth/' + fresh.name)).mode & 0o777, 0o600);
});

test('expired or mismatched login never replaces an existing account and can be cancelled', async t => {
  const f = await fixture(t); let cancelled = false;
  f.management.startLogin = async () => ({ state: 'synthetic-state', url: 'https://auth.openai.com/oauth/authorize?state=synthetic-state' });
  f.management.loginStatus = async () => ({ status: 'ok' });
  f.management.cancelLogin = async state => { assert.equal(state, 'synthetic-state'); cancelled = true; };
  await f.controller.connect('new@example.test'); const status = await f.controller.status();
  assert.match(status.connection.error, /não corresponde/); assert.equal(status.accounts.length, 3);
  await f.controller.cancelConnection(); assert.equal(cancelled, true); assert.equal((await f.controller.status()).connection, null);
  f.management.loginStatus = async () => ({ status: 'error', error: 'expired' });
  await f.controller.connect(emails[0]); assert.match((await f.controller.status()).connection.error, /expirou/);
});

test('disconnect waits for active requests, deletes only the selected credential and preserves other accounts', async t => {
  const f = await fixture(t); const deleted = [];
  f.management.deleteCredential = async name => deleted.push(name);
  await f.controller.update({ revision: 0, mode: 'fixed', fixed_email: emails[1] });
  const account = (await f.controller.readState()).accounts[1]; const release = f.controller.acquire(account);
  await assert.rejects(f.controller.disconnect(emails[1]), { status: 409 }); assert.equal(deleted.length, 0);
  release(); await f.controller.disconnect(emails[1]);
  assert.deepEqual(deleted, ['synthetic-1.json']);
  const state = await f.controller.readState(); assert.equal(state.mode, 'automatic'); assert.equal(state.fixed_email, null);
  assert.deepEqual(state.priority_order, [emails[0], emails[2]]); assert.equal(f.controller.acquire(account), null);
});

test('failed credential deletion does not remove account metadata or leave a permanent disconnect lock', async t => {
  const f = await fixture(t); f.management.deleteCredential = async () => { throw Error('synthetic failure'); };
  await assert.rejects(f.controller.disconnect(emails[0]));
  const state = await f.controller.readState(); assert.equal(state.accounts.length, 3);
  const release = f.controller.acquire(state.accounts[0]); assert.equal(typeof release, 'function'); release();
});


test('a successful OAuth for the wrong account cannot be mistaken for an unchanged existing credential', async t => {
  const f = await fixture(t);
  f.management.startLogin = async () => ({ state: 'synthetic-state', url: 'https://auth.openai.com/oauth/authorize?state=synthetic-state' });
  f.management.loginStatus = async () => ({ status: 'ok' });
  await f.controller.connect(emails[0]);
  const status = await f.controller.status();
  assert.match(status.connection.error, /não corresponde/);
  assert.equal(status.accounts.length, 3);
});

test('changing account during an active stream affects the next inference without interrupting or replaying the current one', async t => {
  const f = await fixture(t); const routed = []; let firstResponse;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); routed.push(body.model);
    if (body.stream) {
      firstResponse = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: content_block_delta\ndata: {"delta":{"text":"started on first account"}}\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'next iteration on second account' }] }));
    }
  });
  await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const first = await post(base, { ...message, stream: true }); const reader = first.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /started on first account/);
  assert.equal(f.controller.activeAccounts.get(emails[0]), 1);
  const changed = await fetch(base + '/_bridge/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-bridge-action': 'accounts' },
    body: JSON.stringify({ revision: 0, mode: 'fixed', fixed_email: emails[1] }),
  });
  assert.equal(changed.status, 200);
  const second = await post(base); assert.equal(second.status, 200);
  assert.equal((await second.json()).content[0].text, 'next iteration on second account');
  assert.deepEqual(routed, ['conta-01/gpt-6.1-sol-fast', 'conta-02/gpt-6.1-sol-fast']);
  assert.equal(f.controller.activeAccounts.get(emails[0]), 1);
  firstResponse.end('event: message_stop\ndata: {}\n\n');
  let ending = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; ending += new TextDecoder().decode(chunk.value); }
  assert.match(ending, /message_stop/);
  assert.equal(f.controller.activeAccounts.get(emails[0]), 0);
  assert.equal(routed.length, 2);
});
