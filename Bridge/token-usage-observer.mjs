import { Transform } from 'node:stream';

const decoder = new TextDecoder('utf-8', { fatal: true });
const parse = bytes => { try { return JSON.parse(decoder.decode(bytes)); } catch { return null; } };
const count = value => Number.isSafeInteger(value) && value >= 0;
function receipt(usage) {
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) return null;
  const value = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens === undefined ? 0 : usage.cache_creation_input_tokens };
  if (!Object.values(value).every(count) || !Number.isSafeInteger(Object.values(value).reduce((sum, count) => sum + count, 0))) return null;
  return value;
}

// Observe original bytes without holding them back or changing their encoding.
// message_start contains a local estimate in the pinned provider; only the
// terminal message_delta (or completed JSON message) is a consumption receipt.
class TokenUsageObserver extends Transform {
  constructor(kind, record) {
    super(); this.kind = kind; this.record = record; this.receipt = null; this.finalized = false;
    this.buffer = Buffer.alloc(kind === 'json' ? 2 * 1024 * 1024 : 64 * 1024);
    this.length = 0; this.overflow = false; this.lineLength = 0; this.lastByte = 0;
  }
  append(bytes) {
    if (this.overflow) return;
    if (this.length + bytes.length > this.buffer.length) { this.overflow = true; this.length = 0; return; }
    bytes.copy(this.buffer, this.length); this.length += bytes.length;
  }
  event() {
    if (!this.overflow) {
      let text;
      try { text = decoder.decode(this.buffer.subarray(0, this.length)); } catch { text = ''; }
      const data = []; let event = '';
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (event === 'message_delta') {
        const value = parse(Buffer.from(data.join('\n')));
        if (value?.type === 'message_delta' && typeof value.delta?.stop_reason === 'string' && value.delta.stop_reason) {
          const confirmed = receipt(value.usage);
          if (confirmed) this.receipt = confirmed;
        }
      }
    }
    this.length = 0; this.overflow = false;
  }
  _transform(chunk, _encoding, done) {
    // Observe this chunk before emitting it: a downstream consumer may cancel
    // synchronously from its data handler, destroying this transform.
    if (this.kind === 'json') this.append(chunk);
    else if (this.kind === 'sse') {
      let start = 0;
      for (let index = 0; index < chunk.length; index++) {
        const byte = chunk[index], boundary = byte === 10 && (this.lineLength === 0 || this.lineLength === 1 && this.lastByte === 13);
        this.lineLength = byte === 10 ? 0 : Math.min(2, this.lineLength + 1); this.lastByte = byte;
        if (boundary) { this.append(chunk.subarray(start, index + 1)); this.event(); start = index + 1; }
      }
      if (start < chunk.length) this.append(chunk.subarray(start));
    }
    this.push(chunk); done();
  }
  finalize() {
    if (this.finalized) return; this.finalized = true;
    try { this.record(this.receipt); } catch { /* Accounting never fails inference. */ }
    this.buffer = null;
  }
  _flush(done) {
    if (this.kind === 'json' && !this.overflow) {
      const value = parse(this.buffer.subarray(0, this.length));
      if (value?.type === 'message') this.receipt = receipt(value.usage);
    }
    this.finalize(); done();
  }
  _destroy(error, done) { this.finalize(); done(error); }
}

export function createTokenUsageObserver(response, record) {
  if (typeof record !== 'function' || response.statusCode < 200 || response.statusCode >= 300) return null;
  const encoding = response.headers['content-encoding'], type = response.headers['content-type'] ?? '';
  const kind = encoding && encoding !== 'identity' ? 'unsupported' :
    /^text\/event-stream(?:\s*;|\s*$)/i.test(type) ? 'sse' :
      /^application\/(?:json|[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(type) ? 'json' : 'unsupported';
  return new TokenUsageObserver(kind, record);
}
