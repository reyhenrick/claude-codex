export const upstreamIdleTimeoutMs = 30 * 60 * 1000;

// Heartbeats keep a working client connected; they are not evidence of provider
// progress. Bound actual upstream silence independently, including partial
// events and downstream backpressure. A timeout aborts the current response and
// never turns a partial response into another attempt on another account.
export function guardUpstreamSilence(incoming, milliseconds = upstreamIdleTimeoutMs) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 2147483647) throw new TypeError('Invalid upstream idle limit.');
  const timeout = setTimeout(() => {
    clear();
    incoming.destroy(Object.assign(new Error('Upstream stream became inactive.'), { code: 'BRIDGE_UPSTREAM_IDLE' }));
  }, milliseconds);
  timeout.unref();
  const progress = () => timeout.refresh();
  function clear() {
    clearTimeout(timeout);
    incoming.off('data', progress); incoming.off('end', clear); incoming.off('close', clear);
  }
  incoming.on('data', progress);
  incoming.once('end', clear); incoming.once('close', clear);
  return clear;
}
