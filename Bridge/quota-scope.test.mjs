import test from 'node:test';
import assert from 'node:assert/strict';
import { baseModels, models } from './model-catalog.mjs';
import { evaluateQuota, quotaForModel, creditPermission, unknownQuota } from './quota-state.mjs';

const group = (used = 1, exhausted = false) => ({ allowed: !exhausted, limit_reached: exhausted,
  primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: 2000000000 } });
const usage = (additional_rate_limits = [], main = group()) => ({ rate_limit: main, additional_rate_limits,
  credits: { has_credits: true, unlimited: false, balance: '50' },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 } });
const extra = (limit_name, rate_limit = group(100, true)) => ({ limit_name, rate_limit });
const permission = quota => creditPermission({ allow_extra_credits: true }, [{ connected: true, disabled: false, quota }]);

test('Spark allowance remains visible without blocking the three current model families', () => {
  const quota = evaluateQuota(usage([extra('GPT-5.3-Codex-Spark')]));
  assert.equal(quota.subscription_status, 'available');
  assert.equal(quota.remaining_percent, 99);
  assert.equal(quota.eligible, true);
  assert.equal(quota.reason, 'available');
  assert.deepEqual(quota.windows.map(window => [window.name, window.used_percent]), [['Uso do Codex', 1], ['GPT-5.3-Codex-Spark', 100]]);
  for (const model of models) assert.deepEqual(quotaForModel(quota, model.baseModel), { eligible: true, additional_allowed: true, reason: 'available' });
  assert.equal(permission(quota).allowed, false);
  assert.equal(permission(quota).reason, 'subscriptions_available');
});

test('current model-specific limits apply to every speed of that base, not to other bases', () => {
  for (const limited of baseModels) {
    for (const name of [limited.id, limited.label, `  ${limited.label.toUpperCase()}  `]) {
      const quota = evaluateQuota(usage([extra(name)]));
      assert.equal(quota.eligible, true);
      assert.equal(quota.reason, 'available');
      assert.equal(quota.remaining_percent, 99);
      assert.equal(quota.additional_limits[0].base_model, limited.id);
      for (const model of models) {
        const selected = quotaForModel(quota, model.baseModel);
        assert.equal(selected.eligible, model.baseModel !== limited.id, `${name}: ${model.id}`);
        assert.equal(selected.additional_allowed, model.baseModel !== limited.id, `${name}: ${model.id}`);
        assert.equal(selected.reason, model.baseModel === limited.id ? 'exhausted' : 'available');
      }
    }
  }
});

test('unknown names, compatibility aliases and approximate matches cannot narrow a limit scope', () => {
  for (const name of ['another-model', 'Astra', 'opus', 'claude-opus-5-5', 'gpt-6-astra-fast', 'gpt-6-astra-extra',
    'GPT-6 Astra and GPT-6.1 Sol', 'GPT-5.3-Codex-Spark shared', '', 42, {}, null]) {
    const quota = evaluateQuota(usage([extra(name)]));
    assert.equal(quota.additional_limits[0].base_model, null);
    assert.equal(quota.eligible, false);
    assert.equal(quota.subscription_status, 'available');
    for (const model of baseModels) assert.equal(quotaForModel(quota, model.id).eligible, false);
    assert.equal(permission(quota).allowed, false);
    assert.ok(quota.windows.every(window => typeof window.name === 'string'));
  }
});

test('contradictory scope names are conservative and unsupported metadata is not guessed', () => {
  for (const item of [
    { ...extra('GPT-5.3-Codex-Spark'), name: 'GPT-6 Astra' },
    { ...extra('GPT-6 Astra'), name: 'unknown' },
    { ...extra('unknown'), model: 'gpt-6-astra' },
    { ...extra('unknown'), model_slug: 'gpt-6-astra' },
    { ...extra('unknown'), metered_feature: 'codex_bengalfox' },
  ]) {
    const quota = evaluateQuota(usage([item]));
    assert.equal(quota.additional_limits[0].base_model, null);
    for (const model of baseModels) assert.equal(quotaForModel(quota, model.id).eligible, false);
  }
  const fallback = evaluateQuota(usage([{ name: 'GPT-6 Astra', rate_limit: group(100, true) }]));
  assert.equal(quotaForModel(fallback, 'gpt-6-astra').eligible, false);
  assert.equal(quotaForModel(fallback, 'gpt-6.1-sol').eligible, true);
});

test('an account summary becomes unavailable only when every current model is blocked', () => {
  const quota = evaluateQuota(usage(baseModels.map(model => extra(model.label))));
  assert.equal(quota.eligible, false);
  assert.equal(quota.additional_allowed, false);
  assert.equal(quota.reason, 'exhausted');
  assert.equal(quota.remaining_percent, 99);
  assert.equal(quota.subscription_status, 'available');
  for (const model of baseModels) assert.equal(quotaForModel(quota, model.id).eligible, false);
});

test('credits still require central exhaustion and respect the requested model-specific gate', () => {
  const quota = evaluateQuota(usage([extra('GPT-6 Astra')], group(100, true)));
  assert.equal(permission(quota).allowed, true);
  assert.equal(quota.subscription_status, 'exhausted');
  assert.equal(quota.remaining_percent, 0);
  assert.equal(quotaForModel(quota, 'gpt-6-astra').additional_allowed, false);
  assert.equal(quotaForModel(quota, 'gpt-6.1-sol').additional_allowed, true);
  for (const model of baseModels) assert.equal(quotaForModel(quota, model.id).eligible, false);
  const spark = evaluateQuota(usage([extra('GPT-5.3-Codex-Spark')], group(100, true)));
  assert.equal(permission(spark).allowed, true);
  for (const model of baseModels) assert.equal(quotaForModel(spark, model.id).additional_allowed, true);
  const blocked = evaluateQuota(usage([extra('unconfirmed limit')], group(100, true)));
  assert.equal(permission(blocked).allowed, false);
  assert.equal(permission(blocked).reason, 'no_credits');
});

test('scope views preserve snapshot identity, core reset percentages and non-quota blocks', () => {
  const quota = evaluateQuota(usage([extra('GPT-6 Astra')], group(95)));
  const proofs = new WeakMap([[quota, 'original quota proof']]);
  const before = structuredClone(quota);
  assert.equal(quota.remaining_percent, 5);
  assert.equal(quota.resets.available_count, 2);
  for (const model of baseModels) quotaForModel(quota, model.id);
  assert.deepEqual(quota, before);
  assert.equal(proofs.get(quota), 'original quota proof');
  const blocked = { ...quota, eligible: false, reason: 'cooldown' };
  assert.deepEqual(quotaForModel(blocked, 'gpt-6.1-sol'), { eligible: false, additional_allowed: true, reason: 'cooldown' });
  const spent = evaluateQuota({ ...usage(), spend_control: { reached: true } });
  assert.equal(quotaForModel(spent, 'gpt-6-astra').eligible, false);
  assert.equal(permission(spent).allowed, false);
});

test('only canonical base-model IDs select a quota scope', () => {
  const quota = evaluateQuota(usage());
  for (const id of [undefined, null, 'opus', 'GPT-6 Astra', 'gpt-6-astra-fast', 'claude-opus-5-5', 'gpt-unknown', {}]) {
    assert.deepEqual(quotaForModel(quota, id), { eligible: false, additional_allowed: false, reason: 'unknown' });
  }
  assert.equal(quotaForModel(unknownQuota(), 'gpt-6-astra').eligible, false);
  assert.equal(quotaForModel({}, 'gpt-6-astra').eligible, false);
});

test('unsafe, fractional and invalid durations cannot reach native numeric conversion', () => {
  for (const duration of [1e30, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, -1, 0, 18000.5, '18000']) {
    const main = group(); main.primary_window.limit_window_seconds = duration;
    const quota = evaluateQuota(usage([], main));
    assert.equal(quota.subscription_status, 'unknown');
    assert.equal(quota.eligible, false);
    assert.deepEqual(quota.windows, []);
    assert.equal(permission(quota).allowed, false);
    for (const model of baseModels) assert.equal(quotaForModel(quota, model.id).eligible, false);
  }
  for (const duration of [1, 18000, 604800, Number.MAX_SAFE_INTEGER]) {
    const main = group(); main.primary_window.limit_window_seconds = duration;
    assert.equal(evaluateQuota(usage([], main)).eligible, true);
  }
});

test('invalid additional windows block their scope and cannot leak unsafe values to the panel', () => {
  const malformed = group(); malformed.primary_window.limit_window_seconds = 1e30;
  for (const name of ['GPT-6 Astra', 'unknown']) {
    const quota = evaluateQuota(usage([extra(name, malformed)]));
    assert.equal(quotaForModel(quota, 'gpt-6-astra').eligible, false);
    assert.equal(quotaForModel(quota, 'gpt-6-astra').reason, 'unknown');
    assert.equal(quotaForModel(quota, 'gpt-6.1-sol').eligible, name !== 'unknown');
    assert.equal(quota.windows.length, 1);
    assert.equal(quota.additional_limits[0].valid, false);
  }
  const unrelated = evaluateQuota(usage([extra('GPT-5.3-Codex-Spark', malformed)]));
  assert.equal(unrelated.eligible, true);
  assert.equal(unrelated.windows.length, 1);
});

test('reset timestamps and counts reject nonrepresentable provider numbers', () => {
  for (const resetAt of [1e30, 8640000000001, Infinity, NaN, -1, 2000000000.5, '2000000000']) {
    const main = group(); main.primary_window.reset_at = resetAt;
    assert.equal(evaluateQuota(usage([], main)).eligible, false);
  }
  for (const resetAt of [undefined, null, 0, 2000000000, 8640000000000]) {
    const main = group(); main.primary_window.reset_at = resetAt;
    assert.equal(evaluateQuota(usage([], main)).eligible, true);
  }
  for (const available of [1e30, Number.MAX_SAFE_INTEGER + 1, 1.5, -1, '2']) {
    const quota = evaluateQuota({ ...usage(), rate_limit_reset_credits: { available_count: available, applicable_available_count: available } });
    assert.deepEqual(quota.resets, { known: false, available_count: null, applicable_count: null });
  }
});
