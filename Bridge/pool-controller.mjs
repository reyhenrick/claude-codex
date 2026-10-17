import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join, basename } from 'node:path';

export class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function evaluateQuota(usage) {
  const groups = [{ name: 'Uso do Codex', value: usage?.rate_limit }];
  if (usage?.additional_rate_limits != null) {
    if (!Array.isArray(usage.additional_rate_limits)) return { eligible: false, reason: 'unknown', windows: [] };
    for (const item of usage.additional_rate_limits) {
      // Additional limits may be model-specific. Treat every returned limit conservatively.
      groups.push({ name: item.limit_name ?? item.name ?? 'Limite adicional', value: item.rate_limit });
    }
  }
  const windows = [];
  let exhausted = false;
  for (const { name, value } of groups) {
    if (!value || typeof value.allowed !== 'boolean' || typeof value.limit_reached !== 'boolean') {
      return { eligible: false, reason: 'unknown', windows };
    }
    const present = [value.primary_window, value.secondary_window].filter(w => w != null);
    if (!present.length) return { eligible: false, reason: 'unknown', windows };
    for (const w of present) {
      if (!Number.isFinite(w.used_percent) || w.used_percent < 0 || !Number.isFinite(w.limit_window_seconds) || w.limit_window_seconds <= 0) {
        return { eligible: false, reason: 'unknown', windows };
      }
      windows.push({ name, used_percent: w.used_percent, window_seconds: w.limit_window_seconds, reset_at: Number.isFinite(w.reset_at) ? w.reset_at : null });
      if (w.used_percent >= 100) exhausted = true;
    }
    if (!value.allowed || value.limit_reached) exhausted = true;
  }
  return { eligible: !exhausted, reason: exhausted ? 'exhausted' : 'available', windows };
}

export class ManagementClient {
  constructor({ runtimeDir, baseURL = 'http://127.0.0.1:18768', fetchImpl = fetch }) {
    this.runtimeDir = runtimeDir; this.baseURL = baseURL; this.fetch = fetchImpl;
  }
  async call(path, method = 'GET', body, signal) {
    const key = await readFile(join(this.runtimeDir, 'management.key'), 'utf8');
    const response = await this.fetch(`${this.baseURL}/v8/management/${path}`, {
      method, headers: { authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new BridgeError(503, 'O gerenciador local não respondeu.'); }
    return response.json();
  }
  async credentials() { return (await this.call('credentials')).files; }
  async quota(credential) {
    const body = {
      auth_index: credential.auth_index, method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage',
      header: { Authorization: 'Bearer $TOKEN$', 'Chatgpt-Account-Id': credential.account_id, 'User-Agent': 'codex-tui/0.154.0' },
    };
    let result = await this.call('requests/api-call', 'POST', body);
    if (result.status_code === 401) {
      // The manager owns refresh-token rotation. Never read or duplicate OAuth credentials here.
      await this.call('credentials/refresh', 'POST', { name: credential.name });
      result = await this.call('requests/api-call', 'POST', body);
    }
    if (result.status_code !== 200) throw new BridgeError(503, 'Não foi possível consultar o limite desta conta.');
    const usage = JSON.parse(result.body);
    if (usage.email !== credential.email || (usage.account_id && usage.account_id !== credential.account_id)) {
      throw new BridgeError(503, 'A consulta de limite retornou uma conta diferente.');
    }
    return usage;
  }
  async resetCooldown(credential) { await this.call('routing/cooldown/reset', 'POST', { auth_index: credential.auth_index }); }
  async startLogin() { return this.call('oauth/auth-url?provider=codex&is_webui=true'); }
  async loginStatus(state) { return this.call(`oauth/status?state=${encodeURIComponent(state)}`); }
  async cancelLogin(state) { return this.call(`oauth/session?state=${encodeURIComponent(state)}`, 'DELETE'); }
  async patchCredential(name, fields) { await this.call('credentials/fields', 'PATCH', { name, ...fields }); }
  async deleteCredential(name) { await this.call(`credentials?name=${encodeURIComponent(name)}`, 'DELETE'); }
}

export class PoolController {
  constructor({ runtimeDir, management = new ManagementClient({ runtimeDir }), now = Date.now }) {
    this.runtimeDir = runtimeDir; this.management = management; this.now = now;
    this.quotas = new Map(); this.inflight = new Map(); this.transientBlocks = new Map();
    this.lastUsed = null; this.writeQueue = Promise.resolve(); this.credentialCache = null;
    this.activeAccounts = new Map(); this.disconnecting = new Set(); this.removedAccounts = new Set();
  }
  async readState() {
    const state = JSON.parse(await readFile(join(this.runtimeDir, 'accounts-state.json'), 'utf8'));
    const emails = state.accounts?.map(a => a.email);
    if (!Array.isArray(emails) || new Set(emails).size !== emails.length ||
        !Array.isArray(state.priority_order) || state.priority_order.length !== emails.length ||
        new Set(state.priority_order).size !== emails.length || state.priority_order.some(e => !emails.includes(e)) ||
        new Set(state.accounts.map(a => a.prefix)).size !== emails.length ||
        state.accounts.some(a => !/^conta-\d{2,}$/.test(a.prefix) || typeof a.name !== 'string' || basename(a.name) !== a.name)) {
      throw new BridgeError(503, 'A lista de contas precisa ser revisada.');
    }
    const mode = state.mode ?? 'automatic';
    if (!['automatic', 'fixed'].includes(mode) || (mode === 'fixed' && !emails.includes(state.fixed_email))) {
      throw new BridgeError(503, 'A seleção de conta é inválida.');
    }
    return { ...state, mode, revision: state.revision ?? 0 };
  }
  async credentials(force = false) {
    if (!force && this.credentialCache && this.now() - this.credentialCache.at < 1000) return this.credentialCache.rows;
    const files = await this.management.credentials();
    if (!Array.isArray(files)) throw new BridgeError(503, 'O gerenciador não retornou a lista de contas.');
    const rows = files.filter(f => f.provider === 'codex').map(f => ({
      name: f.name, email: f.email, auth_index: f.auth_index, disabled: Boolean(f.disabled),
      unavailable: Boolean(f.unavailable), next_retry_after: f.next_retry_after,
      account_id: f.id_token?.chatgpt_account_id, plan: f.id_token?.plan_type,
      updated_at: f.updated_at ?? f.modtime,
    }));
    this.credentialCache = { at: this.now(), rows }; return rows;
  }
  async quota(credential) {
    if (this.inflight.has(credential.name)) return this.inflight.get(credential.name);
    const pending = (async () => {
      let snapshot;
      const previous = this.quotas.get(credential.email);
      try {
        if (credential.disabled || !credential.auth_index || !credential.account_id) {
          snapshot = { eligible: false, reason: credential.disabled ? 'disabled' : 'unknown', windows: [] };
        } else {
          snapshot = evaluateQuota(await this.management.quota(credential));
          if (snapshot.eligible && previous?.reason === 'exhausted' && credential.unavailable) {
            await this.management.resetCooldown(credential);
            credential.unavailable = false;
            this.credentialCache = null;
          }
        }
      } catch { snapshot = { eligible: false, reason: 'unknown', windows: [] }; }
      snapshot.checked_at = new Date(this.now()).toISOString();
      this.quotas.set(credential.email, snapshot); return snapshot;
    })();
    this.inflight.set(credential.name, pending);
    try { return await pending; } finally { this.inflight.delete(credential.name); }
  }
  async *candidates({ countOnly = false, signal } = {}) {
    const state = await this.readState();
    const credentials = await this.credentials();
    const order = state.mode === 'fixed' ? [state.fixed_email] : state.priority_order;
    for (const email of order) {
      signal?.throwIfAborted();
      const account = state.accounts.find(a => a.email === email);
      const credential = credentials.find(c => c.name === account.name && c.email === email);
      if (!credential || credential.disabled) continue;
      if (countOnly) { yield { ...account, credential }; continue; }
      const block = this.transientBlocks.get(email);
      if (block && block > this.now()) continue;
      const quota = await this.quota(credential);
      signal?.throwIfAborted();
      if (!quota.eligible) continue;
      if (credential.unavailable && Date.parse(credential.next_retry_after) > this.now()) continue;
      yield { ...account, credential };
    }
  }
  markUsed(account) { this.lastUsed = { email: account.email, at: new Date(this.now()).toISOString() }; }
  acquire(account) {
    if (this.disconnecting.has(account.email) || this.removedAccounts.has(account.email)) return null;
    this.activeAccounts.set(account.email, (this.activeAccounts.get(account.email) ?? 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; this.activeAccounts.set(account.email, Math.max(0, (this.activeAccounts.get(account.email) ?? 1) - 1)); } };
  }
  markUnavailable(account, status) {
    // A bounded backoff also covers an upstream 429 that has not reached the usage endpoint yet.
    this.transientBlocks.set(account.email, this.now() + 60000);
    this.quotas.set(account.email, { eligible: false, reason: status === 429 ? 'cooldown' : 'auth_error', windows: this.quotas.get(account.email)?.windows ?? [], checked_at: new Date(this.now()).toISOString() });
    this.credentialCache = null;
  }
  mutate(action) {
    const pending = this.writeQueue.then(action, action);
    this.writeQueue = pending.catch(() => {}); return pending;
  }
  async saveState(next) {
    const destination = join(this.runtimeDir, 'accounts-state.json');
    const temporary = join(this.runtimeDir, `accounts-state.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, destination); await chmod(destination, 0o600);
    return next;
  }
  update(input) {
    return this.mutate(async () => {
      const state = await this.readState();
      if (input.revision !== state.revision) throw new BridgeError(409, 'A configuração mudou. Atualize o painel e tente novamente.');
      const fields = Object.keys(input);
      if (fields.some(k => !['revision', 'mode', 'fixed_email', 'priority_order'].includes(k))) throw new BridgeError(400, 'Configuração desconhecida.');
      const next = { ...state, ...input, revision: state.revision + 1 };
      const emails = state.accounts.map(a => a.email);
      if (!['automatic', 'fixed'].includes(next.mode) ||
          (next.mode === 'fixed' && !emails.includes(next.fixed_email)) ||
          !Array.isArray(next.priority_order) || next.priority_order.length !== emails.length ||
          new Set(next.priority_order).size !== emails.length || next.priority_order.some(e => !emails.includes(e))) {
        throw new BridgeError(400, 'Selecione contas conectadas, sem repetir ou remover itens da ordem.');
      }
      return this.saveState(next);
    });
  }
  connect(email) {
    return this.mutate(async () => {
      if (typeof email === 'string') email = email.trim().toLowerCase();
      if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BridgeError(400, 'Informe o e-mail da conta.');
      const state = await this.readState();
      if (state.pending_oauth && !state.pending_oauth.error) throw new BridgeError(409, 'Conclua ou cancele a conexão que já está em andamento.');
      const before = await this.credentials(true);
      const login = await this.management.startLogin();
      const url = new URL(login.url);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' || typeof login.state !== 'string') throw new BridgeError(503, 'O endereço de autorização não é válido.');
      await this.saveState({ ...state, pending_oauth: { email, state: login.state, started_at: new Date(this.now()).toISOString(),
        previous_names: before.map(c => c.name), previous_versions: Object.fromEntries(before.map(c => [c.name, c.updated_at ?? null])) }, revision: state.revision + 1 });
      return { auth_url: login.url, email };
    });
  }
  cancelConnection() {
    return this.mutate(async () => {
      const state = await this.readState();
      if (state.pending_oauth) await this.management.cancelLogin(state.pending_oauth.state);
      await this.saveState({ ...state, pending_oauth: null, revision: state.revision + 1 });
    });
  }
  async pollConnection() {
    const initial = await this.readState();
    if (!initial.pending_oauth || initial.pending_oauth.error) return;
    return this.mutate(async () => {
      const state = await this.readState(); const pending = state.pending_oauth;
      if (!pending || pending.error) return;
      let status;
      try { status = await this.management.loginStatus(pending.state); } catch { return; }
      if (status.status === 'wait') return;
      const credentials = await this.credentials(true);
      const matches = credentials.filter(c => c.email?.toLowerCase() === pending.email);
      const recovered = status.status === 'error' && matches.length === 1 && !pending.previous_names.includes(matches[0].name);
      const fresh = matches.length === 1 && (!pending.previous_names.includes(matches[0].name) ||
        (matches[0].updated_at && matches[0].updated_at !== pending.previous_versions?.[matches[0].name]));
      if ((status.status !== 'ok' && !recovered) || !fresh) {
        const error = status.status === 'ok' ? `A autorização não corresponde a ${pending.email}. Conecte novamente escolhendo esse e-mail.` : 'A autorização expirou ou falhou. Inicie uma nova conexão.';
        await this.saveState({ ...state, pending_oauth: { ...pending, error }, revision: state.revision + 1 }); return;
      }
      const credential = matches[0];
      if (basename(credential.name) !== credential.name) throw new BridgeError(503, 'O arquivo da conta não é válido.');
      const existing = state.accounts.find(a => a.email.toLowerCase() === pending.email);
      const nextIndex = Math.max(0, ...state.accounts.map(a => Number(a.prefix.slice(6)))) + 1;
      const prefix = existing?.prefix ?? `conta-${String(nextIndex).padStart(2, '0')}`;
      await this.management.patchCredential(credential.name, { prefix, priority: existing ? 1000 - state.priority_order.indexOf(existing.email) * 100 : 0 });
      await chmod(join(this.runtimeDir, 'auth', credential.name), 0o600);
      const account = { email: credential.email, name: credential.name, prefix, plan: credential.plan };
      const accounts = state.accounts.filter(a => a.email !== existing?.email).concat(account);
      const order = existing ? state.priority_order.map(e => e === existing.email ? credential.email : e) : [...state.priority_order, credential.email];
      await this.saveState({ ...state, accounts, priority_order: order, fixed_email: state.fixed_email === existing?.email ? credential.email : state.fixed_email,
        pending_oauth: null, revision: state.revision + 1, last_connection: { email: credential.email, at: new Date(this.now()).toISOString() } });
      this.removedAccounts.delete(credential.email);
      this.credentialCache = null;
    });
  }
  disconnect(email) {
    return this.mutate(async () => {
      const state = await this.readState();
      const account = state.accounts.find(a => a.email === email);
      if (!account) throw new BridgeError(404, 'Conta não encontrada.');
      if ((this.activeAccounts.get(email) ?? 0) > 0) throw new BridgeError(409, 'Esta conta tem solicitações em andamento. Aguarde a conclusão para desconectar.');
      if (state.pending_oauth?.email === email) throw new BridgeError(409, 'Cancele a autorização em andamento antes de desconectar.');
      this.disconnecting.add(email);
      try {
        const credentials = await this.credentials(true);
        if (credentials.some(c => c.name === account.name && c.email === email)) await this.management.deleteCredential(account.name);
        const accounts = state.accounts.filter(a => a.email !== email);
        const priority_order = state.priority_order.filter(e => e !== email);
        await this.saveState({ ...state, accounts, priority_order, mode: state.fixed_email === email ? 'automatic' : state.mode,
          fixed_email: state.fixed_email === email ? null : state.fixed_email, revision: state.revision + 1 });
        this.removedAccounts.add(email);
        this.quotas.delete(email); this.transientBlocks.delete(email); this.credentialCache = null;
        if (this.lastUsed?.email === email) this.lastUsed = null;
      } finally { this.disconnecting.delete(email); }
    });
  }
  async status(refresh = false) {
    await this.pollConnection();
    const state = await this.readState();
    const credentials = await this.credentials(refresh);
    if (refresh) await Promise.all(state.accounts.map(async a => {
      const credential = credentials.find(c => c.name === a.name && c.email === a.email);
      if (credential) await this.quota(credential);
    }));
    return {
      mode: state.mode, fixed_email: state.fixed_email ?? null, priority_order: state.priority_order,
      revision: state.revision, last_used: this.lastUsed,
      connection: state.pending_oauth ? { email: state.pending_oauth.email, started_at: state.pending_oauth.started_at, error: state.pending_oauth.error ?? null } : null,
      last_connection: state.last_connection ?? null,
      accounts: state.priority_order.map(email => {
        const account = state.accounts.find(a => a.email === email);
        const credential = credentials.find(c => c.name === account.name && c.email === email);
        const quota = this.quotas.get(email) ?? { eligible: false, reason: 'unchecked', windows: [] };
        const cooldown = (this.transientBlocks.get(email) ?? 0) > this.now() ||
          (credential?.unavailable && Date.parse(credential.next_retry_after) > this.now());
        return { email, plan: credential?.plan ?? account.plan, connected: Boolean(credential), active_requests: this.activeAccounts.get(email) ?? 0, ...quota,
          eligible: Boolean(credential && !credential.disabled && quota.eligible && !cooldown),
          reason: !credential ? 'disconnected' : credential.disabled ? 'disabled' : cooldown ? 'cooldown' : quota.reason };
      }),
    };
  }
}
