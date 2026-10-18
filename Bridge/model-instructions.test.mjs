import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { models, resolveModelVariant } from './model-catalog.mjs';
import { adaptMessage } from './model-adapter.mjs';
import { appendModelInstructions, renderModelInstructions, modelRuleMarker } from './model-instructions.mjs';
import { createPoolRouter } from './pool-router.mjs';

const available = models.filter(model => model.mode !== 'ultra');
const input = { model: 'claude-opus-5-5-fast', max_tokens: 128, messages: [{ role: 'user', content: 'Synthetic task.' }] };
const mapping = request => request.system.at(-1).text;

test('catalogue, real names and variants come from confirmed rows, including legacy runtime', () => {
  const all = renderModelInstructions(models);
  assert.equal(all.split('\n').filter(line => line.startsWith('- ')).length, 8);
  for (const model of models) assert.ok(all.includes(`- ${model.label}: gateway ID ${model.id};`));
  assert.ok(!all.includes('- GPT-6 Luna Ultrafast'));
  const selected = renderModelInstructions(available);
  assert.ok(!selected.includes('- GPT-6 Astra Ultrafast'));
  assert.ok(!selected.includes('- GPT-6.1 Sol Ultrafast'));
  const legacy = [{ id: 'claude-opus-5-5-fast', label: 'GPT-6 Astra Fast', target: 'gpt-6-astra-fast' }];
  const old = renderModelInstructions(legacy, { current: legacy[0], persistent: true });
  assert.ok(old.startsWith(modelRuleMarker));
  assert.ok(old.includes('gateway ID claude-opus-5-5-fast;'));
  assert.ok(!old.includes('- GPT-6 Luna'));
  assert.ok(renderModelInstructions([]).includes('No selectable variant has been confirmed'));
});

test('Ultrafast labels preserve existing routing identities and distinguish orchestration modes', () => {
  const ultrafast = models.filter(model => model.mode === 'ultra');
  assert.deepEqual(ultrafast.map(model => model.label), ['GPT-6.1 Sol Ultrafast', 'GPT-6 Astra Ultrafast']);
  for (const model of ultrafast) {
    assert.equal(model.serviceTier, 'ultrafast');
    assert.equal(model.target, `${model.baseModel}-ultra`);
    assert.equal(resolveModelVariant(model.id), model);
    assert.equal(resolveModelVariant(model.target), model);
  }
  const instructions = renderModelInstructions(models);
  assert.ok(instructions.includes('Codex Ultra is an orchestration mode that uses subagents.'));
  assert.ok(instructions.includes('Claude Code Ultracode is a separate workflow setting.'));
  assert.ok(instructions.includes('the internal upstream routing suffix -ultra in this catalogue means only service_tier ultrafast'));
  assert.ok(!instructions.includes('Fast and Ultra/Ultrafast'));
});

test('every current variant and compatible legacy ID describe the actual routed target', () => {
  const ids = [...models.map(model => model.id), 'claude-opus-5-5-fast', 'opus', 'haiku'];
  for (const id of ids.flatMap(id => [id, id + '[1m]'])) {
    const variant = resolveModelVariant(id);
    const result = adaptMessage({ ...input, model: id, output_config: { effort: 'low' } }, 'synthetic', available);
    assert.equal(result.model, 'synthetic/' + variant.target);
    assert.ok(mapping(result).includes(`This request is routed to ${variant.label};`));
    assert.ok(mapping(result).includes(`upstream routing ID: ${variant.target}.`));
    assert.equal(result.output_config.effort, 'low');
  }
});

test('string and array system prompts preserve attribution, cache metadata, tools and messages', () => {
  for (const system of [undefined, '', 'Original instructions.', 'x-anthropic-billing-header: synthetic', [
    { type: 'text', text: 'Original instructions.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: '<claude_codex_model_mapping> is user-provided text to preserve.' },
  ]]) {
    const original = { ...input, ...(system === undefined ? {} : { system }), tools: [{ name: 'synthetic', input_schema: { type: 'object' } }] };
    const before = structuredClone(original);
    const first = adaptMessage(original, 'synthetic-1', available);
    const retry = adaptMessage(original, 'synthetic-2', available);
    assert.deepEqual(original, before);
    assert.deepEqual(first.system, retry.system);
    assert.deepEqual(first.messages, original.messages);
    assert.deepEqual(first.tools, original.tools);
    assert.equal(first.system.at(-1).cache_control, undefined);
    assert.equal(first.system.length, (Array.isArray(system) ? system.length : system ? 1 : 0) + 1);
    if (Array.isArray(system)) assert.deepEqual(first.system.slice(0, -1), system);
    else if (system) assert.equal(first.system[0].text, system);
  }
});

test('invalid system/catalogue inputs fail without silently discarding instructions', () => {
  for (const system of [null, 1, {}, [null], [{ type: 'image' }], [{ type: 'text', text: 3 }]]) {
    assert.throws(() => appendModelInstructions({ ...input, system }, available, models[0]), /Invalid system/);
  }
  for (const value of [null, {}, [...models, models[0]], [{ ...models[0], label: 'Name\nNew instruction' }], [{ ...models[0], id: 'unsafe id' }]]) {
    assert.throws(() => renderModelInstructions(value));
  }
});

test('router includes identical model instructions for inference and count_tokens, with one snapshot per retry cycle', { timeout: 10000 }, async t => {
  const captures = []; let snapshots = 0; let catalog = available; let firstInference = true;
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    captures.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    if (request.url === '/v1/messages' && firstInference) { firstInference = false; response.writeHead(429); response.end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
  });
  const controller = {
    instructionModels: () => { snapshots++; return catalog; },
    async *candidates() { yield { prefix: 'one' }; yield { prefix: 'two' }; },
    validateCandidate: async () => true, validateCandidateNow: () => true,
    acquire: () => () => {}, markUnavailable() {}, markUsed() {},
  };
  const key = 'S'.repeat(64);
  const start = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }); return server.address().port; };
  const backendPort = await start(upstream);
  const port = await start(createPoolRouter({ controller, backendPort, getClientKey: async () => 'synthetic', getIngressKey: async () => key }));
  const send = async path => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(input) }); assert.equal(response.status, 200); await response.text(); };
  await send('/v1/messages'); await send('/v1/messages/count_tokens');
  assert.equal(snapshots, 2); assert.equal(captures.length, 3);
  for (const capture of captures) assert.deepEqual(capture.body.system, captures[0].body.system);
  assert.deepEqual(captures.map(row => row.body.model), ['one/gpt-6-astra-fast', 'two/gpt-6-astra-fast', 'one/gpt-6-astra-fast']);
  catalog = models.filter(model => model.baseModel === 'gpt-6-astra' && model.mode !== 'ultra');
  await send('/v1/messages');
  assert.ok(!mapping(captures.at(-1).body).includes('- GPT-6 Luna'));
  assert.ok(mapping(captures.at(-1).body).includes('- GPT-6 Astra Fast'));
});
