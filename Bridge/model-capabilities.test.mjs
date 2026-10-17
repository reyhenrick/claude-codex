import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { models, baseModels, resolveModel, resolveModelVariant, supportedModelIds } from './model-catalog.mjs';
import { ManagementClient, PoolController, capabilityTTL } from './pool-controller.mjs';
import { createPoolRouter } from './pool-router.mjs';
import { ensureRuntime, makeConfig, upgradeModelConfig } from './runtime.mjs';

const responseModels = (slugs = baseModels.map(model => model.id), tiers = ['priority']) => ({ models: slugs.map(slug => ({ slug, visibility: 'list', service_tiers: tiers.map(id => ({ id })) })) });
const allowance = (exhausted = false) => ({ rate_limit: { allowed: !exhausted, limit_reached: exhausted, primary_window: { used_percent: exhausted ? 100 : 0, limit_window_seconds: 604800, reset_at: 2000000000 } }, additional_rate_limits: [], credits: { has_credits: true, unlimited: false, balance: '50' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'codex-ultra-capabilities-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const accounts = [0, 1].map(i => ({ email: `account-${i}@example.test`, name: `synthetic-${i}.json`, prefix: `conta-0${i + 1}` }));
  const rows = accounts.map((account, i) => ({ ...account, provider: 'codex', auth_index: `${i}`, updated_at: 'v1', id_token: { chatgpt_account_id: `synthetic-${i}` } }));
  const values = new Map(accounts.map(account => [account.email, responseModels()]));
  const quotaValues = new Map(accounts.map(account => [account.email, allowance()]));
  const counts = { models: 0, quota: 0, reset: 0, cooldown: 0 };
  const management = { credentials: async () => rows,
    models: async credential => { counts.models++; const value = values.get(credential.email); if (value instanceof Error) throw value; return value; },
    quota: async credential => { counts.quota++; return quotaValues.get(credential.email); },
    consumeReset: async () => { counts.reset++; throw Error('Unexpected reset'); },
    resetCooldown: async () => { counts.cooldown++; }, deleteCredential: async () => {} };
  const clock = { value: 1900000000000 };
  await writeFile(join(runtimeDir, 'accounts-state.json'), JSON.stringify({ accounts, priority_order: accounts.map(account => account.email), mode: 'automatic', revision: 0 }));
  const controller = new PoolController({ runtimeDir, management, now: () => clock.value });
  return { runtimeDir, controller, accounts, rows, management, values, quotaValues, counts, clock };
}
async function collect(controller, model, options = {}) {
  const selected = []; for await (const candidate of controller.candidates({ model, ...options })) selected.push(candidate); return selected;
}
async function server(t, instance) {
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}

test('fixed catalogue has exactly three bases and eight variants with legacy Fast routing', () => {
  assert.deepEqual(baseModels.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']);
  assert.equal(models.length, 8);
  for (const base of baseModels) {
    assert.equal(resolveModel(`claude-${base.family}-5-5`), base.id);
    assert.equal(resolveModel(`anthropic.claude-${base.family}-5-5`), `${base.id}-fast`);
    assert.equal(resolveModel(`claude-${base.family}-5-5-fast`), `${base.id}-fast`);
    assert.equal(resolveModel(`us.anthropic.claude-${base.family}-5-5`), base.ultra ? `${base.id}-ultra` : undefined);
  }
  assert.equal(resolveModel('haiku'), 'gpt-6-luna');
  assert.equal(resolveModel('anthropic.claude-sonnet-5-5[1m]'), 'gpt-6.1-sol-fast');
  assert.equal(resolveModel('gpt-unknown'), undefined);
  assert.equal(resolveModelVariant('claude-opus-5-5-fast').serviceTier, 'priority');
});

test('capabilities intersect the fixed catalogue and never infer Ultra from Fast or another slug', () => {
  assert.equal(supportedModelIds(responseModels()).length, 6);
  assert.equal(supportedModelIds(responseModels(undefined, ['priority', 'ultrafast'])).length, 8);
  assert.deepEqual(supportedModelIds(responseModels(['gpt-6-luna'], ['priority', 'ultrafast'])), ['claude-haiku-5-5', 'anthropic.claude-haiku-5-5']);
  assert.deepEqual(supportedModelIds(responseModels(['gpt-unknown', 'gpt-6.1-sol-fast'])), []);
  for (const value of [null, {}, { models: {} }, { models: [null] }, { models: [{ slug: 'gpt-6.1-sol' }] }, responseModels(['gpt-6.1-sol', 'gpt-6.1-sol']), { models: [{ slug: 'gpt-6.1-sol', visibility: 'hidden', service_tiers: [] }] }]) assert.deepEqual(supportedModelIds(value), []);
});

test('models endpoint binds the account and uses only the read-only Codex models operation', async t => {
  const f = await fixture(t); await writeFile(join(f.runtimeDir, 'management.key'), 'synthetic-local-key');
  const calls = [];
  const client = new ManagementClient({ runtimeDir: f.runtimeDir, fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ status_code: 200, body: JSON.stringify(responseModels()) }) };
  } });
  const credential = (await f.controller.credentials())[0];
  assert.equal((await client.models(credential)).models.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.method, 'GET');
  assert.equal(calls[0].body.auth_index, credential.auth_index);
  assert.equal(calls[0].body.header['Chatgpt-Account-Id'], credential.account_id);
  assert.equal(calls[0].body.header.Authorization, 'Bearer $TOKEN$');
  assert.equal(calls[0].body.url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.162.0-alpha.17.2');
  assert.equal(calls[0].body.data, undefined);
  client.fetch = async () => ({ ok: true, json: async () => ({ status_code: 200, body: '{"models":null}' }) });
  await assert.rejects(client.models(credential), { status: 503 });
});

test('menu uses selected enabled connections and ignores quota without reset or inference calls', async t => {
  const f = await fixture(t);
  f.values.set(f.accounts[0].email, responseModels(['gpt-6-luna']));
  f.values.set(f.accounts[1].email, responseModels(['gpt-6-astra'], ['ultrafast']));
  f.rows[1].unavailable = true; f.rows[1].next_retry_after = '2099-01-01T00:00:00Z';
  await f.controller.update({ revision: 0, auto_reset_emails: f.accounts.map(account => account.email) });
  assert.deepEqual((await f.controller.availableModels()).map(model => model.id), ['claude-haiku-5-5', 'anthropic.claude-haiku-5-5', 'claude-opus-5-5', 'us.anthropic.claude-opus-5-5']);
  assert.equal(f.counts.quota, 0); assert.equal(f.counts.reset, 0); assert.equal(f.counts.cooldown, 0);
  await f.controller.update({ revision: 1, mode: 'fixed', fixed_email: f.accounts[0].email });
  assert.deepEqual((await f.controller.availableModels()).map(model => model.baseModel), ['gpt-6-luna', 'gpt-6-luna']);
  f.rows[0].disabled = true;
  assert.deepEqual(await f.controller.availableModels({ force: true }), []);
  f.rows.length = 0;
  assert.deepEqual(await f.controller.availableModels({ force: true }), []);
});

test('all models and tiers are filtered by capabilities for inference and count_tokens', async t => {
  const f = await fixture(t);
  for (const model of models) {
    f.values.set(f.accounts[0].email, responseModels([], []));
    f.values.set(f.accounts[1].email, responseModels([model.baseModel], [model.serviceTier]));
    for (const credential of await f.controller.credentials()) f.controller.invalidateCapabilities(credential.name);
    const selected = await collect(f.controller, model.id);
    assert.deepEqual(selected.map(candidate => candidate.email), [f.accounts[1].email]);
    assert.equal(await f.controller.validateCandidate(selected[0]), true);
    assert.equal(f.controller.validateCandidateNow(selected[0]), true);
    assert.equal((await collect(f.controller, model.id, { countOnly: true })).length, 1);
  }
  await f.controller.update({ revision: 0, mode: 'fixed', fixed_email: f.accounts[0].email });
  assert.deepEqual(await collect(f.controller, 'us.anthropic.claude-opus-5-5'), []);
  await assert.rejects(collect(f.controller, undefined), { status: 400 });
});

test('menu rechecks every snapshot after a slower account query completes', async t => {
  const f = await fixture(t), gate = deferred(), started = deferred();
  const read = f.management.models;
  f.management.models = async credential => {
    if (credential.email === f.accounts[1].email) { started.resolve(); return gate.promise; }
    return read(credential);
  };
  const pending = f.controller.availableModels();
  await started.promise;
  f.rows[0].updated_at = 'v2'; await f.controller.credentials(true);
  gate.resolve(responseModels([]));
  assert.deepEqual(await pending, []);
});

test('unknown capabilities, errors and expired snapshots fail closed', async t => {
  const f = await fixture(t);
  const candidate = (await collect(f.controller, 'claude-sonnet-5-5'))[0];
  f.clock.value += capabilityTTL;
  assert.equal(f.controller.validateCandidateNow(candidate), false);
  f.values.set(f.accounts[0].email, new Error('offline')); f.values.set(f.accounts[1].email, {});
  assert.deepEqual(await collect(f.controller, 'claude-sonnet-5-5'), []);
  delete f.management.models;
  assert.deepEqual(await f.controller.availableModels({ force: true }), []);
});

test('routing settings changed after selection invalidate a candidate before forwarding', async t => {
  const f = await fixture(t);
  const candidate = (await collect(f.controller, 'claude-sonnet-5-5'))[0];
  await f.controller.update({ revision: 0, mode: 'fixed', fixed_email: f.accounts[1].email });
  assert.equal(await f.controller.validateCandidate(candidate), false);
  assert.equal(f.controller.validateCandidateNow(candidate), false);
});

test('subscription exhaustion observed during credential validation blocks dispatch while count-only remains available', async t => {
  const f = await fixture(t), gate = deferred(), started = deferred();
  const candidate = (await collect(f.controller, 'claude-sonnet-5-5'))[0];
  const credentials = f.management.credentials;
  f.management.credentials = async () => { started.resolve(); await gate.promise; return credentials(); };
  const validation = f.controller.validateCandidate(candidate); await started.promise;
  f.quotaValues.set(candidate.email, allowance(true));
  await f.controller.quota(candidate.credential, { force: true });
  gate.resolve();
  assert.equal(await validation, false);
  assert.equal(f.controller.validateCandidateNow(candidate), false);
  const counted = (await collect(f.controller, 'claude-sonnet-5-5', { countOnly: true }))[0];
  assert.equal(await f.controller.validateCandidate(counted), true);
});

test('timestamp, auth identity, generation and credential removal invalidate cached capabilities', async t => {
  for (const field of ['updated_at', 'auth_index', 'account_id', 'disabled', 'removed']) {
    const f = await fixture(t);
    const candidate = (await collect(f.controller, 'claude-sonnet-5-5'))[0];
    if (field === 'account_id') f.rows[0].id_token.chatgpt_account_id = 'changed';
    else if (field === 'removed') f.rows.shift();
    else f.rows[0][field] = field === 'disabled' ? true : 'changed';
    assert.equal(await f.controller.validateCandidate(candidate), false);
    assert.equal(f.controller.validateCandidateNow(candidate), false);
  }
});

test('delayed older credentials cannot replace or return a superseded account identity', async t => {
  for (const change of ['disabled', 'rebound']) {
    const f = await fixture(t), gate = deferred();
    const candidate = (await collect(f.controller, 'claude-sonnet-5-5'))[0];
    const oldRows = structuredClone(f.rows); let reads = 0;
    f.management.credentials = async () => ++reads === 1 ? gate.promise : f.rows;
    const oldRead = f.controller.credentials(true);
    if (change === 'disabled') f.rows[0].disabled = true;
    else f.rows[0].id_token.chatgpt_account_id = 'replacement';
    const latest = await f.controller.credentials(true);
    gate.resolve(oldRows);
    assert.deepEqual(await oldRead, latest);
    assert.deepEqual(f.controller.credentialCache.rows, latest);
    assert.equal(f.controller.validateCandidateNow(candidate), false);
    assert.equal(f.controller.capabilityCache.has(candidate.name), false);
  }
});

test('an older credential query waits for the newer in-flight result instead of returning stale data', async t => {
  const f = await fixture(t), older = deferred(), newer = deferred(); let reads = 0;
  f.management.credentials = async () => ++reads === 1 ? older.promise : newer.promise;
  const previous = f.controller.credentials(true), current = f.controller.credentials(true);
  older.resolve(structuredClone(f.rows));
  await Promise.resolve();
  f.rows[0].disabled = true; newer.resolve(f.rows);
  assert.deepEqual(await previous, await current);
  assert.equal((await previous)[0].disabled, true);
});

test('late model response cannot repopulate capability cache after reconnection or disconnection', async t => {
  for (const disconnected of [false, true]) {
    const f = await fixture(t), gate = deferred();
    const credential = (await f.controller.credentials())[0];
    f.management.models = async () => gate.promise;
    const pending = f.controller.capabilities(credential);
    if (disconnected) await f.controller.disconnect(credential.email);
    else { f.rows[0].updated_at = 'v2'; await f.controller.credentials(true); }
    gate.resolve(responseModels(undefined, ['priority', 'ultrafast']));
    const stale = await pending;
    assert.equal(f.controller.capabilityCurrent(stale, credential), false);
    assert.equal(f.controller.capabilityCache.has(credential.name), false);
  }
});

test('concurrent reads share one account capability request and refresh after the bounded local lifetime', async t => {
  const f = await fixture(t), gate = deferred(); let requests = 0;
  const credential = (await f.controller.credentials())[0];
  f.management.models = async () => { requests++; return gate.promise; };
  const pending = Array.from({ length: 12 }, () => f.controller.capabilities(credential));
  gate.resolve(responseModels()); await Promise.all(pending);
  assert.equal(requests, 1);
  await f.controller.capabilities(credential); assert.equal(requests, 1);
  f.clock.value += capabilityTTL;
  await f.controller.capabilities(credential); assert.equal(requests, 2);
});

test('unsupported model on a healthy subscription cannot enable paid admission on another account', async t => {
  const f = await fixture(t);
  await f.controller.update({ revision: 0, allow_extra_credits: true });
  f.values.set(f.accounts[0].email, responseModels(['gpt-6.1-sol'], ['ultrafast']));
  f.quotaValues.set(f.accounts[0].email, allowance(true));
  f.values.set(f.accounts[1].email, responseModels(['gpt-6-luna']));
  assert.deepEqual(await collect(f.controller, 'us.anthropic.claude-sonnet-5-5'), []);
  f.quotaValues.set(f.accounts[1].email, allowance(true));
  const admitted = await collect(f.controller, 'us.anthropic.claude-sonnet-5-5');
  assert.equal(admitted.length, 1); assert.equal(admitted[0].consumption_source, 'credits');
});

test('paid admission revalidates every observed account even when that account lacks the requested model', async t => {
  for (const change of ['disabled', 'removed', 'rebound']) {
    const f = await fixture(t);
    await f.controller.update({ revision: 0, allow_extra_credits: true });
    f.values.set(f.accounts[0].email, responseModels(['gpt-6.1-sol'], ['ultrafast']));
    f.values.set(f.accounts[1].email, responseModels(['gpt-6-luna']));
    for (const account of f.accounts) f.quotaValues.set(account.email, allowance(true));
    const candidate = (await collect(f.controller, 'us.anthropic.claude-sonnet-5-5'))[0];
    assert.equal(candidate.consumption_source, 'credits');
    if (change === 'disabled') f.rows[1].disabled = true;
    if (change === 'removed') f.rows.pop();
    if (change === 'rebound') f.rows[1].id_token.chatgpt_account_id = 'replacement';
    assert.equal(await f.controller.validateCandidate(candidate), false);
    assert.equal(f.controller.validateCandidateNow(candidate), false);
  }
});

test('clearing paid account cooldown preserves its latest credential proof for the first request', async t => {
  const f = await fixture(t); let resets = 0;
  await f.controller.update({ revision: 0, allow_extra_credits: true, mode: 'fixed', fixed_email: f.accounts[0].email });
  for (const account of f.accounts) f.quotaValues.set(account.email, allowance(true));
  f.rows[0].unavailable = true; f.rows[0].next_retry_after = '2099-01-01T00:00:00Z';
  f.management.resetCooldown = async credential => { resets++; f.rows.find(row => row.name === credential.name).unavailable = false; };
  const selected = await collect(f.controller, 'claude-sonnet-5-5');
  assert.equal(selected.length, 1); assert.equal(resets, 1);
  assert.equal(selected[0].consumption_source, 'credits');
  assert.equal(await f.controller.validateCandidate(selected[0]), true);
});

test('router has an empty safe menu and refuses unsupported Ultra without a backend request', async t => {
  const f = await fixture(t); let dispatched = 0;
  const backend = await server(t, http.createServer(async (req, res) => { for await (const chunk of req) {} dispatched++; res.end('{}'); }));
  const base = await server(t, createPoolRouter({ controller: f.controller, getClientKey: async () => 'synthetic', backendPort: Number(new URL(backend).port) }));
  const request = model => fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }) });
  const menu = (await (await fetch(base + '/v1/models')).json()).data;
  assert.equal(menu.length, 6);
  for (const model of menu) {
    const family = resolveModelVariant(model.id).family;
    assert.equal(model.anthropic_family_tier, family);
    assert.equal(model.is_family_default, family ? true : undefined);
  }
  assert.equal((await request('us.anthropic.claude-sonnet-5-5')).status, 429);
  assert.equal((await request('us.anthropic.claude-haiku-5-5')).status, 400);
  assert.equal(dispatched, 0);
  f.rows.length = 0; await f.controller.credentials(true);
  assert.deepEqual(await (await fetch(base + '/v1/models')).json(), { data: [], has_more: false, first_id: null, last_id: null });
});

test('expired capability proof at final dispatch check cannot reach the backend', async t => {
  const f = await fixture(t); let dispatched = 0;
  const backend = await server(t, http.createServer((_, res) => { dispatched++; res.end('{}'); }));
  const validate = f.controller.validateCandidate.bind(f.controller);
  f.controller.validateCandidate = async candidate => { const valid = await validate(candidate); f.clock.value += capabilityTTL; return valid; };
  const base = await server(t, createPoolRouter({ controller: f.controller, getClientKey: async () => 'synthetic', backendPort: Number(new URL(backend).port) }));
  assert.equal((await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] }) })).status, 429);
  assert.equal(dispatched, 0);
});

test('runtime upgrades only owned aliases and tier overrides while preserving credentials and unrelated configuration', async t => {
  const f = await fixture(t);
  const original = makeConfig(f.runtimeDir, 'synthetic-hash', 'synthetic-key');
  original.oauth['model-alias'].codex = [{ name: 'gpt-6.1-sol', alias: 'gpt-6.1-sol-fast', fork: true, custom: 'keep' }, { name: 'external', alias: 'external-alias', fork: true }];
  original.oauth['model-alias'].other = [{ name: 'other', alias: 'other-alias' }];
  original.requests.payload = { default: [{ custom: 'keep' }], override: [
    { models: [{ name: '*gpt-6.1-sol-fast', protocol: 'codex' }, { name: 'external', protocol: 'codex' }], params: { service_tier: 'priority', temperature: 0.2 } },
    { models: [{ name: '*', protocol: 'other' }], params: { service_tier: 'custom' } },
  ] };
  original.custom = { untouched: true };
  await writeFile(join(f.runtimeDir, 'management.key'), 'synthetic-management-key');
  await writeFile(join(f.runtimeDir, 'config.yaml'), JSON.stringify(original));
  const stateBefore = await readFile(join(f.runtimeDir, 'accounts-state.json'), 'utf8');
  const upgraded = await ensureRuntime(f.runtimeDir);
  assert.deepEqual(upgraded.custom, original.custom);
  assert.deepEqual(upgraded.management, original.management);
  assert.deepEqual(upgraded.access, original.access);
  assert.deepEqual(upgraded.oauth['model-alias'].other, original.oauth['model-alias'].other);
  assert.deepEqual(upgraded.requests.payload.default, original.requests.payload.default);
  assert.equal(upgraded.oauth['model-alias'].codex.find(alias => alias.alias === 'gpt-6.1-sol-fast').custom, 'keep');
  assert.ok(upgraded.oauth['model-alias'].codex.some(alias => alias.alias === 'external-alias'));
  assert.ok(upgraded.requests.payload.override.some(rule => rule.models.some(model => model.name === 'external') && rule.params.temperature === 0.2 && rule.params.service_tier === 'priority'));
  assert.ok(upgraded.requests.payload.override.some(rule => rule.models.some(model => model.name === '*gpt-6.1-sol-fast') && rule.params.temperature === 0.2 && rule.params.service_tier === undefined));
  for (const model of models) {
    const rule = upgraded.requests.payload.override.findLast(rule => rule.models.some(matcher => matcher.name === `*${model.target}` && matcher.protocol === 'codex') && rule.params.service_tier);
    assert.equal(rule.params.service_tier, model.serviceTier);
  }
  assert.deepEqual(upgradeModelConfig(upgraded), upgraded);
  assert.deepEqual(await ensureRuntime(f.runtimeDir), upgraded);
  assert.equal(await readFile(join(f.runtimeDir, 'management.key'), 'utf8'), 'synthetic-management-key');
  assert.equal(await readFile(join(f.runtimeDir, 'accounts-state.json'), 'utf8'), stateBefore);
});
