import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createModelResponseTransform, modelResponseBufferBytes } from './model-response.mjs';
import { models } from './model-catalog.mjs';
const response = (type = 'text/event-stream', statusCode = 200, extra = {}) => ({ statusCode, headers: { 'content-type': type, ...extra } });
const message = model => ({ id: 'msg_synthetic', type: 'message', role: 'assistant', model,
  content: [{ type: 'text', text: 'preserve → 🧪' }], usage: { input_tokens: 700, output_tokens: 23 } });
const start = (model, newline = '\n') => Buffer.from(`event: message_start${newline}data: ${JSON.stringify({ type: 'message_start', message: message(model) })}${newline}${newline}`);
async function collect(transform, chunks) {
  const output = []; const done = (async () => { for await (const chunk of transform) output.push(chunk); })();
  for (const chunk of chunks) transform.write(chunk); transform.end(); await done; return Buffer.concat(output);
}

test('every model, speed, 1m suffix and compatibility alias restores only the matching protocol name', async () => {
  for (const variant of models) for (const requested of [variant.id, variant.id + '[1m]', variant.target]) {
    const original = message(variant.baseModel), bytes = Buffer.from(JSON.stringify(original));
    const output = await collect(createModelResponseTransform(response('application/json'), requested), [bytes]);
    assert.deepEqual(JSON.parse(output), { ...original, model: requested });
  }
  const output = await collect(createModelResponseTransform(response('application/json'), 'claude-sonnet-5-5-fast'), [Buffer.from(JSON.stringify(message('gpt-6.1-sol')))]);
  assert.equal(JSON.parse(output).model, 'claude-sonnet-5-5-fast');
});

test('SSE framing survives every byte split, LF/CRLF, Unicode, comments and subsequent tool/usage bytes', async () => {
  for (const newline of ['\n', '\r\n']) {
    const tail = Buffer.from(`: keep${newline}${newline}event: content_block_delta${newline}data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"value\\": 42}"}}${newline}${newline}event: message_stop${newline}data: {"type":"message_stop"}${newline}${newline}`);
    const input = Buffer.concat([start('gpt-6-astra', newline), tail]);
    for (let split = 1; split < input.length; split++) {
      const output = await collect(createModelResponseTransform(response(), 'claude-opus-5-5[1m]', { idleMs: 0 }), [input.subarray(0, split), input.subarray(split)]);
      assert.ok(output.includes(Buffer.from('"model":"claude-opus-5-5[1m]"')));
      assert.deepEqual(output.subarray(output.length - tail.length), tail);
    }
    const output = await collect(createModelResponseTransform(response(), 'claude-opus-5-5', { idleMs: 0 }), [...input].map(byte => Buffer.from([byte])));
    assert.ok(output.includes(Buffer.from('preserve → 🧪')));
  }
});

test('unknown or genuinely different model, invalid content, errors and incomplete frames remain unchanged', async () => {
  const bodies = [start('gpt-6-astra'), start('unknown'), Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\n'),
    Buffer.from('event: error\ndata: {"type":"error","error":{"code":"context_length_exceeded"}}\n\n'),
    start('gpt-6.1-sol').subarray(0, -1), Buffer.from([0xff, 0x0a, 0x0a])];
  for (const body of bodies) assert.deepEqual(await collect(createModelResponseTransform(response(), 'claude-sonnet-5-5', { idleMs: 0 }), [body]), body);
  for (const status of [400, 401, 429, 503]) assert.equal(createModelResponseTransform(response('application/json', status), 'claude-sonnet-5-5'), null);
  assert.equal(createModelResponseTransform(response('text/event-stream', 200, { 'content-encoding': 'gzip' }), 'claude-sonnet-5-5'), null);
});

test('bounded JSON and oversized SSE frames pass through without losing bytes or poisoning later frames', async () => {
  const body = Buffer.from(JSON.stringify({ ...message('gpt-6.1-sol'), huge: 'x'.repeat(modelResponseBufferBytes) }));
  assert.deepEqual(await collect(createModelResponseTransform(response('application/json'), 'claude-sonnet-5-5'), [body.subarray(0, 500000), body.subarray(500000)]), body);
  assert.equal(createModelResponseTransform(response('application/json', 200, { 'content-length': String(body.length) }), 'claude-sonnet-5-5'), null);
  const bigFrame = Buffer.from(`event: content_block_delta\ndata: {"text":"${'x'.repeat(70000)}"}\n\n`);
  const input = Buffer.concat([bigFrame, start('gpt-6.1-sol')]);
  const output = await collect(createModelResponseTransform(response(), 'claude-sonnet-5-5', { idleMs: 0 }), [input.subarray(0, 60000), input.subarray(60000)]);
  assert.deepEqual(output.subarray(0, bigFrame.length), bigFrame); assert.ok(output.includes(Buffer.from('"model":"claude-sonnet-5-5"')));
});

test('long silent reasoning receives bounded pings only after message_start and at complete event boundaries', async () => {
  const transform = createModelResponseTransform(response(), 'claude-sonnet-5-5', { idleMs: 15 });
  const output = []; transform.on('data', data => output.push(data));
  await new Promise(resolve => setTimeout(resolve, 45)); assert.equal(output.length, 0);
  transform.write(start('gpt-6.1-sol'));
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.ok(Buffer.concat(output).includes(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n')));
  const count = output.length;
  transform.write(Buffer.from('event: content_block_delta\ndata: {"text":"partial'));
  await new Promise(resolve => setTimeout(resolve, 45)); assert.equal(output.length, count);
  transform.write(Buffer.from('"}\n\n')); transform.write(Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
  const stopped = output.length;
  await new Promise(resolve => setTimeout(resolve, 45)); assert.equal(output.length, stopped);
  transform.destroy(); await once(transform, 'close'); assert.equal(transform.pingTimer?._destroyed, true);
});
