import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuota, quotaForModel, creditPermission } from './quota-state.mjs';
import { baseModels } from './model-catalog.mjs';

const group = (allowed = true, reached = false, used = 100) => ({ allowed, limit_reached: reached,
  primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 2000000000 }, secondary_window: null });
const usage = (rate_limit = group(), extra = {}) => ({ rate_limit, additional_rate_limits: [],
  credits: { has_credits: false, unlimited: false, balance: '0', overage_limit_reached: false },
  spend_control: { reached: false }, rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 }, ...extra });
const permission = quota => creditPermission({ allow_extra_credits: true }, [{ connected: true, disabled: false, quota }]);

test('a displayed 100 percent does not override the provider allowing subscription use', () => {
  for (const balance of ['0', '50']) {
    const quota = evaluateQuota(usage(group(), { credits: { has_credits: balance !== '0', unlimited: false, balance } }));
    assert.equal(quota.remaining_percent, 0, 'retain the actual reported meter');
    assert.equal(quota.subscription_status, 'available');
    assert.equal(quota.ordinary_allowed, true);
    assert.equal(quota.eligible, true);
    assert.equal(quota.reason, 'available');
    for (const model of baseModels) assert.equal(quotaForModel(quota, model.id).eligible, true);
    assert.deepEqual(permission(quota), { allowed: false, reason: 'subscriptions_available' });
  }
});

test('explicit exhaustion wins at every percentage and denial without exhaustion stays unknown', () => {
  for (const used of [0, 99, 100]) {
    for (const allowed of [true, false]) {
      const quota = evaluateQuota(usage(group(allowed, true, used)));
      assert.equal(quota.subscription_status, 'exhausted');
      assert.equal(quota.eligible, false);
      assert.equal(quota.reason, 'exhausted');
    }
    const denied = evaluateQuota(usage(group(false, false, used)));
    assert.equal(denied.subscription_status, 'unknown');
    assert.equal(denied.eligible, false);
    assert.equal(denied.reason, 'unknown');
    assert.deepEqual(permission(denied), { allowed: false, reason: 'unconfirmed' });
  }
});

test('additional allowance uses its explicit permission and remains scoped to the selected model', () => {
  for (const model of baseModels) {
    const quota = evaluateQuota(usage(group(), { additional_rate_limits: [{ limit_name: model.id, rate_limit: group() }] }));
    assert.equal(quota.eligible, true);
    for (const target of baseModels) assert.equal(quotaForModel(quota, target.id).eligible, true);
    for (const reached of [true, false]) {
      const denied = evaluateQuota(usage(group(), { additional_rate_limits: [{ limit_name: model.id, rate_limit: group(false, reached) }] }));
      assert.equal(quotaForModel(denied, model.id).eligible, false);
      assert.equal(quotaForModel(denied, model.id).reason, reached ? 'exhausted' : 'unknown');
      for (const target of baseModels.filter(target => target.id !== model.id)) assert.equal(quotaForModel(denied, target.id).eligible, true);
    }
  }
});

test('malformed permission and spend blocks cannot be authorized by the percentage fix', () => {
  for (const patch of [{ allowed: undefined }, { allowed: 'true' }, { limit_reached: undefined }, { limit_reached: 'false' }, { primary_window: null }]) {
    const quota = evaluateQuota(usage({ ...group(), ...patch }));
    assert.equal(quota.eligible, false);
    assert.equal(permission(quota).allowed, false);
  }
  for (const spend_control of [{ reached: true }, { reached: 'false' }, {}, []]) {
    const blocked = evaluateQuota(usage(group(), { spend_control }));
    assert.equal(blocked.eligible, false);
    for (const model of baseModels) assert.equal(quotaForModel(blocked, model.id).eligible, false);
  }
});
