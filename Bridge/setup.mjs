import { cp, mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureRuntime, privateJSON } from './runtime.mjs';
import { models } from './model-catalog.mjs';
const run = promisify(execFile);
export const serviceLabel = 'com.henrick.claude-codex-bridge';
const resources = fileURLToPath(new URL('../', import.meta.url));
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));
async function absent(path) {
  try { await lstat(path); throw new Error('Este nome ou destino já existe. Escolha outro para preservar os dados.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function profileConfig() {
  return {
    inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayBaseUrl: 'http://127.0.0.1:18765',
    inferenceGatewayApiKey: 'local-codex-accounts', modelDiscoveryEnabled: false, modelCatalogEnabled: false,
    inferenceModels: models.map(m => ({ name: m.id, labelOverride: m.label, maxEffort: 'max', ...(m.family ? { anthropicFamilyTier: m.family, isFamilyDefault: true } : {}) })),
    defaultModelEffort: 'xhigh', alwaysStartWithDefaultModel: true,
    chatTabEnabled: true, isDesktopExtensionEnabled: true, userPluginMarketplacesEnabled: true, userPluginUploadsEnabled: true,
    disableBundledSkills: false, skillCreationEnabled: true, scheduledTasksEnabled: true, keepAwakeEnabled: true,
    autoModeEnabled: true, builtinBrowserEnabled: true,
  };
}
export async function createProfile({ root, name, activate = true }) {
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
  await privateJSON(join(library, `${id}.json`), profileConfig());
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
  return { path: resolve(root), profileId: id, message: activate ? 'Perfil criado e selecionado. Encerre e abra o Claude para aplicar.' : 'Perfil criado. Selecione-o nas configurações de provedor do Claude.' };
}
export async function createIsolated({ name, source, base = join(homedir(), 'Library', 'Application Support', 'Codex Accounts', 'Managed Claudes'), applications = join(homedir(), 'Applications') }) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u.test(name) || name.includes('..')) throw new Error('Use um nome de até 60 caracteres, sem barras ou caracteres especiais.');
  source = resolve(source);
  const plistPath = join(source, 'Contents', 'Info.plist');
  const { stdout: identifier } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath]);
  if (identifier.trim() !== 'com.anthropic.claudefordesktop') throw new Error('Selecione o aplicativo oficial Claude.app.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', source]);
  if (!signature.stderr.includes('TeamIdentifier=Q6L2SF6YDW')) throw new Error('A assinatura do Claude não pertence ao fornecedor esperado.');
  const slug = randomUUID();
  const managed = join(base, slug), launcher = join(applications, `${name.trim()}.app`);
  await absent(launcher); await mkdir(base, { recursive: true, mode: 0o700 }); await mkdir(applications, { recursive: true });
  await mkdir(managed, { mode: 0o700 });
  const temporary = join(applications, `.codex-accounts-${slug}.app`);
  let installed = false;
  try {
    await cp(source, join(managed, 'Claude.app'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(managed, 'Claude.app')]);
    const data = join(managed, 'User Data'); await mkdir(data, { mode: 0o700 });
    await mkdir(join(data, 'claude-code'), { mode: 0o700 });
    await privateJSON(join(data, 'claude-code', 'settings.json'), { effortLevel: 'xhigh', enableWorkflows: true, ultracode: true });
    await createProfile({ root: `${data}-3p`, name: 'Codex', activate: true });
    await mkdir(join(temporary, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(temporary, 'Contents', 'Resources'));
    await cp(join(resources, 'bin', 'ClaudeLauncher'), join(temporary, 'Contents', 'MacOS', 'ClaudeLauncher'));
    await cp(join(resources, 'Accounts.icns'), join(temporary, 'Contents', 'Resources', 'Accounts.icns'));
    await privateJSON(join(temporary, 'Contents', 'Resources', 'Profile.json'), { applicationPath: join(managed, 'Claude.app'), userDataDirectory: data });
    await writeFile(join(temporary, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.henrick.codex-accounts.claude.${slug}</string><key>CFBundleName</key><string>${xml(name.trim())}</string><key>CFBundleDisplayName</key><string>${xml(name.trim())}</string><key>CFBundleExecutable</key><string>ClaudeLauncher</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>CFBundleIconFile</key><string>Accounts.icns</string><key>LSMinimumSystemVersion</key><string>26.0</string></dict></plist>`);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', temporary]);
    await run('/usr/bin/codesign', ['--verify', '--strict', temporary]);
    await absent(launcher); await rename(temporary, launcher); installed = true;
    await privateJSON(join(managed, 'installation.json'), { name: name.trim(), launcher, source, createdAt: new Date().toISOString() });
    return { path: launcher, message: 'Instalação separada criada. Abra o aplicativo pelo Finder quando quiser começar.' };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (!installed) await rm(managed, { recursive: true, force: true });
    throw error;
  }
}
export async function installService() {
  await ensureRuntime();
  const path = join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel}.plist`);
  const program = join(resources, 'bin', 'node'), script = join(resources, 'Bridge', 'pool-service.mjs');
  try {
    const { stdout } = await run('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', path]);
    const previous = JSON.parse(stdout);
    if (previous[0] !== program || previous[1] !== script) throw new Error('Já existe outro serviço usando esta conexão. Migre-o antes de instalar o gerenciador.');
  } catch (error) {
    try { await lstat(path); } catch (missing) { if (missing.code === 'ENOENT') error = null; }
    if (error) throw error;
  }
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${serviceLabel}</string><key>ProgramArguments</key><array><string>${xml(program)}</string><string>${xml(script)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>AssociatedBundleIdentifiers</key><array><string>com.henrick.codex-accounts</string></array><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  try { await run('/bin/launchctl', ['print', `${domain}/${serviceLabel}`]); }
  catch { await run('/bin/launchctl', ['bootstrap', domain, path]); }
  await run('/bin/launchctl', ['kickstart', `${domain}/${serviceLabel}`]);
  return { path, message: 'Serviço preparado. Conecte suas contas para começar.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) throw new Error('Configuração muito grande.'); }
    const options = JSON.parse(input);
    const result = options.action === 'service' ? await installService() : options.action === 'profile' ? await createProfile(options) : options.action === 'isolated' ? await createIsolated(options) : null;
    if (!result) throw new Error('Ação desconhecida.');
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) { console.log(JSON.stringify({ ok: false, message: error.code ? 'Não foi possível concluir a preparação. Confira os caminhos e as permissões do aplicativo.' : error.message })); process.exitCode = 1; }
}
