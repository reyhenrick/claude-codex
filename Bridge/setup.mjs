import { cp, mkdir, readFile, writeFile, rename, rm, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureRuntime, privateJSON, runtimeDirectory } from './runtime.mjs';
import { models } from './model-catalog.mjs';
import { applyContextDefaults } from './context-policy.mjs';
import { renderModelInstructions } from './model-instructions.mjs';
import { writeModelRule } from './model-rules.mjs';
import { ensureClientKey, readClientKey } from './client-auth.mjs';
import { migrateProfile, migrationOptions, resolveMigrationSource } from './migrate-profile.mjs';
const run = promisify(execFile);
const setupError = (code, message, cause) => Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
export const serviceLabel = 'com.henrick.claude-codex-bridge';
const resources = fileURLToPath(new URL('../', import.meta.url));
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));
async function absent(path) {
  try { await lstat(path); throw setupError('setup.destination_exists', 'Este nome ou destino já existe. Escolha outro para preservar os dados.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function removeOwnedDirectory(path, identity) {
  if (!identity) return;
  let current;
  try { current = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await rm(path, { recursive: true, force: true });
}
export async function copyLauncherLocalizations(sourceRoot, destinationRoot) {
  let locales = [], root = sourceRoot;
  for (const candidate of [sourceRoot, join(sourceRoot, 'Resources')]) {
    try { locales = (await readdir(candidate, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2,4})?\.lproj$/.test(entry.name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (locales.length) { root = candidate; break; }
  }
  if (!locales.length) throw new Error('Os recursos de idioma do launcher não estão disponíveis.');
  for (const locale of locales) await cp(join(root, locale.name), join(destinationRoot, locale.name), { recursive: true, errorOnExist: true, force: false });
}
export async function publishIsolatedInstallation({ managed, temporary, launcher, metadata, managedIdentity, temporaryIdentity }) {
  managedIdentity ??= await lstat(managed);
  temporaryIdentity ??= await lstat(temporary);
  const path = join(managed, 'installation.json');
  try {
    await privateJSON(path, metadata);
    if (JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(metadata)) throw new Error('Os metadados da instalação não puderam ser verificados.');
    await absent(launcher);
    await rename(temporary, launcher);
  } catch (error) {
    await removeOwnedDirectory(temporary, temporaryIdentity);
    await removeOwnedDirectory(managed, managedIdentity);
    throw error;
  }
}
export function profileConfig(catalog = models, clientKey) {
  if (typeof clientKey !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(clientKey)) throw new Error('A autenticação local não está preparada.');
  return {
    inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayBaseUrl: 'http://127.0.0.1:18765',
    inferenceGatewayApiKey: clientKey, modelDiscoveryEnabled: false, modelCatalogEnabled: false,
    inferenceModels: catalog.map(m => ({ name: m.id, labelOverride: m.label, maxEffort: 'max', supports1m: true, prefer1m: true, ...(m.family ? { anthropicFamilyTier: m.family, isFamilyDefault: true } : {}) })),
    alwaysStartWithDefaultModel: false,
    chatTabEnabled: true, isDesktopExtensionEnabled: true, userPluginMarketplacesEnabled: true, userPluginUploadsEnabled: true,
    disableBundledSkills: false, skillCreationEnabled: true, scheduledTasksEnabled: true, keepAwakeEnabled: true,
    autoModeEnabled: true, builtinBrowserEnabled: true,
  };
}
export async function configureGatewayProfile({ root, name, activate = true, catalog = models, clientKey }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Informe um nome de perfil com até 80 caracteres.');
  const library = join(resolve(root), 'configLibrary');
  await mkdir(library, { recursive: true, mode: 0o700 });
  const metaPath = join(library, '_meta.json');
  let raw = null, meta;
  try { raw = await readFile(metaPath, 'utf8'); meta = JSON.parse(raw); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('O catálogo existente não pôde ser lido. Nenhum perfil foi alterado.'); }
  if (!meta) meta = { entries: [], appliedId: null };
  if (!Array.isArray(meta.entries)) throw new Error('O catálogo existente tem formato desconhecido.');
  if (meta.entries.some(e => e.name?.toLowerCase() === name.trim().toLowerCase())) throw new Error('Já existe um perfil com esse nome. Escolha outro.');
  const modePath = join(resolve(root), 'claude_desktop_config.json');
  let modeRaw = null, modeConfig = {};
  if (activate) {
    try { modeRaw = await readFile(modePath, 'utf8'); modeConfig = JSON.parse(modeRaw); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('O modo existente do Claude não pôde ser lido. Nenhum perfil foi alterado.'); }
    if (!modeConfig || typeof modeConfig !== 'object' || Array.isArray(modeConfig)) throw new Error('A configuração existente do Claude tem formato desconhecido.');
  }
  const nextMode = { ...modeConfig, deploymentMode: '3p' };
  let modeWritten = false;
  const id = randomUUID();
  await privateJSON(join(library, `${id}.json`), profileConfig(catalog, clientKey ?? await readClientKey(runtimeDirectory())));
  try {
    let current = null;
    try { current = await readFile(metaPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== raw) throw new Error('O catálogo mudou durante a criação. Tente novamente.');
    if (activate) {
      let currentMode = null;
      try { currentMode = await readFile(modePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (currentMode !== modeRaw) throw new Error('O modo do Claude mudou durante a criação. Tente novamente.');
      await privateJSON(modePath, nextMode); modeWritten = true;
    }
    await privateJSON(metaPath, { ...meta, entries: [...meta.entries, { id, name: name.trim() }], ...(activate ? { appliedId: id } : {}) });
  } catch (error) {
    if (modeWritten && await readFile(modePath, 'utf8') === JSON.stringify(nextMode, null, 2) + '\n') {
      if (modeRaw === null) await rm(modePath, { force: true }); else await privateJSON(modePath, modeConfig);
    }
    await rm(join(library, `${id}.json`), { force: true }); throw error;
  }
  return { path: resolve(root), profileId: id, code: activate ? 'setup.profile_created_selected' : 'setup.profile_created', message: activate ? 'Perfil criado e selecionado. Encerre e abra o Claude para aplicar.' : 'Perfil criado. Selecione-o nas configurações de provedor do Claude.' };
}
export async function availableProfileModels(fetchImpl = fetch) {
  try {
    const key = await readClientKey(runtimeDirectory());
    const response = await fetchImpl('http://127.0.0.1:18765/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); return []; }
    const body = await response.json();
    if (!Array.isArray(body.data)) return [];
    const ids = new Set(body.data.map(value => value?.id));
    return models.filter(model => ids.has(model.id));
  } catch { return []; }
}
export async function createIsolated({ name, source, base = join(homedir(), 'Library', 'Application Support', 'Codex Accounts', 'Managed Claudes'), applications = join(homedir(), 'Applications'), migrate_data, source_data_root, source_code_root }) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u.test(name) || name.includes('..')) throw setupError('setup.invalid_name', 'Use um nome de até 60 caracteres, sem barras ou caracteres especiais.');
  if (typeof source !== 'string' || !source.startsWith('/') || /[\r\n\0]/.test(source)) throw setupError('setup.source_invalid', 'Selecione o aplicativo oficial Claude.app.');
  source = resolve(source);
  const contains = (parent, child) => child === parent || child.startsWith(parent + '/');
  base = resolve(base); applications = resolve(applications);
  if (contains(source, base) || contains(source, applications) || contains(base, source) || contains(base, applications) || contains(applications, base)) throw setupError('setup.paths_conflict', 'As pastas de origem e destino precisam ser independentes.');
  const plistPath = join(source, 'Contents', 'Info.plist');
  let identifier;
  try { ({ stdout: identifier } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath])); }
  catch (error) { throw setupError('setup.source_invalid', 'Selecione o aplicativo oficial Claude.app.', error); }
  if (identifier.trim() !== 'com.anthropic.claudefordesktop') throw setupError('setup.source_invalid', 'Selecione o aplicativo oficial Claude.app.');
  const officialRequirement = '=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW" and identifier "com.anthropic.claudefordesktop"';
  try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', officialRequirement, source]); }
  catch (error) { throw setupError('setup.source_untrusted', 'A assinatura do aplicativo oficial não pôde ser confirmada.', error); }
  const migrationSource = await resolveMigrationSource(migrationOptions({ migrate_data, source_data_root, source_code_root }));
  const slug = randomUUID();
  const managed = join(base, slug), launcher = join(applications, `${name.trim()}.app`);
  await absent(launcher); await mkdir(base, { recursive: true, mode: 0o700 }); await mkdir(applications, { recursive: true });
  await mkdir(managed, { mode: 0o700 });
  const managedIdentity = await lstat(managed);
  const temporary = join(applications, `.codex-accounts-${slug}.app`);
  let temporaryIdentity, migration;
  try {
    await run('/usr/bin/ditto', ['--norsrc', '--noextattr', source, join(managed, 'Claude.app')]);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', officialRequirement, join(managed, 'Claude.app')]);
    const data = join(managed, 'User Data'); await mkdir(data, { mode: 0o700 });
    migration = migrationSource ? await migrateProfile({ ...migrationSource, targetDataRoot: `${data}-3p`, targetCodeRoot: join(data, 'claude-code'), reportPath: join(base, `${slug}.migration.json`) }) : undefined;
    await mkdir(join(data, 'claude-code'), { recursive: true, mode: 0o700 });
    let codeSettings = {};
    try { codeSettings = JSON.parse(await readFile(join(data, 'claude-code', 'settings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    delete codeSettings.ultracode;
    await privateJSON(join(data, 'claude-code', 'settings.json'), applyContextDefaults({ ...codeSettings, enableWorkflows: true }));
    await ensureClientKey(runtimeDirectory());
    const catalog = await availableProfileModels();
    const modelRule = await writeModelRule(join(data, 'claude-code'), renderModelInstructions(catalog, { persistent: true }));
    const gatewayProfile = await configureGatewayProfile({ root: `${data}-3p`, name: 'Codex', activate: true, catalog });
    await mkdir(temporary, { mode: 0o700 }); temporaryIdentity = await lstat(temporary);
    await mkdir(join(temporary, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(temporary, 'Contents', 'Resources'));
    await copyLauncherLocalizations(resources, join(temporary, 'Contents', 'Resources'));
    await cp(join(resources, 'bin', 'ClaudeLauncher'), join(temporary, 'Contents', 'MacOS', 'ClaudeLauncher'));
    await cp(join(resources, 'Accounts.icns'), join(temporary, 'Contents', 'Resources', 'Accounts.icns'));
    await privateJSON(join(temporary, 'Contents', 'Resources', 'Profile.json'), { applicationPath: join(managed, 'Claude.app'), userDataDirectory: data, profileId: gatewayProfile.profileId });
    await writeFile(join(temporary, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.henrick.codex-accounts.claude.${slug}</string><key>CFBundleName</key><string>${xml(name.trim())}</string><key>CFBundleDisplayName</key><string>${xml(name.trim())}</string><key>CFBundleExecutable</key><string>ClaudeLauncher</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>CFBundleIconFile</key><string>Accounts.icns</string><key>LSMinimumSystemVersion</key><string>26.0</string></dict></plist>`);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', temporary]);
    await run('/usr/bin/codesign', ['--verify', '--strict', temporary]);
    await publishIsolatedInstallation({ managed, temporary, launcher, managedIdentity, temporaryIdentity, metadata: { version: 1, name: name.trim(), launcher, source, userDataDirectory: data, codeConfigDirectory: join(data, 'claude-code'), modelRuleStatus: modelRule.reason, createdAt: new Date().toISOString() } });
    return { path: launcher, code: 'setup.isolated_created', ...(migration ? { migration } : {}), message: 'Instalação separada criada. Abra o aplicativo pelo Finder quando quiser começar.' };
  } catch (error) {
    await removeOwnedDirectory(temporary, temporaryIdentity);
    await removeOwnedDirectory(managed, managedIdentity);
    if (migration) {
      const report = JSON.parse(await readFile(migration.report_path, 'utf8'));
      report.status = 'installation_failed'; report.staged_files_discarded = report.copied_files; report.copied_files = 0;
      report.warnings = [...new Set([...report.warnings, 'migration.installation_failed'])];
      for (const file of report.files) if (file.status === 'copied') file.status = 'discarded';
      await privateJSON(migration.report_path, report);
      error.migration = { ...migration, copied_files: 0, warnings: report.warnings };
    }
    throw error;
  }
}
export async function installService({ homeDirectory = homedir(), resourceDirectory = resources, runtimeDir = runtimeDirectory(), runCommand = run, prepareRuntime = ensureRuntime, previousArguments = null } = {}) {
  const directory = join(homeDirectory, 'Library', 'LaunchAgents');
  const path = join(directory, `${serviceLabel}.plist`);
  const arguments_ = [join(resourceDirectory, 'bin', 'BridgeService'), runtimeDir, join(resourceDirectory, 'bin', 'node'), join(resourceDirectory, 'Bridge', 'pool-service.mjs')];
  const domain = `gui/${process.getuid()}`, target = `${domain}/${serviceLabel}`;
  if (arguments_.some(value => /[\r\n\0]/.test(value))) throw new Error('Os caminhos do serviço são inválidos.');
  const ownershipError = () => new Error('Já existe outro serviço usando esta conexão. Migre-o antes de instalar o gerenciador.');
  const validatePlist = async () => {
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw ownershipError();
    const { stdout } = await runCommand('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', path]);
    const previous = JSON.parse(stdout);
    const matches = expected => Array.isArray(expected) && previous.length === expected.length && previous.every((value, index) => value === expected[index]);
    if (!Array.isArray(previous) || !matches(arguments_) && !matches(previousArguments)) throw ownershipError();
    const label = await runCommand('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', path]);
    if (label.stdout.trim() !== serviceLabel) throw ownershipError();
  };
  const registeredJob = async () => {
    let output;
    try { ({ stdout: output } = await runCommand('/bin/launchctl', ['print', target])); }
    catch (error) { if (error.code === 113) return null; throw error; }
    const values = output.match(/(?:^|\n)\s*arguments = \{\n([\s\S]*?)\n\s*\}/)?.[1].split('\n').map(value => value.trim());
    const program = output.match(/(?:^|\n)\s*program = (.+)(?:\n|$)/)?.[1].trim();
    if (program !== arguments_[0] || !values || values.length !== arguments_.length || values.some((value, index) => value !== arguments_[index])) throw ownershipError();
    return output;
  };
  await validatePlist();
  const registered = await registeredJob();
  await prepareRuntime(runtimeDir);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${serviceLabel}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${serviceLabel}</string><key>ProgramArguments</key><array>${arguments_.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>AssociatedBundleIdentifiers</key><array><string>com.henrick.codex-accounts</string></array><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`, { mode: 0o600, flag: 'wx' });
    await runCommand('/usr/bin/plutil', ['-lint', temporary]);
    await validatePlist();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  if (!registered) {
    try { await runCommand('/bin/launchctl', ['bootstrap', domain, path]); }
    catch (error) { if (!await registeredJob()) throw error; }
  }
  if (!await registeredJob()) throw new Error('O serviço não foi registrado. Tente restaurar a conexão.');
  try { await runCommand('/bin/launchctl', ['kickstart', target]); }
  catch (error) {
    const current = await registeredJob();
    if (!current || !/(?:^|\n)\s*pid = [1-9][0-9]*(?:\n|$)/.test(current)) throw error;
  }
  return { path, code: 'setup.service_ready', message: 'Serviço preparado. Conecte suas contas para começar.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) throw new Error('Configuração muito grande.'); }
    const options = JSON.parse(input);
    let result;
    if (options.action === 'service' || options.action === 'service-status') {
      const lifecycle = await import('./service-lifecycle.mjs');
      result = await (options.action === 'service' ? lifecycle.prepareService() : lifecycle.serviceStatus());
    } else if (options.action === 'service-recovery') result = await installService();
    else if (options.action === 'isolated') result = await createIsolated(options);
    if (!result) throw new Error('Ação desconhecida.');
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) { console.log(JSON.stringify({ ok: false, code: typeof error.code === 'string' && /^setup\.[a-z_]+$/.test(error.code) ? error.code : 'setup.failed', ...(error.migration ? { migration: error.migration } : {}), message: error.code ? 'Não foi possível concluir a preparação. Confira os caminhos e as permissões do aplicativo.' : error.message })); process.exitCode = 1; }
}
