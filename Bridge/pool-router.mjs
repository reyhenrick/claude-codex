import http from 'node:http';
import { createTokenUsageObserver } from './token-usage-observer.mjs';
import { createAccountEvents } from './account-events.mjs';
import { pipeline } from 'node:stream';
import { resolveModel } from './model-catalog.mjs';
import { adaptMessage } from './model-adapter.mjs';
import { BridgeError } from './pool-controller.mjs';
import { authorizeClient } from './client-auth.mjs';
import { guardUpstreamSilence, upstreamIdleTimeoutMs } from './upstream-idle.mjs';
import { createModelResponseTransform } from './model-response.mjs';
import { createContextErrorTransform } from './context-errors.mjs';

const forwardedHeaders = new Set(['anthropic-version', 'anthropic-beta', 'user-agent', 'accept',
  'x-client-request-id', 'x-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id', 'x-claude-code-session-id', 'x-claude-code-parent-session-id',
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

export function createPoolRouter({ controller, getClientKey, getIngressKey, serviceIdentity, backendPort = 18768, upstreamHeaderMs = upstreamIdleTimeoutMs, upstreamIdleMs = upstreamIdleTimeoutMs, streamHeartbeatMs = 15000, maxBodyBytes = 64 * 1024 * 1024 }) {
  if (typeof getIngressKey !== 'function') throw new Error('A autenticação local do aplicativo é obrigatória.');
  if (!Number.isSafeInteger(upstreamHeaderMs) || upstreamHeaderMs < 1 || upstreamHeaderMs > 2147483647) throw new TypeError('Invalid upstream response header limit.');
  let activeRequests = 0;
  let draining = controller.pausedForUpdate === true;
  let activeActions = 0;
  const events = createAccountEvents(controller);
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
      const supplied = request.headers.authorization !== undefined || request.headers['x-api-key'] !== undefined;
      const authenticated = supplied && authorizeClient(request.headers, await getIngressKey());
      if (request.method === 'GET' && path === '/healthz') {
        if (!authenticated) { json(response, 200, { status: 'ok', backend: 'codex-pool' }); return; }
        const state = await controller.readState();
        json(response, 200, { status: 'ok', backend: 'codex-pool', ...(serviceIdentity ? { service: serviceIdentity } : {}), active_requests: activeRequests, reset_requests: controller.resetInFlight.size, pending_oauth: state.pending_oauth ? 1 : 0, pending_actions: activeActions, draining }); return;
      }
      if (!authenticated) throw new BridgeError(401, 'Autenticação local obrigatória.');
      if (request.method === 'GET' && path === '/_bridge/events') {
        if (draining) throw new BridgeError(503, 'Aguarde a atualização do aplicativo.');
        events.connect(response); return;
      }
      if (request.method === 'GET' && path === '/v1/models') {
        const data = (await controller.availableModels()).map(m => ({ type: 'model', id: m.id, display_name: m.label, supports_1m: true,
          ...(m.family ? { anthropic_family_tier: m.family, is_family_default: true } : {}) }));
        json(response, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }); return;
      }
      if (request.method === 'GET' && path === '/_bridge/accounts') {
        json(response, 200, { ...(await controller.status()), active_requests: activeRequests }); return;
      }
      if (request.method === 'POST' && ['/_bridge/settings', '/_bridge/refresh', '/_bridge/connect', '/_bridge/connect/cancel', '/_bridge/disconnect', '/_bridge/reset', '/_bridge/update/drain', '/_bridge/update/resume'].includes(path)) {
        if (origin !== `http://${host}` || request.headers['x-bridge-action'] !== 'accounts') throw new BridgeError(403, 'Abra o painel local para mudar as contas.');
        const body = await readBody(request, 8192);
        if (path === '/_bridge/update/drain' || path === '/_bridge/update/resume') {
          if (Object.keys(body).length) throw new BridgeError(400, 'A configuração da atualização é inválida.');
          const requestedDrain = path.endsWith('/drain');
          if (requestedDrain) draining = true;
          await controller.setUpdateDrain(requestedDrain); draining = requestedDrain;
          const state = await controller.readState(), resetRequests = controller.resetInFlight.size, oauth = state.pending_oauth ? 1 : 0;
          json(response, 200, { ready: draining && activeRequests === 0 && activeActions === 0 && resetRequests === 0 && oauth === 0, draining, active_requests: activeRequests, reset_requests: resetRequests, pending_oauth: oauth, pending_actions: activeActions }); return;
        }
        if (draining && path !== '/_bridge/connect/cancel' && path !== '/_bridge/refresh') throw new BridgeError(503, 'Aguarde a atualização do aplicativo.');
        const trackedAction = path !== '/_bridge/refresh';
        if (trackedAction) activeActions++;
        try {
        if (path === '/_bridge/reset') {
          if (Object.keys(body).some(k => !['email', 'revision'].includes(k)) || typeof body.email !== 'string' || !Number.isInteger(body.revision)) throw new BridgeError(400, 'Selecione a conta e uma configuração atual para aplicar o reset.');
          await controller.resetAccount(body.email, { revision: body.revision });
        }
        if (path.endsWith('/settings')) await controller.update(body);
        if (path === '/_bridge/connect') { json(response, 200, await controller.connect(body.email)); return; }
        if (path === '/_bridge/connect/cancel') await controller.cancelConnection();
        if (path === '/_bridge/disconnect') await controller.disconnect(body.email);
        json(response, 200, { ...(await controller.status(path.endsWith('/refresh'))), active_requests: activeRequests }); return;
        } finally { if (trackedAction) activeActions--; }
      }
      if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) throw new BridgeError(404, 'Endpoint não disponível.');
      if (draining) throw new BridgeError(503, 'Aguarde a atualização do aplicativo.');
      const value = await readBody(request, maxBodyBytes);
      if (draining) throw new BridgeError(503, 'Aguarde a atualização do aplicativo.');
      if (!resolveModel(value.model)) throw new BridgeError(400, 'Selecione GPT-6.1 Sol, GPT-6 Luna ou GPT-6 Astra em uma modalidade disponível neste perfil.');
      activeRequests++;
      let settled = false;
      let activeRelease = null;
      const settle = () => { if (!settled) { activeRelease?.(); activeRequests--; settled = true; } };
      response.once('close', settle); response.once('finish', settle);
      const countOnly = path.endsWith('/count_tokens');
      const key = await getClientKey();
      // Take a confirmed cache snapshot after candidate validation, without
      // waiting on capabilities of an account this call does not need.
      let instructionCatalogue;
      for await (const account of controller.candidates({ model: value.model, countOnly, signal: abort.signal })) {
        if (!await controller.validateCandidate(account, { signal: abort.signal })) continue;
        abort.signal.throwIfAborted();
        instructionCatalogue ??= controller.instructionModels(account);
        const releaseAccount = controller.acquire(account);
        if (!releaseAccount) continue;
        activeRelease = releaseAccount;
        let incoming;
        try {
        let body;
        try { body = Buffer.from(JSON.stringify(adaptMessage(value, account.prefix, instructionCatalogue))); }
        catch (error) { throw new BridgeError(400, error.message); }
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => forwardedHeaders.has(key)));
        Object.assign(headers, { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': body.length });
        if (!controller.validateCandidateNow(account)) { releaseAccount(); activeRelease = null; continue; }
        incoming = await new Promise((resolve, reject) => {
          const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, path, method: 'POST', headers, signal: abort.signal }, incoming => {
            clearTimeout(deadline); resolve(incoming);
          });
          // The streaming idle guard starts after headers. Bound the earlier
          // connection wait too, and never replay an ambiguous inference.
          const deadline = setTimeout(() => upstream.destroy(Object.assign(new Error('Upstream response headers timed out.'), { code: 'BRIDGE_UPSTREAM_HEADERS' })), upstreamHeaderMs);
          deadline.unref();
          upstream.once('close', () => clearTimeout(deadline));
          upstream.on('error', reject); upstream.end(body);
        });
        } catch (error) { releaseAccount(); activeRelease = null; throw error; }
        if ([401, 402, 403, 429].includes(incoming.statusCode)) {
          incoming.destroy(); releaseAccount(); activeRelease = null; controller.markUnavailable(account, incoming.statusCode); continue;
        }
        if (response.destroyed) { incoming.destroy(); return; }
        if (incoming.statusCode >= 200 && incoming.statusCode < 300 && !countOnly) controller.markUsed(account);
        const responseHeaders = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) =>
          ['content-type', 'content-length', 'content-encoding', 'cache-control', 'retry-after', 'x-should-retry', 'request-id', 'x-request-id'].includes(key)));
        const contextErrors = createContextErrorTransform(incoming);
        const usageObserver = countOnly ? null : createTokenUsageObserver(incoming, receipt => controller.recordTokenUsage?.(receipt));
        const modelResponse = countOnly ? null : createModelResponseTransform(incoming, value.model, { idleMs: streamHeartbeatMs });
        if (contextErrors || modelResponse) delete responseHeaders['content-length'];
        response.writeHead(incoming.statusCode, { ...responseHeaders, 'cache-control': 'no-store' });
        // From this point onward, never replay the request or any partial tool output on another account.
        const stopIdleGuard = guardUpstreamSilence(incoming, upstreamIdleMs);
        pipeline(...[incoming, usageObserver, contextErrors, modelResponse, response].filter(Boolean), () => { stopIdleGuard(); }); return;
      }
      throw new BridgeError(429, 'Nenhuma conta selecionada confirmou suporte a este modelo e modalidade com limite disponível. Consulte o painel de contas.');
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof BridgeError ? error.status : 502;
      // The provider may have accepted inference before the header deadline.
      // Prevent the client SDK from automatically replaying that ambiguous call.
      if (error.code === 'BRIDGE_UPSTREAM_HEADERS') response.setHeader('x-should-retry', 'false');
      json(response, status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'api_error',
        code: status === 401 ? 'bridge.unauthorized' : status === 409 ? 'bridge.conflict' : status === 403 ? 'bridge.local_only' : status === 429 ? 'bridge.no_capacity' : status >= 500 ? 'bridge.unavailable' : 'bridge.invalid_request',
        message: error instanceof BridgeError ? error.message : 'O serviço local do Codex não está disponível. Tente novamente.' } });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  // Open subscriptions must not keep maintenance waiting for HTTP idle.
  const close = server.close.bind(server);
  server.close = (...arguments_) => { events.close(); return close(...arguments_); };
  return server;
}
