import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, dirname, basename, extname, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const localId = /^local_[a-zA-Z0-9_-]+$/;
const orgId = '00000000-0000-4000-8000-000000000001';
const secretKey = /^(?:.*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|oauth|authorization|cookie).*|.*(?:[_-]token|Token)|token|.*private[_-]?key|env|headers|customHeaders|auth|authentication)$/i;
const forbiddenName = /(?:^\.env(?:\.|$)|credentials?|oauth|cookies?|keychain|auth(?:\.json|[-_])|id_(?:rsa|ed25519)|\.pem$|\.p12$|\.key$)/i;
const textExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.py', '.sh', '.js', '.mjs', '.ts']);
const scriptExtensions = new Set(['.py', '.sh', '.js', '.mjs', '.ts']);
const attachmentExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md', '.csv', '.json', '.html', '.svg']);
const uriUserinfo = /\b([a-z][a-z0-9+.-]*:\/\/)[^\r\n/?#"'`<>]+@/gi;
const secretPatterns = [
  /\bsk-(?:ant-(?:api\d+|oat\d+)-|proj-|svcacct-|or-v1-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:hf_|r8_)[A-Za-z0-9]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9_.~+\/-]{12,}={0,2}/gi,
];
const desktopKeys = ['locale', 'scale', 'userThemeMode'];
const preferenceKeys = ['menuBarEnabled', 'quickEntryShortcut', 'coworkBrowserToolsEnabled', 'coworkPreferredBrowser', 'sidebarMode', 'dockBounceEnabled', 'coworkWebSearchEnabled', 'keepAwakeEnabled', 'ccdScheduledTasksEnabled', 'coworkScheduledTasksEnabled'];
const codeKeys = ['enableWorkflows', 'ultracode', 'theme', 'inputNeededNotifEnabled', 'agentPushNotifEnabled', 'voiceEnabled', 'skipWorkflowUsageWarning', 'alwaysThinkingEnabled', 'language', 'autoMemoryEnabled', 'respectGitignore'];
const persistentEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
const reservedModelNames = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map(name => name.toLowerCase()));
const validCompactWindow = value => Number.isInteger(value) && value >= 100000 && value <= 1000000;
const safeModelName = name => name.length <= 256 && !/[\u0000-\u0020\u007f]/.test(name) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@\d{8})?(?:\[1m\])?$/i.test(name) && !name.replace(/(?:@\d{8})?(?:\[1m\])?$/i, '').split(/[.:/]/).some(part => reservedModelNames.has(part.toLowerCase())) && !name.split(/[/:]/).some(part => part === '.' || part === '..');
const maxEntries = 50000;
const maxFile = 512 * 1024 * 1024;
const maxText = 16 * 1024 * 1024;
const maxLine = 8 * 1024 * 1024;
const maxTotal = 8 * 1024 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => path === root || path.startsWith(root + sep);
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const failure = code => Object.assign(new Error(code), { code });
const pick = (value, keys) => Object.fromEntries(keys.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key])).map(key => [key, value[key]]));

export function migrationOptions({ migrate_data, source_data_root, source_code_root } = {}) {
  if (migrate_data !== undefined && typeof migrate_data !== 'boolean') throw failure('setup.migration_failed');
  const enabled = migrate_data ?? (typeof source_data_root === 'string' && source_data_root.trim().length > 0);
  if (!enabled) return null;
  if (typeof source_data_root !== 'string' || !isAbsolute(source_data_root) || source_data_root.includes('\0')) throw failure('setup.migration_failed');
  if (source_code_root !== undefined && (typeof source_code_root !== 'string' || !isAbsolute(source_code_root) || source_code_root.includes('\0'))) throw failure('setup.migration_failed');
  return { sourceDataRoot: resolve(source_data_root), ...(source_code_root !== undefined ? { sourceCodeRoot: resolve(source_code_root) } : {}) };
}

export async function resolveMigrationSource(options, { defaultCodeRoot = join(homedir(), '.claude'), standardDataRoots = [join(homedir(), 'Library', 'Application Support', 'Claude'), join(homedir(), 'Library', 'Application Support', 'Claude-3p')] } = {}) {
  if (!options) return null;
  const sourceDataRoot = await rootDirectory(options.sourceDataRoot);
  if (options.sourceCodeRoot === null) return { sourceDataRoot, sourceCodeRoot: null };
  if (options.sourceCodeRoot !== undefined) return { sourceDataRoot, sourceCodeRoot: await rootDirectory(options.sourceCodeRoot) };
  const selectionRequired = () => Object.assign(failure('setup.migration_source_selection_required'), { migration: { copied_files: 0, skipped_files: 0, warnings: ['migration.code_root_selection_required'], report_path: null } });
  const baseDataRoot = sourceDataRoot.endsWith('-3p') ? sourceDataRoot.slice(0, -3) : sourceDataRoot;
  const candidatePaths = [...new Set([join(baseDataRoot, 'claude-code'), join(sourceDataRoot, 'claude-code')])];
  if (basename(baseDataRoot) === 'User Data') {
    const managedRoot = dirname(baseDataRoot);
    try {
      const record = JSON.parse((await stableRead(managedRoot, join(managedRoot, 'installation.json'), 65536)).buffer.toString('utf8'));
      if (!plain(record) || typeof record.name !== 'string' || !isAbsolute(record.source ?? '') || !isAbsolute(record.launcher ?? '') || !Number.isFinite(Date.parse(record.createdAt))) throw selectionRequired();
      if (record.userDataDirectory !== undefined && resolve(record.userDataDirectory) !== baseDataRoot || record.codeConfigDirectory !== undefined && resolve(record.codeConfigDirectory) !== candidatePaths[0]) throw selectionRequired();
      const sourceCodeRoot = await rootDirectory(candidatePaths[0]);
      const settings = JSON.parse((await stableRead(sourceCodeRoot, join(sourceCodeRoot, 'settings.json'))).buffer.toString('utf8'));
      if (!plain(settings)) throw selectionRequired();
      return { sourceDataRoot, sourceCodeRoot };
    } catch (error) { if (error.code !== 'ENOENT') throw selectionRequired(); }
  }
  const candidates = [];
  for (const path of candidatePaths) {
    try {
      const root = await rootDirectory(path);
      const settings = JSON.parse((await stableRead(root, join(root, 'settings.json'))).buffer.toString('utf8'));
      if (!plain(settings)) continue;
      let reusable = false;
      for (const marker of ['projects', 'skills', 'rules', 'CLAUDE.md', 'AGENTS.md']) {
        try { const stat = await inspect(root, join(root, marker)); reusable ||= stat.isDirectory() || ['CLAUDE.md', 'AGENTS.md'].includes(marker) && stat.isFile(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (reusable && !candidates.includes(root)) candidates.push(root);
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw selectionRequired(); }
  }
  if (candidates.length === 1) return { sourceDataRoot, sourceCodeRoot: candidates[0] };
  if (candidates.length > 1) throw selectionRequired();
  if (standardDataRoots.map(path => resolve(path)).includes(sourceDataRoot)) {
    try { return { sourceDataRoot, sourceCodeRoot: await rootDirectory(defaultCodeRoot) }; }
    catch (error) { if (error.code === 'ENOENT') return { sourceDataRoot, sourceCodeRoot: null }; throw selectionRequired(); }
  }
  throw selectionRequired();
}

export function sanitizeMigrationValue(value, stats = { redactions: 0 }) {
  if (typeof value === 'string') {
    let result = value;
    if (stats.knownSecrets?.size) {
      stats.knownPattern ??= new RegExp([...stats.knownSecrets].sort((a, b) => b.length - a.length).map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
      result = result.replace(stats.knownPattern, () => { stats.redactions++; return '[REDACTED_CREDENTIAL]'; });
    }
    result = result.replace(uriUserinfo, (_match, scheme) => { stats.redactions++; return `${scheme}[REDACTED_CREDENTIAL]@`; });
    for (const pattern of secretPatterns) result = result.replace(pattern, () => { stats.redactions++; return '[REDACTED_CREDENTIAL]'; });
    return redactAssignments(result, stats);
  }
  if (Array.isArray(value)) return value.map(item => sanitizeMigrationValue(item, stats));
  if (plain(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (secretKey.test(key)) { stats.redactions++; return []; }
    return [[key, sanitizeMigrationValue(item, stats)]];
  }));
  return value;
}

function redactAssignments(value, stats) {
  const assignments = /(^|[^A-Za-z0-9_])((?:\\?["'])?([A-Za-z_][A-Za-z0-9_.-]*)(?:\\?["'])?[ \t]*[:=][ \t]*)/g;
  let match, cursor = 0, result = '';
  while ((match = assignments.exec(value))) {
    if (!secretKey.test(match[3])) continue;
    const start = assignments.lastIndex;
    let quote = '', end = start;
    if (value.startsWith('\\"', start) || value.startsWith("\\'", start)) quote = value.slice(start, start + 2);
    else if (['"', "'", '`'].includes(value[start])) quote = value[start];
    if (quote) {
      end = start + quote.length;
      for (;;) {
        end = value.indexOf(quote, end);
        if (end < 0) { end = value.length; break; }
        let escapes = 0;
        for (let index = end - 1; index >= start + quote.length && value[index] === '\\'; index--) escapes++;
        if (escapes % 2 === 0) break;
        end += quote.length;
      }
    } else {
      while (end < value.length && !/[\s,;<>`"'{}\[\]()]/.test(value[end])) end++;
      if (/auth/i.test(match[3]) && /^(?:Basic|Bearer|Token)$/i.test(value.slice(start, end))) {
        while (end < value.length && /[ \t]/.test(value[end])) end++;
        while (end < value.length && !/[\s,;<>`"'{}\[\]()]/.test(value[end])) end++;
      }
    }
    if (end === start || end === start + quote.length) continue;
    result += value.slice(cursor, start) + quote + '[REDACTED_CREDENTIAL]';
    cursor = end;
    assignments.lastIndex = end + quote.length;
    stats.redactions++;
  }
  return result + value.slice(cursor);
}

function collectKnownSecrets(value, stats, sensitive = false) {
  if (typeof value === 'string') {
    if (sensitive && value.length >= 8 && value.length <= 8192 && !value.startsWith('/') && !value.startsWith('${') && stats.knownSecrets.size < 1000) { stats.knownSecrets.add(value); stats.knownPattern = null; }
  } else if (Array.isArray(value)) for (const item of value) collectKnownSecrets(item, stats, sensitive);
  else if (plain(value)) for (const [key, item] of Object.entries(value)) collectKnownSecrets(item, stats, sensitive || secretKey.test(key));
}

async function rootDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw failure('migration.invalid_root');
  const normalized = resolve(path), stat = await lstat(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('migration.unsafe_path');
  return realpath(normalized);
}

async function inspect(root, path) {
  path = resolve(path);
  if (!inside(root, path)) throw failure('migration.unsafe_path');
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw failure('migration.symlink_skipped');
  }
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1n) || !inside(root, await realpath(path))) throw failure('migration.unsafe_path');
  return stat;
}

async function stableRead(root, path, limit = maxText) {
  const before = await inspect(root, path);
  if (!before.isFile() || before.size > BigInt(limit)) throw failure('migration.file_limit');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) throw failure('migration.source_changed');
    const buffer = await handle.readFile();
    if (buffer.length > limit) throw failure('migration.file_limit');
    const after = await inspect(root, path);
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before) || fingerprint(after) !== fingerprint(before)) throw failure('migration.source_changed');
    return { buffer, fingerprint: fingerprint(after), mode: Number(after.mode) };
  } finally { await handle.close(); }
}

async function writeExclusive(path, content, executable = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, executable ? 0o700 : 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  catch (error) { await rm(path, { force: true }); throw error; }
  finally { await handle.close(); }
}

const jsonBytes = value => JSON.stringify(value, null, 2) + '\n';
async function requireAbsent(path) {
  try { await lstat(path); throw failure('migration.target_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function optionalJSON(root, file, report, category) {
  const path = join(root, file);
  try {
    const result = await stableRead(root, path);
    const value = JSON.parse(result.buffer.toString('utf8'));
    if (!plain(value)) throw failure('migration.invalid_schema');
    collectKnownSecrets(value, report.sanitizer);
    return { value, path, fingerprint: result.fingerprint };
  } catch (error) {
    if (error.code !== 'ENOENT') report.skip(category, root, path, error.code ?? 'migration.invalid_json');
    return null;
  }
}

function makeReport({ sanitizer = { redactions: 0, knownSecrets: new Set(), knownPattern: null }, budget = { bytes: 0, entries: 0 } } = {}) {
  const document = { version: 1, status: 'running', created_at: new Date().toISOString(), copied_files: 0, skipped_files: 0, redactions: 0, native_code_sessions: 0, portable_sessions: 0, limits: { entries: maxEntries, file_bytes: maxFile, text_file_bytes: maxText, transcript_line_bytes: maxLine, total_bytes: maxTotal }, warnings: [], files: [] };
  const warnings = new Set(), counted = new Set();
  const record = entry => {
    if (counted.has(entry.source_id)) return;
    counted.add(entry.source_id);
    document[entry.status === 'copied' ? 'copied_files' : 'skipped_files']++;
    if (document.files.length < maxEntries) document.files.push(entry);
    if (entry.reason) warnings.add(entry.reason);
  };
  return {
    document,
    sanitizer,
    budget,
    warn(code) { warnings.add(code); },
    add(status, category, root, path, reason, target) {
      record({ source_id: digest(category + '\0' + relative(root, path)), category, status, ...(reason ? { reason } : {}), ...(target ? { target } : {}) });
    },
    skip(category, root, path, code) { this.add('skipped', category, root, path, code); },
    merge(child, discarded = false) {
      const other = child.finish(discarded ? 'discarded' : 'completed');
      for (const code of other.warnings) warnings.add(code);
      for (const entry of other.files) record(discarded && entry.status === 'copied' ? { ...entry, status: 'skipped', reason: 'migration.skill_incomplete' } : entry);
    },
    finish(status) { document.status = status; document.redactions = sanitizer.redactions; if (sanitizer.redactions) warnings.add('migration.credentials_redacted'); document.warnings = [...warnings].sort(); return document; },
  };
}

async function walk(root, start, report, category, accept, maxDepth = 10, reportUnsupported = false, includeDirectory = () => true) {
  const files = [], pending = [{ path: start, depth: 0 }];
  while (pending.length) {
    const { path: directory, depth } = pending.shift();
    let entries;
    try { const stat = await inspect(root, directory); if (!stat.isDirectory()) throw failure('migration.unsafe_path'); entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') report.skip(category, root, directory, error.code ?? 'migration.unreadable'); continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++report.budget.entries > maxEntries) { report.warn('migration.entry_limit'); return files; }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || forbiddenName.test(entry.name)) { report.skip(category, root, path, entry.isSymbolicLink() ? 'migration.symlink_skipped' : 'migration.sensitive_file_excluded'); continue; }
      if (entry.isDirectory()) {
        if (!includeDirectory(path)) continue;
        if (['node_modules', '.git', 'cache', 'debug', 'logs', 'telemetry', 'session-env'].includes(entry.name)) { report.skip(category, root, path, 'migration.runtime_excluded'); continue; }
        if (depth >= maxDepth) report.skip(category, root, path, 'migration.depth_limit');
        else pending.push({ path, depth: depth + 1 });
      } else if (entry.isFile() && accept(path)) files.push(path);
      else if (reportUnsupported) report.skip(category, root, path, 'migration.unsupported_file');
    }
  }
  return files;
}

async function copyText(root, source, destination, report, category, replacements = []) {
  try {
    const { buffer, mode } = await stableRead(root, source);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\0')) throw failure('migration.unsupported_file');
    const script = scriptExtensions.has(extname(source).toLowerCase()) || text.startsWith('#!');
    let sanitized = extname(source) === '.json' ? jsonBytes(sanitizeMigrationValue(JSON.parse(text), report.sanitizer)) : sanitizeMigrationValue(text, report.sanitizer);
    if (script && sanitized !== text) throw failure('migration.script_redaction_omitted');
    for (const [from, to] of replacements) sanitized = sanitized.replaceAll(from, to);
    if (script && sanitized !== text) throw failure('migration.script_path_rewrite_omitted');
    if (report.budget.bytes + Buffer.byteLength(sanitized) > maxTotal) throw failure('migration.total_limit');
    report.budget.bytes += Buffer.byteLength(sanitized);
    await writeExclusive(destination, sanitized, script && (mode & 0o111) !== 0);
    report.add('copied', category, root, source);
    return true;
  } catch (error) {
    report.skip(category, root, source, ['EACCES', 'EPERM', 'ENOENT'].includes(error.code) ? 'migration.unreadable' : error.code?.startsWith('migration.') ? error.code : 'migration.invalid_text');
    return false;
  }
}

async function copyTranscript(root, source, destination, report, budget, transform = true) {
  const before = await inspect(root, source);
  if (!before.isFile() || before.size > BigInt(maxFile)) throw failure('migration.file_limit');
  if (budget.bytes + Number(before.size) > maxTotal) throw failure('migration.total_limit');
  budget.bytes += Number(before.size);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    if (fingerprint(await input.stat({ bigint: true })) !== fingerprint(before)) throw failure('migration.source_changed');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let remainder = '', position = 0, lines = 0, cwd, title, createdAt, lastActivityAt;
    const consume = async line => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > maxLine) throw failure('migration.line_limit');
      const frame = JSON.parse(line);
      if (!plain(frame)) throw failure('migration.invalid_transcript');
      cwd ??= typeof frame.cwd === 'string' && isAbsolute(frame.cwd) && !frame.cwd.includes('\0') ? frame.cwd : undefined;
      const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : Date.parse(frame.timestamp);
      if (Number.isFinite(timestamp)) { createdAt = Math.min(createdAt ?? timestamp, timestamp); lastActivityAt = Math.max(lastActivityAt ?? timestamp, timestamp); }
      if (title === undefined && frame.type === 'user') {
        const content = frame.message?.content;
        title = typeof content === 'string' ? content.slice(0, 160) : Array.isArray(content) ? content.find(item => item?.type === 'text')?.text?.slice(0, 160) : undefined;
      }
      if (transform) {
        delete frame.sessionId;
        if (plain(frame.toolUseResult)) delete frame.toolUseResult.agentId;
      }
      await output.writeFile(JSON.stringify(sanitizeMigrationValue(frame, report.sanitizer)) + '\n');
      lines++;
    };
    const chunk = Buffer.alloc(64 * 1024);
    while (position < Number(before.size)) {
      const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, Number(before.size) - position), position);
      if (!bytesRead) throw failure('migration.source_changed');
      position += bytesRead;
      remainder += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
      let split;
      while ((split = remainder.indexOf('\n')) !== -1) { await consume(remainder.slice(0, split)); remainder = remainder.slice(split + 1); }
      if (Buffer.byteLength(remainder) > maxLine) throw failure('migration.line_limit');
    }
    remainder += decoder.decode();
    if (remainder.trim()) await consume(remainder);
    if (!lines) throw failure('migration.empty_transcript');
    if (fingerprint(await input.stat({ bigint: true })) !== fingerprint(before) || fingerprint(await inspect(root, source)) !== fingerprint(before)) throw failure('migration.source_changed');
    await output.sync();
    return { lines, cwd, title, createdAt, lastActivityAt, fingerprint: fingerprint(before) };
  } catch (error) {
    if (output) await rm(destination, { force: true });
    if (error.code?.startsWith('migration.')) throw error;
    if (error instanceof SyntaxError || error instanceof TypeError) throw failure('migration.invalid_transcript');
    throw failure('migration.unreadable');
  } finally { await output?.close(); await input.close(); }
}

async function nativeCode(sourceData, sourceCode, targetData, stageData, config, report, budget, accountId) {
  const indexRoot = join(sourceData, 'claude-code-sessions');
  const indexFiles = await walk(sourceData, indexRoot, report, 'code_index', path => localId.test(basename(path, '.json')) && extname(path) === '.json', 2, false, path => relative(indexRoot, path).split(sep).length <= 2);
  const records = [];
  const sourceAccount = uuid.test(config?.lastKnownAccountUuid ?? '') ? config.lastKnownAccountUuid.toLowerCase() : null;
  const accounts = new Set(indexFiles.map(path => relative(indexRoot, path).split(sep)[0]).filter(value => uuid.test(value)));
  const selected = sourceAccount ?? (accounts.size === 1 ? [...accounts][0] : null);
  if (!selected && accounts.size > 1) report.warn('migration.source_account_ambiguous');
  for (const path of indexFiles) {
    const parts = relative(indexRoot, path).split(sep);
    if (parts.length !== 3 || parts[0].toLowerCase() !== selected || !uuid.test(parts[1])) { report.skip('code_index', sourceData, path, 'migration.other_account_index'); continue; }
    const entry = await optionalJSON(sourceData, relative(sourceData, path), report, 'code_index');
    if (entry) records.push(entry);
  }
  const transcripts = sourceCode ? await walk(sourceCode, join(sourceCode, 'projects'), report, 'code_history', path => extname(path) === '.jsonl' && (uuid.test(basename(path, '.jsonl')) || /^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(basename(path))), 4) : [];
  const direct = new Map();
  for (const path of transcripts) {
    if (relative(join(sourceCode, 'projects'), path).split(sep).length !== 2) continue;
    const id = basename(path, '.jsonl');
    direct.set(id, direct.has(id) ? null : path);
  }
  const imported = new Set(), claimed = new Set();
  const targetIndex = join('claude-code-sessions', accountId, orgId);
  const convert = async (entry, source, root, origin) => {
    const cliSessionId = randomUUID(), sessionId = 'local_' + randomUUID();
    const transcriptRelative = join(targetIndex, 'imported-staging', cliSessionId + '.jsonl');
    const staged = join(stageData, transcriptRelative);
    try {
      const details = await copyTranscript(root, source, staged, report, budget);
      const record = entry?.value ?? {};
      if (entry && fingerprint(await inspect(sourceData, entry.path)) !== entry.fingerprint) throw failure('migration.source_changed');
      const cwd = record.cwd ?? details.cwd;
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0') || cwd.length > 4096) throw failure('migration.missing_working_directory');
      const result = sanitizeMigrationValue({
        sessionId, cliSessionId, cwd, originCwd: typeof record.originCwd === 'string' && isAbsolute(record.originCwd) ? record.originCwd : cwd,
        title: typeof record.title === 'string' ? record.title : details.title ?? '',
        createdAt: Number.isFinite(record.createdAt) ? record.createdAt : details.createdAt ?? Date.now(),
        lastActivityAt: Number.isFinite(record.lastActivityAt) ? record.lastActivityAt : details.lastActivityAt ?? Date.now(),
        indexedAt: Date.now(), isArchived: record.isArchived === true, isStarred: record.isStarred === true,
        importedFrom: origin, stagedTranscriptPath: join(targetData, transcriptRelative),
      }, report.sanitizer);
      await writeExclusive(join(stageData, targetIndex, sessionId + '.json'), jsonBytes(result));
      report.add('copied', 'code_history', root, source);
      if (entry) report.add('copied', 'code_index', sourceData, entry.path);
      report.document.native_code_sessions++;
      imported.add(source);
    } catch (error) {
      await rm(staged, { force: true });
      report.skip(entry ? 'code_index' : 'code_history', entry ? sourceData : root, entry?.path ?? source, error.code?.startsWith('migration.') ? error.code : 'migration.copy_failed');
    }
  };
  for (const entry of records) {
    const record = entry.value;
    if (!localId.test(record.sessionId ?? '') || !uuid.test(record.cliSessionId ?? '')) { report.skip('code_index', sourceData, entry.path, 'migration.invalid_schema'); continue; }
    let source = direct.get(record.cliSessionId), root = sourceCode;
    if (typeof record.stagedTranscriptPath === 'string' && inside(join(dirname(entry.path), 'imported-staging'), resolve(record.stagedTranscriptPath)) && extname(record.stagedTranscriptPath) === '.jsonl') { source = resolve(record.stagedTranscriptPath); root = sourceData; }
    if (!source) { report.skip('code_index', sourceData, entry.path, 'migration.transcript_missing_or_ambiguous'); continue; }
    claimed.add(source);
    if (imported.has(source)) { report.skip('code_index', sourceData, entry.path, 'migration.duplicate_session'); continue; }
    await convert(entry, source, root, 'previous-profile-code');
  }
  for (const source of direct.values()) if (source && !claimed.has(source)) await convert(null, source, sourceCode, 'terminal-cli');
  for (const source of transcripts) {
    if (relative(join(sourceCode, 'projects'), source).split(sep).length === 2) continue;
    const destination = join(stageData, 'portable-history', 'code-supplementary', digest(relative(sourceCode, source)) + '.jsonl');
    try { await copyTranscript(sourceCode, source, destination, report, budget, false); report.add('copied', 'supplementary_history', sourceCode, source); report.warn('migration.supplementary_history_portable'); }
    catch (error) { report.skip('supplementary_history', sourceCode, source, error.code ?? 'migration.copy_failed'); }
  }
}

async function portableSessions(sourceData, stageData, report, budget, config) {
  const sessionsRoot = join(sourceData, 'local-agent-mode-sessions');
  const indexes = await walk(sourceData, sessionsRoot, report, 'local_history', path => extname(path) === '.json' && localId.test(basename(path, '.json')), 2, false, path => relative(sessionsRoot, path).split(sep).length <= 2);
  const available = new Set(indexes.map(path => relative(sessionsRoot, path).split(sep)[0]));
  const selectedAccount = uuid.test(config?.lastKnownAccountUuid ?? '') ? config.lastKnownAccountUuid.slice(0, 8).toLowerCase() : available.size === 1 ? [...available][0].toLowerCase() : null;
  if (!selectedAccount && available.size > 1) { report.warn('migration.source_account_ambiguous'); return; }
  for (const index of indexes) {
    const parts = relative(sessionsRoot, index).split(sep);
    if (parts.length !== 3 || selectedAccount && !parts[0].toLowerCase().startsWith(selectedAccount)) continue;
    const entry = await optionalJSON(sourceData, relative(sourceData, index), report, 'local_history');
    if (!entry) continue;
    const record = entry.value;
    if (!localId.test(record.sessionId ?? '') || record.sessionId + '.json' !== basename(index) || !uuid.test(record.cliSessionId ?? '') || !['chat', 'agent', 'radar', 'dispatch_child', 'scheduled', undefined].includes(record.sessionType)) { report.skip('local_history', sourceData, index, 'migration.invalid_schema'); continue; }
    let session = join(dirname(index), record.sessionId);
    try { await inspect(sourceData, session); }
    catch (error) {
      if (error.code === 'ENOENT' && /^local_[0-9a-f-]{36}$/i.test(record.sessionId)) session = join(dirname(index), record.sessionId.slice(6, 14));
      else { report.skip('local_history', sourceData, index, error.code ?? 'migration.unsafe_path'); continue; }
    }
    const files = await walk(sourceData, join(session, '.claude', 'projects'), report, 'local_transcript', path => basename(path) === record.cliSessionId + '.jsonl', 1);
    if (files.length !== 1) { report.skip('local_history', sourceData, index, 'migration.local_body_unavailable'); continue; }
    const outputRoot = join(stageData, 'portable-history', 'local-sessions', randomUUID());
    try {
      await copyTranscript(sourceData, files[0], join(outputRoot, 'transcript.jsonl'), report, budget, false);
      if (fingerprint(await inspect(sourceData, index)) !== entry.fingerprint) throw failure('migration.source_changed');
      await writeExclusive(join(outputRoot, 'session.json'), jsonBytes(sanitizeMigrationValue({ ...pick(record, ['title', 'createdAt', 'lastActivityAt', 'isStarred', 'isArchived', 'sessionType']), format: 'portable-claude-transcript', native_resume: false }, report.sanitizer)));
      report.add('copied', 'local_history', sourceData, index);
      report.add('copied', 'local_transcript', sourceData, files[0]);
      report.document.portable_sessions++;
      report.warn('migration.local_history_portable_only');
    } catch (error) { await rm(outputRoot, { recursive: true, force: true }); report.skip('local_history', sourceData, index, error.code ?? 'migration.copy_failed'); continue; }
    for (const category of ['outputs', 'uploads']) {
      const base = join(session, category);
      const attachments = await walk(sourceData, base, report, 'attachment', path => attachmentExtensions.has(extname(path).toLowerCase()), 5, true);
      for (const source of attachments) {
        const destination = join(outputRoot, category, relative(base, source));
        if (['.txt', '.md', '.csv', '.json', '.html', '.svg'].includes(extname(source).toLowerCase())) { await copyText(sourceData, source, destination, report, 'attachment'); continue; }
        try {
          const { buffer } = await stableRead(sourceData, source, 64 * 1024 * 1024);
          if (budget.bytes + buffer.length > maxTotal) throw failure('migration.total_limit');
          budget.bytes += buffer.length;
          const type = extname(source).toLowerCase();
          const valid = type === '.pdf' ? buffer.subarray(0, 5).toString() === '%PDF-' : type === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : ['.jpg', '.jpeg'].includes(type) ? buffer[0] === 255 && buffer[1] === 216 : type === '.gif' ? /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString()) : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
          if (!valid) throw failure('migration.attachment_type_mismatch');
          await writeExclusive(destination, buffer);
          report.add('copied', 'attachment', sourceData, source);
        } catch (error) { report.skip('attachment', sourceData, source, error.code ?? 'migration.copy_failed'); }
      }
    }
  }
}

async function localMemories(sourceData, stageData, report, config, accountId) {
  const root = join(sourceData, 'local-agent-mode-sessions');
  const selected = uuid.test(config?.lastKnownAccountUuid ?? '') ? config.lastKnownAccountUuid.toLowerCase() : null;
  let accounts;
  try { await inspect(sourceData, root); accounts = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') report.warn('migration.local_memory_unreadable'); return; }
  const matches = accounts.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && (uuid.test(entry.name) || /^[0-9a-f]{8}$/i.test(entry.name)) && (!selected || entry.name.toLowerCase() === selected || entry.name.toLowerCase() === selected.slice(0, 8)));
  if (!selected && matches.length > 1) { report.warn('migration.source_account_ambiguous'); return; }
  const scopes = [];
  for (const account of matches) {
    const accountRoot = join(root, account.name);
    try {
      await inspect(sourceData, accountRoot);
      for (const entry of await readdir(accountRoot, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && (uuid.test(entry.name) || /^[0-9a-f]{8}$/i.test(entry.name))) scopes.push(join(accountRoot, entry.name));
    } catch { report.warn('migration.local_memory_unreadable'); }
  }
  for (const scope of scopes) {
    const identityRoot = join(stageData, 'local-agent-mode-sessions', accountId.slice(0, 8), orgId.slice(0, 8));
    const portableRoot = join(stageData, 'portable-history', 'local-memory', digest(relative(sourceData, scope)));
    for (const category of ['memory', join('agent', 'memory')]) {
      const sourceRoot = join(scope, category);
      const paths = await walk(sourceData, sourceRoot, report, 'local_memory', path => ['.md', '.txt', '.json'].includes(extname(path).toLowerCase()), 8);
      for (const path of paths) await copyText(sourceData, path, join(scopes.length === 1 ? identityRoot : portableRoot, category, relative(sourceRoot, path)), report, 'local_memory');
      if (paths.length && scopes.length > 1) report.warn('migration.multiple_org_memories_portable');
    }
    const spacesRoot = join(scope, 'spaces');
    let spaces;
    try { await inspect(sourceData, spacesRoot); spaces = await readdir(spacesRoot, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') report.warn('migration.local_memory_unreadable'); continue; }
    for (const space of spaces) {
      if (!space.isDirectory() || space.isSymbolicLink() || !uuid.test(space.name)) continue;
      const sourceRoot = join(spacesRoot, space.name, 'memory');
      const paths = await walk(sourceData, sourceRoot, report, 'space_memory', path => ['.md', '.txt', '.json'].includes(extname(path).toLowerCase()), 8);
      for (const path of paths) await copyText(sourceData, path, join(portableRoot, 'spaces', space.name, 'memory', relative(sourceRoot, path)), report, 'space_memory');
      if (paths.length) report.warn('migration.project_space_memories_portable');
    }
  }
}

function safeMcpServers(value, report) {
  if (!plain(value)) return {};
  const result = {};
  for (const [name, server] of Object.entries(value)) {
    if (!/^[\p{L}\p{N}_. -]{1,100}$/u.test(name) || !plain(server)) { report.warn('migration.mcp_definition_skipped'); continue; }
    const clean = {};
    if (typeof server.url === 'string') {
      try {
        const url = new URL(server.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || sanitizeMigrationValue(server.url, report.sanitizer) !== server.url) throw new Error();
        clean.url = server.url;
        if (['http', 'sse'].includes(server.type)) clean.type = server.type;
      } catch { report.warn('migration.mcp_definition_skipped'); continue; }
    } else if (typeof server.command === 'string' && !/[\n\r\0]/.test(server.command) && sanitizeMigrationValue(server.command, report.sanitizer) === server.command && !['sh', 'bash', 'zsh', 'fish', 'powershell', 'cmd'].includes(basename(server.command)) && Array.isArray(server.args ?? [])) {
      const args = server.args ?? [];
      if (args.some(value => typeof value !== 'string' || ['-c', '-e', '-H', '-u', '--eval', '--command', '--header', '--headers', '--user'].includes(value.split('=', 1)[0]) || secretKey.test(value.replace(/^-+/, '').split('=', 1)[0]) || /[\n\r\0]/.test(value) || sanitizeMigrationValue(value, report.sanitizer) !== value)) { report.warn('migration.mcp_definition_skipped'); continue; }
      clean.command = server.command; clean.args = args;
    } else { report.warn('migration.mcp_definition_skipped'); continue; }
    if (server.env || server.headers || server.oauth) report.warn('migration.mcp_credentials_not_copied');
    result[name] = clean;
  }
  return result;
}

async function reusableSkills(sourceCode, targetCode, stageCode, report) {
  const root = join(sourceCode, 'skills');
  let entries;
  try { const stat = await inspect(sourceCode, root); if (!stat.isDirectory()) throw failure('migration.unsafe_path'); entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') report.skip('skills', sourceCode, root, error.code ?? 'migration.unreadable'); return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (++report.budget.entries > maxEntries) { report.warn('migration.entry_limit'); return; }
    const source = join(root, entry.name);
    if (entry.isSymbolicLink() || forbiddenName.test(entry.name)) { report.skip('skills', sourceCode, source, entry.isSymbolicLink() ? 'migration.symlink_skipped' : 'migration.sensitive_file_excluded'); continue; }
    if (!entry.isDirectory()) {
      if (entry.isFile() && textExtensions.has(extname(source).toLowerCase())) await copyText(sourceCode, source, join(stageCode, 'skills', entry.name), report, 'skills', [[sourceCode, targetCode]]);
      else report.skip('skills', sourceCode, source, 'migration.unsupported_file');
      continue;
    }
    if (['node_modules', '.git', 'cache', 'debug', 'logs', 'telemetry', 'session-env'].includes(entry.name)) { report.skip('skills', sourceCode, source, 'migration.runtime_excluded'); continue; }
    const child = makeReport({ sanitizer: report.sanitizer, budget: report.budget });
    const files = await walk(sourceCode, source, child, 'skills', path => textExtensions.has(extname(path).toLowerCase()), 8, true);
    const temporary = join(stageCode, '.skill-import-' + randomUUID());
    let complete = files.includes(join(source, 'SKILL.md'));
    complete &&= child.document.skipped_files === 0;
    complete &&= report.budget.entries <= maxEntries;
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const file of files) if (!await copyText(sourceCode, file, join(temporary, relative(source, file)), child, 'skills', [[sourceCode, targetCode]])) complete = false;
      if (complete) {
        const destination = join(stageCode, 'skills', entry.name);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await requireAbsent(destination);
        await rename(temporary, destination);
      }
    } catch (error) { complete = false; child.warn(error.code?.startsWith('migration.') ? error.code : 'migration.copy_failed'); }
    finally { await rm(temporary, { recursive: true, force: true }); }
    if (!complete) child.warn('migration.skill_incomplete');
    report.merge(child, !complete);
  }
}

function reusableCodeSettings(value, report) {
  const result = pick(value, codeKeys);
  const copyPreferences = (source, destination) => {
    if (Object.hasOwn(source, 'autoCompactWindow')) {
      if (validCompactWindow(source.autoCompactWindow)) destination.autoCompactWindow = source.autoCompactWindow;
      else report.warn('migration.invalid_context_setting');
    }
    if (Object.hasOwn(source, 'effortLevel')) {
      if (persistentEfforts.has(source.effortLevel)) destination.effortLevel = source.effortLevel;
      else report.warn('migration.invalid_effort_setting');
    }
  };
  copyPreferences(value, result);
  if (Object.hasOwn(value, 'modelSettings')) {
    if (!plain(value.modelSettings)) report.warn('migration.invalid_model_settings');
    else {
      const entries = [];
      for (const [name, settings] of Object.entries(value.modelSettings)) {
        if (!safeModelName(name) || secretKey.test(name)) { report.warn('migration.invalid_model_identifier'); continue; }
        if (!plain(settings)) { report.warn('migration.invalid_model_settings'); continue; }
        const retained = {};
        copyPreferences(settings, retained);
        if (Object.keys(settings).some(key => !['autoCompactWindow', 'effortLevel'].includes(key))) report.warn('migration.model_settings_fields_omitted');
        if (Object.keys(retained).length) entries.push([name, retained]);
      }
      result.modelSettings = Object.fromEntries(entries);
    }
  }
  return sanitizeMigrationValue(result, report.sanitizer);
}

async function reusableContext(sourceData, sourceCode, targetCode, stageData, stageCode, report, configEntry) {
  if (configEntry) {
    await writeExclusive(join(stageData, 'config.json'), jsonBytes(sanitizeMigrationValue(pick(configEntry.value, desktopKeys), report.sanitizer)));
    report.add('copied', 'desktop_preferences', sourceData, configEntry.path);
  }
  const desktop = await optionalJSON(sourceData, 'claude_desktop_config.json', report, 'desktop_preferences');
  if (desktop) {
    const value = { ...pick(desktop.value, ['globalShortcut']), preferences: pick(desktop.value.preferences, preferenceKeys) };
    const mcp = safeMcpServers(desktop.value.mcpServers, report);
    if (Object.keys(mcp).length) value.mcpServers = mcp;
    await writeExclusive(join(stageData, 'claude_desktop_config.json'), jsonBytes(sanitizeMigrationValue(value, report.sanitizer)));
    report.add('copied', 'desktop_preferences', sourceData, desktop.path);
  }
  if (!sourceCode) return;
  const settings = await optionalJSON(sourceCode, 'settings.json', report, 'code_preferences');
  if (settings) {
    await writeExclusive(join(stageCode, 'settings.json'), jsonBytes(reusableCodeSettings(settings.value, report)));
    report.add('copied', 'code_preferences', sourceCode, settings.path);
    if (settings.value.hooks || settings.value.permissions || settings.value.enabledPlugins || settings.value.extraKnownMarketplaces) report.warn('migration.executable_settings_not_activated');
  }
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try { await lstat(join(sourceCode, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; }
    await copyText(sourceCode, join(sourceCode, name), join(stageCode, name), report, 'instructions', [[sourceCode, targetCode]]);
  }
  await reusableSkills(sourceCode, targetCode, stageCode, report);
  for (const category of ['agents', 'rules', 'commands']) {
    const root = join(sourceCode, category);
    const files = await walk(sourceCode, root, report, category, path => textExtensions.has(extname(path).toLowerCase()), 8, true);
    for (const source of files) await copyText(sourceCode, source, join(stageCode, category, relative(root, source)), report, category, [[sourceCode, targetCode]]);
  }
  let projects = [];
  try { await inspect(sourceCode, join(sourceCode, 'projects')); projects = await readdir(join(sourceCode, 'projects'), { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') report.warn('migration.project_memories_unreadable'); }
  for (const project of projects.slice(0, maxEntries)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const root = join(sourceCode, 'projects', project.name, 'memory');
    const files = await walk(sourceCode, root, report, 'memory', path => ['.md', '.txt', '.json'].includes(extname(path).toLowerCase()), 8);
    for (const source of files) await copyText(sourceCode, source, join(stageCode, 'projects', project.name, 'memory', relative(root, source)), report, 'memory', [[sourceCode, targetCode]]);
  }
  const candidateRoot = basename(sourceCode) === '.claude' ? dirname(sourceCode) : sourceCode;
  const global = await optionalJSON(candidateRoot, '.claude.json', report, 'mcp_references');
  if (global) {
    const mcpServers = safeMcpServers(global.value.mcpServers, report);
    await writeExclusive(join(stageCode, '.claude.json'), jsonBytes(sanitizeMigrationValue({ ...pick(global.value, ['theme', 'showSpinnerTree']), ...(Object.keys(mcpServers).length ? { mcpServers } : {}) }, report.sanitizer)));
    report.add('copied', 'mcp_references', candidateRoot, global.path);
  }
  report.warn('migration.plugin_packages_require_reinstallation');
}

export async function migrateProfile({ sourceDataRoot, sourceCodeRoot, targetDataRoot, targetCodeRoot, reportPath }) {
  const report = makeReport();
  const budget = report.budget;
  let temporary, installedData = false, installedCode = false;
  targetDataRoot = resolve(targetDataRoot); targetCodeRoot = resolve(targetCodeRoot);
  reportPath = resolve(reportPath ?? join(dirname(targetDataRoot), 'migration-report.json'));
  try {
    const resolvedSource = await resolveMigrationSource({ sourceDataRoot, ...(sourceCodeRoot !== undefined ? { sourceCodeRoot } : {}) });
    const sourceData = resolvedSource.sourceDataRoot;
    let sourceCode = null;
    try { if (resolvedSource.sourceCodeRoot === null) report.warn('migration.code_root_unavailable'); else sourceCode = await rootDirectory(resolvedSource.sourceCodeRoot); }
    catch (error) { if (error.code === 'ENOENT') report.warn('migration.code_root_unavailable'); else throw error; }
    const roots = [sourceData, sourceCode].filter(Boolean);
    for (const destination of [targetDataRoot, targetCodeRoot, reportPath]) {
      if (roots.some(root => inside(root, destination) || inside(destination, root))) throw failure('migration.overlapping_roots');
      await requireAbsent(destination);
      if (await rootDirectory(dirname(destination)) !== dirname(destination)) throw failure('migration.unsafe_path');
    }
    if (inside(targetDataRoot, targetCodeRoot) || inside(targetCodeRoot, targetDataRoot)) throw failure('migration.overlapping_roots');
    temporary = join(dirname(targetDataRoot), '.migration-' + randomUUID());
    await mkdir(temporary, { mode: 0o700 });
    const stageData = join(temporary, 'data'), stageCode = join(temporary, 'code');
    await mkdir(stageData, { mode: 0o700 }); await mkdir(stageCode, { mode: 0o700 });
    const accountId = randomUUID();
    await writeExclusive(join(stageData, 'ant-did'), Buffer.from(accountId).toString('base64'));
    const contextFiles = [[sourceData, 'config.json'], [sourceData, 'claude_desktop_config.json'], ...(sourceCode ? [[sourceCode, 'settings.json'], [basename(sourceCode) === '.claude' ? dirname(sourceCode) : sourceCode, '.claude.json']] : [])];
    for (const [root, name] of contextFiles) {
      try { collectKnownSecrets(JSON.parse((await stableRead(root, join(root, name))).buffer.toString('utf8')), report.sanitizer); }
      catch {}
    }
    const config = await optionalJSON(sourceData, 'config.json', report, 'desktop_preferences');
    await reusableContext(sourceData, sourceCode, targetCodeRoot, stageData, stageCode, report, config);
    await nativeCode(sourceData, sourceCode, targetDataRoot, stageData, config?.value, report, budget, accountId);
    await portableSessions(sourceData, stageData, report, budget, config?.value);
    await localMemories(sourceData, stageData, report, config?.value, accountId);
    report.warn('migration.cloud_chat_requires_export');
    report.warn('migration.account_authentication_not_copied');
    report.warn('migration.project_files_remain_in_original_locations');
    await requireAbsent(targetCodeRoot); await requireAbsent(targetDataRoot);
    await rename(stageCode, targetCodeRoot); installedCode = true;
    await requireAbsent(targetDataRoot); await rename(stageData, targetDataRoot); installedData = true;
    report.document.destination = { profile: targetDataRoot, code_config: targetCodeRoot, portable_history: join(targetDataRoot, 'portable-history') };
    report.finish('completed');
    await writeExclusive(reportPath, jsonBytes(report.document));
    return { copied_files: report.document.copied_files, skipped_files: report.document.skipped_files, warnings: report.document.warnings, report_path: reportPath };
  } catch (error) {
    if (error.code === 'setup.migration_source_selection_required') throw error;
    if (installedData) await rm(targetDataRoot, { recursive: true, force: true });
    if (installedCode) await rm(targetCodeRoot, { recursive: true, force: true });
    report.document.staged_files_discarded = report.document.copied_files;
    report.document.copied_files = 0;
    for (const file of report.document.files) if (file.status === 'copied') file.status = 'discarded';
    report.warn(error.code?.startsWith('migration.') ? error.code : 'migration.failed');
    report.finish('failed');
    if (temporary) {
      try { await writeExclusive(reportPath, jsonBytes(report.document)); } catch {}
    }
    throw Object.assign(failure('setup.migration_failed'), { migration: { copied_files: 0, skipped_files: report.document.skipped_files, warnings: report.document.warnings, report_path: temporary ? reportPath : null } });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
