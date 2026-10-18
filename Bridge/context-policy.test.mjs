import test from 'node:test';
import assert from 'node:assert/strict';
import { applyContextDefaults, contextPolicy } from './context-policy.mjs';
import { profileConfig } from './setup.mjs';

test('every supported variant advertises only the native 1M option', () => {
  const profile = profileConfig(undefined, 'S'.repeat(64));
  assert.equal(profile.inferenceModels.length, 8);
  assert.ok(profile.inferenceModels.every(model => model.supports1m === true && model.prefer1m === true));
  assert.equal(contextPolicy.context_window, 1000000);
  assert.equal(contextPolicy.auto_compact_window - 20000 - 13000, 867000);
});
test('compaction reserves headroom without reducing the declared model window', () => {
  const settings = { effortLevel: 'low', enableWorkflows: true, other: { preserve: true } };
  const result = applyContextDefaults(settings);
  assert.equal(result.autoCompactWindow, 900000);
  assert.deepEqual(Object.keys(result.modelSettings).sort(), ['claude-haiku-5-5','claude-opus-5-5','claude-sonnet-5-5']);
  assert.ok(Object.values(result.modelSettings).every(model => model.autoCompactWindow === 900000));
  assert.equal(result.effortLevel, 'low'); assert.deepEqual(result.other, { preserve: true });
  assert.equal(settings.autoCompactWindow, undefined);
});
test('existing earlier compaction and unrelated model preferences are preserved', () => {
  const settings = {autoCompactWindow:800000,modelSettings:{'claude-opus-5-5':{autoCompactWindow:700000,effortLevel:'high'},'another-model':{autoCompactWindow:300000}}};
  const result=applyContextDefaults(settings);
  assert.equal(result.autoCompactWindow,800000);
  assert.deepEqual(result.modelSettings['claude-opus-5-5'],{autoCompactWindow:700000,effortLevel:'high'});
  assert.deepEqual(result.modelSettings['another-model'],{autoCompactWindow:300000});
  assert.deepEqual(applyContextDefaults(result),result);
});
test('late or malformed compaction configuration cannot exceed the default safety window', () => {
  for(const value of [1000000,Infinity,NaN,-1,0,'900000',null]) {
    const result=applyContextDefaults({autoCompactWindow:value,modelSettings:{'claude-opus-5-5':{autoCompactWindow:value}}});
    assert.equal(result.autoCompactWindow,900000);assert.equal(result.modelSettings['claude-opus-5-5'].autoCompactWindow,900000);
  }
});

test('equivalent aliases retain their earlier window and per-model effort', () => {
  for(const alias of ['anthropic.claude-opus-5-5','us.anthropic.claude-opus-5-5','claude-opus-5-5-fast','claude-opus-5-5[1m]','claude-opus-5-5@20260101','opus']) {
    const input = {modelSettings:{[alias]:{autoCompactWindow:400000,effortLevel:'high'}}};
    const result=applyContextDefaults(input);
    assert.equal(result.modelSettings['claude-opus-5-5'].autoCompactWindow,400000);
    assert.equal(result.modelSettings['claude-opus-5-5'].effortLevel,'high');
    assert.deepEqual(result.modelSettings[alias],input.modelSettings[alias]);
    assert.deepEqual(applyContextDefaults(result),result);
  }
});
test('an explicit canonical effort remains authoritative while earlier alias windows stay safe', () => {
 const result=applyContextDefaults({modelSettings:{'anthropic.claude-opus-5-5':{autoCompactWindow:400000,effortLevel:'high'},'claude-opus-5-5':{autoCompactWindow:600000,effortLevel:'low'}}});
 assert.equal(result.modelSettings['claude-opus-5-5'].effortLevel,'low');
 assert.equal(result.modelSettings['claude-opus-5-5'].autoCompactWindow,400000);
});
