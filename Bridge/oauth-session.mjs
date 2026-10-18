import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, rm, readdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

const executable = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const validID = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const canonicalEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const terminal = new Set(['ready', 'error', 'expired', 'cancelled', 'consumed']);
const failureCodes = new Set(['oauth.account_mismatch', 'oauth.expired', 'oauth.import_failed', 'oauth.reconnect_busy', 'oauth.session_unavailable']);
export const oauthCallbackLifetimeMs = 5 * 60 * 1000;

export class OAuthSessionError extends Error {
  constructor(code = 'oauth.session_unavailable') {
    super('A autorização precisa ser conferida no aplicativo.');
    this.name = 'OAuthSessionError'; this.code = failureCodes.has(code) ? code : 'oauth.session_unavailable';
  }
}
const unavailable = () => new OAuthSessionError();
const identityOf = stat => ({ dev: stat.dev, ino: stat.ino });
const sameFile = (first, second) => first?.dev === second?.dev && first?.ino === second?.ino;
const safeName = name => typeof name === 'string' && name.length > 5 && name.length <= 255 && basename(name) === name && !name.includes('\\') && !name.includes('\0') && name.endsWith('.json') && !name.startsWith('.');

async function privateDirectory(path, expected) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(), current = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || !current.isDirectory() ||
      !sameFile(info, current) || (expected && !sameFile(info, expected))) throw unavailable();
    return identityOf(info);
  } finally { await handle.close(); }
}
async function readPrivate(path, maximum = 1024 * 1024, expected) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      info.size < 1 || info.size > maximum || (expected && !sameFile(info, expected))) throw unavailable();
    content = await handle.readFile();
    const current = await lstat(path);
    if (content.length !== info.size || !current.isFile() || current.nlink !== 1 || current.uid !== info.uid ||
      (current.mode & 0o777) !== 0o600) throw unavailable();
    if (!sameFile(info, current)) { const error = unavailable(); error.retryAtomicRead = true; throw error; }
    return { content, identity: identityOf(info) };
  } catch (error) { content?.fill(0); throw error; }
  finally { await handle.close(); }
}
async function readJSON(path, maximum) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let content;
    try { ({ content } = await readPrivate(path, maximum)); return JSON.parse(content.toString('utf8')); }
    catch (error) {
      if (error.retryAtomicRead && attempt < 3) continue;
      if (error.code === 'ENOENT' || error instanceof OAuthSessionError) throw error;
      throw unavailable();
    } finally { content?.fill(0); }
  }
}
async function optionalJSON(path) {
  try { return await readJSON(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateJSON(path, value, exclusive = false) {
  const temporary = exclusive ? path : `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null;
    if (!exclusive) await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    if (!exclusive) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function loadSession(sessionDir) {
  const id = basename(sessionDir);
  if (!validID(id)) throw unavailable();
  await privateDirectory(dirname(sessionDir));
  const directory = await privateDirectory(sessionDir), intent = await readJSON(join(sessionDir, 'intent.json'));
  if (intent.version !== 1 || intent.id !== id || !sameFile(directory, intent.directory) ||
    !validEmail(intent.email ?? '') || intent.email !== canonicalEmail(intent.email) || !Number.isFinite(Date.parse(intent.started_at)) ||
    !Number.isFinite(Date.parse(intent.expires_at)) || !isAbsolute(intent.proxy_executable ?? '')) throw unavailable();
  return intent;
}
function publicStatus(intent, state) {
  const result = { id: intent.id, email: intent.email, started_at: intent.started_at, expires_at: intent.expires_at,
    status: state?.status ?? 'created' };
  if (!['created', 'starting', 'pending', ...terminal].includes(result.status)) throw unavailable();
  if (state?.error_code) result.error_code = failureCodes.has(state.error_code) ? state.error_code : 'oauth.session_unavailable';
  if (result.status === 'pending' && state.auth_url) result.auth_url = validateAuthorizationURL(state.auth_url, state.oauth_state).href;
  if (result.status === 'ready' && state.credential) result.credential = { name: state.credential.name, email: state.credential.email,
    account_id: state.credential.account_id, plan: state.credential.plan, digest: state.credential.digest };
  return result;
}
function validateAuthorizationURL(raw, state) {
  let url;
  try { url = new URL(raw); } catch { throw unavailable(); }
  if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash ||
    typeof state !== 'string' || state.length < 16 || state.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(state) ||
    url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state ||
    url.searchParams.getAll('redirect_uri').length !== 1 || url.searchParams.get('redirect_uri') !== 'http://localhost:1455/auth/callback' ||
    url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) throw unavailable();
  return url;
}

// PIDs alone are never authority to stop a resumed process. The command includes
// this attempt's unguessable UUID path; the initial parent relationship is saved.
export async function inspectOAuthProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  let stdout;
  try { ({ stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], { timeout: 3000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })); }
  catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return null;
    throw unavailable();
  }
  const match = stdout.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+([^\n]+)\s*$/);
  if (!match) throw unavailable();
  if (match[4].includes('Z')) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), started_at: match[5].trim(), command: match[6].trim() };
}
const sameProcess = (a, b) => Boolean(a && b && a.pid === b.pid && a.uid === b.uid && a.started_at === b.started_at && a.command === b.command);
function ownsWorker(owner, sessionDir) {
  return owner?.uid === process.getuid() && owner.command.endsWith(` ${executable} --worker ${sessionDir}`);
}
function ownsCPA(owner, worker, intent, sessionDir) {
  return owner?.uid === process.getuid() && owner.ppid === worker?.pid &&
    owner.command === `${intent.proxy_executable} -config ${join(sessionDir, 'config.yaml')} --local-model`;
}
async function stopVerifiedProcess(owner, inspect = inspectOAuthProcess, signal = (pid, value) => process.kill(pid, value)) {
  if (!sameProcess(owner, await inspect(owner?.pid))) return;
  try { signal(owner.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw unavailable(); }
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(50);
    if (!sameProcess(owner, await inspect(owner.pid))) return;
  }
  if (sameProcess(owner, await inspect(owner.pid))) {
    try { signal(owner.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw unavailable(); }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(50);
    if (!sameProcess(owner, await inspect(owner.pid))) return;
  }
  throw unavailable();
}
async function discardSessionSecrets(sessionDir, intent) {
  await privateDirectory(sessionDir, intent.directory);
  for (const name of ['auth', 'config.yaml', 'management.key']) await rm(join(sessionDir, name), { recursive: true, force: true });
}

export class OAuthSessionManager {
  constructor({ runtimeDir, proxyExecutable = fileURLToPath(new URL('../bin/cli-proxy-api', import.meta.url)), nodeExecutable = process.execPath,
    spawnWorker = spawn, inspectProcess = inspectOAuthProcess, signalProcess, now = Date.now, startTimeoutMs = 30000 } = {}) {
    if (!isAbsolute(runtimeDir ?? '') || !isAbsolute(proxyExecutable) || !isAbsolute(nodeExecutable)) throw unavailable();
    this.runtimeDir = resolve(runtimeDir); this.root = join(this.runtimeDir, 'oauth-sessions');
    this.proxyExecutable = proxyExecutable; this.nodeExecutable = nodeExecutable; this.spawnWorker = spawnWorker;
    this.inspectProcess = inspectProcess; this.signalProcess = signalProcess; this.now = now; this.startTimeoutMs = startTimeoutMs;
    this.starting = new Map(); this.operations = new Map();
  }
  path(id) { if (!validID(id)) throw unavailable(); return join(this.root, id); }
  async create({ email }) {
    email = canonicalEmail(email); if (!validEmail(email)) throw unavailable();
    await privateDirectory(this.runtimeDir);
    await mkdir(this.root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await privateDirectory(this.root);
    const id = randomUUID(), path = this.path(id), startedAt = this.now(); await mkdir(path, { mode: 0o700 });
    const intent = { version: 1, id, email, started_at: new Date(startedAt).toISOString(),
      expires_at: new Date(startedAt + oauthCallbackLifetimeMs).toISOString(), directory: await privateDirectory(path),
      proxy_executable: this.proxyExecutable };
    await privateJSON(join(path, 'intent.json'), intent, true);
    return { id, email, started_at: intent.started_at, expires_at: intent.expires_at };
  }
  start(id) {
    if (this.starting.has(id)) return this.starting.get(id);
    const operation = this.startSession(id).finally(() => { if (this.starting.get(id) === operation) this.starting.delete(id); });
    this.starting.set(id, operation); return operation;
  }
  async startSession(id) {
    const sessionDir = this.path(id), intent = await loadSession(sessionDir);
    let state = await optionalJSON(join(sessionDir, 'state.json'));
    if (state && terminal.has(state.status)) return publicStatus(intent, state);
    if (this.now() >= Date.parse(intent.expires_at)) {
      await this.cancel(id);
      return { ...publicStatus(intent, { status: 'expired', error_code: 'oauth.expired' }) };
    }
    let launched = false;
    try {
      await privateJSON(join(sessionDir, 'launch.json'), { manager: await this.inspectProcess(process.pid), at: new Date(this.now()).toISOString() }, true);
      launched = true;
    } catch (error) { if (error.code !== 'EEXIST') throw unavailable(); }
    if (launched) {
      let child;
      try {
        child = this.spawnWorker(this.nodeExecutable, [executable, '--worker', sessionDir], {
          cwd: sessionDir, detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        });
        child.on?.('error', () => {}); child.unref?.();
        if (!Number.isInteger(child.pid)) throw unavailable();
        // The worker writes its own identity before it starts the CPA.
      } catch {
        await privateJSON(join(sessionDir, 'state.json'), { status: 'error', error_code: 'oauth.session_unavailable' });
        throw unavailable();
      }
    }
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      state = await optionalJSON(join(sessionDir, 'state.json'));
      if (state && !['created', 'starting'].includes(state.status)) return publicStatus(intent, state);
      await delay(50);
    }
    throw unavailable();
  }
  async status(id) {
    const sessionDir = this.path(id), intent = await loadSession(sessionDir), state = await optionalJSON(join(sessionDir, 'state.json'));
    return publicStatus(intent, state);
  }
  async recover(id) {
    const sessionDir = this.path(id), intent = await loadSession(sessionDir), state = await optionalJSON(join(sessionDir, 'state.json'));
    if (await optionalJSON(join(sessionDir, 'cancel.json'))) return this.cancel(id);
    if (state && terminal.has(state.status)) return publicStatus(intent, state);
    const processes = await optionalJSON(join(sessionDir, 'process.json'));
    if (processes?.worker && ownsWorker(processes.worker, sessionDir) && sameProcess(processes.worker, await this.inspectProcess(processes.worker.pid))) {
      return publicStatus(intent, state);
    }
    if (processes?.cpa) {
      if (!ownsWorker(processes.worker, sessionDir) || !ownsCPA(processes.cpa, processes.worker, intent, sessionDir)) throw unavailable();
      await stopVerifiedProcess(processes.cpa, this.inspectProcess, this.signalProcess);
    }
    // A killed worker may have observed OAuth persistence before saving its
    // receipt. A private, complete, unique credential remains recoverable.
    try {
      const receipt = await receiptFromDirectory(sessionDir, intent, processes?.auth_directory);
      if (receipt) {
        const ready = { status: 'ready', credential: receipt };
        await privateJSON(join(sessionDir, 'state.json'), ready); return publicStatus(intent, ready);
      }
    } catch (error) {
      if (error instanceof OAuthSessionError && error.code === 'oauth.account_mismatch') {
        await discardSessionSecrets(sessionDir, intent);
        const rejected = { status: 'error', error_code: error.code };
        await privateJSON(join(sessionDir, 'state.json'), rejected); return publicStatus(intent, rejected);
      }
      throw unavailable();
    }
    const failed = { status: 'error', error_code: this.now() >= Date.parse(intent.expires_at) ? 'oauth.expired' : 'oauth.session_unavailable' };
    await discardSessionSecrets(sessionDir, intent); await privateJSON(join(sessionDir, 'state.json'), failed);
    return publicStatus(intent, failed);
  }
  exclusive(id, operation) {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const pending = previous.then(operation, operation);
    const tail = pending.catch(() => {});
    this.operations.set(id, tail);
    tail.finally(() => { if (this.operations.get(id) === tail) this.operations.delete(id); });
    return pending;
  }
  withValidatedCredential(id, { expectedEmail }, callback) {
    return this.exclusive(id, async () => {
      let content, credential;
      try {
        const sessionDir = this.path(id), intent = await loadSession(sessionDir), state = await readJSON(join(sessionDir, 'state.json'));
        if (state.status !== 'ready' || canonicalEmail(expectedEmail) !== intent.email || typeof callback !== 'function') throw unavailable();
        if (await optionalJSON(join(sessionDir, 'cancel.json'))) throw unavailable();
        const receipt = state.credential;
        if (!receipt || !safeName(receipt.name)) throw unavailable();
        await privateDirectory(join(sessionDir, 'auth'), receipt.directory);
        const read = await readPrivate(join(sessionDir, 'auth', receipt.name), 1024 * 1024, receipt.file);
        content = read.content;
        credential = validateCredentialContent(content, receipt.name, intent.email);
        const identity = read.identity;
        if (!sameFile(identity, receipt.file) || credential.account_id !== receipt.account_id || credential.email !== receipt.email ||
          createHash('sha256').update(content).digest('hex') !== receipt.digest) throw unavailable();
      } catch (error) { content?.fill(0); throw error instanceof OAuthSessionError ? error : unavailable(); }
      try { return await callback({ ...credential, content }); } finally { content.fill(0); }
    });
  }
  finish(id) {
    return this.exclusive(id, async () => {
      const sessionDir = this.path(id), intent = await loadSession(sessionDir), state = await readJSON(join(sessionDir, 'state.json'));
      if (state.status === 'consumed') return publicStatus(intent, state);
      if (state.status !== 'ready') throw unavailable();
      await discardSessionSecrets(sessionDir, intent);
      const consumed = { status: 'consumed' }; await privateJSON(join(sessionDir, 'state.json'), consumed);
      return publicStatus(intent, consumed);
    });
  }
  cancel(id) {
    return this.exclusive(id, async () => {
      const sessionDir = this.path(id), intent = await loadSession(sessionDir);
      await privateJSON(join(sessionDir, 'cancel.json'), { requested: true });
      const deadline = Date.now() + 6000;
      while (true) {
        const state = await optionalJSON(join(sessionDir, 'state.json'));
        const processes = await optionalJSON(join(sessionDir, 'process.json'));
        const liveWorker = processes?.worker && ownsWorker(processes.worker, sessionDir) && sameProcess(processes.worker, await this.inspectProcess(processes.worker.pid));
        if (!liveWorker) {
          if (processes?.cpa) {
            if (!ownsWorker(processes.worker, sessionDir) || !ownsCPA(processes.cpa, processes.worker, intent, sessionDir)) throw unavailable();
            await stopVerifiedProcess(processes.cpa, this.inspectProcess, this.signalProcess);
          }
          await discardSessionSecrets(sessionDir, intent);
          const cancelled = { status: state?.status === 'consumed' ? 'consumed' : 'cancelled' };
          await privateJSON(join(sessionDir, 'state.json'), cancelled); return publicStatus(intent, cancelled);
        }
        if (Date.now() >= deadline) {
          await stopVerifiedProcess(processes.worker, this.inspectProcess, this.signalProcess);
          // Recheck the saved child separately, never kill by a reused PID.
          continue;
        }
        await delay(50);
      }
    });
  }
}

function validateCredentialContent(content, name, expectedEmail) {
  let value, claims;
  try {
    value = JSON.parse(content.toString('utf8'));
    const parts = value.id_token?.split('.');
    if (parts?.length !== 3) throw unavailable();
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw unavailable(); }
  const email = canonicalEmail(value.email), claimEmail = canonicalEmail(claims.email), accountID = claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!safeName(name) || value.type !== 'codex' || !validEmail(email) || email !== claimEmail ||
    typeof accountID !== 'string' || !accountID.trim() || value.account_id !== accountID ||
    typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token) throw unavailable();
  if (email !== expectedEmail) throw new OAuthSessionError('oauth.account_mismatch');
  const plan = value.plan_type ?? claims['https://api.openai.com/auth']?.chatgpt_plan_type;
  return { name, email, account_id: accountID, plan: typeof plan === 'string' && plan.trim() ? plan.trim() : 'free' };
}
async function receiptFromDirectory(sessionDir, intent, expectedDirectory) {
  const authDir = join(sessionDir, 'auth');
  let directory;
  try { directory = await privateDirectory(authDir, expectedDirectory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const files = (await readdir(authDir)).filter(name => name.endsWith('.json'));
  if (!files.length) return null;
  if (files.length !== 1 || !safeName(files[0])) throw unavailable();
  const { content, identity } = await readPrivate(join(authDir, files[0]));
  try {
    const credential = validateCredentialContent(content, files[0], intent.email);
    await privateDirectory(authDir, directory);
    return { ...credential, directory, file: identity, digest: createHash('sha256').update(content).digest('hex') };
  } finally { content.fill(0); }
}

export async function createOAuthCallbackListener({ getSession, submitCallback, port = 1455 }) {
  let submitted = false;
  const server = http.createServer(async (request, response) => {
    const reply = (status, received = false) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
      response.end(received ? '<!doctype html><meta charset="utf-8"><title>Claude Codex</title><p>Authorization received. Return to Claude Codex.</p>' : '<!doctype html><meta charset="utf-8"><title>Claude Codex</title><p>Return to Claude Codex to check this authorization.</p>');
    };
    try {
      const actualPort = server.address()?.port, origin = request.headers.origin;
      if (request.method !== 'GET' || !['127.0.0.1:' + actualPort, 'localhost:' + actualPort].includes(request.headers.host) ||
        (origin && !['https://auth.openai.com', `http://${request.headers.host}`].includes(origin)) ||
        !request.url || request.url.length > 16384 || request.url.includes('#')) { reply(400); return; }
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/auth/callback' || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) { reply(400); return; }
      const session = getSession(), state = url.searchParams.get('state'), code = url.searchParams.get('code'), error = url.searchParams.get('error');
      if (!session || typeof state !== 'string' || state.length > 128 ||
        !timingSafeEqual(createHash('sha256').update(state).digest(), createHash('sha256').update(session.state).digest()) ||
        Boolean(code) === Boolean(error) || (code && (code.length > 8192 || code !== code.trim()))) { reply(400); return; }
      if (submitted) { reply(409); return; }
      submitted = true;
      await submitCallback({ provider: 'codex', state, ...(error ? { error: error === 'access_denied' ? 'access_denied' : 'authorization_failed' } : { code }) });
      reply(200, true);
    } catch { reply(502); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function createIsolatedBackend({ sessionDir, intent, onProcess }) {
  const port = await freePort(), key = randomBytes(40).toString('base64url');
  const config = { 'config-version': 8,
    server: { host: '127.0.0.1', port, discovery: { enabled: false }, 'commercial-mode': true },
    management: { 'allow-remote': false, 'secret-key': await bcrypt.hash(key, 10), 'disable-control-panel': true, 'disable-auto-update-panel': true },
    access: { 'api-keys': [randomBytes(40).toString('base64url')] }, oauth: { 'auth-dir': join(sessionDir, 'auth') },
    observability: { logs: { debug: false, 'request-log': false, 'logging-to-file': false } } };
  await privateJSON(join(sessionDir, 'config.yaml'), config);
  const child = spawn(intent.proxy_executable, ['-config', join(sessionDir, 'config.yaml'), '--local-model'], {
    cwd: sessionDir, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  });
  let stopped = false, spawnError;
  child.on('error', () => { spawnError = true; });
  const call = async (path, method = 'GET', body) => {
    if (spawnError || stopped || child.exitCode !== null || child.signalCode !== null) throw unavailable();
    const response = await fetch(`http://127.0.0.1:${port}/v8/management/${path}`, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    try { return await response.json(); } catch { throw unavailable(); }
  };
  const stop = async () => {
    if (stopped) return; stopped = true;
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 40 && child.exitCode === null && child.signalCode === null; attempt++) await delay(50);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (let attempt = 0; attempt < 40 && child.exitCode === null && child.signalCode === null; attempt++) await delay(50);
    if (child.exitCode === null && child.signalCode === null) throw unavailable();
  };
  try {
    let identity;
    for (let attempt = 0; attempt < 30 && !identity && !spawnError; attempt++) { identity = await inspectOAuthProcess(child.pid); if (!identity) await delay(20); }
    if (!identity) throw unavailable();
    await onProcess(identity);
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline && !spawnError && child.exitCode === null && child.signalCode === null) {
      try { const result = await call('credentials'); if (Array.isArray(result.files) && result.files.length === 0) { ready = true; break; } } catch {}
      await delay(100);
    }
    if (!ready) throw unavailable();
    return { start: () => call('oauth/auth-url?provider=codex'), status: state => call(`oauth/status?state=${encodeURIComponent(state)}`),
      submit: body => call('oauth/callback', 'POST', body), credentials: async () => (await call('credentials')).files, stop };
  } catch { await stop(); throw unavailable(); }
}

export async function runOAuthWorker(sessionDir, { backendFactory = createIsolatedBackend, callbackFactory = createOAuthCallbackListener,
  inspectProcess = inspectOAuthProcess, now = Date.now, pollIntervalMs = 250, abortSignal } = {}) {
  const intent = await loadSession(sessionDir);
  let lock;
  try { lock = await open(join(sessionDir, 'worker.lock'), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  await lock.close();
  let backend, callback, login, heartbeat, shutdownPromise;
  const processes = { worker: await inspectProcess(process.pid), cpa: null, auth_directory: null };
  const cancelled = async () => Boolean(await optionalJSON(join(sessionDir, 'cancel.json')));
  const persist = value => privateJSON(join(sessionDir, 'state.json'), value);
  const shutdown = () => {
    if (!shutdownPromise) {
      clearInterval(heartbeat);
      shutdownPromise = Promise.allSettled([Promise.resolve().then(() => callback?.close()), Promise.resolve().then(() => backend?.stop())])
        .then(results => { if (results.some(result => result.status === 'rejected')) throw unavailable(); });
    }
    return shutdownPromise;
  };
  try {
    if (!processes.worker) throw unavailable();
    await privateJSON(join(sessionDir, 'process.json'), processes);
    await persist({ status: 'starting' });
    heartbeat = setInterval(() => { privateJSON(join(sessionDir, 'heartbeat.json'), { at: new Date(now()).toISOString() }).catch(() => {}); }, 2000);
    heartbeat.unref();
    if (await cancelled()) { await persist({ status: 'cancelled' }); return; }
    if (abortSignal?.aborted) throw unavailable();
    if (now() >= Date.parse(intent.expires_at)) throw new OAuthSessionError('oauth.expired');
    await mkdir(join(sessionDir, 'auth'), { mode: 0o700 });
    processes.auth_directory = await privateDirectory(join(sessionDir, 'auth'));
    await privateJSON(join(sessionDir, 'process.json'), processes);
    callback = await callbackFactory({ getSession: () => login, submitCallback: body => backend.submit(body) });
    backend = await backendFactory({ sessionDir, intent, onProcess: async identity => {
      processes.cpa = identity; await privateJSON(join(sessionDir, 'process.json'), processes);
    } });
    if (await cancelled()) { await shutdown(); await discardSessionSecrets(sessionDir, intent); await persist({ status: 'cancelled' }); return; }
    if (abortSignal?.aborted) throw unavailable();
    login = await backend.start();
    const authURL = validateAuthorizationURL(login.url, login.state).href;
    await persist({ status: 'pending', auth_url: authURL, oauth_state: login.state });
    while (true) {
      if (await cancelled()) { await shutdown(); await discardSessionSecrets(sessionDir, intent); await persist({ status: 'cancelled' }); return; }
      if (abortSignal?.aborted) throw unavailable();
      // Look for the exclusively owned result before checking the provider's
      // short-lived session marker, including after a system sleep.
      const files = await backend.credentials();
      if (!Array.isArray(files)) throw unavailable();
      const candidates = files.filter(file => file.provider === 'codex');
      if (candidates.length > 1) throw unavailable();
      if (candidates.length === 1) {
        // Preserve an owned-file receipt before stopping either process. The
        // final read after shutdown seals the exact bytes handed to import.
        const observed = await receiptFromDirectory(sessionDir, intent, processes.auth_directory);
        if (!observed) throw unavailable();
        await privateJSON(join(sessionDir, 'observed.json'), observed);
        await shutdown();
        if (await cancelled()) { await discardSessionSecrets(sessionDir, intent); await persist({ status: 'cancelled' }); return; }
        const receipt = await receiptFromDirectory(sessionDir, intent, processes.auth_directory);
        if (!receipt) throw unavailable();
        await persist({ status: 'ready', credential: receipt }); return;
      }
      if (now() >= Date.parse(intent.expires_at)) throw new OAuthSessionError('oauth.expired');
      const status = await backend.status(login.state);
      if (status?.status === 'error') throw new OAuthSessionError('oauth.expired');
      if (!['ok', 'wait'].includes(status?.status)) throw unavailable();
      await delay(pollIntervalMs);
    }
  } catch (error) {
    await shutdown();
    if (await cancelled()) {
      await discardSessionSecrets(sessionDir, intent); await persist({ status: 'cancelled' }); return;
    }
    // A local transport/process failure can happen after CPA saved the token.
    // Isolation and the original auth-directory identity provide durable proof
    // even when the provider's short-lived status is no longer reachable.
    if (processes.auth_directory) {
      try {
        const receipt = await receiptFromDirectory(sessionDir, intent, processes.auth_directory);
        if (receipt) { await persist({ status: 'ready', credential: receipt }); return; }
      } catch (receiptError) {
        if (receiptError instanceof OAuthSessionError && receiptError.code === 'oauth.account_mismatch') error = receiptError;
      }
    }
    await discardSessionSecrets(sessionDir, intent);
    const code = error instanceof OAuthSessionError ? error.code : 'oauth.session_unavailable';
    await persist({ status: code === 'oauth.expired' ? 'expired' : 'error', error_code: code });
  } finally { await shutdown(); }
}

if (process.argv[1] && resolve(process.argv[1]) === executable && process.argv[2] === '--worker') {
  process.umask(0o077);
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort()); process.once('SIGINT', () => abort.abort());
  runOAuthWorker(resolve(process.argv[3] ?? ''), { abortSignal: abort.signal }).catch(() => { process.exitCode = 1; });
}
