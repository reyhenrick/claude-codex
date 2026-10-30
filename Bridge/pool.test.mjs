import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PoolController, evaluateQuota } from './pool-controller.mjs';
import { createPoolRouter as authenticatedRouter } from './pool-router.mjs';
const ingressKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const createPoolRouter = options => authenticatedRouter({ ...options, getIngressKey: async () => ingressKey });
const authorizedFetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { authorization: `Bearer ${ingressKey}`, ...options.headers } });
import { adaptMessage } from './model-adapter.mjs';
import { models } from './model-catalog.mjs';

const root = fileURLToPath(new URL('../build/test-fixtures/', import.meta.url));
await mkdir(root, { recursive: true });
const emails = ['first@example.test', 'second@example.test', 'third@example.test'];
const available = (used = 0) => ({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 2000000000 }, secondary_window: null }, additional_rate_limits: null });
const exhausted = () => { const result = available(100); result.rate_limit.allowed = false; result.rate_limit.limit_reached = true; return result; };
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
  t.after(() => controller.stopNotifications());
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
const post = (base, value = message, extra = {}) => authorizedFetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) });

test('quota gate blocks exhausted paid-credit accounts, malformed results, and extra exhausted limits', () => {
  assert.equal(evaluateQuota(available()).eligible, true);
  assert.equal(evaluateQuota({ ...exhausted(), credits: { has_credits: true, balance: 500 } }).eligible, false);
  assert.equal(evaluateQuota({ ...available(), rate_limit: { ...available().rate_limit, allowed: false } }).eligible, false);
  for (const value of [null, {}, { rate_limit: { allowed: true, limit_reached: false } }, available(NaN), available('0')]) assert.equal(evaluateQuota(value).eligible, false);
  assert.equal(evaluateQuota({ ...available(), additional_rate_limits: [{ limit_name: 'another-model', rate_limit: exhausted().rate_limit }] }).eligible, false);
});

test('automatic routing skips exhausted and unknown accounts; fixed mode stops instead of falling through', async t => {
  const f = await fixture(t); f.quotas.set(emails[0], exhausted()); f.quotas.set(emails[1], new Error('offline'));
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
  const next = f.controller.quota(credential); resolve(exhausted()); assert.equal((await next).eligible, false); assert.equal(lookups, 2);
});

test('normal and Fast mapping keeps explicit effort and complete tool history', () => {
  const result = adaptMessage(message, 'conta-02');
  assert.equal(result.model, 'conta-02/gpt-6.1-sol-fast'); assert.equal(result.thinking.type, 'adaptive'); assert.equal(result.output_config.effort, 'xhigh');
  assert.deepEqual(result.messages, message.messages); assert.equal(message.thinking, undefined);
  assert.equal(adaptMessage({ model: 'claude-opus-5-5', messages: [] }, 'conta-01').output_config?.effort, undefined);
  assert.equal(adaptMessage({ ...message, thinking: { type: 'disabled' } }, 'conta-01').thinking.type, 'disabled');
  assert.throws(() => adaptMessage({ ...message, output_config: { effort: 'ultracode' } }, 'conta-01'));
});

test('every catalogue variant preserves all five native effort choices without forcing a default', () => {
  for (const model of models) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const result = adaptMessage({ model: model.id, output_config: { effort }, messages: [] }, 'conta-01');
      assert.equal(result.output_config.effort, effort);
      assert.equal(result.thinking.type, 'adaptive');
      assert.equal(result.model, `conta-01/${model.target}`);
    }
    const result = adaptMessage({ model: model.id, messages: [] }, 'conta-01');
    assert.equal(result.output_config?.effort, undefined);
    assert.equal(result.thinking, undefined);
  }
});

test('a pre-stream 429 moves to the next eligible account, with the same Fast model and tool history', async t => {
  const f = await fixture(t); const captures = [];
  const upstream = http.createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); captures.push({ body, headers: req.headers });
    if (body.model.startsWith('conta-01/')) { res.writeHead(429); res.end('quota'); } else { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private=1' }); res.end(JSON.stringify({ content: [{ type: 'text', text: '42' }] })); } });
  await start(t, upstream);
  const server = createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic-local-client-key' });
  const base = await start(t, server);
  const response = await post(base, message, { authorization: `Bearer ${ingressKey}`, cookie: 'session=secret', 'x-api-key': ingressKey, 'x-claude-code-session-id': 'session-test' });
  assert.equal(response.status, 200); assert.equal((await response.json()).content[0].text, '42'); assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(captures.map(c => c.body.model), ['conta-01/gpt-6.1-sol-fast', 'conta-02/gpt-6.1-sol-fast']);
  for (const c of captures) { assert.deepEqual(c.body.messages, message.messages); assert.equal(c.body.output_config.effort, 'xhigh'); assert.equal(c.headers.authorization, 'Bearer synthetic-local-client-key'); assert.equal(c.headers.cookie, undefined); assert.equal(c.headers['x-api-key'], undefined); assert.equal(c.headers['x-claude-code-session-id'], 'session-test'); }
  assert.equal((await f.controller.status()).last_used.email, emails[1]);
});

test('an exhausted pool sends no inference even when purchased credits are available', async t => {
  const f = await fixture(t); for (const email of emails) f.quotas.set(email, { ...exhausted(), credits: { has_credits: true } });
  let hit = false; const upstream = http.createServer((_, res) => { hit = true; res.end('{}'); }); await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  assert.equal((await post(base)).status, 429); assert.equal(hit, false);
});

test('cross-origin actions and invalid host are rejected; token counting does not require quota', async t => {
  const f = await fixture(t); let count = 0;
  const upstream = http.createServer(async (req, res) => { for await (const c of req) {} count++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":42}'); }); await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const unsafe = await authorizedFetch(base + '/_bridge/settings', { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json', 'x-bridge-action': 'accounts' }, body: '{}' }); assert.equal(unsafe.status, 403);
  assert.equal((await authorizedFetch(base + '/_bridge/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const r = http.get(base + '/healthz', { headers: { host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await authorizedFetch(base + '/v8/management/credentials')).status, 404);
  const tokens = await authorizedFetch(base + '/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) }); assert.equal(tokens.status, 200); assert.deepEqual(await tokens.json(), { input_tokens: 42 }); assert.equal(f.calls.length, 0); assert.equal(count, 1);
});

const countTokens = (base, value = message) => authorizedFetch(base + '/v1/messages/count_tokens', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('router accounts for one inference receipt after failover and excludes count_tokens', async t => {
  const f = await fixture(t), receipts = [], paths = [];
  f.controller.tokenUsage = { record: value => receipts.push(value), snapshot: () => ({ available: true }) };
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); paths.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (body.model.startsWith('conta-01/')) { response.writeHead(429); response.end('{}'); return; }
    response.end(JSON.stringify(request.url.endsWith('count_tokens') ? { input_tokens: 100 } :
      { type: 'message', model: 'gpt-6.1-sol-fast', content: [], usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 75 } }));
  });
  await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const inference = await post(base); assert.equal(inference.status, 200); await inference.text();
  const counted = await countTokens(base); assert.equal(counted.status, 200); await counted.text();
  assert.deepEqual(receipts, [{ input_tokens: 20, output_tokens: 5, cache_read_tokens: 75, cache_write_tokens: 0 }]);
  assert.deepEqual(paths, ['/v1/messages', '/v1/messages', '/v1/messages/count_tokens']);
  const state = await f.controller.status(); assert.deepEqual(state.token_usage, { available: true });
  assert.ok(state.accounts.every(row => row.active_inference_requests === 0));
});

test('status distinguishes inference activity from quota-free preflight and release is idempotent', async t => {
  const f = await fixture(t), account = (await f.controller.readState()).accounts[0];
  const releaseCount = f.controller.acquire({ ...account, count_only: true });
  let state = await f.controller.status(); assert.equal(state.accounts[0].active_requests, 1); assert.equal(state.accounts[0].active_inference_requests, 0);
  const releaseInference = f.controller.acquire({ ...account, count_only: false });
  state = await f.controller.status(); assert.equal(state.accounts[0].active_requests, 2); assert.equal(state.accounts[0].active_inference_requests, 1);
  releaseCount(); releaseCount(); state = await f.controller.status(); assert.equal(state.accounts[0].active_inference_requests, 1);
  releaseInference(); releaseInference(); state = await f.controller.status(); assert.equal(state.accounts[0].active_requests, 0); assert.equal(state.accounts[0].active_inference_requests, 0);
});

test('state changes publish invalidations but reading the snapshot does not create an update loop', async t => {
  const f = await fixture(t); let changes = 0;
  const unsubscribe = f.controller.subscribe(() => changes++);
  const account = (await f.controller.readState()).accounts[0];
  const release = f.controller.acquire({ ...account, count_only: true }); assert.equal(changes, 1);
  await f.controller.status(); assert.equal(changes, 1);
  f.controller.markUsed(account); assert.equal(changes, 2);
  release(); assert.equal(changes, 3);
  await f.controller.update({ revision: 0, mode: 'fixed', fixed_email: account.email }); assert.equal(changes, 4);
  unsubscribe(); f.controller.markUsed(account); assert.equal(changes, 4);
});

test('automatic quota checks share in-flight work and avoid querying fresh values', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.management.quota = async credential => { f.calls.push(credential.email); entered.resolve(); await gate.promise; return available(); };
  const first = f.controller.refreshStaleQuotas(); await entered.promise;
  const second = f.controller.refreshStaleQuotas(); gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(f.calls, emails);
  await f.controller.refreshStaleQuotas(); assert.deepEqual(f.calls, emails);
  f.controller.pausedForUpdate = true; await f.controller.refreshStaleQuotas(0); assert.deepEqual(f.calls, emails);
});

test('inference completion schedules one quota check while preflight never schedules one', { timeout: 4000 }, async t => {
  const f = await fixture(t), refreshed = deferred(); f.controller.refreshAfterInference = true;
  const account = (await f.controller.readState()).accounts[0];
  const count = f.controller.acquire({ ...account, count_only: true }); count();
  assert.equal(f.controller.quotaRefreshTimers.size, 0);
  f.management.quota = async credential => { f.calls.push(credential.email); refreshed.resolve(); return available(20); };
  const first = f.controller.acquire(account), second = f.controller.acquire(account); first(); second();
  assert.equal(f.controller.quotaRefreshTimers.size, 1);
  const keepAlive = setInterval(() => {}, 1000);
  try { await refreshed.promise; assert.deepEqual(f.calls, [account.email]); }
  finally { clearInterval(keepAlive); }
});

test('completion during an in-flight quota lookup schedules a trailing fresh check', { timeout: 5000 }, async t => {
  const f = await fixture(t), firstEntered = deferred(), releaseFirst = deferred(), secondEntered = deferred();
  f.controller.refreshAfterInference = true;
  f.management.quota = async credential => {
    f.calls.push(credential.email);
    if (f.calls.length === 1) { firstEntered.resolve(); await releaseFirst.promise; }
    else secondEntered.resolve();
    return available();
  };
  const keepAlive = setInterval(() => {}, 1000);
  try {
    f.controller.scheduleQuotaRefresh(emails[0]); await firstEntered.promise;
    f.controller.scheduleQuotaRefresh(emails[0]); f.controller.scheduleQuotaRefresh(emails[0]);
    releaseFirst.resolve(); await secondEntered.promise;
    assert.deepEqual(f.calls, [emails[0], emails[0]]);
  } finally { releaseFirst.resolve(); clearInterval(keepAlive); }
});

test('token counting skips credential cooldowns while preserving model, history and quota-free behavior', async t => {
  const f = await fixture(t), credentials = f.management.credentials, captured = [];
  f.management.credentials = async () => (await credentials()).map((row, i) => ({ ...row, unavailable: i < 2, next_retry_after: '2099-01-01T00:00:00Z' }));
  f.management.resetCooldown = async () => assert.fail('count must not reset a cooldown');
  f.controller.maybeAutomaticReset = async () => assert.fail('count must not redeem a reset');
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured.push(JSON.parse(Buffer.concat(chunks))); res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":42}');
  });
  await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const astra = { ...message, model: 'anthropic.claude-opus-5-5' };
  const result = await countTokens(base, astra);
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { input_tokens: 42 });
  assert.equal(captured.length, 1); assert.equal(captured[0].model, 'conta-03/gpt-6-astra-fast');
  assert.deepEqual(captured[0].messages, message.messages); assert.equal(captured[0].output_config.effort, 'xhigh');
  assert.deepEqual(f.calls, []); assert.equal(f.controller.lastUsed, null);
  await f.controller.update({ revision: 0, mode: 'fixed', fixed_email: emails[0] });
  const fixed = await countTokens(base, astra); assert.equal(fixed.status, 429); await fixed.text();
  assert.equal(captured.length, 1, 'fixed mode never falls through to another account');
});

test('token counting with every credential blocked returns promptly without provider calls', async t => {
  const f = await fixture(t), credentials = f.management.credentials;
  f.management.credentials = async () => (await credentials()).map(row => ({ ...row, unavailable: true, next_retry_after: '2099-01-01T00:00:00Z' }));
  f.management.models = async () => assert.fail('blocked credential metadata cannot hold up admission');
  const upstream = http.createServer(() => assert.fail('blocked credentials must not be dispatched')); await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const result = await countTokens(base); assert.equal(result.status, 429); await result.text(); assert.deepEqual(f.calls, []);
});

test('token counting fails over only on credential errors and never charges quota or marks inference used', async t => {
  for (const status of [401, 402, 403, 429, 400, 413, 500, 503]) await t.test(String(status), async t => {
    const f = await fixture(t), captured = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      captured.push(JSON.parse(Buffer.concat(chunks)));
      const failed = captured.length === 1;
      res.writeHead(failed ? status : 200, { 'content-type': 'application/json', ...(failed ? { 'retry-after': '437449', 'x-should-retry': 'false' } : {}) });
      res.end(failed ? '{"error":{"type":"synthetic_error"}}' : '{"input_tokens":42}');
    });
    await start(t, upstream);
    const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
    const result = await countTokens(base), retryable = [401, 402, 403, 429].includes(status);
    assert.equal(result.status, retryable ? 200 : status); await result.json();
    assert.equal(result.headers.get('retry-after'), retryable ? null : '437449');
    assert.equal(result.headers.get('x-should-retry'), retryable ? null : 'false');
    assert.deepEqual(captured.map(body => body.model), retryable ? ['conta-01/gpt-6.1-sol-fast', 'conta-02/gpt-6.1-sol-fast'] : ['conta-01/gpt-6.1-sol-fast']);
    for (const body of captured) assert.deepEqual(body.messages, message.messages);
    assert.deepEqual(f.calls, []); assert.equal(f.controller.lastUsed, null);
  });
});

test('count selection rechecks operational state after capability lookup and before dispatch', async t => {
  const f = await fixture(t), models = f.management.models;
  f.management.models = async credential => {
    if (credential.email === emails[0]) f.controller.transientBlocks.set(credential.email, Date.now() + 60000);
    return models(credential);
  };
  const candidates = [];
  for await (const candidate of f.controller.candidates({ model: message.model, countOnly: true })) candidates.push(candidate);
  assert.deepEqual(candidates.map(row => row.email), emails.slice(1));
  const selected = candidates[0], credentials = f.management.credentials;
  f.management.credentials = async () => (await credentials()).map(row => ({ ...row, unavailable: row.email === selected.email, next_retry_after: '2099-01-01T00:00:00Z' }));
  assert.equal(await f.controller.validateCandidate(selected), false);
  assert.equal(f.controller.validateCandidateNow(selected), false);
});

test('cancelled admission stops waiting on shared metadata without starting quota or automatic resets', { timeout: 3000 }, async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(), models = f.management.models;
  let lookups = 0, resets = 0;
  f.management.models = async credential => { lookups++; entered.resolve(); await gate.promise; return models(credential); };
  f.controller.maybeAutomaticReset = async () => { resets++; };
  const state = await f.controller.readState(); await f.controller.saveState({ ...state, auto_reset_emails: emails });
  const abort = new AbortController();
  const cancelled = f.controller.candidates({ model: message.model, signal: abort.signal }).next();
  await entered.promise;
  const credential = (await f.controller.credentials())[0], shared = f.controller.capabilities(credential);
  abort.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  assert.deepEqual(f.calls, []); assert.equal(resets, 0);
  gate.resolve(); assert.ok((await shared).ids.length); assert.equal(lookups, 1);
  assert.deepEqual(f.calls, []); assert.equal(resets, 0);
});

test('cancelled validation releases its wait even if the credential request later rejects', { timeout: 3000 }, async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  const { value: account } = await f.controller.candidates({ model: message.model, countOnly: true }).next();
  f.management.credentials = async () => { entered.resolve(); return gate.promise; };
  const abort = new AbortController(), pending = f.controller.validateCandidate(account, { signal: abort.signal });
  await entered.promise; abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  gate.reject(new Error('late metadata failure')); await new Promise(resolve => setImmediate(resolve));
});

test('disconnect cancels upstream streaming and never replays a started response', async t => {
  const f = await fixture(t); let calls = 0; let closed; const closedPromise = new Promise(r => { closed = r; });
  const upstream = http.createServer(async (req, res) => { for await (const c of req) {} calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: content_block_delta\ndata: {"delta":{"text":"first"}}\n\n'); res.on('close', closed); }); await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const abort = new AbortController(); const response = await authorizedFetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...message, stream: true }), signal: abort.signal });
  const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /first/); abort.abort();
  await Promise.race([closedPromise, new Promise((_, reject) => { const timer=setTimeout(()=>reject(Error('upstream was not cancelled')),1500);timer.unref(); })]); assert.equal(calls, 1);
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
  const changed = await authorizedFetch(base + '/_bridge/settings', {
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

test('parent and concurrent child agents retain separate routing and reasoning-cache identities', async t => {
  const f = await fixture(t), seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    seen.push([req.headers['x-claude-code-session-id'], req.headers['x-claude-code-agent-id'], req.headers['x-claude-code-parent-agent-id']]);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller: f.controller, backendPort: upstream.address().port, getClientKey: async () => 'synthetic' }));
  const responses = await Promise.all(['main', 'child-a', 'child-b'].map(agent => post(base, message,
    { 'x-claude-code-session-id': 'same-session', 'x-claude-code-agent-id': agent, ...(agent === 'main' ? {} : { 'x-claude-code-parent-agent-id': 'main' }) })));
  for (const response of responses) { assert.equal(response.status, 200); await response.text(); }
  assert.deepEqual(seen.sort((a,b) => a[1].localeCompare(b[1])), [
    ['same-session', 'child-a', 'main'], ['same-session', 'child-b', 'main'], ['same-session', 'main', undefined],
  ]);
});

test('a model-specific cap blocks only that model at candidate selection and final dispatch validation', async t => {
  const f = await fixture(t);
  const capped = { ...available(), additional_rate_limits: [{ limit_name: 'gpt-6-astra', rate_limit: exhausted().rate_limit }] };
  for (const email of emails) f.quotas.set(email, capped);
  const sol = []; for await (const candidate of f.controller.candidates({ model: 'claude-sonnet-5-5' })) sol.push(candidate);
  assert.equal(sol.length, 3); assert.equal(await f.controller.validateCandidate(sol[0]), true);
  const astra = []; for await (const candidate of f.controller.candidates({ model: 'claude-opus-5-5' })) astra.push(candidate);
  assert.equal(astra.length, 0);
  f.quotas.set(emails[0], { ...available(), additional_rate_limits: [{ limit_name: 'gpt-6.1-sol', rate_limit: exhausted().rate_limit }] });
  await f.controller.quota(sol[0].credential, { force: true }); assert.equal(f.controller.validateCandidateNow(sol[0]), false);
});
