import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PoolController } from './pool-controller.mjs';
import { oauthFixture } from './testing/oauth-fixture.mjs';
const root = fileURLToPath(new URL('../build/oauth-controller-fixtures/', import.meta.url));
await mkdir(root, { recursive: true });
const email = 'first@example.test';
async function fixture() {
  const runtimeDir = await mkdtemp(root + 'case-');
  const accounts = [email, 'second@example.test'].map((email, i) => ({ email, name: `original-${i}.json`, prefix: `conta-0${i+1}`, plan: 'pro' }));
  await writeFile(runtimeDir + '/accounts-state.json', JSON.stringify({ accounts, priority_order: accounts.map(row => row.email), mode: 'fixed', fixed_email: email, revision: 0 }));
  const rows = accounts.map((account, i) => ({ ...account, provider: 'codex', auth_index: String(i), disabled: false,
    id_token: { chatgpt_account_id: `account-${i}`, plan_type: 'pro' } }));
  const management = { models: async () => ({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', service_tiers: [] }] }) };
  const oauth = oauthFixture(runtimeDir); oauth.installManagement(management, rows);
  const controller = new PoolController({ runtimeDir, management, oauthSessions: oauth.manager });
  const reload = () => new PoolController({ runtimeDir, management, oauthSessions: oauth.manager });
  return { controller, reload, runtimeDir, rows, accounts, oauth, management };
}
async function complete(f, requested = email) {
  await f.controller.connect(requested); f.oauth.latest.status = 'ready';
}

test('isolated OAuth accepts the requested email despite concurrent inference timestamps and changing plan', async () => {
  const f = await fixture(); await complete(f);
  f.oauth.latest.account_id = 'new-workspace'; f.oauth.latest.plan = 'business';
  for (const row of f.rows) row.updated_at = 'other-inference';
  const result = await f.controller.status();
  assert.equal(result.connection, null); assert.equal(result.last_connection.email, email);
  assert.equal(result.accounts.length, 2); assert.equal(result.accounts[0].plan, 'business');
  const state = await f.controller.readState();
  assert.equal(state.fixed_email, email); assert.deepEqual(state.priority_order, f.accounts.map(row => row.email));
  assert.equal(f.rows.filter(row => row.prefix === 'conta-01').length, 1);
  assert.ok(!f.rows.some(row => row.name === 'original-0.json'));
  const body = await readFile(f.runtimeDir + '/accounts-state.json', 'utf8');
  for (const privateValue of ['access_token', 'refresh_token', 'new-workspace', 'broker-only']) assert.ok(!body.includes(privateValue));
});

test('a completed wrong account cannot enter the main credential directory or replace an existing account', async () => {
  const f = await fixture(); await complete(f); f.oauth.latest.email = 'wrong@example.test';
  const status = await f.controller.status();
  assert.equal(status.connection.error_code, 'oauth.account_mismatch');
  assert.equal(f.oauth.events.includes('import'), false); assert.equal(f.rows.length, 2);
  await f.controller.cancelConnection(); assert.equal((await f.controller.readState()).pending_oauth, null);
  assert.equal(f.oauth.latest.status, 'cancelled');
});

test('cancel after browser completion removes the isolated attempt before any import', async () => {
  const f = await fixture(); await complete(f, 'new@example.test');
  await f.controller.cancelConnection();
  assert.deepEqual(f.oauth.events, ['cancel']); assert.equal(f.rows.length, 2);
  assert.equal((await f.controller.status()).accounts.length, 2);
});

test('reopening the panel recovers the exact successful attempt without OAuth status TTL dependence', async () => {
  const f = await fixture(); await complete(f, 'new@example.test');
  f.oauth.latest.expires_at = '2000-01-01T00:00:00Z';
  const reloaded = f.reload(); const result = await reloaded.status();
  assert.equal(result.connection, null); assert.equal(result.accounts.at(-1).email, 'new@example.test');
  assert.equal(result.accounts.length, 3); assert.equal(f.oauth.events.filter(event => event === 'import').length, 1);
});

test('reconnect drains only its account and never interrupts an active stream', async () => {
  const f = await fixture(); const release = f.controller.acquire(f.accounts[0]);
  await complete(f); let status = await f.controller.status();
  assert.equal(status.connection.error_code, 'oauth.reconnect_busy'); assert.equal(f.oauth.events.includes('import'), false);
  assert.equal(f.controller.activeAccounts.get(email), 1); assert.equal(f.controller.acquire(f.accounts[0]), null);
  const other = f.controller.acquire(f.accounts[1]); assert.equal(typeof other, 'function'); other();
  release(); status = await f.controller.status();
  assert.equal(status.connection, null); assert.equal(f.controller.activeAccounts.get(email), 0);
  const next = f.controller.acquire((await f.controller.readState()).accounts.find(row => row.email === email)); assert.equal(typeof next, 'function'); next();
});

test('cancelling a waiting reconnection restores immediate admission without touching any credential', async () => {
  const f = await fixture(); const release = f.controller.acquire(f.accounts[0]);
  await complete(f); await f.controller.status(); await f.controller.cancelConnection();
  assert.equal(f.oauth.events.includes('delete'), false); assert.equal(f.rows[0].disabled, false);
  const next = f.controller.acquire(f.accounts[0]); assert.equal(typeof next, 'function'); next(); release();
});

test('a failed import after persistence is recoverable by cancellation without orphan or lost previous credentials', async () => {
  for (const operation of ['importCredential', 'patchCredential', 'setCredentialDisabled']) {
    const f = await fixture(); await complete(f);
    const original = f.management[operation]; let once = true;
    f.management[operation] = async (...args) => { await original(...args); if (once) { once = false; throw Error('simulated lost response'); } };
    const status = await f.controller.status(); assert.equal(status.connection.error_code, 'oauth.import_failed', operation);
    await f.reload().cancelConnection();
    assert.equal(f.rows.length, 2, operation); assert.equal(f.rows.find(row => row.name === 'original-0.json').disabled, false, operation);
    assert.equal((await f.controller.readState()).accounts.find(row => row.email === email).name, 'original-0.json');
  }
});

test('cleanup after account commit resumes idempotently across app restarts and preserves the new credential', async () => {
  for (const operation of ['deleteCredential', 'finish']) {
    const f = await fixture(); await complete(f);
    const target = operation === 'finish' ? f.oauth.manager : f.management;
    const original = target[operation]; let once = true;
    target[operation] = async (...args) => { await original(...args); if (once) { once = false; throw Error('lost response after commit'); } };
    const first = await f.controller.status(); assert.equal(first.connection.error_code, 'oauth.import_failed');
    assert.equal((await f.controller.readState()).pending_oauth.phase, 'committed');
    const result = await f.reload().status(); assert.equal(result.connection, null);
    assert.equal(f.rows.length, 2); assert.equal(f.rows.find(row => row.email === email).disabled, false);
    assert.equal(f.oauth.events.filter(event => event === 'import').length, 1);
  }
});

test('legacy incomplete authorization fails closed and requires cancellation instead of guessing the login identity', async () => {
  const f = await fixture(), state = await f.controller.readState();
  await f.controller.saveState({ ...state, pending_oauth: { email, state: 'legacy-state', started_at: new Date().toISOString() } });
  const status = await f.controller.status(); assert.equal(status.connection.error_code, 'oauth.expired');
  assert.equal(f.oauth.events.includes('import'), false);
});

test('connection URL is recoverable but absent from failed and committed attempts', async () => {
  const f = await fixture(); await f.controller.connect('new@example.test');
  assert.match((await f.reload().status()).connection.url, /^https:\/\/auth.openai.com\/oauth\/authorize/);
  f.oauth.latest.status = 'expired'; f.oauth.latest.error_code = 'oauth.expired';
  const result = await f.controller.status(); assert.equal(result.connection.url, null); assert.equal(result.connection.error_code, 'oauth.expired');
});

test('legacy mixed-case email uses one identity for in-flight requests, fixed selection and reconnect', async () => {
  const f = await fixture(), state = await f.controller.readState();
  const legacy = 'First@Example.Test';
  state.accounts[0].email = legacy; state.priority_order[0] = legacy; state.fixed_email = legacy;
  await writeFile(f.runtimeDir + '/accounts-state.json', JSON.stringify(state)); f.rows[0].email = legacy;
  const loaded = await f.controller.readState(); assert.equal(loaded.accounts[0].email, email);
  const release = f.controller.acquire(loaded.accounts[0]);
  await complete(f); assert.equal((await f.controller.status()).connection.error_code, 'oauth.reconnect_busy'); release();
  const status = await f.controller.status(); assert.equal(status.connection, null); assert.equal(status.accounts.length, 2); assert.equal(status.fixed_email, email);
  assert.equal((await f.controller.readState()).accounts.filter(row => row.email === email).length, 1);
});

test('financial reset authorization follows account identity and is not inherited by another workspace', async () => {
  for (const same of [true, false]) {
    const f = await fixture(), state = await f.controller.readState();
    const old = (await f.controller.credentials())[0];
    await f.controller.saveState({ ...state, auto_reset_emails: [email], reset_journal: { [email]: { key: 'existing-cycle', identity: f.controller.identity(old), status: 'succeeded', recovered: false } } });
    await complete(f); f.oauth.latest.account_id = same ? 'account-0' : 'another-workspace';
    await f.controller.status(); const next = await f.controller.readState();
    assert.deepEqual(next.auto_reset_emails, same ? [email] : []);
    if (same) {
      assert.equal(next.reset_journal[email].key, 'existing-cycle');
      assert.equal(next.reset_journal[email].identity, f.controller.identity((await f.controller.credentials(true)).find(row => row.email === email)));
    } else assert.equal(next.reset_journal[email], undefined);
  }
});
