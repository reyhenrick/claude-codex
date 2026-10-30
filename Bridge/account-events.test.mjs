import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createPoolRouter } from './pool-router.mjs';
import { createAccountEvents } from './account-events.mjs';

const key = 'S'.repeat(64);
async function fixture(t) {
  const emitter = new EventEmitter();
  const controller = { subscribe: callback => { emitter.on('change', callback); return () => emitter.off('change', callback); },
    readState: async () => ({}), resetInFlight: new Map(), status: async () => ({ revision: 1 }) };
  const server = createPoolRouter({ controller, getIngressKey: async () => key, getClientKey: async () => 'synthetic' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, emitter };
}
async function subscribe(base) {
  const wire = new EventEmitter(); let bytes = '', response;
  const request = http.get(base + '/_bridge/events', { headers: { authorization: `Bearer ${key}` } }, incoming => {
    response = incoming; incoming.on('data', chunk => { bytes += chunk; wire.emit('bytes'); });
    incoming.on('error', () => {}); incoming.on('close', () => wire.emit('closed'));
  });
  request.on('error', () => {});
  const waitFor = async count => { while ((bytes.match(/event: changed/g) ?? []).length < count) await once(wire, 'bytes'); };
  await waitFor(1);
  return { request, wire, waitFor, text: () => bytes, response: () => response };
}

test('live updates require authentication, contain no account data and leave inference activity idle', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/_bridge/events')).status, 401);
  const stream = await subscribe(f.base); t.after(() => stream.request.destroy());
  assert.equal(stream.response().headers['content-type'], 'text/event-stream');
  assert.equal(stream.text(), 'event: changed\ndata: {}\n\n');
  const health = await fetch(f.base + '/healthz', { headers: { authorization: `Bearer ${key}` } });
  assert.equal((await health.json()).active_requests, 0);
  for (let index = 0; index < 20; index++) f.emitter.emit('change');
  await stream.waitFor(2); assert.equal((stream.text().match(/event: changed/g) ?? []).length, 2);
  const disconnected = once(stream.wire, 'closed'); stream.request.destroy(); await disconnected;
  const reconnected = await subscribe(f.base); assert.match(reconnected.text(), /event: changed/); reconnected.request.destroy();
});

test('service close ends subscriptions and detaches its change listener', { timeout: 3000 }, async t => {
  const f = await fixture(t), stream = await subscribe(f.base), closed = once(stream.wire, 'closed');
  assert.equal(f.emitter.listenerCount('change'), 1);
  await new Promise(resolve => f.server.close(resolve)); await closed;
  assert.equal(f.emitter.listenerCount('change'), 0);
});

test('a subscription awaiting authentication cannot reopen the hub during shutdown', { timeout: 3000 }, async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  const server = createPoolRouter({ controller: {}, getClientKey: async () => 'synthetic', getIngressKey: async () => { entered(); await gate; return key; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = http.get(`http://127.0.0.1:${server.address().port}/_bridge/events`, { headers: { authorization: `Bearer ${key}` } });
  request.on('error', () => {}); t.after(() => request.destroy());
  await waiting; const closed = new Promise(resolve => server.close(resolve)); release(); await closed;
  assert.equal(server.listening, false);
});

test('heartbeats keep the subscription live and a backpressured client is bounded', { timeout: 3000 }, async () => {
  const emitter = new EventEmitter(), controller = { subscribe: callback => { emitter.on('change', callback); return () => emitter.off('change', callback); } };
  const response = new EventEmitter(); let bytes = '', destroyed = false;
  Object.assign(response, { writableLength: 0, writeHead() {}, write(value) { bytes += value; response.emit('written'); }, destroy() { destroyed = true; response.emit('close'); } });
  const events = createAccountEvents(controller, { heartbeatMs: 5, coalesceMs: 1 });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    events.connect(response); await once(response, 'written'); assert.match(bytes, /: heartbeat/);
    response.writableLength = 65537; emitter.emit('change');
    await once(response, 'close'); assert.equal(destroyed, true);
  } finally { events.close(); clearInterval(keepAlive); }
  assert.equal(emitter.listenerCount('change'), 0);
});
