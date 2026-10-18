import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { contextErrorBufferBytes, createContextErrorTransform } from './context-errors.mjs';
import { createPoolRouter } from './pool-router.mjs';

const ingressKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const openAIMessage = 'Your input exceeds the context window of this model. Please adjust your input and try again.';
const rawError = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: openAIMessage } }));
const message = { model: 'claude-opus-5-5-fast', max_tokens: 256, messages: [
  { role: 'user', content: 'Preserve  every\nspace. São Paulo 🌎' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_synthetic', name: 'calculate', input: { value: 17 } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_synthetic', content: '17' }] },
] };

async function start(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, respond) {
  const captures = [], released = [], unavailable = [], used = [], selected = [];
  const accounts = [{ email: 'first@example.test', prefix: 'conta-01' }, { email: 'second@example.test', prefix: 'conta-02' }];
  const controller = {
    resetInFlight: new Map(), readState: async () => ({}),
    async *candidates() { for (const account of accounts) { selected.push(account); yield account; } },
    validateCandidate: async () => true, validateCandidateNow: () => true,
    acquire: account => () => released.push(account),
    markUnavailable: (...args) => unavailable.push(args), markUsed: account => used.push(account),
  };
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    captures.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks)), headers: request.headers });
    try { await respond(response, request); } catch (error) { response.destroy(error); }
  });
  await start(t, upstream);
  const base = await start(t, createPoolRouter({ controller, backendPort: upstream.address().port,
    getClientKey: async () => 'synthetic-upstream-key', getIngressKey: async () => ingressKey }));
  const post = (options = {}) => fetch(base + '/v1/messages', { method: 'POST',
    headers: { authorization: `Bearer ${ingressKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...message, stream: true }), ...options });
  const health = async () => (await fetch(base + '/healthz', { headers: { authorization: `Bearer ${ingressKey}` } })).json();
  return { post, health, captures, released, unavailable, used, selected };
}

function assertSingleRequest(f) {
  assert.equal(f.captures.length, 1);
  assert.equal(f.selected.length, 1);
  assert.deepEqual(f.captures[0].body.messages, message.messages);
  assert.equal(f.captures[0].body.model, 'conta-01/gpt-6-astra-fast');
  assert.equal(f.released.length, 1);
  assert.equal(f.unavailable.length, 0);
}

function assertOverflow(bytes) {
  const value = JSON.parse(bytes);
  assert.equal(value.type, 'error');
  assert.equal(value.error.type, 'invalid_request_error');
  assert.equal(value.error.code, 'context_length_exceeded');
  assert.ok(value.error.message.startsWith('prompt is too long. OpenAI: '));
  return value;
}

function transform(type, statusCode = 200) {
  return createContextErrorTransform({ statusCode, headers: { 'content-type': type } });
}

async function collect(stream, chunks) {
  const output = [];
  await pipeline(Readable.from(chunks), stream, new Writable({ write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } }));
  return Buffer.concat(output);
}

test('router translates the exact observed CPA HTTP 400 into a Claude context overflow without changing the request', async t => {
  const f = await fixture(t, response => {
    response.writeHead(400, { 'content-type': 'application/json', 'content-length': rawError.length, 'request-id': 'synthetic-request' });
    response.end(rawError);
  });
  const response = await f.post();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('request-id'), 'synthetic-request');
  assert.equal(assertOverflow(await response.text()).error.message, `prompt is too long. OpenAI: ${openAIMessage}`);
  assert.equal((await f.health()).active_requests, 0);
  assertSingleRequest(f);
  assert.equal(f.used.length, 0);
});

test('only explicit overflow codes/types or the complete known message are normalized', async () => {
  for (const value of [
    { error: { code: 'context_length_exceeded', message: 'The synthetic input is too large.' } },
    { error: { type: 'context_length_exceeded', message: 'Limite atingido 🌎' } },
    { code: 'context_length_exceeded', message: 'synthetic detail' },
    { error: { code: 'context_length_exceeded' } },
  ]) {
    const bytes = Buffer.from(JSON.stringify(value));
    const output = await collect(transform('application/json', 400), Array.from(bytes, byte => Buffer.from([byte])));
    const normalized = assertOverflow(output);
    assert.equal(normalized.error.message, `prompt is too long. OpenAI: ${(value.error ?? value).message ?? 'context_length_exceeded'}`);
  }
  for (const value of [
    { error: { type: 'invalid_request_error', message: `Prefix: ${openAIMessage}` } },
    { error: { type: 'invalid_request_error', message: `${openAIMessage} Extra.` } },
    { error: { code: 'invalid_value', message: 'context window setting is invalid' } },
    { error: { code: 'invalid_value', message: 'prompt is too long for this tool parameter' } },
    { error: { code: 'context_length_exceeded_similar', message: 'unrelated' } },
    { type: 'error', error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: `prompt is too long. OpenAI: ${openAIMessage}` } },
    { content: [{ type: 'text', text: openAIMessage }] },
    { error: openAIMessage }, null, [],
  ]) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    assert.deepEqual(await collect(transform('application/json', 400), [bytes]), bytes);
  }
});

test('unrelated HTTP 400 JSON remains byte-exact and cannot rotate accounts', async t => {
  const bytes = Buffer.from('{  "error": {"type": "invalid_request_error", "message": "Tool name inválido 🌎"} }\n');
  const f = await fixture(t, response => {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
    response.end(bytes);
  });
  const response = await f.post();
  assert.equal(response.status, 400);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assertSingleRequest(f);
});

test('non-JSON and successful JSON preserve content length and bytes', async t => {
  for (const [status, type, bytes] of [
    [400, 'text/plain', Buffer.from(openAIMessage)],
    [400, 'text/html', Buffer.from(`<p>${openAIMessage}</p>`)],
    [200, 'application/json', rawError],
    [500, 'application/json', rawError],
    [400, 'application/json', Buffer.from(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x'.repeat(contextErrorBufferBytes) } }))],
  ]) {
    await t.test(`${status} ${type}`, async t => {
      const f = await fixture(t, response => { response.writeHead(status, { 'content-type': type, 'content-length': bytes.length }); response.end(bytes); });
      const response = await f.post();
      assert.equal(response.status, status);
      assert.equal(response.headers.get('content-length'), String(bytes.length));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assertSingleRequest(f);
    });
  }
});

test('malformed, invalid UTF-8 and oversized JSON pass through with bounded inspection', async () => {
  for (const bytes of [Buffer.from('{"error":'), Buffer.concat([rawError, Buffer.from([0xff])]),
    Buffer.from(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x'.repeat(contextErrorBufferBytes) } }))]) {
    const chunks = []; for (let offset = 0; offset < bytes.length; offset += 97) chunks.push(bytes.subarray(offset, offset + 97));
    assert.deepEqual(await collect(transform('application/json', 400), chunks), bytes);
  }
  assert.equal(createContextErrorTransform({ statusCode: 400, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), null);
});

test('router normalizes an SSE error after partial output without replaying or changing successful bytes', async t => {
  const prefix = Buffer.from('event: message_start\ndata: {"message":{"id":"synthetic"}}\n\nevent: content_block_delta\ndata: {"delta":{"text":"A  B\\nSão Paulo 🌎"}}\n\n');
  const error = Buffer.from(`event: error\ndata: ${rawError}\n\n`);
  const f = await fixture(t, async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': prefix.length + error.length });
    response.write(prefix);
    await nextTurn();
    for (const byte of error) { response.write(Buffer.from([byte])); await nextTurn(); }
    response.end();
  });
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  const normalized = bytes.subarray(prefix.length).toString();
  assert.ok(normalized.startsWith('event: error\ndata: '));
  assertOverflow(normalized.slice('event: error\ndata: '.length));
  assert.equal((await f.health()).active_requests, 0);
  assertSingleRequest(f);
  assert.equal(f.used.length, 1);
});

test('SSE handles every split position, byte fragments, CRLF, UTF-8 and multiple data fields', async () => {
  for (const newline of ['\n', '\r\n']) {
    const start = `: comentário 🌎${newline}id: synthetic${newline}retry: 123${newline}`;
    const input = Buffer.from(`${start}data: {"error":${newline}data: {"code":"context_length_exceeded",${newline}data: "message":"São Paulo 🌎"}}${newline}event: error${newline}${newline}`);
    const verify = bytes => {
      const text = bytes.toString();
      const encoded = text.match(/data: ([^\r\n]*)/)[1];
      assert.deepEqual(assertOverflow(encoded), { type: 'error', error: { code: 'context_length_exceeded', message: 'prompt is too long. OpenAI: São Paulo 🌎', type: 'invalid_request_error' } });
      assert.equal(text.replace(encoded, '<normalized>'), `${start}data: <normalized>${newline}event: error${newline}${newline}`);
    };
    for (let split = 0; split <= input.length; split++) {
      verify(await collect(transform('text/event-stream'), [input.subarray(0, split), input.subarray(split)]));
    }
    verify(await collect(transform('text/event-stream'), Array.from(input, byte => Buffer.from([byte]))));
  }
});

test('SSE success, unknown errors and incomplete frames retain exact whitespace and bytes', async () => {
  const inputs = [
    `event: content_block_delta\r\ndata: {"delta":{"text":"now 15/15 green; 63 passed.\\n🌎"}}\r\n\r\n`,
    `event: error\ndata: { "error": { "message": "another error" } }\n\n`,
    `data: ${rawError}\n\n`,
    `event: error\nevent: content_block_delta\ndata: ${rawError}\n\n`,
    `event: error\ndata: ${rawError}\n`,
    `event: error\ndata: broken JSON\n\n`,
    `event: ping\ndata: {}\n\n: heartbeat\n\n`,
  ];
  for (const input of inputs) {
    const bytes = Buffer.from(input);
    assert.deepEqual(await collect(transform('text/event-stream'), Array.from(bytes, byte => Buffer.from([byte]))), bytes);
  }
  const invalid = Buffer.concat([Buffer.from('event: error\ndata: '), rawError, Buffer.from([0xff, 10, 10])]);
  assert.deepEqual(await collect(transform('text/event-stream'), [invalid]), invalid);
});

test('oversized SSE frames pass through and following bounded errors are still normalized', async () => {
  const oversized = Buffer.from(`event: error\ndata: {"error":{"code":"context_length_exceeded","message":"${'x'.repeat(contextErrorBufferBytes * 3)}"}}\r\n\r\n`);
  const suffix = Buffer.from(`event: error\r\ndata: ${rawError}\r\n\r\n`);
  const input = Buffer.concat([oversized, suffix]);
  const chunks = []; for (let offset = 0; offset < input.length; offset += 71) chunks.push(input.subarray(offset, offset + 71));
  const result = await collect(transform('text/event-stream'), chunks);
  assert.deepEqual(result.subarray(0, oversized.length), oversized);
  assertOverflow(result.subarray(oversized.length).toString().slice('event: error\r\ndata: '.length));
});

test('SSE backpressure bounds upstream reads when the downstream consumer pauses', async () => {
  const chunk = Buffer.from(`event: content_block_delta\ndata: {"delta":{"text":"${'x'.repeat(4000)}"}}\n\n`);
  let produced = 0;
  let release;
  let reached;
  const reachedPromise = new Promise(resolve => { reached = resolve; });
  const source = Readable.from((async function* () { for (let index = 0; index < 2000; index++) { produced++; yield chunk; } })(), { objectMode: false, highWaterMark: 8192 });
  const sink = new Writable({ highWaterMark: 8192, write(bytes, encoding, callback) { if (!release) { release = callback; reached(); } else callback(); } });
  const running = pipeline(source, transform('text/event-stream'), sink);
  await reachedPromise;
  await nextTurn();
  assert.ok(produced < 100, `read ${produced} chunks while the consumer was paused`);
  release();
  await running;
  assert.equal(produced, 2000);
});

test('JSON and SSE over-limit inspection flushes before upstream completion', async () => {
  for (const [type, status] of [['application/json', 400], ['text/event-stream', 200]]) {
    const stream = transform(type, status);
    const chunk = Buffer.alloc(contextErrorBufferBytes + 1, 120);
    const first = once(stream, 'data');
    stream.write(chunk);
    assert.deepEqual((await first)[0], chunk);
    stream.end();
    await once(stream, 'end');
  }
});

test('client cancellation during a buffered HTTP error releases the account and cancels upstream once', async t => {
  let closed, started;
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const startedPromise = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, response => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.write('{"error":');
    response.once('close', closed);
    started();
  });
  const abort = new AbortController();
  const response = f.post({ signal: abort.signal }).catch(error => error);
  await startedPromise;
  abort.abort();
  await response;
  await closedPromise;
  assert.equal((await f.health()).active_requests, 0);
  assertSingleRequest(f);
});

test('client cancellation after a successful SSE frame closes upstream and never replays', async t => {
  let closed;
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const prefix = 'event: content_block_delta\ndata: {"delta":{"text":"first"}}\n\n';
  const f = await fixture(t, response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(prefix);
    response.once('close', closed);
  });
  const abort = new AbortController();
  const response = await f.post({ signal: abort.signal });
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), prefix);
  abort.abort();
  await closedPromise;
  assert.equal((await f.health()).active_requests, 0);
  assertSingleRequest(f);
});

test('upstream failure after a partial response preserves cleanup and cannot replay', async t => {
  let upstream;
  const prefix = 'event: content_block_delta\ndata: {"delta":{"text":"partial"}}\n\n';
  const f = await fixture(t, response => {
    upstream = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(prefix);
  });
  const response = await f.post();
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), prefix);
  upstream.destroy();
  await assert.rejects(reader.read());
  assert.equal((await f.health()).active_requests, 0);
  assertSingleRequest(f);
});
