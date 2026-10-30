import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createTokenUsageObserver } from './token-usage-observer.mjs';

const reported = { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 5 };
const expected = { input_tokens: 20, output_tokens: 10, cache_read_tokens: 70, cache_write_tokens: 5 };
const event = (name, value, newline = '\n') => `event: ${name}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
const terminal = (usage = reported, newline) => event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }, newline);
const start = event('message_start', { type: 'message_start', message: { type: 'message', usage: { input_tokens: 99999, output_tokens: 0 } } });
function fixture(type = 'text/event-stream', headers = {}, callback) {
  const values = [], bytes = [];
  const observer = createTokenUsageObserver({ statusCode: 200, headers: { 'content-type': type, ...headers } }, value => { values.push(value); callback?.(value); });
  observer.on('data', chunk => bytes.push(Buffer.from(chunk)));
  return { observer, values, bytes };
}
async function complete(f, chunks) { const done = once(f.observer, 'end'); for (const chunk of chunks) f.observer.write(Buffer.from(chunk)); f.observer.end(); await done; }

test('SSE byte splits, CRLF and duplicate cumulative receipts count once without initial estimates', async () => {
  for (const newline of ['\n', '\r\n']) {
    const text = start + event('content_block_delta', { type: 'content_block_delta', delta: { text: 'olá 🌍' } }, newline) + terminal(reported, newline) + terminal(reported, newline) + event('message_stop', { type: 'message_stop' }, newline);
    const source = Buffer.from(text), f = fixture(); await complete(f, Array.from(source, byte => Buffer.from([byte])));
    assert.deepEqual(Buffer.concat(f.bytes), source); assert.deepEqual(f.values, [expected]);
  }
});

test('the first bytes are delivered before a complete SSE event or JSON document', async () => {
  for (const [type, prefix] of [['text/event-stream', 'event: content_block_delta\ndata: {'], ['application/json', '{"type":"message","content":[']]) {
    const f = fixture(type); f.observer.write(prefix); assert.equal(Buffer.concat(f.bytes).toString(), prefix);
    const closed = once(f.observer, 'close'); f.observer.destroy(); await closed; assert.deepEqual(f.values, [null]);
  }
});

test('oversized content resynchronizes at the next SSE event and retains terminal usage', async () => {
  const f = fixture(), text = start + event('content_block_delta', { delta: { text: 'x'.repeat(200000) } }) + ': ping\n\n' + terminal();
  await complete(f, [text.slice(0, 100000), text.slice(100000)]); assert.deepEqual(f.values, [expected]); assert.equal(Buffer.concat(f.bytes).toString(), text);
});

test('cancelled requests only count when terminal usage was already observed', async () => {
  for (const usage of [false, true]) {
    const f = fixture(); f.observer.write(start + (usage ? terminal() : '')); const closed = once(f.observer, 'close'); f.observer.destroy(); await closed;
    assert.deepEqual(f.values, [usage ? expected : null]);
  }
});

test('synchronous cancellation while receiving a terminal chunk records it once and does not throw', async () => {
  const f = fixture(), closed = once(f.observer, 'close');
  f.observer.once('data', () => f.observer.destroy());
  assert.doesNotThrow(() => f.observer.write(terminal())); await closed;
  assert.deepEqual(f.values, [expected]);
});

test('invalid, incomplete and estimated usage is not reported as consumption', async () => {
  for (const usage of [{ ...reported, input_tokens: -1 }, { ...reported, input_tokens: '20' }, { ...reported, output_tokens: undefined },
    { ...reported, cache_read_input_tokens: null }, { ...reported, input_tokens: Number.MAX_SAFE_INTEGER }]) {
    const f = fixture(); await complete(f, [start, terminal(usage)]); assert.deepEqual(f.values, [null]);
  }
  const f = fixture(); await complete(f, [start, event('message_delta', { type: 'message_delta', usage: reported, delta: {} })]); assert.deepEqual(f.values, [null]);
});

test('a later malformed event does not erase a confirmed receipt', async () => {
  const f = fixture(); await complete(f, [terminal(), terminal({})]); assert.deepEqual(f.values, [expected]);
});

test('multiline data and absent optional cache fields are supported', async () => {
  const f = fixture(); await complete(f, ['event: message_delta\ndata: {"type":"message_delta",\ndata: "delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":1,"output_tokens":2}}\n\n']);
  assert.deepEqual(f.values, [{ input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 }]);
});

test('completed JSON reports usage once; oversized, malformed and compressed bytes remain unchanged', async () => {
  const body = JSON.stringify({ type: 'message', usage: reported, content: [] });
  const f = fixture('application/json'); await complete(f, [body]); assert.deepEqual(f.values, [expected]);
  for (const bytes of [Buffer.from('{'), Buffer.from('{"text":"' + 'x'.repeat(2 * 1024 * 1024) + '"}')]) {
    const f = fixture('application/json'); await complete(f, [bytes]); assert.deepEqual(f.values, [null]); assert.deepEqual(Buffer.concat(f.bytes), bytes);
  }
  const compressed = gzipSync(Buffer.from(body)), encoded = fixture('application/json', { 'content-encoding': 'gzip' });
  await complete(encoded, [compressed]); assert.deepEqual(encoded.values, [null]); assert.deepEqual(Buffer.concat(encoded.bytes), compressed);
});

test('accounting exceptions and non-success descriptors cannot fail the primary response', async () => {
  const f = fixture('text/event-stream', {}, () => { throw Error('synthetic disk failure'); });
  await complete(f, [terminal()]); assert.deepEqual(f.values, [expected]);
  assert.equal(createTokenUsageObserver({ statusCode: 429, headers: {} }, () => {}), null);
});
