import http from 'node:http';
import { pipeline } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { models, resolveModel } from './model-catalog.mjs';
import { adaptMessage } from './model-adapter.mjs';
import { BridgeError } from './pool-controller.mjs';

const forwardedHeaders = new Set(['anthropic-version', 'anthropic-beta', 'user-agent', 'accept',
  'x-client-request-id', 'x-session-id', 'x-claude-code-session-id', 'x-claude-code-parent-session-id',
  'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch',
  'x-stainless-runtime', 'x-stainless-runtime-version']);

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function readBody(request, maximum) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new BridgeError(415, 'Envie uma solicitação JSON.');
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new BridgeError(413, 'A solicitação excede o limite local.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks)); } catch { throw new BridgeError(400, 'JSON inválido.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError(400, 'Objeto JSON obrigatório.');
  return value;
}

export function createPoolRouter({ controller, getClientKey, backendPort = 18768, maxBodyBytes = 64 * 1024 * 1024, pagePath = new URL('./accounts.html', import.meta.url) }) {
  let activeRequests = 0;
  const server = http.createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    try {
      const port = server.address()?.port;
      const host = request.headers.host;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(host)) throw new BridgeError(403, 'Host local obrigatório.');
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) throw new BridgeError(403, 'Origem local obrigatória.');
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/healthz') {
        json(response, 200, { status: 'ok', backend: 'codex-pool', active_requests: activeRequests }); return;
      }
      if (request.method === 'GET' && path === '/v1/models') {
        const data = models.map(m => ({ type: 'model', id: m.id, display_name: m.label }));
        json(response, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }); return;
      }
      if (request.method === 'GET' && ['/', '/accounts', '/monitor'].includes(path)) {
        const page = await readFile(pagePath);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        response.end(page); return;
      }
      if (request.method === 'GET' && path === '/_bridge/accounts') {
        json(response, 200, { ...(await controller.status()), active_requests: activeRequests }); return;
      }
      if (request.method === 'POST' && ['/_bridge/settings', '/_bridge/refresh', '/_bridge/connect', '/_bridge/connect/cancel', '/_bridge/disconnect'].includes(path)) {
        if (origin !== `http://${host}` || request.headers['x-bridge-action'] !== 'accounts') throw new BridgeError(403, 'Abra o painel local para mudar as contas.');
        const body = await readBody(request, 8192);
        if (path.endsWith('/settings')) await controller.update(body);
        if (path === '/_bridge/connect') { json(response, 200, await controller.connect(body.email)); return; }
        if (path === '/_bridge/connect/cancel') await controller.cancelConnection();
        if (path === '/_bridge/disconnect') await controller.disconnect(body.email);
        json(response, 200, { ...(await controller.status(path.endsWith('/refresh'))), active_requests: activeRequests }); return;
      }
      if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) throw new BridgeError(404, 'Endpoint não disponível.');
      const value = await readBody(request, maxBodyBytes);
      if (!resolveModel(value.model)) throw new BridgeError(400, 'Este perfil aceita somente GPT-6.1 Sol e GPT-6 Astra, normal ou Fast.');
      activeRequests++;
      let settled = false;
      let activeRelease = null;
      const settle = () => { if (!settled) { activeRelease?.(); activeRequests--; settled = true; } };
      response.once('close', settle); response.once('finish', settle);
      const countOnly = path.endsWith('/count_tokens');
      const key = await getClientKey();
      for await (const account of controller.candidates({ countOnly, signal: abort.signal })) {
        const releaseAccount = controller.acquire(account);
        if (!releaseAccount) continue;
        activeRelease = releaseAccount;
        let incoming;
        try {
        let body;
        try { body = Buffer.from(JSON.stringify(adaptMessage(value, account.prefix))); }
        catch (error) { throw new BridgeError(400, error.message); }
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => forwardedHeaders.has(key)));
        Object.assign(headers, { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': body.length });
        incoming = await new Promise((resolve, reject) => {
          const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, path, method: 'POST', headers, signal: abort.signal }, resolve);
          upstream.on('error', reject); upstream.end(body);
        });
        } catch (error) { releaseAccount(); activeRelease = null; throw error; }
        if (!countOnly && [401, 402, 403, 429].includes(incoming.statusCode)) {
          incoming.destroy(); releaseAccount(); activeRelease = null; controller.markUnavailable(account, incoming.statusCode); continue;
        }
        if (response.destroyed) { incoming.destroy(); return; }
        if (incoming.statusCode >= 200 && incoming.statusCode < 300 && !countOnly) controller.markUsed(account);
        const responseHeaders = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) =>
          ['content-type', 'content-length', 'cache-control', 'retry-after', 'request-id', 'x-request-id'].includes(key)));
        response.writeHead(incoming.statusCode, { ...responseHeaders, 'cache-control': 'no-store' });
        // From this point onward, never replay the request or any partial tool output on another account.
        pipeline(incoming, response, () => {}); return;
      }
      throw new BridgeError(429, 'Nenhuma conta selecionada tem limite disponível e confirmado. Consulte o painel de contas; novas solicitações serão liberadas quando a cota voltar.');
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof BridgeError ? error.status : 502;
      json(response, status, { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'api_error',
        message: error instanceof BridgeError ? error.message : 'O serviço local do Codex não está disponível. Tente novamente.' } });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  return server;
}
