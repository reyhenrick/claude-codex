import { Transform } from 'node:stream';

export const contextErrorBufferBytes = 64 * 1024;
const openAIContextMessage = 'Your input exceeds the context window of this model. Please adjust your input and try again.';
const decoder = new TextDecoder('utf-8', { fatal: true });

function normalizeError(bytes) {
  let value;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = value.error ?? value;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  if (error.code !== 'context_length_exceeded' && error.type !== 'context_length_exceeded' && error.message !== openAIContextMessage) return null;
  if (error.type === 'invalid_request_error' && typeof error.message === 'string' && error.message.startsWith('prompt is too long. OpenAI: ')) return null;
  const detail = typeof error.message === 'string' && error.message ? error.message : 'context_length_exceeded';
  return Buffer.from(JSON.stringify({
    ...(value.error ? value : {}),
    type: 'error',
    error: { ...error, type: 'invalid_request_error', code: 'context_length_exceeded', message: `prompt is too long. OpenAI: ${detail}` },
  }));
}

class JSONContextErrorTransform extends Transform {
  constructor() {
    super();
    this.buffer = Buffer.allocUnsafe(contextErrorBufferBytes);
    this.length = 0;
    this.passthrough = false;
  }

  _transform(chunk, encoding, callback) {
    if (this.passthrough) this.push(chunk);
    else if (this.length + chunk.length > this.buffer.length) {
      if (this.length) this.push(this.buffer.subarray(0, this.length));
      this.buffer = null;
      this.passthrough = true;
      this.push(chunk);
    } else {
      chunk.copy(this.buffer, this.length);
      this.length += chunk.length;
    }
    callback();
  }

  _flush(callback) {
    if (!this.passthrough) {
      const bytes = this.buffer.subarray(0, this.length);
      this.push(normalizeError(bytes) ?? bytes);
    }
    callback();
  }
}

function normalizeEvent(bytes) {
  let text;
  try { text = decoder.decode(bytes); } catch { return bytes; }
  const lines = text.split(/\r?\n/);
  let event = '';
  const data = [];
  for (const line of lines) {
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (event !== 'error') return bytes;
  const normalized = normalizeError(Buffer.from(data.join('\n')));
  if (!normalized) return bytes;
  let replaced = false;
  return Buffer.from(text.split(/(?<=\n)/).map(line => {
    if (!/^data(?::|\r?\n|$)/.test(line)) return line;
    if (replaced) return '';
    replaced = true;
    return `data: ${normalized.toString('utf8')}${line.endsWith('\r\n') ? '\r\n' : '\n'}`;
  }).join(''));
}

class SSEContextErrorTransform extends Transform {
  constructor() {
    super();
    this.buffer = Buffer.allocUnsafe(contextErrorBufferBytes);
    this.length = 0;
    this.lineLength = 0;
    this.lastByte = 0;
    this.passthrough = false;
  }

  append(chunk) {
    if (this.passthrough) this.push(chunk);
    else if (this.length + chunk.length > this.buffer.length) {
      if (this.length) this.push(Buffer.from(this.buffer.subarray(0, this.length)));
      this.length = 0;
      this.passthrough = true;
      this.push(chunk);
    } else {
      chunk.copy(this.buffer, this.length);
      this.length += chunk.length;
    }
  }

  _transform(chunk, encoding, callback) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      const boundary = byte === 10 && (this.lineLength === 0 || (this.lineLength === 1 && this.lastByte === 13));
      this.lineLength = byte === 10 ? 0 : Math.min(this.lineLength + 1, 2);
      this.lastByte = byte;
      if (!boundary) continue;
      this.append(chunk.subarray(start, index + 1));
      if (!this.passthrough) this.push(normalizeEvent(Buffer.from(this.buffer.subarray(0, this.length))));
      this.length = 0;
      this.passthrough = false;
      start = index + 1;
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
    callback();
  }

  _flush(callback) {
    if (this.length) this.push(Buffer.from(this.buffer.subarray(0, this.length)));
    callback();
  }
}

export function createContextErrorTransform(response) {
  if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return null;
  const contentType = response.headers['content-type'] ?? '';
  if (/^text\/event-stream(?:\s*;|\s*$)/i.test(contentType)) return new SSEContextErrorTransform();
  if (response.statusCode === 400 && /^application\/(?:json|[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(contentType)) {
    const length = response.headers['content-length'];
    if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > contextErrorBufferBytes) return null;
    return new JSONContextErrorTransform();
  }
  return null;
}
