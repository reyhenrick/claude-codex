import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PoolController } from './pool-controller.mjs';
import { oauthFixture } from './testing/oauth-fixture.mjs';

const email = 'synthetic-owner@example.invalid';
const oldName = 'synthetic-original.json';
const otherName = 'synthetic-other.json';
class SimulatedCrash extends Error {}

async function fixture(t, { disabled = false, otherWorkspace = false } = {}) {
  const runtimeDir = await mkdtemp(join(process.env.CODEX_OAUTH_TEST_ROOT ?? tmpdir(), 'claude-codex-transaction-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await mkdir(join(runtimeDir, 'auth'), { mode: 0o700 });
  const accounts = [
    { email, name: oldName, prefix: 'conta-01', plan: 'pro' },
    { email: 'synthetic-other@example.invalid', name: otherName, prefix: 'conta-02', plan: 'pro' },
  ];
  const rows = accounts.map((account, index) => ({ ...account, provider: 'codex', disabled: index === 0 && disabled,
    auth_index: `synthetic-index-${index}`, id_token: { chatgpt_account_id: `synthetic-account-${index}`, plan_type: 'pro' } }));
  for (const row of rows) await writeFile(join(runtimeDir, 'auth', row.name), JSON.stringify({ type: 'codex', email: row.email, prefix: row.prefix, disabled: row.disabled }), { mode: 0o600 });
  await writeFile(join(runtimeDir, 'accounts-state.json'), JSON.stringify({ accounts, priority_order: accounts.map(account => account.email),
    mode: 'fixed', fixed_email: email, revision: 0, allow_extra_credits: false, auto_reset_emails: [], reset_journal: {} }), { mode: 0o600 });
  const management = {}, oauth = oauthFixture(runtimeDir); oauth.installManagement(management, rows);
  const deleteRow = management.deleteCredential;
  management.deleteCredential = async name => { await deleteRow(name); await rm(join(runtimeDir, 'auth', name), { force: true }); };
  const makePool = () => new PoolController({ runtimeDir, management, oauthSessions: oauth.manager });
  const pool = makePool();
  await pool.connect(email); oauth.latest.account_id = otherWorkspace ? 'synthetic-different-workspace' : 'synthetic-account-0';
  oauth.latest.plan = 'business'; oauth.latest.status = 'ready';
  const newName = `claude-codex-${oauth.latest.id}.json`;
  let observations = 0;
  const invariant = async () => {
    observations++;
    const raw = await readFile(join(runtimeDir, 'accounts-state.json'), 'utf8'), state = JSON.parse(raw);
    assert.equal(new Set(state.accounts.map(account => account.prefix)).size, state.accounts.length, 'Managed state never duplicates a prefix');
    assert.equal(new Set(state.accounts.map(account => account.email)).size, state.accounts.length, 'Managed state never duplicates an email');
    assert.ok(rows.filter(row => row.prefix === 'conta-01' && !row.disabled).length <= 1, 'Old and new credentials are never enabled under the same prefix');
    for (const secret of ['access_token', 'refresh_token', 'synthetic-test-only']) assert.ok(!raw.includes(secret), 'Journal contains no credential material');
    assert.ok(rows.some(row => row.name === otherName && row.disabled === false && row.prefix === 'conta-02'), 'Unrelated credential remains exact');
    if (state.pending_oauth?.phase === 'importing') assert.equal(pool.acquire(accounts[0]), null, 'Importing account cannot admit another request');
  };
  return { runtimeDir, pool, makePool, management, oauth, accounts, rows, newName, invariant, observations: () => observations };
}

function crashAt(f, boundary, timing) {
  let crashed = false, triggered = false;
  const restores = [];
  const shouldCrash = stage => !triggered && stage === timing;
  const crash = () => { triggered = true; crashed = true; throw new SimulatedCrash(`${boundary}:${timing}`); };
  const wrap = (target, name, matches) => {
    const original = target[name]; restores.push(() => { target[name] = original; });
    target[name] = async (...args) => {
      if (crashed) throw new SimulatedCrash('The crashed bridge cannot perform more actions');
      const selected = matches(...args);
      if (selected && shouldCrash('before')) crash();
      const result = await original.apply(target, args);
      await f.invariant();
      if (selected && shouldCrash('after')) crash();
      return result;
    };
  };
  wrap(f.management, 'importCredential', () => boundary === 'import');
  wrap(f.management, 'setCredentialDisabled', (name, disabled) => boundary === 'disable-old' && name === oldName && disabled === true ||
    boundary === 'enable-new' && name === f.newName && disabled === false);
  wrap(f.management, 'patchCredential', name => boundary === 'patch-prefix' && name === f.newName);
  wrap(f.management, 'deleteCredential', name => boundary === 'delete-old' && name === oldName);
  wrap(f.oauth.manager, 'finish', () => boundary === 'finish');
  wrap(f.pool, 'saveState', next => boundary === 'commit' && next.pending_oauth?.phase === 'committed' || boundary === 'clear-journal' && next.pending_oauth === null);
  return { triggered: () => triggered, restore: () => restores.forEach(restore => restore()) };
}

const boundaries = ['import', 'disable-old', 'patch-prefix', 'enable-new', 'commit', 'delete-old', 'finish', 'clear-journal'];

for (const boundary of boundaries) for (const timing of ['before', 'after']) {
  test(`crash ${timing} ${boundary}: restart resumes the same import without duplicate credentials`, async t => {
    const f = await fixture(t), fault = crashAt(f, boundary, timing);
    await assert.rejects(f.pool.status(), SimulatedCrash); assert.equal(fault.triggered(), true); fault.restore();
    const restarted = f.makePool();
    const result = await restarted.status();
    assert.equal(result.connection, null);
    const state = await restarted.readState();
    assert.equal(state.accounts.find(account => account.email === email).name, f.newName);
    assert.equal(state.mode, 'fixed'); assert.equal(state.fixed_email, email);
    assert.deepEqual(state.priority_order, f.accounts.map(account => account.email));
    assert.equal(f.rows.length, 2); assert.equal(f.rows.find(row => row.name === f.newName).disabled, false);
    assert.ok(!f.rows.some(row => row.name === oldName));
    assert.deepEqual((await readdir(join(f.runtimeDir, 'auth'))).sort(), [f.newName, otherName].sort(), 'No orphan credential file remains after commit');
    assert.equal(f.oauth.events.filter(event => event === 'import').length, 1);
    assert.equal(f.oauth.latest.status, 'consumed');
    await restarted.status(); assert.equal(f.oauth.events.filter(event => event === 'import').length, 1);
    assert.ok(f.observations() > 0); await f.invariant();
  });
}

for (const boundary of boundaries) for (const timing of ['before', 'after']) {
  test(`crash ${timing} ${boundary}: cancellation rolls back only before the durable commit`, async t => {
    const f = await fixture(t), fault = crashAt(f, boundary, timing);
    await assert.rejects(f.pool.status(), SimulatedCrash); assert.equal(fault.triggered(), true); fault.restore();
    const interrupted = JSON.parse(await readFile(join(f.runtimeDir, 'accounts-state.json'), 'utf8'));
    const committed = interrupted.accounts.some(account => account.name === f.newName);
    const restarted = f.makePool(); await restarted.cancelConnection();
    const state = await restarted.readState(); assert.equal(state.pending_oauth, null);
    const expected = committed ? f.newName : oldName;
    assert.equal(state.accounts.find(account => account.email === email).name, expected);
    assert.equal(f.rows.length, 2); assert.equal(f.rows.find(row => row.name === expected).disabled, false);
    assert.ok(!f.rows.some(row => row.name === (committed ? oldName : f.newName)));
    assert.deepEqual((await readdir(join(f.runtimeDir, 'auth'))).sort(), [expected, otherName].sort(), 'Cleanup preserves exactly the committed or restored credential file');
    assert.equal(f.oauth.latest.status, committed ? 'consumed' : 'cancelled');
    assert.equal(f.oauth.events.filter(event => event === 'import').length, boundary === 'import' && timing === 'before' ? 0 : 1);
    const release = restarted.acquire(state.accounts.find(account => account.email === email)); assert.equal(typeof release, 'function'); release();
    await f.invariant();
  });
}

test('rollback restores the originally disabled account and presents its actual connection state', async t => {
  const f = await fixture(t, { disabled: true }), fault = crashAt(f, 'enable-new', 'after');
  await assert.rejects(f.pool.status(), SimulatedCrash); fault.restore();
  const restarted = f.makePool(); await restarted.cancelConnection();
  assert.equal(f.rows.find(row => row.name === oldName).disabled, true);
  const account = (await restarted.status()).accounts.find(account => account.email === email);
  assert.equal(account.connected, true); assert.equal(account.reason, 'disabled'); assert.equal(account.eligible, false);
});

test('different workspace loses automatic reset authority even when restart happens immediately after commit', async t => {
  const f = await fixture(t, { otherWorkspace: true }), state = await f.pool.readState();
  const old = (await f.pool.credentials(true)).find(row => row.name === oldName);
  await f.pool.saveState({ ...state, auto_reset_emails: [email], reset_journal: { [email]: {
    identity: f.pool.identity(old), key: 'synthetic-past-reset', status: 'succeeded', recovered: true,
  } }, revision: state.revision + 1 });
  const fault = crashAt(f, 'commit', 'after'); await assert.rejects(f.pool.status(), SimulatedCrash); fault.restore();
  const restarted = f.makePool(); await restarted.status();
  const recovered = await restarted.readState();
  assert.deepEqual(recovered.auto_reset_emails, []); assert.equal(recovered.reset_journal[email], undefined);
  assert.equal(f.oauth.events.filter(event => event === 'import').length, 1);
});

test('cancel queued while import is in flight waits for commit and cannot remove the committed replacement', async t => {
  const f = await fixture(t); let entered, release;
  const atImport = new Promise(resolve => { entered = resolve; });
  const continueImport = new Promise(resolve => { release = resolve; });
  const original = f.management.importCredential;
  f.management.importCredential = async (...args) => { await original(...args); entered(); await continueImport; };
  const poll = f.pool.status(); await atImport;
  const cancel = f.pool.cancelConnection();
  const waiting = await f.pool.readState(); assert.equal(waiting.pending_oauth.phase, 'importing');
  assert.equal(f.pool.acquire(f.accounts[0]), null);
  release(); await poll; await cancel;
  const final = await f.pool.readState(); assert.equal(final.pending_oauth, null);
  assert.equal(final.accounts.find(account => account.email === email).name, f.newName);
  assert.equal(f.rows.find(row => row.name === f.newName).disabled, false);
  assert.equal(f.oauth.events.filter(event => event === 'import').length, 1);
});
