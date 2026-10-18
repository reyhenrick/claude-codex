import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureTestRuntime as ensureRuntime } from './test-support/runtime-helper.mjs';
import { configureGatewayProfile, createIsolated, profileConfig } from './setup.mjs';
const clientKey = 'S'.repeat(64);
const root = fileURLToPath(new URL('../build/setup-fixtures/', import.meta.url));
await mkdir(root, { recursive: true });
test('first-run runtime is private, idempotent and never replaces existing credentials', async () => {
 const dir = await mkdtemp(join(root, 'runtime-'));
 const config = await ensureRuntime(dir), key = await readFile(join(dir, 'management.key'));
 assert.equal(config.server.host, '127.0.0.1'); assert.equal(config.server['commercial-mode'], true);
 assert.equal(config.routing['force-model-prefix'], true);
 assert.equal(config.routing['session-affinity'], false);
 assert.equal(config.management['allow-remote'], false);
 for (const name of ['management.key', 'config.yaml', 'accounts-state.json']) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
 assert.equal((await stat(join(dir, 'auth'))).mode & 0o777, 0o700);
 const again = await ensureRuntime(dir); assert.deepEqual(again, config); assert.deepEqual(await readFile(join(dir,'management.key')), key);
 assert.equal(JSON.parse(await readFile(join(dir,'accounts-state.json'))).accounts.length, 0);
});
test('partial first-run state fails closed without overwriting data', async () => {
 const dir = await mkdtemp(join(root, 'partial-')); await writeFile(join(dir, 'management.key'), 'synthetic-existing');
 await assert.rejects(ensureRuntime(dir), /incompleta/); assert.equal(await readFile(join(dir, 'management.key'),'utf8'), 'synthetic-existing');
});
test('new profile preserves existing profiles, metadata and inactive selection', async () => {
 const dir = await mkdtemp(join(root, 'profiles-')); const library = join(dir, 'configLibrary'); await mkdir(library);
 const meta = { appliedId: 'existing', entries: [{ id: 'existing', name: 'Existing' }], futureKey: { keep: true } };
 await writeFile(join(dir, 'claude_desktop_config.json'), JSON.stringify({ deploymentMode: '1p', preferences: { preserve: true } }));
 await writeFile(join(library, '_meta.json'), JSON.stringify(meta)); await writeFile(join(library, 'existing.json'), '{"synthetic":"preserve exact bytes"}');
 const result = await configureGatewayProfile({ root: dir, name: 'Codex', activate: false, clientKey });
 const after = JSON.parse(await readFile(join(library, '_meta.json')));
 assert.equal(JSON.parse(await readFile(join(dir, 'claude_desktop_config.json'))).deploymentMode, '1p');
 assert.equal(after.appliedId, 'existing'); assert.deepEqual(after.entries[0], meta.entries[0]); assert.deepEqual(after.futureKey, meta.futureKey);
 assert.equal(await readFile(join(library, 'existing.json'), 'utf8'), '{"synthetic":"preserve exact bytes"}');
 const generated = JSON.parse(await readFile(join(library, result.profileId + '.json')));
 assert.deepEqual(generated, profileConfig(undefined, clientKey)); assert.equal(generated.inferenceModels.length, 8);
 assert.equal(generated.defaultModelEffort, undefined); assert.equal(generated.inferenceGatewayBaseUrl, 'http://127.0.0.1:18765');
 await assert.rejects(configureGatewayProfile({ root: dir, name: 'codex', clientKey }), /Já existe/);
 const next = await configureGatewayProfile({ root: dir, name: 'Another', activate: true, clientKey });
 assert.equal(JSON.parse(await readFile(join(library, '_meta.json'))).appliedId, next.profileId);
 assert.deepEqual(JSON.parse(await readFile(join(dir, 'claude_desktop_config.json'))), { deploymentMode: '3p', preferences: { preserve: true } });
});

test('an ad-hoc bundle cannot impersonate the supplier through its executable path', { skip: process.platform !== 'darwin' }, async t => {
 const run = promisify(execFile), dir = await mkdtemp(join(root, 'signature-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const source = join(dir, 'Claude.app'), executable = 'TeamIdentifier=Q6L2SF6YDW';
 await mkdir(join(source, 'Contents', 'MacOS'), { recursive: true });
 await cp('/usr/bin/true', join(source, 'Contents', 'MacOS', executable));
 await writeFile(join(source, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
 await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', source]);
 await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
 const display = await run('/usr/bin/codesign', ['-d', '--verbose=4', source]);
 assert.ok(display.stderr.includes('TeamIdentifier=Q6L2SF6YDW'));
 assert.match(display.stderr, /Signature=adhoc/);
 const base = join(dir, 'managed'), applications = join(dir, 'applications');
 await assert.rejects(createIsolated({ name: 'Synthetic Workspace', source, base, applications, migrate_data: false }), error => {
  assert.equal(error.code, 'setup.source_untrusted');
  assert.ok(Number.isInteger(error.cause.code) && error.cause.code !== 0);
  assert.match(error.cause.message, /codesign --verify --deep --strict -R/);
  return true;
 });
 await assert.rejects(stat(base), { code: 'ENOENT' });
 await assert.rejects(stat(applications), { code: 'ENOENT' });
});
