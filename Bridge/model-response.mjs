import { resolveModelVariant } from './model-catalog.mjs';
import { BoundedJSONTransform, BoundedSSETransform } from './message-transforms.mjs';

export const modelResponseBufferBytes = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
function parse(bytes) { try { return JSON.parse(decoder.decode(bytes)); } catch { return null; } }
function rewrite(message, requested, variant) {
  if (!message || message.type !== 'message' || typeof message.model !== 'string') return false;
  const resolved = resolveModelVariant(message.model);
  if (message.model !== variant.baseModel && message.model !== variant.target && resolved?.id !== variant.id) return false;
  if (message.model === requested) return false;
  message.model = requested; return true;
}

// Claude <=2.1.300 can repeatedly compact when a compatible gateway echoes the
// provider's real model rather than the requested protocol alias. Change only
// confirmed equivalent names; never conceal a different upstream model.
export function createModelResponseTransform(response, requested, { idleMs = 15000 } = {}) {
  const variant = resolveModelVariant(requested);
  if (!variant || response.statusCode < 200 || response.statusCode >= 300 ||
    (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) return null;
  const type = response.headers['content-type'] ?? '';
  if (/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(type)) {
    const size = response.headers['content-length'];
    if (typeof size === 'string' && /^\d+$/.test(size) && Number(size) > modelResponseBufferBytes) return null;
    return new BoundedJSONTransform(bytes => {
      const value = parse(bytes);
      return rewrite(value, requested, variant) ? Buffer.from(JSON.stringify(value)) : bytes;
    }, modelResponseBufferBytes);
  }
  if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(type)) return null;
  let started = false;
  return new BoundedSSETransform(bytes => {
    let text;
    try { text = decoder.decode(bytes); } catch { return bytes; }
    const lines = text.split(/\r?\n/), data = [];
    let event = '';
    for (const line of lines) {
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = (separator < 0 ? '' : line.slice(separator + 1)).replace(/^ /, '');
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
    if (event === 'message_stop' || event === 'error') { started = false; return bytes; }
    if (event !== 'message_start') return bytes;
    const value = parse(Buffer.from(data.join('\n')));
    if (value?.type !== 'message_start' || value.message?.type !== 'message') return bytes;
    started = true;
    if (!rewrite(value.message, requested, variant)) return bytes;
    let emitted = false;
    return Buffer.from(text.split(/(?<=\n)/).map(line => {
      if (!/^data(?::|\r?\n|$)/.test(line)) return line;
      if (emitted) return ''; emitted = true;
      return `data: ${JSON.stringify(value)}${line.endsWith('\r\n') ? '\r\n' : '\n'}`;
    }).join(''));
  }, 64 * 1024, { idleMs, canPing: () => started });
}
