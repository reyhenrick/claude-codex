import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError } from './pool-controller.mjs';

const messages = {
  'oauth.account_mismatch': 'A autorização não corresponde ao e-mail informado. Conecte novamente escolhendo essa conta.',
  'oauth.expired': 'A autorização expirou ou falhou. Inicie uma nova conexão.',
  'oauth.import_failed': 'Não foi possível concluir a conexão. Cancele esta tentativa para restaurar a conta anterior.',
  'oauth.reconnect_busy': 'A reconexão aguarda as solicitações desta conta terminarem.',
  'oauth.session_unavailable': 'Não foi possível iniciar a autorização. Cancele esta tentativa e tente novamente.',
};
const subject = id => typeof id === 'string' ? createHash('sha256').update(id).digest('hex') : null;
const failure = code => Object.hasOwn(messages, code) ? code : 'oauth.import_failed';
const validID = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export function connectionURL(raw) {
  try {
    const url = new URL(raw);
    return url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/authorize' && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

// Serialized by PoolController.mutate. The journal contains no OAuth tokens.
// Every import has a new owned filename, making replay and rollback idempotent.
export class AccountConnections {
  constructor(pool, sessions) { this.pool = pool; this.sessions = sessions; }
  async save(state, pending, extra = {}) {
    return this.pool.saveState({ ...state, ...extra, pending_oauth: pending, revision: state.revision + 1 });
  }
  async fail(state, code) {
    code = failure(code);
    return this.save(state, { ...state.pending_oauth, error_code: code, error: messages[code] });
  }
  async connect(email) {
    const pool = this.pool;
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BridgeError(400, 'Informe o e-mail da conta.');
    let state = await pool.readState();
    if (state.pending_oauth) throw new BridgeError(409, 'Conclua ou cancele a conexão que já está em andamento.');
    const reset = state.reset_journal[email];
    if (pool.resetInFlight.has(email) || (reset && ['pending', 'uncertain'].includes(reset.status))) throw new BridgeError(409, 'Confirme o reset pendente antes de reconectar esta conta.');
    const session = await this.sessions.create({ email });
    if (!validID(session.id) || session.email !== email) throw new BridgeError(503, messages['oauth.session_unavailable']);
    try {
      state = await this.save(state, { email, broker_id: session.id, started_at: session.started_at, expires_at: session.expires_at, phase: 'authorizing' });
    } catch (error) { await this.sessions.cancel(session.id).catch(() => {}); throw error; }
    try {
      const result = await this.sessions.start(session.id);
      const url = connectionURL(result.auth_url);
      if (result.status !== 'pending' || !url) {
        await this.fail(state, result.error_code ?? 'oauth.session_unavailable');
        throw new BridgeError(503, messages['oauth.session_unavailable']);
      }
      await this.save(state, { ...state.pending_oauth, url });
      return { auth_url: url, email };
    } catch (error) {
      state = await pool.readState();
      if (!state.pending_oauth.error_code) await this.fail(state, error.code ?? 'oauth.session_unavailable');
      throw new BridgeError(503, messages['oauth.session_unavailable']);
    }
  }
  async cancel() {
    let state = await this.pool.readState();
    const pending = state.pending_oauth;
    if (!pending) return;
    if (pending.phase === 'committed') { await this.cleanup(state); return; }
    if (pending.import) {
      const journal = this.journal(pending);
      const rows = await this.pool.credentials(true);
      const imported = rows.find(row => row.name === journal.name);
      if (imported) {
        if (imported.email?.toLowerCase() !== pending.email) throw new BridgeError(503, messages['oauth.import_failed']);
        await this.pool.management.setCredentialDisabled(journal.name, true);
        await this.pool.management.deleteCredential(journal.name);
      }
      const previous = rows.find(row => row.name === journal.old_name);
      if (previous) {
        if (this.pool.identity(previous) !== journal.old_identity) throw new BridgeError(503, messages['oauth.import_failed']);
        await this.pool.management.setCredentialDisabled(previous.name, journal.old_disabled);
      }
      this.invalidate(pending);
    }
    if (pending.broker_id) await this.sessions.cancel(pending.broker_id);
    else if (pending.state) await this.pool.management.cancelLogin(pending.state);
    state = await this.pool.readState();
    await this.save(state, null);
  }
  journal(pending) {
    const j = pending.import;
    if (!validID(pending.broker_id) || !j || j.name !== `claude-codex-${pending.broker_id}.json` ||
      !/^conta-\d{2,}$/.test(j.prefix) || (j.old_name && (typeof j.old_identity !== 'string' || typeof j.old_disabled !== 'boolean'))) {
      throw new BridgeError(503, messages['oauth.import_failed']);
    }
    return j;
  }
  invalidate(pending) {
    const pool = this.pool;
    for (const name of [pending.import?.name, pending.import?.old_name].filter(Boolean)) {
      pool.invalidateCapabilities(name); pool.invalidateQuota({ name, email: pending.email });
    }
    pool.credentialCache = null; pool.transientBlocks.delete(pending.email);
  }
  async cleanup(state) {
    const pending = state.pending_oauth, j = this.journal(pending), pool = this.pool;
    const current = state.accounts.find(row => row.email === pending.email && row.name === j.name);
    if (!current) throw new BridgeError(503, messages['oauth.import_failed']);
    if (j.old_name && j.old_name !== j.name) {
      const old = (await pool.credentials(true)).find(row => row.name === j.old_name);
      if (old) {
        if (pool.identity(old) !== j.old_identity) throw new BridgeError(503, messages['oauth.import_failed']);
        await pool.management.deleteCredential(j.old_name);
      }
    }
    await this.sessions.finish(pending.broker_id);
    this.invalidate(pending);
    pool.removedAccounts.delete(pending.email);
    await this.save(state, null);
  }
  async poll() {
    let state = await this.pool.readState(), pending = state.pending_oauth;
    if (!pending) return;
    if (pending.phase === 'committed') {
      try { await this.cleanup(state); } catch { await this.fail(await this.pool.readState(), 'oauth.import_failed'); }
      return;
    }
    if (pending.error_code && pending.error_code !== 'oauth.reconnect_busy') return;
    if (!validID(pending.broker_id)) { await this.fail(state, 'oauth.expired'); return; }
    let session;
    try { session = await this.sessions.recover(pending.broker_id); }
    catch { await this.fail(state, 'oauth.session_unavailable'); return; }
    if (session.email !== pending.email) { await this.fail(state, 'oauth.account_mismatch'); return; }
    if (['created', 'starting', 'pending'].includes(session.status)) return;
    if (session.status !== 'ready') { await this.fail(state, session.error_code ?? 'oauth.expired'); return; }
    const pool = this.pool;
    try {
      if (!pending.import) {
        const existing = state.accounts.find(row => row.email.toLowerCase() === pending.email);
        const old = existing && (await pool.credentials(true)).find(row => row.name === existing.name && row.email.toLowerCase() === pending.email);
        const nextIndex = Math.max(0, ...state.accounts.map(row => Number(row.prefix.slice(6)))) + 1;
        pending = { ...pending, phase: 'importing', import: {
          name: `claude-codex-${pending.broker_id}.json`, prefix: existing?.prefix ?? `conta-${String(nextIndex).padStart(2, '0')}`,
          old_name: existing?.name ?? null, old_identity: old ? pool.identity(old) : null, old_subject: subject(old?.account_id), old_disabled: old?.disabled ?? false,
        } };
        // A missing previous credential needs no rollback; retain its metadata
        // filename for eventual cleanup, but never mutate an unverified record.
        if (pending.import.old_name && !old) pending.import.old_name = null;
        state = await this.save(state, pending);
      }
      const j = this.journal(pending);
      if ((pool.activeAccounts.get(pending.email) ?? 0) > 0 || pool.resetInFlight.has(pending.email)) {
        if (pending.error_code !== 'oauth.reconnect_busy') await this.fail(state, 'oauth.reconnect_busy');
        return;
      }
      await this.sessions.withValidatedCredential(pending.broker_id, { expectedEmail: pending.email }, async credential => {
        if (credential.email !== pending.email) throw new BridgeError(503, messages['oauth.account_mismatch']);
        let rows = await pool.credentials(true), imported = rows.find(row => row.name === j.name);
        if (!imported) {
          let content;
          try {
            const value = JSON.parse(credential.content.toString('utf8'));
            content = Buffer.from(JSON.stringify({ ...value, email: pending.email, disabled: true, prefix: `pending-${pending.broker_id}` }));
            await pool.management.importCredential(j.name, content);
          } finally { content?.fill(0); }
          rows = await pool.credentials(true); imported = rows.find(row => row.name === j.name);
        }
        if (!imported || imported.email.toLowerCase() !== pending.email || imported.account_id !== credential.account_id) throw new BridgeError(503, messages['oauth.import_failed']);
        await chmod(join(pool.runtimeDir, 'auth', j.name), 0o600);
        const old = rows.find(row => row.name === j.old_name);
        if (old) {
          if (pool.identity(old) !== j.old_identity) throw new BridgeError(503, messages['oauth.import_failed']);
          await pool.management.setCredentialDisabled(old.name, true);
        }
        const index = state.priority_order.indexOf(pending.email);
        await pool.management.patchCredential(j.name, { prefix: j.prefix, priority: index < 0 ? 0 : 1000 - index * 100 });
        await pool.management.setCredentialDisabled(j.name, false);
        const activated = (await pool.credentials(true)).find(row => row.name === j.name);
        if (!activated || activated.disabled || activated.email.toLowerCase() !== pending.email || activated.account_id !== credential.account_id || activated.prefix !== j.prefix) throw new BridgeError(503, messages['oauth.import_failed']);
        const account = { email: pending.email, name: j.name, prefix: j.prefix, plan: credential.plan };
        const accounts = state.accounts.filter(row => row.email !== pending.email).concat(account);
        const order = index < 0 ? [...state.priority_order, pending.email] : state.priority_order;
        pending = { ...pending, phase: 'committed', error_code: null, error: null, url: null };
        const sameIdentity = j.old_subject === subject(credential.account_id);
        const reset_journal = { ...state.reset_journal }, previousReset = reset_journal[pending.email];
        if (!sameIdentity || (previousReset && previousReset.identity !== j.old_identity)) delete reset_journal[pending.email];
        else if (previousReset) reset_journal[pending.email] = { ...previousReset, identity: pool.identity(activated) };
        state = await this.save(state, pending, { accounts, priority_order: order, reset_journal,
          auto_reset_emails: sameIdentity ? state.auto_reset_emails : state.auto_reset_emails.filter(email => email !== pending.email),
          last_connection: { email: pending.email, at: new Date(pool.now()).toISOString() } });
        this.invalidate(pending);
      });
      await this.cleanup(state);
    } catch (error) {
      await this.fail(await pool.readState(), error.code ?? 'oauth.import_failed');
    }
  }
}
