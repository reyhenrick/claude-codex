import { baseModels } from './model-catalog.mjs';

const emptyCredits = () => ({ known: false, has_credits: null, unlimited: null, balance: null, eligible: false });
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const maximumTimestampSeconds = 8640000000000; // The representable JavaScript Date range.
const timestamp = n => Number.isSafeInteger(n) && n >= 0 && n <= maximumTimestampSeconds;
const modelScopes = new Map(baseModels.flatMap(model => [[model.id.toLowerCase(), model.id], [model.label.toLowerCase(), model.id]]));
// OpenAI documents Spark's separate model-specific allowance. Keep its windows
// visible, but do not apply that allowance to Sol, Luna or Astra.
// https://learn.chatgpt.com/docs/changelog#codex-2026-02-12
modelScopes.set('gpt-5.3-codex-spark', 'gpt-5.3-codex-spark');

function additionalModel(item) {
  const names = [item?.limit_name, item?.name].filter(value => value != null);
  const scopes = names.map(name => typeof name === 'string' ? modelScopes.get(name.trim().toLowerCase()) : undefined);
  // Unknown or contradictory names remain unscoped and apply conservatively.
  return scopes.length && scopes.every(scope => scope && scope === scopes[0]) ? scopes[0] : null;
}
const permits = group => group.valid && group.allowed && !group.reached && group.windows.every(window => window.used_percent < 100);
const depleted = group => group.valid && (group.reached || group.windows.some(window => window.used_percent >= 100));
const applicableGroups = (groups, baseModel) => groups.filter(group => group.base_model === null || group.base_model === baseModel);

export function unknownQuota(reason = 'unknown') {
  return { eligible: false, reason, windows: [], subscription_status: 'unknown', ordinary_allowed: null,
    remaining_percent: null, additional_allowed: false, additional_limits: [], credits: emptyCredits(),
    resets: { known: false, available_count: null, applicable_count: null } };
}
function readGroup(value, name) {
  if (!value || typeof value.allowed !== 'boolean' || typeof value.limit_reached !== 'boolean') return null;
  const raw = [value.primary_window, value.secondary_window].filter(w => w != null);
  if (!raw.length || raw.some(w => !Number.isFinite(w.used_percent) || w.used_percent < 0 ||
      !Number.isSafeInteger(w.limit_window_seconds) || w.limit_window_seconds <= 0 ||
      (w.reset_at != null && !timestamp(w.reset_at)))) return null;
  return { allowed: value.allowed, reached: value.limit_reached, windows: raw.map(w => ({ name,
    used_percent: w.used_percent, window_seconds: w.limit_window_seconds, reset_at: w.reset_at ?? null })) };
}

// Read a model-specific view without replacing the original snapshot, whose
// identity is also used by the controller's quota and reset proofs.
export function quotaForModel(quota, requestedBaseModel) {
  if (!baseModels.some(model => model.id === requestedBaseModel) || !Array.isArray(quota?.additional_limits)) {
    return { eligible: false, additional_allowed: false, reason: 'unknown' };
  }
  const groups = applicableGroups(quota.additional_limits, requestedBaseModel);
  const allowed = quota.additional_allowed === true && groups.every(permits);
  const eligible = quota.eligible === true && allowed;
  const reason = eligible ? 'available' : !allowed && groups.some(depleted) ? 'exhausted' : !allowed ? 'unknown' : quota.reason;
  return { eligible, additional_allowed: allowed, reason };
}

export function evaluateQuota(usage) {
  const result = unknownQuota();
  const credit = usage?.credits;
  if (credit && typeof credit.has_credits === 'boolean' && typeof credit.unlimited === 'boolean') {
    const balance = typeof credit.balance === 'string' && /^\d+(?:\.\d+)?$/.test(credit.balance) && credit.balance.length < 80 && Number.isFinite(Number(credit.balance)) ? credit.balance : null;
    const validBalance = credit.balance == null || balance !== null;
    const validOverage = credit.overage_limit_reached == null || typeof credit.overage_limit_reached === 'boolean';
    const validSpend = usage.spend_control == null || typeof usage.spend_control?.reached === 'boolean';
    result.credits = { known: validBalance && validOverage && validSpend, has_credits: credit.has_credits, unlimited: credit.unlimited, balance,
      eligible: validBalance && validOverage && validSpend && (credit.unlimited || (credit.has_credits && (balance === null || Number(balance) > 0))) && credit.overage_limit_reached !== true && usage.spend_control?.reached !== true };
  }
  const available = count(usage?.rate_limit_reset_credits?.available_count);
  const applicable = count(usage?.rate_limit_reset_credits?.applicable_available_count);
  result.resets = { known: available !== null, available_count: available, applicable_count: applicable };
  const main = readGroup(usage?.rate_limit, 'Uso do Codex');
  if (!main) return result;
  result.windows = main.windows;
  result.ordinary_allowed = main.allowed;
  result.remaining_percent = Math.max(0, 100 - Math.max(...main.windows.map(w => w.used_percent)));
  // A negative operational result or rounded 100% alone is not proof of depleted subscription allowance.
  if (main.reached) result.subscription_status = 'exhausted';
  else if (main.allowed && result.remaining_percent > 0) result.subscription_status = 'available';
  const additions = usage.additional_rate_limits ?? [];
  if (!Array.isArray(additions)) return result;
  const groups = additions.map(item => {
    const label = item?.limit_name ?? item?.name;
    const group = readGroup(item?.rate_limit, typeof label === 'string' && label.trim() ? label : 'Limite adicional');
    return { base_model: additionalModel(item), valid: Boolean(group), allowed: false, reached: false, windows: [], ...group };
  });
  result.additional_limits = groups;
  result.windows.push(...groups.flatMap(group => group.windows));
  // The account panel is a summary: one model-specific cap does not make every
  // current model unavailable. Inference must use quotaForModel for its choice.
  result.additional_allowed = baseModels.some(model => applicableGroups(groups, model.id).every(permits));
  result.eligible = result.subscription_status === 'available' && result.additional_allowed && usage.spend_control?.reached !== true;
  result.reason = result.eligible ? 'available' : result.subscription_status === 'exhausted' || result.remaining_percent === 0 ||
    !result.additional_allowed && groups.some(depleted) ? 'exhausted' : 'unknown';
  return result;
}
export function creditPermission(state, rows) {
  if (!state.allow_extra_credits) return { allowed: false, reason: 'disabled' };
  if (!rows.length || rows.some(r => !r.connected || r.disabled || r.quota.subscription_status === 'unknown')) return { allowed: false, reason: 'unconfirmed' };
  if (rows.some(r => r.quota.subscription_status === 'available')) return { allowed: false, reason: 'subscriptions_available' };
  if (!rows.every(r => r.quota.subscription_status === 'exhausted')) return { allowed: false, reason: 'unconfirmed' };
  if (!rows.some(r => r.quota.additional_allowed && r.quota.credits.eligible)) return { allowed: false, reason: 'no_credits' };
  return { allowed: true, reason: 'available' };
}
