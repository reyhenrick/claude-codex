import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenUsageStore, localUsageDay } from './token-usage.mjs';

const receipt = { input_tokens: 120, output_tokens: 30, cache_read_tokens: 900, cache_write_tokens: 50 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'claude-token-test-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const now = () => new Date(2026, 9, 25, 12);
  const store = await TokenUsageStore.load({ runtimeDir, now, ...options });
  t.after(() => store.flush());
  return { runtimeDir, store, path: join(runtimeDir, 'token-usage.json'), now };
}

test('confirmed categories stay disjoint, unknown requests remain explicit and aggregates survive restart', async t => {
  const f = await fixture(t);
  f.store.record(receipt); f.store.record(null); f.store.record(receipt); await f.store.flush();
  const view = f.store.snapshot();
  assert.equal(view.today.input_tokens, 240); assert.equal(view.today.output_tokens, 60);
  assert.equal(view.today.cache_tokens, 1900); assert.equal(view.total.total_tokens, 2200);
  assert.equal(view.total.requests, 2); assert.equal(view.total.unreported_requests, 1);
  assert.equal(view.available, true); assert.equal(view.persisted, true);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const restored = await TokenUsageStore.load({ runtimeDir: f.runtimeDir, now: f.now });
  assert.deepEqual(restored.snapshot(), view);
  const saved = await readFile(f.path, 'utf8'); assert.ok(!/email|prompt|credential|response|account/.test(saved));
});

test('today follows local midnight while accumulated totals survive retention and clock rollback', async t => {
  let date = new Date(2026, 9, 25, 23, 59), now = () => date;
  const f = await fixture(t, { now }); f.store.record(receipt);
  date = new Date(2026, 9, 26, 0, 1);
  assert.equal(f.store.snapshot().today.total_tokens, 0); assert.equal(f.store.snapshot().total.total_tokens, 1100);
  f.store.record(receipt); date = new Date(2026, 9, 25, 23, 58); f.store.record(receipt);
  assert.equal(f.store.snapshot().today.total_tokens, 2200);
  for (let day = 27; day < 67; day++) { date = new Date(2026, 9, day, 12); f.store.record(receipt); }
  await f.store.flush(); const saved = JSON.parse(await readFile(f.path));
  assert.equal(Object.keys(saved.days).length, 32); assert.equal(saved.total.requests, 43);
  date = new Date(2025, 0, 1, 12); f.store.record(receipt); await f.store.flush();
  assert.equal(f.store.snapshot().today.requests, 1, 'A newly current day is retained after a large clock correction');
  assert.equal(f.store.snapshot().total.requests, 44);
  assert.equal(Object.keys(JSON.parse(await readFile(f.path)).days).length, 32);
  assert.equal(localUsageDay(new Date(2026, 0, 2)), '2026-01-02');
});

test('coalesced writes and a receipt arriving during persistence retain every increment', async t => {
  const gate = deferred(), entered = deferred(), saved = []; let writes = 0;
  const f = await fixture(t, { write: async (_path, value) => {
    writes++; if (writes === 2) { entered.resolve(); await gate.promise; }
    saved.push(structuredClone(value));
  } });
  f.store.record(receipt); const flushing = f.store.flush(); await entered.promise;
  for (let index = 0; index < 20; index++) f.store.record(receipt);
  const second = f.store.flush(); gate.resolve(); assert.equal(await flushing, true); assert.equal(await second, true);
  assert.equal(saved.at(-1).total.requests, 21); assert.equal(saved.at(-1).total.input_tokens, 2520);
  assert.equal(writes, 3);
});

test('failed persistence retains dirty counters and a retry writes them exactly once', async t => {
  let fail = false, saved;
  const f = await fixture(t, { write: async (_path, value) => { if (fail) throw Error('synthetic write failure'); saved = structuredClone(value); } });
  fail = true; f.store.record(receipt); assert.equal(await f.store.flush(), false);
  assert.equal(f.store.snapshot().available, true); assert.equal(f.store.snapshot().persisted, false);
  fail = false; assert.equal(await f.store.flush(), true); assert.equal(saved.total.requests, 1);
  assert.equal(f.store.snapshot().persisted, true);
});

test('invalid receipts cannot enter the aggregate and overflow makes accounting unavailable', async t => {
  const f = await fixture(t);
  for (const value of [-1, 0.1, '5', NaN, Infinity, undefined, Number.MAX_SAFE_INTEGER + 1]) f.store.record({ ...receipt, input_tokens: value });
  assert.equal(f.store.snapshot().total.requests, 0);
  f.store.record({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  f.store.record(receipt); assert.equal(f.store.snapshot().available, false);
});

test('malformed or unsafe ledgers stay unavailable and are never overwritten', async t => {
  for (const kind of ['invalid-json', 'bad-version', 'bad-totals', 'bad-day', 'overflow', 'oversized', 'symlink', 'hardlink', 'permissions']) await t.test(kind, async t => {
    const f = await fixture(t), original = JSON.parse(await readFile(f.path));
    if (kind === 'invalid-json') await writeFile(f.path, '{');
    if (kind === 'bad-version') { original.version = 2; await writeFile(f.path, JSON.stringify(original)); }
    if (kind === 'bad-totals') { original.total.input_tokens = -1; await writeFile(f.path, JSON.stringify(original)); }
    if (kind === 'bad-day') { original.days['2026-02-30'] = original.total; await writeFile(f.path, JSON.stringify(original)); }
    if (kind === 'overflow') { original.total.input_tokens = Number.MAX_SAFE_INTEGER; original.total.output_tokens = 1; await writeFile(f.path, JSON.stringify(original)); }
    if (kind === 'oversized') await writeFile(f.path, ' '.repeat(32769));
    if (kind === 'symlink' || kind === 'hardlink') {
      const outside = join(f.runtimeDir, 'preserved.json'); await writeFile(outside, JSON.stringify(original), { mode: 0o600 });
      await rm(f.path); await (kind === 'symlink' ? symlink(outside, f.path) : link(outside, f.path));
    }
    if (kind === 'permissions') await chmod(f.path, 0o644);
    const before = await readFile(f.path);
    const loaded = await TokenUsageStore.load({ runtimeDir: f.runtimeDir, now: f.now });
    assert.equal(loaded.snapshot().available, false); loaded.record(receipt); assert.equal(await loaded.flush(), false);
    assert.deepEqual(await readFile(f.path), before);
  });
});
