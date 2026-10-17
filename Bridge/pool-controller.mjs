import { readFile, writeFile, rename, chmod, open, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { evaluateQuota, unknownQuota, creditPermission } from './quota-state.mjs';
import { models, resolveModelVariant, supportedModelIds } from './model-catalog.mjs';
export { evaluateQuota } from './quota-state.mjs';
export const capabilityTTL = 60000;

export class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
  async models(credential) {
    const request = {
      auth_index: credential.auth_index, method: 'GET', url: 'https://chatgpt.com/backend-api/codex/models?client_version=0.162.0-alpha.17.2',
      header: { Authorization: 'Bearer $TOKEN$', 'Chatgpt-Account-Id': credential.account_id, Originator: 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/0.162.0-alpha.17.2 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9', Accept: 'application/json' },
    };
    let result = await this.call('requests/api-call', 'POST', request);
    if (result.status_code === 401) {
      await this.call('credentials/refresh', 'POST', { name: credential.name });
      result = await this.call('requests/api-call', 'POST', request);
    }
    if (result.status_code !== 200) throw new BridgeError(503, 'A OpenAI não confirmou os modelos desta conta.');
    let value;
    try { value = JSON.parse(result.body); } catch { throw new BridgeError(503, 'A lista de modelos desta conta é inválida.'); }
    if (!value || !Array.isArray(value.models)) throw new BridgeError(503, 'A lista de modelos desta conta é inválida.');
    return value;
  }
  async accountCall(credential, path, method = 'GET', data) {
    const body = {
      auth_index: credential.auth_index, method, url: `https://chatgpt.com/backend-api/wham/${path}`,
      header: { Authorization: 'Bearer $TOKEN$', 'Chatgpt-Account-Id': credential.account_id, 'User-Agent': 'codex-tui/0.154.0', 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    };
    let result = await this.call('requests/api-call', 'POST', body);
    if (result.status_code === 401) {
      await this.call('credentials/refresh', 'POST', { name: credential.name });
      result = await this.call('requests/api-call', 'POST', body);
    }
    if (result.status_code !== 200) throw new BridgeError(503, 'A OpenAI não confirmou a operação desta conta.');
    try { return JSON.parse(result.body); } catch { throw new BridgeError(503, 'A OpenAI retornou uma resposta inválida.'); }
  }
  async quota(credential) {
    const usage = await this.accountCall(credential, 'usage');
    if (usage.email !== credential.email || (usage.account_id && usage.account_id !== credential.account_id)) {
      throw new BridgeError(503, 'A consulta de limite retornou uma conta diferente.');
    }
    return usage;
  }
  async consumeReset(credential, idempotencyKey) {
    const result = await this.accountCall(credential, 'rate-limit-reset-credits/consume', 'POST', { redeem_request_id: idempotencyKey });
    if (!['reset', 'already_redeemed', 'no_credit', 'nothing_to_reset'].includes(result?.code)) throw new BridgeError(503, 'Não foi possível confirmar o resultado do reset.');
    return result.code;
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
    this.quotaMetadata = new WeakMap(); this.resetBarriers = new Map(); this.rememberedRevision = -1; this.rememberedCredits = false;
    this.quotaEpochs = new Map(); this.resetInFlight = new Map(); this.lastAutomaticRun = null;
    this.activeAccounts = new Map(); this.disconnecting = new Set(); this.removedAccounts = new Set();
    this.capabilityCache = new Map(); this.capabilityInflight = new Map(); this.capabilityEpochs = new Map(); this.capabilityIdentities = new Map();
    this.credentialReadSequence = 0; this.credentialPending = null;
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
    const allow_extra_credits = state.allow_extra_credits ?? false;
    const auto_reset_emails = state.auto_reset_emails ?? [];
    if (typeof allow_extra_credits !== 'boolean' || !Array.isArray(auto_reset_emails) || new Set(auto_reset_emails).size !== auto_reset_emails.length || auto_reset_emails.some(e => !emails.includes(e))) throw new BridgeError(503, 'As preferências de consumo precisam ser revisadas.');
    const update_draining = state.update_draining ?? false;
    if (typeof update_draining !== 'boolean') throw new BridgeError(503, 'O estado de atualização precisa ser revisado.');
    const next = { ...state, mode, revision: state.revision ?? 0, allow_extra_credits, auto_reset_emails, update_draining, reset_journal: state.reset_journal ?? {} };
    this.rememberState(next); return next;
  }
  rememberState(state) {
    if (state.revision < this.rememberedRevision) return;
    this.rememberedRevision = state.revision; this.rememberedCredits = state.allow_extra_credits ?? false;
    this.rememberedSelection = this.selectionIdentity(state);
    this.resetBarriers = new Map(Object.entries(state.reset_journal ?? {}).map(([email, op]) => [email,
      ['pending', 'uncertain'].includes(op.status) ? `pending:${op.key}` : op.key]));
  }
  selectionIdentity(state) {
    return createHash('sha256').update(JSON.stringify([state.mode, state.fixed_email ?? null, state.priority_order,
      state.accounts.map(account => [account.email, account.name, account.prefix])])).digest('hex');
  }
  async credentials(force = false) {
    if (!force && this.credentialCache && this.now() - this.credentialCache.at < 1000) return this.credentialCache.rows;
    const sequence = ++this.credentialReadSequence;
    const pending = (async () => {
      const files = await this.management.credentials();
      if (sequence !== this.credentialReadSequence) {
        if (this.credentialPending) return this.credentialPending;
        if (this.credentialCache?.sequence === this.credentialReadSequence) return this.credentialCache.rows;
        throw new BridgeError(503, 'A lista atual de contas não pôde ser confirmada.');
      }
      if (!Array.isArray(files)) throw new BridgeError(503, 'O gerenciador não retornou a lista de contas.');
      const rows = files.filter(f => f.provider === 'codex').map(f => ({
        name: f.name, email: f.email, auth_index: f.auth_index, disabled: Boolean(f.disabled),
        unavailable: Boolean(f.unavailable), next_retry_after: f.next_retry_after,
        account_id: f.id_token?.chatgpt_account_id, plan: f.id_token?.plan_type,
        updated_at: f.updated_at ?? f.modtime,
      }));
      const identities = new Map(rows.map(credential => [credential.name, this.capabilityIdentity(credential)]));
      for (const [name, identity] of this.capabilityIdentities) if (identities.get(name) !== identity) this.invalidateCapabilities(name);
      this.capabilityIdentities = identities;
      this.credentialCache = { at: this.now(), rows, sequence }; return rows;
    })();
    this.credentialPending = pending;
    try { return await pending; } finally { if (this.credentialPending === pending) this.credentialPending = null; }
  }
  capabilityIdentity(credential) {
    return createHash('sha256').update(JSON.stringify([credential.name, credential.email, credential.account_id, credential.auth_index, credential.updated_at, credential.disabled])).digest('hex');
  }
  invalidateCapabilities(name) {
    this.capabilityEpochs.set(name, (this.capabilityEpochs.get(name) ?? 0) + 1);
    this.capabilityCache.delete(name); this.capabilityInflight.delete(name);
  }
  capabilityCurrent(snapshot, credential) {
    const age = snapshot ? this.now() - snapshot.checkedAt : Infinity;
    return Boolean(snapshot && credential && !credential.disabled && !this.removedAccounts.has(credential.email) &&
      snapshot.identity === this.capabilityIdentity(credential) && this.capabilityIdentities.get(credential.name) === snapshot.identity &&
      snapshot.epoch === (this.capabilityEpochs.get(credential.name) ?? 0) && age >= 0 && age < capabilityTTL);
  }
  async capabilities(credential, { force = false } = {}) {
    if (force) this.invalidateCapabilities(credential.name);
    const identity = this.capabilityIdentity(credential), epoch = this.capabilityEpochs.get(credential.name) ?? 0;
    const cached = this.capabilityCache.get(credential.name);
    if (this.capabilityCurrent(cached, credential)) return cached;
    const inflight = this.capabilityInflight.get(credential.name);
    if (inflight?.identity === identity && inflight.epoch === epoch) return inflight.promise;
    const pending = (async () => {
      let ids = [];
      const checkedAt = this.now();
      if (!credential.disabled && credential.account_id && credential.auth_index && this.capabilityIdentities.get(credential.name) === identity) {
        try { ids = supportedModelIds(await this.management.models(credential)); } catch {}
      }
      const snapshot = Object.freeze({ identity, epoch, checkedAt, ids: Object.freeze(ids) });
      if (this.capabilityCurrent(snapshot, credential)) this.capabilityCache.set(credential.name, snapshot);
      return snapshot;
    })();
    const entry = { identity, epoch, promise: pending };
    this.capabilityInflight.set(credential.name, entry);
    try { return await pending; } finally { if (this.capabilityInflight.get(credential.name) === entry) this.capabilityInflight.delete(credential.name); }
  }
  async availableModels({ force = false } = {}) {
    const state = await this.readState(), credentials = await this.credentials(force);
    const order = state.mode === 'fixed' ? [state.fixed_email] : state.priority_order;
    const snapshots = await Promise.all(order.map(async email => {
      const account = state.accounts.find(account => account.email === email);
      const credential = credentials.find(credential => credential.email === email && credential.name === account.name);
      if (!credential || credential.disabled) return null;
      const snapshot = await this.capabilities(credential, { force });
      return { snapshot, credential };
    }));
    const current = await this.readState();
    if (current.revision !== state.revision) return [];
    const supported = new Set(snapshots.flatMap(row => row && this.capabilityCurrent(row.snapshot, row.credential) ? row.snapshot.ids : []));
    return models.filter(model => supported.has(model.id));
  }
  invalidateQuota(credential) {
    this.quotaEpochs.set(credential.name, (this.quotaEpochs.get(credential.name) ?? 0) + 1);
    this.inflight.delete(credential.name);
    const previous = this.quotas.get(credential.email); if (previous) this.quotaMetadata.delete(previous);
    this.quotas.delete(credential.email);
  }
  async quota(credential, { force = false } = {}) {
    if (force) this.invalidateQuota(credential);
    if (this.inflight.has(credential.name)) return this.inflight.get(credential.name);
    const epoch = this.quotaEpochs.get(credential.name) ?? 0;
    const metadata = { epoch, identity: this.identity(credential), resetKey: this.resetBarriers.get(credential.email) ?? null, startedAt: this.now() };
    const pending = (async () => {
      let snapshot;
      const previous = this.quotas.get(credential.email);
      try {
        if (credential.disabled || !credential.auth_index || !credential.account_id) snapshot = unknownQuota(credential.disabled ? 'disabled' : 'unknown');
        else {
          snapshot = evaluateQuota(await this.management.quota(credential));
          if (snapshot.eligible && previous?.reason === 'exhausted' && credential.unavailable) {
            await this.management.resetCooldown(credential); credential.unavailable = false; this.credentialCache = null;
          }
        }
      } catch { snapshot = unknownQuota(); }
      snapshot.checked_at = new Date(this.now()).toISOString();
      if ((this.quotaEpochs.get(credential.name) ?? 0) !== epoch) return this.quota(credential);
      this.quotaMetadata.set(snapshot, metadata); this.quotas.set(credential.email, snapshot); return snapshot;
    })();
    this.inflight.set(credential.name, pending);
    try { return await pending; } finally { if (this.inflight.get(credential.name) === pending) this.inflight.delete(credential.name); }
  }
  operational(credential) {
    return credential && !credential.disabled && (this.transientBlocks.get(credential.email) ?? 0) <= this.now() &&
      !(credential.unavailable && Date.parse(credential.next_retry_after) > this.now());
  }
  async *candidates({ model, countOnly = false, signal } = {}) {
    const variant = resolveModelVariant(model);
    if (!variant) throw new BridgeError(400, 'Selecione um modelo e uma modalidade disponíveis neste perfil.');
    const state = await this.readState();
    const credentials = await this.credentials();
    const order = state.mode === 'fixed' ? [state.fixed_email] : state.priority_order;
    const observed = new Map(); const offered = new Set();
    const lookup = async email => {
      const account = state.accounts.find(a => a.email === email);
      const credential = credentials.find(c => c.name === account.name && c.email === email);
      const capability = credential ? await this.capabilities(credential) : null;
      let quota = credential ? await this.quota(credential) : unknownQuota('disconnected');
      signal?.throwIfAborted();
      if (credential && state.auto_reset_emails.includes(email)) {
        await this.maybeAutomaticReset(email, credential, quota);
        quota = this.quotas.get(email) ?? quota;
      }
      const row = { account, credential, capability, quota, connected: Boolean(credential), disabled: Boolean(credential?.disabled) };
      observed.set(email, row); return row;
    };
    const capable = row => this.capabilityCurrent(row.capability, row.credential) && row.capability.ids.includes(variant.id);
    const selection = row => ({ ...row.account, credential: row.credential, requested_model: variant.id, capability: row.capability, count_only: countOnly, selection_identity: this.selectionIdentity(state) });
    for (const email of order) {
      signal?.throwIfAborted();
      if (countOnly) {
        const account = state.accounts.find(a => a.email === email), credential = credentials.find(c => c.name === account.name && c.email === email);
        const row = { account, credential, capability: credential ? await this.capabilities(credential) : null };
        if (capable(row)) yield selection(row);
        continue;
      }
      const row = await lookup(email);
      if (capable(row) && row.quota.eligible && this.operational(row.credential)) {
        offered.add(email); yield { ...selection(row), consumption_source: 'subscription' };
      }
    }
    if (countOnly || !state.allow_extra_credits) return;
    // Only subscription exhaustion, never an auth failure, cooldown or another model's cap, admits paid calls.
    await Promise.all(state.priority_order.filter(email => !observed.has(email)).map(lookup));
    for (const row of observed.values()) row.quota = this.quotas.get(row.account.email) ?? unknownQuota();
    for (const email of order) {
      const row = observed.get(email);
      if (!offered.has(email) && capable(row) && row.quota.eligible && this.operational(row.credential) && this.quotaMetadata.get(row.quota)?.identity === this.identity(row.credential)) {
        offered.add(email); yield { ...selection(row), consumption_source: 'subscription' };
      }
    }
    const permission = creditPermission(state, [...observed.values()]);
    if (!permission.allowed) return;
    const current = await this.readState();
    if (current.revision !== state.revision || !current.allow_extra_credits) return;
    for (const email of order) {
      signal?.throwIfAborted();
      const row = observed.get(email);
      if (!capable(row) || !row.quota.credits.eligible || !row.quota.additional_allowed || !row.credential || row.credential.disabled || (this.transientBlocks.get(email) ?? 0) > this.now()) continue;
      if (row.credential.unavailable) {
        await this.management.resetCooldown(row.credential); row.credential.unavailable = false; this.credentialCache = null;
      }
      const latest = await this.readState();
      if (latest.revision !== state.revision || !latest.allow_extra_credits) return;
      const candidate = { ...selection(row), consumption_source: 'credits', policy_revision: state.revision,
        credit_proof: [...observed.values()].map(r => ({ email: r.account.email, credential: r.credential })) };
      if (!this.validateCandidateNow(candidate)) continue;
      yield candidate;
    }
  }
  async validateCandidate(account) {
    const state = await this.readState();
    const credentials = await this.credentials(true);
    const credential = credentials.find(credential => credential.name === account.name && this.capabilityIdentity(credential) === account.capability?.identity);
    if (!state.accounts.some(row => row.email === account.email && row.name === account.name) ||
      !credential) return false;
    account.credential = credential;
    return this.validateCandidateNow(account);
  }
  validateCandidateNow(account) {
    if (account.selection_identity !== this.rememberedSelection || !this.capabilityCurrent(account.capability, account.credential) ||
      !account.capability.ids.includes(account.requested_model)) return false;
    if (account.count_only) return true;
    if (account.consumption_source === 'subscription') {
      const quota = this.quotas.get(account.email), meta = quota && this.quotaMetadata.get(quota);
      return Boolean(quota?.eligible && meta && meta.identity === this.identity(account.credential) &&
        meta.epoch === (this.quotaEpochs.get(account.credential.name) ?? 0) && this.operational(account.credential));
    }
    if (account.consumption_source !== 'credits') return false;
    if (!this.rememberedCredits || this.rememberedRevision !== account.policy_revision || !account.credit_proof?.length) return false;
    const rows = [];
    for (const proof of account.credit_proof) {
      const quota = this.quotas.get(proof.email), meta = quota && this.quotaMetadata.get(quota);
      if (!proof.credential || proof.credential.disabled || this.capabilityIdentities.get(proof.credential.name) !== this.capabilityIdentity(proof.credential) ||
        !meta || meta.identity !== this.identity(proof.credential) || meta.epoch !== (this.quotaEpochs.get(proof.credential.name) ?? 0)) return false;
      if (quota.windows.some(w => w.name === 'Uso do Codex' && w.reset_at !== null && w.reset_at * 1000 > meta.startedAt && w.reset_at * 1000 <= this.now())) return false;
      rows.push({ connected: true, disabled: proof.credential.disabled, quota });
    }
    const selected = this.quotas.get(account.email);
    return Boolean(selected?.credits.eligible && selected.additional_allowed && this.operational(account.credential) && creditPermission({ allow_extra_credits: true }, rows).allowed);
  }
  markUsed(account) { this.lastUsed = { email: account.email, at: new Date(this.now()).toISOString(), consumption_source: account.consumption_source ?? 'subscription' }; }
  acquire(account) {
    if (this.disconnecting.has(account.email) || this.removedAccounts.has(account.email)) return null;
    this.activeAccounts.set(account.email, (this.activeAccounts.get(account.email) ?? 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; this.activeAccounts.set(account.email, Math.max(0, (this.activeAccounts.get(account.email) ?? 1) - 1)); } };
  }
  markUnavailable(account, status) {
    // A bounded backoff also covers an upstream 429 that has not reached the usage endpoint yet.
    this.transientBlocks.set(account.email, this.now() + 60000);
    this.quotas.set(account.email, { ...(this.quotas.get(account.email) ?? unknownQuota()), eligible: false, reason: status === 429 ? 'cooldown' : 'auth_error', windows: this.quotas.get(account.email)?.windows ?? [], checked_at: new Date(this.now()).toISOString() });
    this.credentialCache = null;
  }
  mutate(action) {
    const pending = this.writeQueue.then(action, action);
    this.writeQueue = pending.catch(() => {}); return pending;
  }
  async saveState(next) {
    const destination = join(this.runtimeDir, 'accounts-state.json');
    const temporary = join(this.runtimeDir, `accounts-state.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2) + '\n');
      await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, destination);
      const directory = await open(this.runtimeDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      this.rememberState(next); return next;
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async setUpdateDrain(enabled) {
    if (enabled) this.pausedForUpdate = true;
    await this.mutate(async () => {
      const state = await this.readState();
      if (state.update_draining !== enabled) await this.saveState({ ...state, update_draining: enabled });
    });
    this.pausedForUpdate = enabled;
  }
  update(input) {
    return this.mutate(async () => {
      const state = await this.readState();
      if (input.revision !== state.revision) throw new BridgeError(409, 'A configuração mudou. Atualize o painel e tente novamente.');
      const fields = Object.keys(input);
      if (fields.some(k => !['revision', 'mode', 'fixed_email', 'priority_order', 'allow_extra_credits', 'auto_reset_emails'].includes(k))) throw new BridgeError(400, 'Configuração desconhecida.');
      const next = { ...state, ...input, revision: state.revision + 1 };
      const emails = state.accounts.map(a => a.email);
      if (typeof next.allow_extra_credits !== 'boolean' || !Array.isArray(next.auto_reset_emails) ||
          new Set(next.auto_reset_emails).size !== next.auto_reset_emails.length || next.auto_reset_emails.some(e => !emails.includes(e)) ||
          !['automatic', 'fixed'].includes(next.mode) ||
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
      const reset = state.reset_journal[email];
      if (this.resetInFlight.has(email) || (reset && ['pending', 'uncertain'].includes(reset.status))) throw new BridgeError(409, 'Confirme o reset pendente antes de reconectar esta conta.');
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
      const changed = credentials.filter(credential => !pending.previous_names.includes(credential.name) ||
        (credential.updated_at && credential.updated_at !== pending.previous_versions?.[credential.name]));
      const fresh = matches.length === 1 && changed.length === 1 && changed[0].name === matches[0].name;
      const recovered = status.status === 'error' && fresh && !pending.previous_names.includes(matches[0].name);
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
      if (existing) this.invalidateCapabilities(existing.name);
      this.invalidateCapabilities(credential.name);
      this.removedAccounts.delete(credential.email);
      this.credentialCache = null;
    });
  }
  disconnect(email) {
    return this.mutate(async () => {
      const state = await this.readState();
      const account = state.accounts.find(a => a.email === email);
      if (!account) throw new BridgeError(404, 'Conta não encontrada.');
      if (this.resetInFlight.has(email) || ['pending', 'uncertain'].includes(state.reset_journal[email]?.status)) throw new BridgeError(409, 'Confirme o reset pendente antes de desconectar esta conta.');
      if ((this.activeAccounts.get(email) ?? 0) > 0) throw new BridgeError(409, 'Esta conta tem solicitações em andamento. Aguarde a conclusão para desconectar.');
      if (state.pending_oauth?.email === email) throw new BridgeError(409, 'Cancele a autorização em andamento antes de desconectar.');
      this.disconnecting.add(email);
      try {
        const credentials = await this.credentials(true);
        if (credentials.some(c => c.name === account.name && c.email === email)) await this.management.deleteCredential(account.name);
        const accounts = state.accounts.filter(a => a.email !== email);
        const priority_order = state.priority_order.filter(e => e !== email);
        const reset_journal = { ...state.reset_journal }; delete reset_journal[email];
        await this.saveState({ ...state, accounts, priority_order, reset_journal, auto_reset_emails: state.auto_reset_emails.filter(e => e !== email), mode: state.fixed_email === email ? 'automatic' : state.mode,
          fixed_email: state.fixed_email === email ? null : state.fixed_email, revision: state.revision + 1 });
        this.removedAccounts.add(email);
        this.invalidateCapabilities(account.name);
        this.quotas.delete(email); this.transientBlocks.delete(email); this.credentialCache = null;
        if (this.lastUsed?.email === email) this.lastUsed = null;
      } finally { this.disconnecting.delete(email); }
    });
  }
  identity(credential) { return createHash('sha256').update(`${credential.name}\0${credential.account_id}`).digest('hex'); }
  resetAccount(email, { revision, automatic = false } = {}) {
    if (this.resetInFlight.has(email)) return this.resetInFlight.get(email);
    const pending = this.performReset(email, { revision, automatic }).finally(() => {
      if (this.resetInFlight.get(email) === pending) this.resetInFlight.delete(email);
    });
    this.resetInFlight.set(email, pending); return pending;
  }
  async performReset(email, { revision, automatic }) {
    if (this.pausedForUpdate) throw new BridgeError(503, 'Aguarde a atualização do aplicativo.');
    const initial = await this.readState();
    if (!automatic && revision !== initial.revision) throw new BridgeError(409, 'A configuração mudou. Atualize o painel e tente novamente.');
    if (automatic && !initial.auto_reset_emails.includes(email)) return;
    const account = initial.accounts.find(a => a.email === email);
    if (!account || initial.pending_oauth?.email === email || this.disconnecting.has(email)) throw new BridgeError(409, 'A conta não está disponível para aplicar um reset.');
    const credential = (await this.credentials(true)).find(c => c.name === account.name && c.email === email);
    if (!credential || credential.disabled || !credential.account_id || !credential.auth_index) throw new BridgeError(409, 'Confira a conexão desta conta antes de aplicar um reset.');
    const identity = this.identity(credential);
    const previous = initial.reset_journal[email];
    const retry = previous && ['pending', 'uncertain'].includes(previous.status);
    if (retry && previous.identity !== identity) throw new BridgeError(409, 'A identidade da conta mudou. O reset pendente precisa ser revisado.');
    let before = null;
    if (!retry) {
      before = await this.quota(credential, { force: true });
      if (!before.resets.known || before.resets.available_count < 1 || before.resets.applicable_count === 0 || before.subscription_status === 'unknown') {
        if (automatic) return;
        throw new BridgeError(409, 'Não há um reset aplicável confirmado para esta conta agora.');
      }
      if (automatic && (before.remaining_percent === null || before.remaining_percent > 5 || (previous && !previous.recovered))) return;
    } else if (automatic && this.now() - Date.parse(previous.updated_at) < 60000) return;
    const operation = await this.mutate(async () => {
      const state = await this.readState();
      if (this.pausedForUpdate || (automatic && !state.auto_reset_emails.includes(email))) return null;
      const current = state.accounts.find(a => a.email === email && a.name === account.name);
      if (!current || state.pending_oauth?.email === email) throw new BridgeError(409, 'A conta mudou durante a preparação do reset.');
      if (!automatic && state.revision !== revision) throw new BridgeError(409, 'A configuração mudou. Atualize o painel e tente novamente.');
      const old = state.reset_journal[email];
      const next = { key: retry ? previous.key : randomUUID(), identity, status: 'pending', result: null,
        source: retry ? previous.source : automatic ? 'automatic' : 'manual', created_at: retry ? previous.created_at : new Date(this.now()).toISOString(),
        updated_at: new Date(this.now()).toISOString(), recovered: false, verified: false, attempts: retry ? (previous.attempts ?? 1) + 1 : 1 };
      if (retry && (old?.key !== previous.key || old.identity !== identity)) throw new BridgeError(409, 'A tentativa de reset mudou. Atualize o painel.');
      await this.saveState({ ...state, reset_journal: { ...state.reset_journal, [email]: next }, revision: state.revision + 1 });
      return next;
    });
    if (!operation) return;
    let result;
    try {
      // The same persisted key is reused after timeout, app restart or an ambiguous response.
      result = await this.management.consumeReset(credential, operation.key);
    } catch {
      await this.finishReset(email, operation.key, { status: 'uncertain', result: null }); return;
    }
    const succeeded = ['reset', 'already_redeemed'].includes(result);
    await this.finishReset(email, operation.key, { status: succeeded ? 'succeeded' : 'not_applied', result });
    this.invalidateQuota(credential);
    if (succeeded) {
      this.transientBlocks.delete(email);
      try { await this.management.resetCooldown(credential); credential.unavailable = false; this.credentialCache = null; } catch {}
    }
    const after = await this.quota(credential, { force: true });
    await this.finishReset(email, operation.key, {
      verified: after.subscription_status !== 'unknown',
      recovered: after.eligible && after.remaining_percent > 5,
    });
  }
  finishReset(email, key, patch) {
    return this.mutate(async () => {
      const state = await this.readState(), previous = state.reset_journal[email];
      if (!previous || previous.key !== key) return;
      const operation = { ...previous, ...patch, updated_at: new Date(this.now()).toISOString() };
      await this.saveState({ ...state, reset_journal: { ...state.reset_journal, [email]: operation }, revision: state.revision + 1 });
    });
  }
  confirmRecovery(email, key, credential, quota) {
    return this.mutate(async () => {
      const state = await this.readState(), operation = state.reset_journal[email];
      const meta = this.quotaMetadata.get(quota);
      if (!operation || operation.key !== key || ['pending', 'uncertain'].includes(operation.status) || this.resetInFlight.has(email) ||
          !meta || meta.resetKey !== key || meta.identity !== operation.identity || meta.identity !== this.identity(credential) ||
          meta.epoch !== (this.quotaEpochs.get(credential.name) ?? 0) || this.quotas.get(email) !== quota || !quota.eligible || quota.remaining_percent <= 5) return;
      await this.saveState({ ...state, reset_journal: { ...state.reset_journal, [email]: { ...operation, recovered: true, verified: true } }, revision: state.revision + 1 });
    });
  }
  async maybeAutomaticReset(email, credential, quota) {
    const state = await this.readState();
    if (this.pausedForUpdate || !state.auto_reset_emails.includes(email)) return;
    const previous = state.reset_journal[email];
    if (previous && !['pending', 'uncertain'].includes(previous.status) && !previous.recovered && quota.eligible && quota.remaining_percent > 5) {
      await this.confirmRecovery(email, previous.key, credential, quota); return;
    }
    const retry = previous && ['pending', 'uncertain'].includes(previous.status);
    if (retry || (quota.resets.known && quota.resets.available_count > 0 && quota.resets.applicable_count !== 0 && quota.remaining_percent !== null && quota.remaining_percent <= 5 && (!previous || previous.recovered))) {
      try { await this.resetAccount(email, { automatic: true }); } catch {}
    }
  }
  async runAutomaticResets() {
    if (this.lastAutomaticRun) return this.lastAutomaticRun;
    const pending = (async () => {
      const state = await this.readState();
      if (this.pausedForUpdate || !state.auto_reset_emails.length) return;
      const credentials = await this.credentials(true);
      for (const email of state.auto_reset_emails) {
        if (this.pausedForUpdate) break;
        const account = state.accounts.find(a => a.email === email), credential = credentials.find(c => c.name === account.name && c.email === email);
        if (credential) await this.maybeAutomaticReset(email, credential, await this.quota(credential));
      }
    })().finally(() => { if (this.lastAutomaticRun === pending) this.lastAutomaticRun = null; });
    this.lastAutomaticRun = pending; return pending;
  }
  resetSnapshot(state, email, credential, quota) {
    const stored = state.reset_journal[email];
    const busy = this.resetInFlight.has(email);
    const pending = stored && ['pending', 'uncertain'].includes(stored.status);
    const identityChanged = pending && credential && stored.identity !== this.identity(credential);
    const canRetry = Boolean(pending && !busy && credential && !credential.disabled && !identityChanged);
    const canApply = Boolean(!busy && !identityChanged && credential && !credential.disabled &&
      (canRetry || (quota.resets.known && quota.resets.available_count > 0 && quota.resets.applicable_count !== 0 && quota.subscription_status !== 'unknown')));
    let operation = null;
    if (stored) {
      const status = stored.status === 'pending' && !busy ? 'uncertain' : stored.status;
      const messages = {
        pending: 'Aplicando reset…', uncertain: 'Não foi possível confirmar o resultado. Verifique a mesma tentativa.',
        succeeded: stored.verified ? 'Reset aplicado; limites consultados novamente.' : 'Reset aplicado; limites ainda em atualização.',
        not_applied: stored.result === 'no_credit' ? 'Nenhum reset disponível foi consumido.' : 'Nenhuma janela elegível foi restaurada.',
      };
      operation = { status, result: stored.result, source: stored.source, updated_at: stored.updated_at, verified: stored.verified, message: messages[status] ?? 'Confira o resultado da operação.' };
    }
    return { ...quota.resets, can_apply: canApply, auto_enabled: state.auto_reset_emails.includes(email), threshold_percent: 5, operation,
      reason: identityChanged ? 'identity_changed' : busy ? 'pending' : canRetry ? 'retry' : !quota.resets.known ? 'unknown' : quota.resets.available_count === 0 ? 'no_resets' : !canApply ? 'not_eligible' : 'available' };
  }
  async status(refresh = false) {
    await this.pollConnection();
    let state = await this.readState();
    const credentials = await this.credentials(refresh);
    if (refresh) await Promise.all(state.accounts.map(async a => {
      const credential = credentials.find(c => c.name === a.name && c.email === a.email);
      if (credential) await this.quota(credential);
    }));
    state = await this.readState();
    const rows = state.priority_order.map(email => {
      const account = state.accounts.find(a => a.email === email);
      const credential = credentials.find(c => c.name === account.name && c.email === email);
      const quota = this.quotas.get(email) ?? unknownQuota('unchecked');
      return { email, account, credential, quota, connected: Boolean(credential), disabled: Boolean(credential?.disabled) };
    });
    const credit = creditPermission(state, rows);
    const accounts = rows.map(({ email, account, credential, quota }) => {
      const operational = this.operational(credential);
      const paid = credit.allowed && quota.credits.eligible && quota.additional_allowed;
      const eligible = Boolean(operational && (quota.eligible || paid));
      return { email, plan: credential?.plan ?? account.plan, connected: Boolean(credential), active_requests: this.activeAccounts.get(email) ?? 0, ...quota,
        eligible, consumption_source: eligible ? quota.eligible ? 'subscription' : 'credits' : null,
        resets: this.resetSnapshot(state, email, credential, quota),
        reason: !credential ? 'disconnected' : credential.disabled ? 'disabled' : !operational ? 'cooldown' : paid && !quota.eligible ? 'credits' : quota.reason };
    });
    return {
      mode: state.mode, fixed_email: state.fixed_email ?? null, priority_order: state.priority_order,
      revision: state.revision, last_used: this.lastUsed, allow_extra_credits: state.allow_extra_credits,
      auto_reset_emails: state.auto_reset_emails, auto_reset_threshold_percent: 5,
      credit_phase: credit.allowed, credit_block_reason: credit.reason,
      next_eligible_account: (state.mode === 'fixed' ? accounts.find(a => a.email === state.fixed_email && a.eligible) : accounts.find(a => a.eligible))?.email ?? null,
      connection: state.pending_oauth ? { email: state.pending_oauth.email, started_at: state.pending_oauth.started_at, error: state.pending_oauth.error ?? null } : null,
      last_connection: state.last_connection ?? null, accounts,
    };
  }
}
