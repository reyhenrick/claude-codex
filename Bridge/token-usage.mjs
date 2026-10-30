import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const fields = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'requests', 'unreported_requests'];
const empty = () => Object.fromEntries(fields.map(key => [key, 0]));
const count = value => Number.isSafeInteger(value) && value >= 0;
const validTotals = value => value && fields.every(key => count(value[key])) &&
  Number.isSafeInteger(value.input_tokens + value.output_tokens + value.cache_read_tokens + value.cache_write_tokens);
const copyTotals = value => Object.fromEntries(fields.map(key => [key, value[key]]));
const present = value => ({ ...value, cache_tokens: value.cache_read_tokens + value.cache_write_tokens,
  total_tokens: value.input_tokens + value.output_tokens + value.cache_read_tokens + value.cache_write_tokens });
export const localUsageDay = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const safeDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function readLedger(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 32768) throw new Error('Unsafe usage ledger.');
    const bytes = await handle.readFile(), current = await lstat(path);
    if (!sameFile(info, current) || info.size !== bytes.length || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw new Error('Usage ledger changed.');
    const value = JSON.parse(bytes);
    if (value.version !== 1 || !safeDate(value.started_at) || !validTotals(value.total) || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) ||
      Object.keys(value.days).length > 32) throw new Error('Invalid usage ledger.');
    const days = {};
    for (const [day, totals] of Object.entries(value.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !safeDate(day) || new Date(day).toISOString().slice(0, 10) !== day || !validTotals(totals)) throw new Error('Invalid usage day.');
      days[day] = copyTotals(totals);
    }
    for (const key of fields) if (Object.values(days).reduce((sum, row) => sum + row[key], 0) > value.total[key]) throw new Error('Invalid usage aggregate.');
    return { version: 1, started_at: value.started_at, total: copyTotals(value.total), days };
  } finally { await handle.close(); }
}

async function writeLedger(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// One owner, protected by the service's existing process lock. Store numeric
// aggregates only: no account IDs, prompts, request bodies or credentials.
export class TokenUsageStore {
  static async load({ runtimeDir, now = () => new Date(), write = writeLedger } = {}) {
    const store = new TokenUsageStore(join(runtimeDir, 'token-usage.json'), now, write);
    try { store.data = await readLedger(store.path); }
    catch (error) {
      if (error.code !== 'ENOENT') return store;
      store.data = { version: 1, started_at: now().toISOString(), total: empty(), days: {} };
      store.revision = 1;
    }
    store.available = true;
    await store.flush();
    return store;
  }
  constructor(path, now, write) {
    this.path = path; this.now = now; this.write = write; this.available = false;
    this.data = null; this.revision = 0; this.savedRevision = 0; this.writeFailed = false; this.timer = null; this.writing = null;
  }
  record(receipt) {
    if (!this.available) return;
    const increment = receipt === null ? { ...empty(), unreported_requests: 1 } : { ...receipt, requests: 1, unreported_requests: 0 };
    if (!validTotals(increment)) return;
    const day = localUsageDay(this.now()), previous = this.data.days[day] ?? empty();
    const add = totals => Object.fromEntries(fields.map(key => [key, totals[key] + increment[key]]));
    const total = add(this.data.total), daily = add(previous);
    if (!validTotals(total) || !validTotals(daily)) { this.available = false; return; }
    this.data.total = total; this.data.days[day] = daily;
    const obsolete = Object.keys(this.data.days).filter(key => key !== day).sort();
    while (Object.keys(this.data.days).length > 32) delete this.data.days[obsolete.shift()];
    this.revision++;
    this.onChange?.();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 250);
      this.timer.unref();
    }
  }
  snapshot() {
    return { available: this.available, persisted: this.available && !this.writeFailed,
      started_at: this.data?.started_at ?? null, today_date: localUsageDay(this.now()),
      today: present(this.data?.days[localUsageDay(this.now())] ?? empty()), total: present(this.data?.total ?? empty()) };
  }
  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.available) return false;
    if (this.writing) { await this.writing; if (this.writeFailed) return false; return this.flush(); }
    this.writing = (async () => {
      while (this.savedRevision < this.revision) {
        const revision = this.revision, value = structuredClone(this.data);
        try { await this.write(this.path, value); }
        catch { this.writeFailed = true; this.onChange?.(); return false; }
        this.savedRevision = revision;
        const recovered = this.writeFailed; this.writeFailed = false;
        if (recovered) this.onChange?.();
      }
      return true;
    })();
    try { return await this.writing; } finally { this.writing = null; }
  }
}
