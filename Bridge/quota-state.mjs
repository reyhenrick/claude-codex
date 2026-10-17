const emptyCredits = () => ({ known: false, has_credits: null, unlimited: null, balance: null, eligible: false });
const count = n => Number.isInteger(n) && n >= 0 ? n : null;
export function unknownQuota(reason = 'unknown') {
  return { eligible: false, reason, windows: [], subscription_status: 'unknown', ordinary_allowed: null,
    remaining_percent: null, additional_allowed: false, credits: emptyCredits(),
    resets: { known: false, available_count: null, applicable_count: null } };
}
function readGroup(value, name) {
  if (!value || typeof value.allowed !== 'boolean' || typeof value.limit_reached !== 'boolean') return null;
  const raw = [value.primary_window, value.secondary_window].filter(w => w != null);
  if (!raw.length || raw.some(w => !Number.isFinite(w.used_percent) || w.used_percent < 0 || !Number.isFinite(w.limit_window_seconds) || w.limit_window_seconds <= 0)) return null;
  return { allowed: value.allowed, reached: value.limit_reached, windows: raw.map(w => ({ name,
    used_percent: w.used_percent, window_seconds: w.limit_window_seconds, reset_at: Number.isFinite(w.reset_at) ? w.reset_at : null })) };
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
  const groups = additions.map(item => readGroup(item?.rate_limit, item?.limit_name ?? item?.name ?? 'Limite adicional'));
  result.windows.push(...groups.filter(Boolean).flatMap(g => g.windows));
  result.additional_allowed = groups.every(g => g && g.allowed && !g.reached && g.windows.every(w => w.used_percent < 100));
  result.eligible = result.subscription_status === 'available' && result.additional_allowed && usage.spend_control?.reached !== true;
  result.reason = result.eligible ? 'available' : result.subscription_status === 'exhausted' || result.remaining_percent === 0 || groups.some(g => g && (g.reached || g.windows.some(w => w.used_percent >= 100))) ? 'exhausted' : 'unknown';
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
