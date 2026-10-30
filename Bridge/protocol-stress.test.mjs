import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { models } from './model-catalog.mjs';
import { createModelResponseTransform } from './model-response.mjs';
import { createContextErrorTransform } from './context-errors.mjs';
import { createPoolRouter } from './pool-router.mjs';
import { guardUpstreamSilence } from './upstream-idle.mjs';

const response = (statusCode = 200, type = 'text/event-stream', headers = {}) => ({ statusCode, headers: { 'content-type': type, ...headers } });
const jsonMessage = model => ({ type: 'message', id: 'synthetic-message', role: 'assistant', model,
  content: [], usage: { input_tokens: 11, output_tokens: 3 } });
const start = model => Buffer.from(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: jsonMessage(model) })}\n\n`);
const stop = Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function transformAll(transforms, chunks) {
  const output = [];
  await pipeline(Readable.from(chunks, { objectMode: false }), ...transforms,
    new Writable({ write(bytes, _encoding, callback) { output.push(Buffer.from(bytes)); callback(); } }));
  return Buffer.concat(output);
}

test('composed context and model transforms preserve partial tool bytes while normalizing only the matching metadata and overflow', async () => {
  const tool = Buffer.from('event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"accent\\":\\"São 🌎\\"}"}}\r\n\r\n');
  const error = Buffer.from('event: error\ndata: {"type":"error","error":{"code":"context_length_exceeded","message":"synthetic overflow"}}\n\n');
  const input = Buffer.concat([start('gpt-6-astra'), tool, error]);
  const descriptor = response();
  const output = await transformAll([createContextErrorTransform(descriptor), createModelResponseTransform(descriptor, 'claude-opus-5-5-fast[1M]', { idleMs: 0 })],
    [...input].map(byte => Buffer.from([byte])));
  assert.ok(output.includes(Buffer.from('"model":"claude-opus-5-5-fast[1M]"')));
  assert.ok(output.includes(tool));
  assert.ok(output.includes(Buffer.from('prompt is too long. OpenAI: synthetic overflow')));
  assert.equal(output.toString().match(/event: message_start/g)?.length, 1);
  assert.equal(output.toString().match(/event: error/g)?.length, 1);
  assert.ok(!output.includes(Buffer.from('event: ping')));
});

test('every speed keeps its exact requested spelling and refuses a genuinely different base or speed', async () => {
  for (const variant of models) {
    for (const requested of [variant.id, variant.id + '[1M]', variant.target]) {
      const descriptor = response(200, 'application/json');
      const expected = { ...jsonMessage(variant.baseModel), model: requested };
      const bytes = Buffer.from(JSON.stringify(jsonMessage(variant.baseModel)));
      const output = await transformAll([createModelResponseTransform(descriptor, requested)], [...bytes].map(byte => Buffer.from([byte])));
      assert.deepEqual(JSON.parse(output), expected);
    }
    const different = models.find(model => model.baseModel !== variant.baseModel);
    const bytes = start(different.baseModel);
    assert.deepEqual(await transformAll([createModelResponseTransform(response(), variant.id, { idleMs: 0 })], [bytes]), bytes);
    if (variant.mode === 'normal') {
      const faster = models.find(model => model.baseModel === variant.baseModel && model.mode === 'fast');
      const fasterBytes = start(faster.target);
      assert.deepEqual(await transformAll([createModelResponseTransform(response(), variant.id, { idleMs: 0 })], [fasterBytes]), fasterBytes);
    }
  }
});

test('an empty event field resets the event type instead of rewriting a default-event payload', async () => {
  const bytes = Buffer.from(`event: message_start\nevent\ndata: ${JSON.stringify({ type: 'message_start', message: jsonMessage('gpt-6-astra') })}\n\n`);
  const output = await transformAll([createModelResponseTransform(response(), 'claude-opus-5-5', { idleMs: 0 })], [bytes]);
  assert.deepEqual(output, bytes);
});

test('terminal SSE error stops the heartbeat even if the upstream socket does not close', async t => {
  const transform = createModelResponseTransform(response(), 'claude-opus-5-5', { idleMs: 8 });
  t.after(() => transform.destroy());
  const output = []; transform.on('data', bytes => output.push(Buffer.from(bytes)));
  transform.write(start('gpt-6-astra'));
  transform.write(Buffer.from('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"terminal synthetic error"}}\n\n'));
  const afterError = output.length;
  await delay(40);
  assert.equal(output.length, afterError);
});

test('oversized and incomplete event bodies never receive an interleaved heartbeat', async t => {
  const transform = createModelResponseTransform(response(), 'claude-opus-5-5', { idleMs: 8 });
  t.after(() => transform.destroy());
  const output = []; transform.on('data', bytes => output.push(Buffer.from(bytes)));
  transform.write(start('gpt-6-astra'));
  const head = Buffer.from(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"${'x'.repeat(70000)}`);
  transform.write(head);
  const paused = Buffer.concat(output);
  await delay(35);
  assert.deepEqual(Buffer.concat(output), paused);
  const tail = Buffer.from('"}}\n\n');
  transform.write(tail); transform.write(stop); transform.end();
  await once(transform, 'end');
  const result = Buffer.concat(output);
  assert.ok(result.includes(Buffer.concat([head, tail])));
  assert.ok(!result.includes(Buffer.from('event: ping')));
  assert.equal(transform.pingTimer?._destroyed, true);
});

test('slow consumers bound both composed transforms and their heartbeat queue', { timeout: 5000 }, async () => {
  const descriptor = response(), heartbeat = createModelResponseTransform(descriptor, 'claude-opus-5-5', { idleMs: 5 });
  const errorTransform = createContextErrorTransform(descriptor);
  const entered = deferred(), gate = deferred();
  let produced = 0, held = false;
  const chunk = Buffer.from(`event: content_block_delta\ndata: {"delta":{"text":"${'x'.repeat(4000)}"}}\n\n`);
  const source = Readable.from((async function* () {
    yield start('gpt-6-astra');
    for (let i = 0; i < 2000; i++) { produced++; yield chunk; }
    yield stop;
  })(), { objectMode: false, highWaterMark: 8192 });
  const sink = new Writable({ highWaterMark: 8192, write(_bytes, _encoding, callback) {
    if (!held) { held = true; entered.resolve(); gate.promise.then(() => callback()); } else callback();
  } });
  const running = pipeline(source, errorTransform, heartbeat, sink);
  await entered.promise; await delay(30);
  try {
    assert.ok(produced < 100, `upstream produced ${produced} frames while the sink was paused`);
    assert.ok(heartbeat.readableLength <= heartbeat.readableHighWaterMark + chunk.length);
    assert.ok(errorTransform.readableLength <= errorTransform.readableHighWaterMark + chunk.length);
  } finally { gate.resolve(); }
  await running;
  assert.equal(produced, 2000);
  assert.equal(heartbeat.pingTimer?._destroyed, true);
});

test('client-side destruction stops heartbeat production and closes both transforms', async () => {
  const descriptor = response(), heartbeat = createModelResponseTransform(descriptor, 'claude-opus-5-5', { idleMs: 5 });
  const context = createContextErrorTransform(descriptor), source = new Readable({ read() {} });
  const received = deferred(), sink = new Writable({ write(_bytes, _encoding, done) { received.resolve(); done(); } });
  const running = pipeline(source, context, heartbeat, sink).catch(error => error);
  source.push(start('gpt-6-astra'));
  await received.promise;
  sink.destroy();
  assert.ok((await running) instanceof Error);
  assert.equal(source.destroyed, true);
  assert.equal(context.destroyed, true);
  assert.equal(heartbeat.destroyed, true);
  assert.equal(heartbeat.pingTimer?._destroyed, true);
});

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const key = 'S'.repeat(64);
const fakeController = () => ({ instructionModels: () => [], async *candidates() { yield { prefix: 'synthetic' }; },
  validateCandidate: async () => true, validateCandidateNow: () => true, acquire: () => () => {}, markUsed() {}, markUnavailable() {} });

test('router preserves parent and child execution identity without forwarding caller credentials', async t => {
  const captured = [];
  const upstream = http.createServer((request, reply) => { request.resume(); captured.push(request.headers); reply.setHeader('content-type', 'application/json'); reply.end('{}'); });
  await serve(t, upstream);
  const base = await serve(t, createPoolRouter({ controller: fakeController(), backendPort: upstream.address().port,
    getIngressKey: async () => key, getClientKey: async () => 'synthetic-backend-key' }));
  await Promise.all(['main', 'child-a', 'child-b'].map(async agent => {
    const reply = await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${key}`,
      'x-api-key': key, cookie: 'synthetic-cookie', 'content-type': 'application/json', 'x-claude-code-session-id': 'synthetic-session',
      ...(agent === 'main' ? {} : { 'x-claude-code-agent-id': agent, 'x-claude-code-parent-agent-id': 'main' }) },
    body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }) });
    assert.equal(reply.status, 200); await reply.text();
  }));
  assert.deepEqual(captured.map(headers => headers['x-claude-code-agent-id'] ?? 'main').sort(), ['child-a', 'child-b', 'main']);
  for (const headers of captured) {
    assert.equal(headers['x-claude-code-session-id'], 'synthetic-session');
    if (headers['x-claude-code-agent-id']) assert.equal(headers['x-claude-code-parent-agent-id'], 'main');
    assert.equal(headers.authorization, 'Bearer synthetic-backend-key');
    assert.equal(headers['x-api-key'], undefined); assert.equal(headers.cookie, undefined);
  }
});

test('compressed response passthrough retains its encoding header and exact bytes', async t => {
  const bytes = gzipSync(Buffer.from(JSON.stringify(jsonMessage('gpt-6-astra'))));
  const upstream = http.createServer((request, reply) => { request.resume();
    reply.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': bytes.length }); reply.end(bytes); });
  await serve(t, upstream);
  const base = await serve(t, createPoolRouter({ controller: fakeController(), backendPort: upstream.address().port,
    getIngressKey: async () => key, getClientKey: async () => 'synthetic' }));
  const result = await new Promise((resolve, reject) => {
    const request = http.request(base + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, reply => {
      const chunks = []; reply.on('data', chunk => chunks.push(chunk)); reply.on('end', () => resolve({ headers: reply.headers, body: Buffer.concat(chunks) })); reply.on('error', reject);
    });
    request.on('error', reject); request.end(JSON.stringify({ model: 'claude-opus-5-5', messages: [] }));
  });
  assert.deepEqual(result.body, bytes);
  assert.equal(result.headers['content-encoding'], 'gzip');
});

async function idleFixture(t, write, { upstreamHeaderMs, upstreamIdleMs = 100, streamHeartbeatMs = 8 } = {}) {
  let calls = 0, released = 0;
  const closed = deferred(), releaseDone = deferred();
  const upstream = http.createServer((request, reply) => {
    calls++; request.resume();
    reply.on('close', closed.resolve);
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    write(reply);
  });
  await serve(t, upstream);
  const controller = fakeController();
  controller.acquire = () => { let done = false; return () => { if (!done) { done = true; released++; releaseDone.resolve(); } }; };
  const base = await serve(t, createPoolRouter({ controller, backendPort: upstream.address().port, upstreamHeaderMs, upstreamIdleMs, streamHeartbeatMs,
    getIngressKey: async () => key, getClientKey: async () => 'synthetic' }));
  return { base, closed, releaseDone, calls: () => calls, released: () => released };
}

function readWire(base) {
  return new Promise((resolve, reject) => {
    const request = http.request(base + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, reply => {
      const chunks = [];
      const finish = event => resolve({ event, body: Buffer.concat(chunks), complete: reply.complete });
      reply.on('data', bytes => chunks.push(Buffer.from(bytes)));
      reply.on('end', () => finish('end'));
      reply.on('aborted', () => finish('aborted'));
      reply.on('error', () => finish('error'));
    });
    request.on('error', reject); request.end(JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }));
  });
}

test('local pings cannot renew upstream silence or replay the abandoned response', { timeout: 3000 }, async t => {
  const fixture = await idleFixture(t, reply => reply.write(start('gpt-6-astra')));
  const result = await readWire(fixture.base);
  await fixture.closed.promise;
  await fixture.releaseDone.promise;
  assert.equal(result.complete, false);
  assert.notEqual(result.event, 'end');
  assert.ok(result.body.includes(Buffer.from('"model":"claude-opus-5-5"')));
  assert.ok(result.body.includes(Buffer.from('event: ping')));
  assert.equal(fixture.calls(), 1);
  assert.equal(fixture.released(), 1);
});

test('real upstream bytes renew the idle budget across a response longer than that budget', { timeout: 3000 }, async t => {
  const fixture = await idleFixture(t, reply => {
    reply.write(start('gpt-6-astra'));
    let step = 0;
    const timer = setInterval(() => {
      step++;
      reply.write(Buffer.from(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"${step}"}}\n\n`));
      if (step === 8) { clearInterval(timer); reply.end(stop); }
    }, 35);
    reply.on('close', () => clearInterval(timer));
  }, { upstreamHeaderMs: 100, upstreamIdleMs: 180, streamHeartbeatMs: 8 });
  const result = await readWire(fixture.base);
  await fixture.closed.promise;
  await fixture.releaseDone.promise;
  assert.equal(result.event, 'end'); assert.equal(result.complete, true);
  assert.ok(result.body.includes(Buffer.from('"text":"8"')));
  assert.ok(result.body.includes(stop));
  assert.equal(fixture.calls(), 1); assert.equal(fixture.released(), 1);
});

test('partial upstream bytes renew the budget even while the context transform holds their unfinished event', { timeout: 3000 }, async t => {
  const prefix = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"';
  const suffix = '"}}\n\n';
  const fixture = await idleFixture(t, reply => {
    reply.write(start('gpt-6-astra')); reply.write(prefix);
    let step = 0;
    const timer = setInterval(() => {
      step++; reply.write('x'.repeat(500));
      if (step === 8) { clearInterval(timer); reply.write(suffix); reply.end(stop); }
    }, 35);
    reply.on('close', () => clearInterval(timer));
  }, { upstreamIdleMs: 180, streamHeartbeatMs: 8 });
  const result = await readWire(fixture.base);
  await fixture.closed.promise; await fixture.releaseDone.promise;
  assert.equal(result.event, 'end'); assert.equal(result.complete, true);
  assert.ok(result.body.includes(Buffer.from(prefix + 'x'.repeat(4000) + suffix)));
  assert.equal(fixture.calls(), 1); assert.equal(fixture.released(), 1);
});

test('idle expiration closes incomplete oversized frames without injecting JSON or replaying', { timeout: 3000 }, async t => {
  const partial = Buffer.from(`event: content_block_delta\ndata: {"delta":{"text":"${'x'.repeat(70000)}`);
  const fixture = await idleFixture(t, reply => {
    reply.write(start('gpt-6-astra')); reply.write(partial);
  });
  const result = await readWire(fixture.base);
  await fixture.closed.promise;
  await fixture.releaseDone.promise;
  assert.equal(result.complete, false);
  const partialAt = result.body.indexOf(Buffer.from('event: content_block_delta'));
  assert.ok(partialAt >= 0);
  assert.deepEqual(result.body.subarray(partialAt), partial);
  assert.ok(!result.body.includes(Buffer.from('event: error')));
  assert.ok(!result.body.includes(Buffer.from('event: ping')));
  assert.equal(fixture.calls(), 1); assert.equal(fixture.released(), 1);
});

test('idle guard expires a backpressured input and detaches after end or cancellation', { timeout: 3000 }, async () => {
  const blocked = new Readable({ read() {} }), gate = deferred(), reached = deferred();
  const sink = new Writable({ highWaterMark: 1, write(_bytes, _encoding, done) { reached.resolve(); gate.promise.then(() => done()); } });
  guardUpstreamSilence(blocked, 25);
  const pending = pipeline(blocked, sink).catch(error => error);
  blocked.push(Buffer.alloc(65536));
  await reached.promise;
  const [error] = await Promise.all([pending, delay(50)]);
  gate.resolve();
  assert.equal(error.code, 'BRIDGE_UPSTREAM_IDLE');
  assert.equal(blocked.destroyed, true);
  assert.equal(blocked.listenerCount('data'), 0);
  for (const mode of ['end', 'cancel']) {
    const input = new Readable({ read() {} }); const failures = [];
    input.on('error', error => failures.push(error));
    guardUpstreamSilence(input, 15);
    const closed = once(input, 'close');
    if (mode === 'end') input.push(null); else input.destroy();
    await closed; await delay(25);
    assert.deepEqual(failures, []);
    assert.equal(input.listenerCount('data'), 0);
  }
});

test('idle guard refuses timer values that Node would overflow into an immediate timeout', () => {
  for (const value of [0, -1, 1.5, Infinity, NaN, '100', 2147483648, Number.MAX_SAFE_INTEGER]) {
    const input = new Readable({ read() {} }); input.on('error', () => {});
    try { assert.throws(() => guardUpstreamSilence(input, value), TypeError); }
    finally { input.destroy(); }
  }
});

test('a provider that never sends headers is closed once without replaying inference', { timeout: 3000 }, async t => {
  const closed = deferred(), released = deferred(); let calls = 0, releases = 0;
  const upstream = http.createServer((request, reply) => { calls++; request.resume(); reply.on('close', closed.resolve); });
  await serve(t, upstream);
  const controller = fakeController();
  controller.candidates = async function* () { yield { prefix: 'first' }; yield { prefix: 'second' }; };
  controller.acquire = () => { let done = false; return () => { if (!done) { done = true; releases++; released.resolve(); } }; };
  const base = await serve(t, createPoolRouter({ controller, backendPort: upstream.address().port, upstreamHeaderMs: 40,
    getIngressKey: async () => key, getClientKey: async () => 'synthetic' }));
  const result = await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
  assert.equal(result.status, 502); assert.equal((await result.json()).error.code, 'bridge.unavailable');
  assert.equal(result.headers.get('x-should-retry'), 'false');
  await closed.promise; await released.promise;
  assert.equal(calls, 1); assert.equal(releases, 1);
});

test('cancellation before headers aborts the provider and releases its account before the deadline', { timeout: 3000 }, async t => {
  const entered = deferred(), closed = deferred(), released = deferred(); let calls = 0, releases = 0;
  const upstream = http.createServer((request, reply) => { calls++; request.resume(); reply.on('close', closed.resolve); entered.resolve(); });
  await serve(t, upstream);
  const controller = fakeController();
  controller.acquire = () => { let done = false; return () => { if (!done) { done = true; releases++; released.resolve(); } }; };
  const base = await serve(t, createPoolRouter({ controller, backendPort: upstream.address().port, upstreamHeaderMs: 10000,
    getIngressKey: async () => key, getClientKey: async () => 'synthetic' }));
  const abort = new AbortController();
  const pending = fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: abort.signal,
    body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
  await entered.promise; abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await closed.promise; await released.promise;
  assert.equal(calls, 1); assert.equal(releases, 1);
});

test('the response header guard refuses overflowing or invalid timer values', () => {
  for (const upstreamHeaderMs of [0, -1, 1.5, Infinity, NaN, '100', 2147483648, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createPoolRouter({ controller: fakeController(), getIngressKey: async () => key, upstreamHeaderMs }), TypeError);
  }
});
