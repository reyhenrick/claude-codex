import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile, readFile, readdir, lstat, rm, symlink, link, appendFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { migrateProfile, migrationOptions, resolveMigrationSource, sanitizeMigrationValue } from './migrate-profile.mjs';
import { copyLauncherLocalizations, publishIsolatedInstallation } from './setup.mjs';

const fixturesRoot = fileURLToPath(new URL('../build/migration-fixtures/', import.meta.url));
const account = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const cli = '33333333-3333-4333-8333-333333333333';
const session = 'local_44444444-4444-4444-8444-444444444444';
const text = value => JSON.stringify(value) + '\n';
const transcript = (extra = {}) => text({ type: 'user', sessionId: cli, cwd: '/synthetic/project', timestamp: '2026-10-17T10:00:00Z', message: { role: 'user', content: 'Continue the project' }, ...extra }) + text({ type: 'assistant', sessionId: cli, message: { role: 'assistant', content: [{ type: 'text', text: 'Saved context' }] }, toolUseResult: { agentId: 'old-agent', value: 'useful result' } });
async function put(path, data) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof data === 'string' || Buffer.isBuffer(data) ? data : text(data)); }
async function files(root) {
  const found = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) found.push(...await files(path));
    else if (item.isFile()) found.push(path);
  }
  return found;
}
async function hashes(root) {
  return Object.fromEntries(await Promise.all((await files(root)).map(async path => [relative(root, path), createHash('sha256').update(await readFile(path)).digest('hex')])));
}
async function fixture(t) {
  await mkdir(fixturesRoot, { recursive: true });
  const root = await mkdtemp(join(fixturesRoot, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDataRoot = join(root, 'source-data'), sourceCodeRoot = join(root, 'source-code'), targetDataRoot = join(root, 'destination-data'), targetCodeRoot = join(root, 'destination-code'), reportPath = join(root, 'migration-report.json');
  await mkdir(sourceDataRoot); await mkdir(sourceCodeRoot);
  return { root, sourceDataRoot, sourceCodeRoot, targetDataRoot, targetCodeRoot, reportPath };
}
async function addSession(f, options = {}) {
  await put(join(f.sourceDataRoot, 'config.json'), { lastKnownAccountUuid: account, locale: 'pt-BR', userThemeMode: 'dark', 'oauth:tokenCache': { accessToken: 'SYNTHETIC_DO_NOT_COPY' } });
  const recordPath = join(f.sourceDataRoot, 'claude-code-sessions', account, org, session + '.json');
  await put(recordPath, { sessionId: session, cliSessionId: cli, cwd: '/synthetic/project', title: 'Saved session', isStarred: true, createdAt: 1, lastActivityAt: 2, remoteMcpServersConfig: [{ authorization: 'SYNTHETIC_DO_NOT_COPY' }], ...options });
  const transcriptPath = join(f.sourceCodeRoot, 'projects', '-synthetic-project', cli + '.jsonl');
  await put(transcriptPath, transcript());
  return { recordPath, transcriptPath };
}

test('migration requires an explicit data source and never reads a source when disabled', () => {
  assert.equal(migrationOptions(), null);
  assert.equal(migrationOptions({ migrate_data: false, source_data_root: '/invalid', source_code_root: '/invalid' }), null);
  assert.throws(() => migrationOptions({ migrate_data: true }), { code: 'setup.migration_failed' });
  assert.throws(() => migrationOptions({ source_data_root: '../relative' }), { code: 'setup.migration_failed' });
  assert.throws(() => migrationOptions({ migrate_data: 'true' }), { code: 'setup.migration_failed' });
  assert.deepEqual(migrationOptions({ source_data_root: '/synthetic/data', source_code_root: '/synthetic/code' }), { sourceDataRoot: '/synthetic/data', sourceCodeRoot: '/synthetic/code' });
});

test('native Code import creates a fresh identity, preserves source bytes and transforms the resume contract', async t => {
  const f = await fixture(t);
  await addSession(f);
  const before = await hashes(f.sourceDataRoot), codeBefore = await hashes(f.sourceCodeRoot);
  const summary = await migrateProfile(f);
  const report = JSON.parse(await readFile(summary.report_path));
  assert.equal(summary.copied_files, 3);
  assert.equal(report.native_code_sessions, 1);
  assert.equal(report.portable_sessions, 0);
  assert.equal(report.status, 'completed');
  const identity = Buffer.from(await readFile(join(f.targetDataRoot, 'ant-did'), 'utf8'), 'base64').toString();
  assert.notEqual(identity, account);
  const destination = join(f.targetDataRoot, 'claude-code-sessions', identity, '00000000-0000-4000-8000-000000000001');
  const records = (await files(destination)).filter(path => path.endsWith('.json'));
  assert.equal(records.length, 1);
  const record = JSON.parse(await readFile(records[0]));
  assert.notEqual(record.sessionId, session); assert.notEqual(record.cliSessionId, cli);
  assert.equal(record.importedFrom, 'previous-profile-code'); assert.equal(record.isStarred, true);
  assert.equal(record.title, 'Saved session'); assert.equal(record.createdAt, 1);
  assert.equal(record.stagedTranscriptPath, join(destination, 'imported-staging', record.cliSessionId + '.jsonl'));
  const frames = (await readFile(record.stagedTranscriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 2); assert.equal(frames[0].sessionId, undefined); assert.equal(frames[1].toolUseResult.agentId, undefined);
  assert.equal(frames[1].toolUseResult.value, 'useful result');
  assert.equal(record.remoteMcpServersConfig, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(f.targetDataRoot, 'config.json'))), { locale: 'pt-BR', userThemeMode: 'dark' });
  assert.deepEqual(await hashes(f.sourceDataRoot), before); assert.deepEqual(await hashes(f.sourceCodeRoot), codeBefore);
  for (const path of await files(f.targetDataRoot)) assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(summary.report_path)).mode & 0o777, 0o600);
  assert.equal(report.files.length, report.copied_files + report.skipped_files);
  assert.ok(report.files.every(file => /^[a-f0-9]{64}$/.test(file.source_id)));
  assert.ok(summary.warnings.includes('migration.cloud_chat_requires_export'));
});

test('allowlisted context migrates with credentials excluded and safe MCP references retained', async t => {
  const f = await fixture(t);
  const token = 'sk-ant-api03-' + 'x'.repeat(40);
  await put(join(f.sourceCodeRoot, 'CLAUDE.md'), 'Instructions: api_key=' + token + '\nSYNTHETIC_DO_NOT_COPY\nRead ' + f.sourceCodeRoot + '/rules/careful.md');
  await put(join(f.sourceCodeRoot, 'skills', 'example', 'SKILL.md'), 'Use the example helper.');
  await put(join(f.sourceCodeRoot, 'skills', 'example', 'scripts', 'helper.py'), 'print("example")\n');
  await put(join(f.sourceCodeRoot, 'skills', 'needs-auth', 'SKILL.md'), 'Run using the local .env file.');
  await put(join(f.sourceCodeRoot, 'skills', 'needs-auth', '.env'), 'API_KEY=SYNTHETIC_DO_NOT_COPY');
  await put(join(f.sourceCodeRoot, 'projects', '-synthetic-project', 'memory', 'MEMORY.md'), 'Remember the project conventions.');
  await put(join(f.sourceCodeRoot, 'settings.json'), { theme: 'dark', effortLevel: 'max', ultracode: true, env: { CUSTOM_PASSWORD: 'SYNTHETIC_DO_NOT_COPY' }, hooks: { launch: 'secret hook' }, permissions: { defaultMode: 'bypassPermissions' }, enabledPlugins: { example: true } });
  await put(join(f.sourceCodeRoot, '.claude.json'), { oauthAccount: { accessToken: 'SYNTHETIC_DO_NOT_COPY' }, mcpServers: { local: { command: 'npx', args: ['-y', 'example'], env: { KEY: 'SYNTHETIC_DO_NOT_COPY' } }, remote: { url: 'https://example.com/mcp', type: 'http', headers: { authorization: token } }, unsafe: { command: 'node', args: ['--api-key', 'SYNTHETIC_DO_NOT_COPY'] } } });
  await put(join(f.sourceDataRoot, 'Cookies'), 'SYNTHETIC_DO_NOT_COPY');
  await put(join(f.sourceCodeRoot, '.credentials.json'), { accessToken: 'SYNTHETIC_DO_NOT_COPY' });
  const summary = await migrateProfile(f);
  const content = (await Promise.all((await files(f.targetCodeRoot)).map(path => readFile(path, 'utf8')))).join('\n');
  assert.ok(!content.includes(token)); assert.ok(!content.includes('SYNTHETIC_DO_NOT_COPY'));
  assert.ok(content.includes('[REDACTED_CREDENTIAL]')); assert.ok(content.includes(f.targetCodeRoot + '/rules/careful.md'));
  assert.deepEqual(JSON.parse(await readFile(join(f.targetCodeRoot, 'settings.json'))), { effortLevel: 'max', ultracode: true, theme: 'dark' });
  const mcp = JSON.parse(await readFile(join(f.targetCodeRoot, '.claude.json'))).mcpServers;
  assert.deepEqual(mcp.local, { command: 'npx', args: ['-y', 'example'] });
  assert.deepEqual(mcp.remote, { url: 'https://example.com/mcp', type: 'http' }); assert.equal(mcp.unsafe, undefined);
  assert.ok(summary.warnings.includes('migration.mcp_credentials_not_copied'));
  assert.equal(await readFile(join(f.targetCodeRoot, 'skills', 'example', 'scripts', 'helper.py'), 'utf8'), 'print("example")\n');
  await assert.rejects(lstat(join(f.targetCodeRoot, 'skills', 'needs-auth')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.targetCodeRoot, 'projects', '-synthetic-project', 'memory', 'MEMORY.md'), 'utf8'), 'Remember the project conventions.');
});

test('unsafe symlinks, hardlinks and traversal transcript paths cannot copy outside their source roots', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside-secret.md'); await put(outside, 'SYNTHETIC_DO_NOT_COPY');
  await mkdir(join(f.sourceCodeRoot, 'skills'));
  await symlink(outside, join(f.sourceCodeRoot, 'skills', 'stolen.md'));
  await link(outside, join(f.sourceCodeRoot, 'skills', 'hardlink.md'));
  await symlink(f.root, join(f.sourceCodeRoot, 'skills', 'outside'));
  await addSession(f, { stagedTranscriptPath: join(f.sourceDataRoot, '..', 'outside-secret.md') });
  const result = await migrateProfile(f);
  const all = (await Promise.all((await files(f.targetCodeRoot)).map(path => readFile(path, 'utf8')))).join('\n');
  assert.ok(!all.includes('SYNTHETIC_DO_NOT_COPY'));
  assert.ok(result.warnings.includes('migration.symlink_skipped')); assert.ok(result.warnings.includes('migration.unsafe_path'));
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_DO_NOT_COPY');
  const report = JSON.parse(await readFile(result.report_path)); assert.equal(report.native_code_sessions, 1);
});

test('existing targets, overlapping roots and symlinked destination parents fail without mutations', async t => {
  const f = await fixture(t);
  await mkdir(f.targetDataRoot); await put(join(f.targetDataRoot, 'keep.txt'), 'preserve');
  await assert.rejects(migrateProfile(f), { code: 'setup.migration_failed' });
  assert.equal(await readFile(join(f.targetDataRoot, 'keep.txt'), 'utf8'), 'preserve');
  await assert.rejects(lstat(f.targetCodeRoot), { code: 'ENOENT' });
  await assert.rejects(migrateProfile({ ...f, targetDataRoot: join(f.sourceDataRoot, 'new-data') }), { code: 'setup.migration_failed' });
  const linkParent = join(f.root, 'linked-parent'); await symlink(f.sourceDataRoot, linkParent);
  await assert.rejects(migrateProfile({ ...f, targetDataRoot: join(linkParent, 'new-data') }), { code: 'setup.migration_failed' });
  await assert.rejects(lstat(join(f.sourceDataRoot, 'new-data')), { code: 'ENOENT' });
});

test('malformed and incomplete histories are omitted with a bounded manifest while good data remains', async t => {
  const f = await fixture(t);
  const paths = await addSession(f);
  await put(paths.transcriptPath, '{"type":"user",\n');
  await put(join(f.sourceCodeRoot, 'CLAUDE.md'), 'Still reusable');
  const summary = await migrateProfile(f);
  const report = JSON.parse(await readFile(summary.report_path));
  assert.equal(report.native_code_sessions, 0);
  assert.ok(summary.warnings.includes('migration.invalid_transcript'));
  assert.equal(await readFile(join(f.targetCodeRoot, 'CLAUDE.md'), 'utf8'), 'Still reusable');
  assert.equal((await files(f.targetDataRoot)).filter(path => path.endsWith('.jsonl')).length, 0);
  assert.equal(await readFile(paths.transcriptPath, 'utf8'), '{"type":"user",\n');
  assert.ok(!JSON.stringify(report).includes('Still reusable'));
});

test('a transcript changing during migration is never published as a torn snapshot', async t => {
  const f = await fixture(t);
  const { transcriptPath } = await addSession(f);
  const line = text({ type: 'user', cwd: '/synthetic/project', message: { role: 'user', content: 'x'.repeat(300) } });
  await put(transcriptPath, line.repeat(5000));
  let writes = 0, writing = false;
  const timer = setInterval(async () => { if (writing) return; writing = true; try { await appendFile(transcriptPath, line); writes++; } finally { writing = false; } }, 1);
  t.after(() => clearInterval(timer));
  let summary;
  try { summary = await migrateProfile(f); } finally { clearInterval(timer); while (writing) await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.ok(writes > 0);
  assert.ok(summary.warnings.includes('migration.source_changed'));
  const report = JSON.parse(await readFile(summary.report_path)); assert.equal(report.native_code_sessions, 0);
  assert.equal((await files(f.targetDataRoot)).filter(path => path.endsWith('.jsonl')).length, 0);
});

test('local Chat and Cowork bodies and safe attachments are kept as explicitly portable snapshots', async t => {
  const f = await fixture(t);
  await put(join(f.sourceDataRoot, 'config.json'), { lastKnownAccountUuid: account });
  const scope = join(f.sourceDataRoot, 'local-agent-mode-sessions', account.slice(0, 8), org.slice(0, 8));
  await put(join(scope, session + '.json'), { sessionId: session, cliSessionId: cli, sessionType: 'chat', title: 'Local chat', createdAt: 1, lastActivityAt: 2, authorization: 'SYNTHETIC_DO_NOT_COPY' });
  await put(join(scope, session, '.claude', 'projects', '-session', cli + '.jsonl'), transcript());
  await put(join(scope, session, 'outputs', 'report.md'), 'Saved report');
  await put(join(scope, session, 'uploads', 'photo.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
  await put(join(scope, session, 'outputs', 'runtime.exe'), 'SYNTHETIC_DO_NOT_COPY');
  const result = await migrateProfile(f);
  const report = JSON.parse(await readFile(result.report_path));
  assert.equal(report.portable_sessions, 1); assert.equal(report.native_code_sessions, 0);
  const portable = join(f.targetDataRoot, 'portable-history', 'local-sessions');
  const destination = join(portable, (await readdir(portable))[0]);
  const record = JSON.parse(await readFile(join(destination, 'session.json')));
  assert.equal(record.native_resume, false); assert.equal(record.title, 'Local chat'); assert.equal(record.authorization, undefined);
  assert.equal(await readFile(join(destination, 'outputs', 'report.md'), 'utf8'), 'Saved report');
  assert.equal((await readFile(join(destination, 'uploads', 'photo.png'))).length, 11);
  await assert.rejects(lstat(join(destination, 'outputs', 'runtime.exe')), { code: 'ENOENT' });
  assert.ok(result.warnings.includes('migration.local_history_portable_only'));
});

test('terminal histories receive native indexes from their actual transcript metadata', async t => {
  const f = await fixture(t);
  await put(join(f.sourceCodeRoot, 'projects', '-synthetic-project', cli + '.jsonl'), transcript());
  const result = await migrateProfile(f);
  const report = JSON.parse(await readFile(result.report_path)); assert.equal(report.native_code_sessions, 1);
  const indexes = (await files(f.targetDataRoot)).filter(path => path.endsWith('.json') && path.includes('claude-code-sessions'));
  const record = JSON.parse(await readFile(indexes[0]));
  assert.equal(record.importedFrom, 'terminal-cli'); assert.equal(record.title, 'Continue the project'); assert.equal(record.cwd, '/synthetic/project');
});

test('short local session directories and account memories follow the current Claude storage contract', async t => {
  const f = await fixture(t);
  await put(join(f.sourceDataRoot, 'config.json'), { lastKnownAccountUuid: account });
  const scope = join(f.sourceDataRoot, 'local-agent-mode-sessions', account.slice(0, 8), org.slice(0, 8));
  await put(join(scope, session + '.json'), { sessionId: session, cliSessionId: cli, sessionType: 'agent', title: 'Cowork' });
  await put(join(scope, session.slice(6, 14), '.claude', 'projects', '-session', cli + '.jsonl'), transcript());
  await put(join(scope, 'memory', 'memory', 'MEMORY.md'), 'Shared local memory');
  await put(join(scope, 'agent', 'memory', 'MEMORY.md'), 'Cowork local memory');
  await put(join(scope, 'spaces', org, 'memory', 'MEMORY.md'), 'Project space memory');
  const result = await migrateProfile(f);
  const report = JSON.parse(await readFile(result.report_path)); assert.equal(report.portable_sessions, 1);
  const identity = Buffer.from(await readFile(join(f.targetDataRoot, 'ant-did'), 'utf8'), 'base64').toString();
  const destination = join(f.targetDataRoot, 'local-agent-mode-sessions', identity.slice(0, 8), '00000000');
  assert.equal(await readFile(join(destination, 'memory', 'memory', 'MEMORY.md'), 'utf8'), 'Shared local memory');
  assert.equal(await readFile(join(destination, 'agent', 'memory', 'MEMORY.md'), 'utf8'), 'Cowork local memory');
  assert.ok(result.warnings.includes('migration.project_space_memories_portable'));
  assert.ok((await files(join(f.targetDataRoot, 'portable-history', 'local-memory'))).some(path => path.endsWith(join('spaces', org, 'memory', 'MEMORY.md'))));
});

test('a publication failure rolls back only owned output and retains a failed manifest', async t => {
  const f = await fixture(t);
  const { transcriptPath } = await addSession(f);
  await put(transcriptPath, transcript().repeat(5000));
  const pending = migrateProfile(f).then(value => ({ value }), error => ({ error }));
  while (!(await readdir(f.root)).some(name => name.startsWith('.migration-'))) await new Promise(resolve => setTimeout(resolve, 1));
  await put(join(f.targetDataRoot, 'concurrent.txt'), 'preserve concurrent file');
  assert.equal((await pending).error?.code, 'setup.migration_failed');
  assert.equal(await readFile(join(f.targetDataRoot, 'concurrent.txt'), 'utf8'), 'preserve concurrent file');
  await assert.rejects(lstat(f.targetCodeRoot), { code: 'ENOENT' });
  const report = JSON.parse(await readFile(f.reportPath));
  assert.equal(report.status, 'failed'); assert.equal(report.copied_files, 0);
  assert.ok(report.staged_files_discarded > 0);
  assert.ok(report.files.some(file => file.status === 'discarded'));
  assert.ok(!(await readdir(f.root)).some(name => name.startsWith('.migration-')));
});

test('structured and embedded credentials are removed without deleting normal token usage', () => {
  const stats = { redactions: 0 };
  const result = sanitizeMigrationValue({ authorization: 'synthetic', message: 'password=private-value and useful text', usage: { input_tokens: 23 }, toolUseResult: { api_key: 'synthetic', content: 'Keep me' } }, stats);
  assert.equal(result.authorization, undefined); assert.equal(result.toolUseResult.api_key, undefined);
  assert.deepEqual(result.usage, { input_tokens: 23 }); assert.equal(result.toolUseResult.content, 'Keep me');
  assert.ok(result.message.includes('[REDACTED_CREDENTIAL]')); assert.equal(stats.redactions, 3);
});

test('contextual redaction removes unknown secrets in prefixed, quoted and embedded assignments', () => {
  const examples = [
    ['SERVICE_PASSWORD=opaque-a1', 'opaque-a1'],
    ['export MY_API_KEY="opaque value a2"', 'opaque value a2'],
    ["SERVICE_PASSWORD='opaque value a3; with punctuation'", 'opaque value a3'],
    ['Configuration {"MY_API_KEY":"opaque-a4","useful":true}', 'opaque-a4'],
    ['Escaped JSON {\\"SERVICE_PASSWORD\\":\\"opaque-a5\\"}', 'opaque-a5'],
    ['SERVICE_TOKEN=opaque-a6', 'opaque-a6'],
    ['Authorization: Bearer opaque7', 'opaque7'],
    ['Authorization: Basic opaque8', 'opaque8'],
  ];
  for (const [input, secret] of examples) {
    const result = sanitizeMigrationValue(input);
    assert.ok(!result.includes(secret), 'opaque credential remains in sanitized content');
    assert.ok(result.includes('[REDACTED_CREDENTIAL]'));
  }
  assert.deepEqual(JSON.parse(sanitizeMigrationValue('{"MY_API_KEY":"opaque-a9","useful":true}')), { MY_API_KEY: '[REDACTED_CREDENTIAL]', useful: true });
});

test('credential-bearing MCP token switches are omitted rather than activated', async t => {
  const f = await fixture(t);
  await put(join(f.sourceCodeRoot, '.claude.json'), { mcpServers: {
    separated: { command: 'node', args: ['server.mjs', '--token', 'opaque-separated'] },
    assigned: { command: 'node', args: ['server.mjs', '--token=opaque-assigned'] },
    prefixed: { command: 'node', args: ['server.mjs', '--service-token', 'opaque-prefixed'] },
    environment: { command: 'node', args: ['server.mjs', 'SERVICE_PASSWORD=opaque-env'] },
    safe: { command: 'node', args: ['server.mjs', '--transport', 'stdio'] },
  } });
  await put(join(f.sourceCodeRoot, 'CLAUDE.md'), 'MY_API_KEY="opaque-document"');
  const result = await migrateProfile(f);
  const config = JSON.parse(await readFile(join(f.targetCodeRoot, '.claude.json')));
  assert.deepEqual(Object.keys(config.mcpServers), ['safe']);
  assert.ok(result.warnings.includes('migration.mcp_definition_skipped'));
  const copied = (await Promise.all((await files(f.targetCodeRoot)).map(path => readFile(path, 'utf8')))).join('\n');
  for (const secret of ['opaque-separated', 'opaque-assigned', 'opaque-prefixed', 'opaque-env', 'opaque-document']) assert.ok(!copied.includes(secret));
});

test('the selected profile owns its Code source even when a distinct global source exists', async t => {
  const f = await fixture(t);
  await addSession(f);
  await put(join(f.sourceCodeRoot, 'CLAUDE.md'), 'Global context must not mix');
  const ownCode = join(f.sourceDataRoot, 'claude-code');
  await put(join(ownCode, 'settings.json'), { theme: 'dark' });
  await put(join(ownCode, 'CLAUDE.md'), 'Selected profile context');
  await put(join(ownCode, 'projects', '-synthetic-project', cli + '.jsonl'), transcript({ message: { role: 'user', content: 'Own profile history' } }));
  const source = await resolveMigrationSource({ sourceDataRoot: f.sourceDataRoot }, { defaultCodeRoot: f.sourceCodeRoot, standardDataRoots: [] });
  assert.equal(source.sourceCodeRoot, ownCode);
  const result = await migrateProfile({ ...f, sourceCodeRoot: undefined });
  assert.equal(await readFile(join(f.targetCodeRoot, 'CLAUDE.md'), 'utf8'), 'Selected profile context');
  const histories = (await files(f.targetDataRoot)).filter(path => path.endsWith('.jsonl'));
  assert.equal(histories.length, 1);
  assert.ok((await readFile(histories[0], 'utf8')).includes('Own profile history'));
  assert.equal(JSON.parse(await readFile(result.report_path)).native_code_sessions, 1);
});

test('managed source metadata binds the -3p profile to its own base Code root', async t => {
  const f = await fixture(t);
  const managed = join(f.root, 'managed-source'), data = join(managed, 'User Data'), code = join(data, 'claude-code');
  await mkdir(data + '-3p', { recursive: true });
  await put(join(code, 'settings.json'), { theme: 'dark' });
  await put(join(managed, 'installation.json'), { version: 1, name: 'Workspace', source: '/synthetic/Claude.app', launcher: '/synthetic/Workspace.app', userDataDirectory: data, codeConfigDirectory: code, createdAt: '2026-10-17T00:00:00Z' });
  await put(join(data + '-3p', 'claude-code', 'runtime-version', 'cache.bin'), 'runtime');
  const selected = await resolveMigrationSource({ sourceDataRoot: data + '-3p' }, { defaultCodeRoot: f.sourceCodeRoot, standardDataRoots: [] });
  assert.deepEqual(selected, { sourceDataRoot: data + '-3p', sourceCodeRoot: code });
  const explicit = await resolveMigrationSource({ sourceDataRoot: data + '-3p', sourceCodeRoot: f.sourceCodeRoot });
  assert.equal(explicit.sourceCodeRoot, f.sourceCodeRoot);
});

test('a custom profile with only runtime cache requires an explicit Code root instead of mixing global data', async t => {
  const f = await fixture(t);
  await put(join(f.sourceDataRoot, 'claude-code', 'runtime', 'cache.bin'), 'runtime');
  await put(join(f.sourceCodeRoot, 'CLAUDE.md'), 'Unrelated global context');
  await assert.rejects(resolveMigrationSource({ sourceDataRoot: f.sourceDataRoot }, { defaultCodeRoot: f.sourceCodeRoot, standardDataRoots: [] }), { code: 'setup.migration_source_selection_required' });
  await assert.rejects(migrateProfile({ ...f, sourceCodeRoot: undefined }), { code: 'setup.migration_source_selection_required' });
  await assert.rejects(lstat(f.targetDataRoot), { code: 'ENOENT' });
  await assert.rejects(lstat(f.targetCodeRoot), { code: 'ENOENT' });
});

test('installation metadata failure occurs before publication and rolls back only owned staging', async t => {
  const f = await fixture(t);
  const managed = join(f.root, 'managed'), temporary = join(f.root, '.workspace.app'), launcher = join(f.root, 'Workspace.app');
  await mkdir(join(managed, 'installation.json'), { recursive: true });
  await put(join(temporary, 'Contents', 'Info.plist'), 'synthetic launcher');
  await put(join(f.sourceDataRoot, 'keep.txt'), 'Original data');
  await assert.rejects(publishIsolatedInstallation({ managed, temporary, launcher, metadata: { name: 'Workspace', launcher, createdAt: '2026-10-17T00:00:00Z' } }));
  for (const path of [managed, temporary, launcher]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.sourceDataRoot, 'keep.txt'), 'utf8'), 'Original data');
});

test('successful publication already has verified metadata and copies launcher language resources', async t => {
  const f = await fixture(t);
  const managed = join(f.root, 'managed'), temporary = join(f.root, '.workspace.app'), launcher = join(f.root, 'Workspace.app');
  await mkdir(managed); await mkdir(join(temporary, 'Contents', 'Resources'), { recursive: true });
  await put(join(f.root, 'source-resources', 'Resources', 'en.lproj', 'Localizable.strings'), '"launcher.error" = "Unable to open";');
  await put(join(f.root, 'source-resources', 'Resources', 'pt.lproj', 'Localizable.strings'), '"launcher.error" = "Não foi possível abrir";');
  await copyLauncherLocalizations(join(f.root, 'source-resources'), join(temporary, 'Contents', 'Resources'));
  const metadata = { version: 1, name: 'Workspace', launcher, source: '/synthetic/Claude.app', userDataDirectory: join(managed, 'User Data'), codeConfigDirectory: join(managed, 'User Data', 'claude-code'), createdAt: '2026-10-17T00:00:00Z' };
  await publishIsolatedInstallation({ managed, temporary, launcher, metadata });
  assert.deepEqual(JSON.parse(await readFile(join(managed, 'installation.json'))), metadata);
  assert.ok((await readFile(join(launcher, 'Contents', 'Resources', 'pt.lproj', 'Localizable.strings'), 'utf8')).includes('Não foi possível abrir'));
  await assert.rejects(lstat(temporary), { code: 'ENOENT' });
});

test('URI userinfo is redacted for every scheme, including username-only authorities', async t => {
  const f = await fixture(t);
  const uris = [
    'postgres://db-user:opaque-pg-value@database.example/db',
    'mysql://db-user:opaque-mysql-value@database.example/db',
    'mongodb+srv://db-user:opaque-mongo-value@database.example/db',
    'redis://:opaque-redis-value@cache.example/0',
    'https://opaque-http-user@api.example/path',
    'custom+scheme://opaque-custom-user@api.example/path',
    'postgresql+psycopg://db-user:opaque%40encoded-value@database.example/db',
  ];
  for (const uri of uris) {
    const sanitized = sanitizeMigrationValue('Use ' + uri);
    assert.ok(sanitized.includes('[REDACTED_CREDENTIAL]@'));
    assert.ok(!sanitized.includes('opaque'));
  }
  await put(join(f.sourceCodeRoot, '.claude.json'), { mcpServers: Object.fromEntries([
    ...uris.map((uri, index) => ['dsn' + index, { command: 'node', args: ['server.mjs', '--dsn=' + uri] }]),
    ['safe', { command: 'node', args: ['server.mjs', '--dsn', 'postgres://database.example/db'] }],
  ]) });
  await put(join(f.sourceCodeRoot, 'CLAUDE.md'), uris.join('\n'));
  const result = await migrateProfile(f);
  const config = JSON.parse(await readFile(join(f.targetCodeRoot, '.claude.json')));
  assert.deepEqual(Object.keys(config.mcpServers), ['safe']);
  assert.ok(!(await readFile(join(f.targetCodeRoot, 'CLAUDE.md'), 'utf8')).includes('opaque'));
  assert.ok(result.warnings.includes('migration.mcp_definition_skipped'));
});

test('scripts altered by credential redaction or unsafe path rewriting are omitted without becoming executable', async t => {
  const f = await fixture(t);
  const scripts = join(f.sourceCodeRoot, 'skills', 'fixture', 'scripts');
  await put(join(f.sourceCodeRoot, 'skills', 'fixture', 'SKILL.md'), 'Run scripts/environment.mjs, scripts/literal.py and scripts/safe.py.\n');
  const inputs = {
    'literal.py': 'api_key = "opaque-script-value"\nprint(api_key)\n',
    'environment.mjs': 'const apiKey = process.env.MY_API_KEY;\nconsole.log(apiKey);\n',
    'uri.sh': 'export DATABASE_URL="postgres://user:opaque-script-uri@host/database"\n',
    'relocate.py': 'print("' + f.sourceCodeRoot + '/skills/fixture")\n',
    'safe.py': 'print("safe fixture")\n',
    'safe.sh': '#!/bin/sh\nprintf "safe fixture\\n"\n',
  };
  for (const [name, content] of Object.entries(inputs)) await put(join(scripts, name), content);
  const good = join(f.sourceCodeRoot, 'skills', 'complete');
  await put(join(good, 'SKILL.md'), 'Run scripts/safe.py or scripts/safe.sh.\n');
  for (const name of ['safe.py', 'safe.sh']) await put(join(good, 'scripts', name), inputs[name]);
  await chmod(join(good, 'scripts', 'safe.sh'), 0o700);
  const before = await hashes(f.sourceCodeRoot);
  const result = await migrateProfile(f);
  await assert.rejects(lstat(join(f.targetCodeRoot, 'skills', 'fixture')), { code: 'ENOENT' });
  const target = join(f.targetCodeRoot, 'skills', 'complete', 'scripts');
  assert.equal(await readFile(join(target, 'safe.py'), 'utf8'), inputs['safe.py']);
  assert.equal(await readFile(join(target, 'safe.sh'), 'utf8'), inputs['safe.sh']);
  assert.equal((await lstat(join(target, 'safe.py'))).mode & 0o111, 0);
  assert.equal((await lstat(join(target, 'safe.sh'))).mode & 0o777, 0o700);
  assert.ok(result.warnings.includes('migration.script_redaction_omitted'));
  assert.ok(result.warnings.includes('migration.script_path_rewrite_omitted'));
  assert.ok(result.warnings.includes('migration.skill_incomplete'));
  const report = JSON.parse(await readFile(result.report_path));
  assert.equal(report.files.filter(file => file.reason === 'migration.script_redaction_omitted').length, 3);
  assert.equal(report.files.filter(file => file.reason === 'migration.script_path_rewrite_omitted').length, 1);
  assert.equal(report.files.filter(file => file.reason === 'migration.skill_incomplete').length, 3);
  assert.equal(result.copied_files, 3);
  assert.equal(result.skipped_files, 7);
  assert.deepEqual(await hashes(f.sourceCodeRoot), before);
});

test('a skill referencing an omitted environment helper never becomes partially active', async t => {
  const f = await fixture(t);
  const skill = join(f.sourceCodeRoot, 'skills', 'example');
  await put(join(skill, 'SKILL.md'), '---\nname: example\ndescription: Synthetic fixture.\n---\nRun scripts/helper.py.\n');
  await put(join(skill, 'scripts', 'helper.py'), 'import os\napi_key = os.environ["MY_API_KEY"]\nprint(api_key)\n');
  const before = await hashes(f.sourceCodeRoot);
  const result = await migrateProfile(f);
  await assert.rejects(lstat(join(f.targetCodeRoot, 'skills', 'example')), { code: 'ENOENT' });
  assert.ok(!(await readdir(f.targetCodeRoot)).some(name => name.startsWith('.skill-import-')));
  const report = JSON.parse(await readFile(result.report_path));
  assert.equal(result.copied_files, 0);
  assert.equal(result.skipped_files, 2);
  assert.equal(report.files.length, 2);
  assert.ok(report.files.every(file => file.status === 'skipped'));
  assert.equal(report.files.filter(file => file.reason === 'migration.skill_incomplete').length, 1);
  assert.equal(report.files.filter(file => file.reason === 'migration.script_redaction_omitted').length, 1);
  assert.ok(result.warnings.includes('migration.skill_incomplete'));
  assert.deepEqual(await hashes(f.sourceCodeRoot), before);
});

test('an official source without a Code directory still migrates available Desktop context',async t=>{
 const f=await fixture(t);await rm(f.sourceCodeRoot,{recursive:true});
 await put(join(f.sourceDataRoot,'config.json'),{userThemeMode:'dark'});
 const source=await resolveMigrationSource({sourceDataRoot:f.sourceDataRoot},{defaultCodeRoot:f.sourceCodeRoot,standardDataRoots:[f.sourceDataRoot]});
 assert.equal(source.sourceCodeRoot,null);
 const result=await migrateProfile({...f,...source});
 assert.ok(result.warnings.includes('migration.code_root_unavailable'));
 assert.equal(JSON.parse(await readFile(join(f.targetDataRoot,'config.json'))).userThemeMode,'dark');
});
