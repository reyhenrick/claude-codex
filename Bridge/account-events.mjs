// Invalidations contain no account data. Clients fetch a fresh authenticated
// snapshot, including after reconnect, so missed events cannot create gaps.
export function createAccountEvents(controller, { heartbeatMs = 15000, coalesceMs = 50 } = {}) {
  const clients = new Set(); let scheduled = null, closed = false;
  const send = response => {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength > 65536) { response.destroy(); return; }
    response.write('event: changed\ndata: {}\n\n');
  };
  const unsubscribe = controller.subscribe?.(() => {
    if (!clients.size || scheduled) return;
    scheduled = setTimeout(() => { scheduled = null; for (const response of clients) send(response); }, coalesceMs);
    scheduled.unref();
  });
  const heartbeat = setInterval(() => {
    for (const response of clients) {
      if (response.writableLength > 65536) response.destroy();
      else if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n');
    }
  }, heartbeatMs);
  heartbeat.unref();
  return {
    connect(response) {
      if (closed || response.destroyed || response.writableEnded) { response.destroy(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      clients.add(response); response.once('close', () => clients.delete(response)); send(response);
    },
    close() {
      closed = true;
      clearTimeout(scheduled); scheduled = null; clearInterval(heartbeat); unsubscribe?.();
      for (const response of clients) response.destroy();
      clients.clear();
    },
  };
}
