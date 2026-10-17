import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, chmod, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ensureClientKey, readClientKey, authorizeClient } from './client-auth.mjs';
import { ensureRuntime, makeConfig, upgradeModelConfig } from './runtime.mjs';
import { createPoolRouter } from './pool-router.mjs';

const syntheticKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-ultra-client-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('client key is separate, private, random, idempotent and shared by concurrent initializers', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'management.key'), 'synthetic-management', { mode: 0o600 });
  const values = await Promise.all(Array.from({ length: 12 }, () => ensureClientKey(dir)));
  assert.equal(new Set(values.map(digest)).size, 1);
  assert.equal(/^[A-Za-z0-9_-]{64}$/.test(values[0]), true);
  assert.equal((await stat(join(dir, 'client.key'))).mode & 0o777, 0o600);
  assert.equal(digest(await readClientKey(dir)), digest(values[0]));
  assert.equal(await readFile(join(dir, 'management.key'), 'utf8'), 'synthetic-management');
  const other = await fixture(t);
  assert.notEqual(digest(await ensureClientKey(other)), digest(values[0]));
});

test('existing unsafe or malformed client keys are rejected without replacement', async t => {
  for (const value of ['', 'short', syntheticKey + 'extra', syntheticKey + '\n\n', '!'.repeat(64)]) {
    const dir = await fixture(t), path = join(dir, 'client.key');
    await writeFile(path, value, { mode: 0o600 });
    await assert.rejects(ensureClientKey(dir));
    assert.equal(digest(await readFile(path)), digest(value));
  }
  const dir = await fixture(t); await ensureClientKey(dir);
  await chmod(join(dir, 'client.key'), 0o644);
  await assert.rejects(readClientKey(dir)); await assert.rejects(ensureClientKey(dir));
  await chmod(join(dir, 'client.key'), 0o600); await chmod(dir, 0o755);
  await assert.rejects(readClientKey(dir)); await assert.rejects(ensureClientKey(dir));
});

test('another process can finish the same private partial key without replacement or divergent keys', async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { open } from 'node:fs/promises';
    const handle = await open(process.env.SYNTHETIC_CLIENT_KEY_PATH, 'wx', 0o600);
    await handle.writeFile(${JSON.stringify(syntheticKey.slice(0, 16))});
    process.stdout.write('partial\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    await handle.writeFile(${JSON.stringify(syntheticKey.slice(16) + '\n')});
    await handle.sync(); await handle.close();
  `], { env: { ...process.env, SYNTHETIC_CLIENT_KEY_PATH: join(dir, 'client.key') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const before = await stat(join(dir, 'client.key'));
  const pending = ensureClientKey(dir);
  child.stdin.end('finish');
  const result = await pending;
  await exited;
  assert.equal(digest(result), digest(syntheticKey));
  assert.equal((await stat(join(dir, 'client.key'))).ino, before.ino);
  assert.equal(child.exitCode, 0);
});

test('symbolic links, linked files and symbolic runtime directories cannot supply a key', async t => {
  const outer = await fixture(t), dir = join(outer, 'runtime'); await mkdir(dir, { mode: 0o700 });
  const elsewhere = join(outer, 'elsewhere'); await writeFile(elsewhere, syntheticKey, { mode: 0o600 });
  await symlink(elsewhere, join(dir, 'client.key'));
  await assert.rejects(ensureClientKey(dir)); await assert.rejects(readClientKey(dir));
  await rm(join(dir, 'client.key')); await link(elsewhere, join(dir, 'client.key'));
  await assert.rejects(readClientKey(dir));
  await rm(join(dir, 'client.key')); await ensureClientKey(dir);
  const alias = join(outer, 'alias'); await symlink(dir, alias);
  await assert.rejects(readClientKey(alias)); await assert.rejects(ensureClientKey(alias));
});

test('runtime initializes and migrates the ingress key without replacing the management key or application state', async t => {
  const dir = await fixture(t); await ensureRuntime(dir);
  const managementBefore = digest(await readFile(join(dir, 'management.key')));
  const stateBefore = await readFile(join(dir, 'accounts-state.json'), 'utf8');
  await rm(join(dir, 'client.key'));
  await ensureRuntime(dir);
  assert.equal(/^[A-Za-z0-9_-]{64}$/.test(await readClientKey(dir)), true);
  assert.equal(digest(await readFile(join(dir, 'management.key'))), managementBefore);
  assert.equal(await readFile(join(dir, 'accounts-state.json'), 'utf8'), stateBefore);
});

test('both supported authentication headers require exact valid credentials and cannot override each other', () => {
  assert.equal(authorizeClient({ authorization: `Bearer ${syntheticKey}` }, syntheticKey), true);
  assert.equal(authorizeClient({ 'x-api-key': syntheticKey }, syntheticKey), true);
  assert.equal(authorizeClient({ authorization: `Bearer ${syntheticKey}`, 'x-api-key': syntheticKey }, syntheticKey), true);
  for (const headers of [{}, { authorization: 'Bearer local-codex-accounts' }, { authorization: `Basic ${syntheticKey}` },
    { authorization: [`Bearer ${syntheticKey}`] }, { 'x-api-key': [syntheticKey] }, { authorization: `Bearer ${syntheticKey}`, 'x-api-key': 'A'.repeat(64) }]) {
    assert.equal(authorizeClient(headers, syntheticKey), false);
  }
  assert.throws(() => authorizeClient({}, 'weak'));
});

test('router blocks unauthenticated access before quota, models, inference and every administrative action', async t => {
  const operations = [];
  const controller = { resetInFlight: new Map(),
    readState: async () => { operations.push('state'); return {}; },
    status: async () => { operations.push('status'); return {}; },
    availableModels: async () => { operations.push('models'); return []; } };
  const base = await listen(t, createPoolRouter({ controller, getIngressKey: async () => syntheticKey, getClientKey: async () => { operations.push('backend-key'); return 'synthetic'; } }));
  const endpoints = [['GET', '/v1/models'], ['GET', '/_bridge/accounts'], ...['/v1/messages', '/v1/messages/count_tokens', '/_bridge/settings', '/_bridge/refresh', '/_bridge/connect', '/_bridge/connect/cancel', '/_bridge/disconnect', '/_bridge/reset', '/_bridge/update/drain', '/_bridge/update/resume'].map(path => ['POST', path])];
  for (const [method, path] of endpoints) {
    const response = await fetch(base + path, { method, headers: { origin: base, 'x-bridge-action': 'accounts', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).error.code, 'bridge.unauthorized');
  }
  assert.deepEqual(operations, []);
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok', backend: 'codex-pool' });
  assert.deepEqual(operations, []);
  assert.equal((await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${'A'.repeat(64)}` } })).status, 401);
  assert.deepEqual(operations, []);
  const health = await (await fetch(base + '/healthz', { headers: { 'x-api-key': syntheticKey } })).json();
  assert.equal(health.active_requests, 0); assert.equal(health.pending_actions, 0);
  assert.equal((await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${syntheticKey}` } })).status, 200);
  assert.deepEqual(operations, ['state', 'models']);
  assert.throws(() => createPoolRouter({ controller, getClientKey: async () => 'synthetic' }));
});

test('post-override tier conflicts are rejected and unrelated payload rules remain exact', () => {
  for (const kind of ['override-raw', 'filter']) {
    for (const matcher of [{ name: '*gpt-6.1-sol-fast', protocol: 'codex' }, { name: '*', protocol: 'codex' }, { name: 'conta-99/gpt-6-luna' }, { name: 'conta-*9999/gpt-6-luna' }, { name: 'gpt-6-*', protocol: ' CODEX ' }]) {
      const config = makeConfig('/synthetic', '', 'synthetic');
      config.requests.payload[kind] = [{ models: [matcher], params: kind === 'filter' ? ['service_tier'] : { service_tier: '"default"' } }];
      assert.throws(() => upgradeModelConfig(config), /service_tier/);
    }
  }
  const config = makeConfig('/synthetic', '', 'synthetic');
  config.requests.payload['override-raw'] = [{ models: [{ name: '*gpt-4', protocol: 'codex' }], params: { service_tier: '"custom"' } }, { models: [{ name: '*', protocol: 'anthropic' }], params: { service_tier: '"custom"' } }, { models: [{ name: 'other-account/gpt-6-luna', protocol: 'codex' }], params: { service_tier: '"custom"' } }];
  config.requests.payload.filter = [{ models: [{ name: '*gpt-6.1-sol-fast', protocol: 'codex' }], params: ['metadata', 'temperature'] }];
  const upgraded = upgradeModelConfig(config);
  assert.deepEqual(upgraded.requests.payload['override-raw'], config.requests.payload['override-raw']);
  assert.deepEqual(upgraded.requests.payload.filter, config.requests.payload.filter);
});

test('a normal managed model cannot be redirected by an existing OAuth alias', () => {
  for (const target of ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']) {
    const config = makeConfig('/synthetic', '', 'synthetic');
    config.oauth['model-alias'].codex.push({ name: 'other-model', alias: target, fork: true });
    assert.throws(() => upgradeModelConfig(config), /redireciona/);
  }
});

test('an incompatible runtime is rejected before its existing payload rules are rewritten', async t => {
  const dir = await fixture(t), config = await ensureRuntime(dir);
  config.requests.payload.filter = [{ models: [{ name: '*gpt-6-astra-ultra', protocol: 'codex' }], params: ['service_tier'] }];
  const raw = JSON.stringify(config);
  await writeFile(join(dir, 'config.yaml'), raw);
  await assert.rejects(ensureRuntime(dir), /service_tier/);
  assert.equal(digest(await readFile(join(dir, 'config.yaml'))), digest(raw));
});
