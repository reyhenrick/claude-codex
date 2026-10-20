import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// The shipping app's existing --staging mode points only to this loopback port.
// Serve a fixed synthetic snapshot; reject every account-changing operation.
const snapshot = readFileSync(new URL('./accounts.json', import.meta.url));
const accounts = JSON.parse(snapshot).accounts;
if (!Array.isArray(accounts) || accounts.length !== 2 || !accounts.every(account => account.email?.endsWith('@example.com'))) {
  throw new Error('Documentation requires two synthetic example.com accounts.');
}
const server = createServer((request, response) => {
  const allowed = (request.method === 'GET' && request.url === '/_bridge/accounts')
    || (request.method === 'POST' && request.url === '/_bridge/refresh');
  request.resume();
  response.writeHead(allowed ? 200 : 403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(allowed ? snapshot : JSON.stringify({ error: { message: 'Documentation fixture is read-only.' } }));
});
server.listen(18769, '127.0.0.1', () => console.log(`Synthetic account fixture ready; pid=${process.pid}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
