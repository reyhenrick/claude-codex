import { constants } from 'node:fs';
import { open, lstat, readFile, writeFile, mkdir, rename, link, unlink, rm, realpath } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { installService, serviceLabel } from './setup.mjs';
import { ensureRuntime, runtimeDirectory, privateJSON } from './runtime.mjs';
import { readClientKey } from './client-auth.mjs';
import { bundleIdentifier, maintenanceLabel, loadServiceIdentity, compareBuild, currentIdentity, validBuild, validReadiness, idleReadiness, serviceProtocol } from './service-contract.mjs';

const execute = promisify(execFile);
const defaultRun = (file, args) => execute(file, args, { timeout: 15000, maxBuffer: 262144 });
const resources = fileURLToPath(new URL('../', import.meta.url));
const missing = error => error.code === 'ENOENT';
const fail = (code, message = 'A preparação do serviço precisa de atenção. Os processos existentes foram preservados.') => Object.assign(new Error(message), { code });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phases = new Set(['queued', 'draining', 'stopping', 'starting', 'complete']);
const sameArguments = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const fileIdentity = info => [info.dev, info.ino, info.uid, info.mode & 0o777].join(':');

async function privateFile(path, maximum = 32768, links = [1]) {
  let info;
  try { info = await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
  if (!info.isFile() || info.uid !== process.getuid() || !links.includes(info.nlink) || (info.mode & 0o077) !== 0 || info.size > maximum) throw fail('setup.service_ownership');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fileIdentity(await handle.stat()) !== fileIdentity(info)) throw fail('setup.service_ownership');
    const bytes = await handle.readFile();
    const current = await lstat(path);
    if (bytes.length > maximum || fileIdentity(current) !== fileIdentity(info) || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw fail('setup.service_ownership');
    return { bytes, identity: fileIdentity(current) };
  } finally { await handle.close(); }
}

export function parseLaunchJob(output) {
  const lines = output.split('\n').map(line => line.trim());
  const start = lines.indexOf('arguments = {'), end = start < 0 ? -1 : lines.indexOf('}', start + 1);
  const program = lines.find(line => line.startsWith('program = '))?.slice(10);
  if (!program || start < 0 || end < 0) throw fail('setup.service_ownership');
  const pidText = lines.find(line => line.startsWith('pid = '))?.slice(6);
  const pid = pidText === undefined ? null : Number(pidText);
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 1)) throw fail('setup.service_ownership');
  return { program, arguments: lines.slice(start + 1, end), pid };
}

async function jobAt(env, target) {
  try { return parseLaunchJob((await env.run('/bin/launchctl', ['print', target])).stdout); }
  catch (error) { if (error.code === 113) return null; throw error; }
}

async function bundleTrust(env, resourceDirectory) {
  if (!isAbsolute(resourceDirectory) || resolve(resourceDirectory) !== resourceDirectory || !resourceDirectory.endsWith('.app/Contents/Resources')) throw fail('setup.service_ownership');
  const info = join(dirname(resourceDirectory), 'Info.plist');
  const identifier = (await env.run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info])).stdout.trim();
  const key = (await env.run('/usr/bin/plutil', ['-extract', 'SUPublicEDKey', 'raw', '-o', '-', info])).stdout.trim();
  if (identifier !== bundleIdentifier || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key || env.publicKey && key !== env.publicKey) throw fail('setup.service_ownership');
  return key;
}

async function modernArguments(env, args) {
  if (Array.isArray(args) && args.length === 2) throw fail('setup.service_legacy_pending', 'Esta conexão anterior precisa ser migrada depois que os trabalhos em andamento terminarem.');
  if (!Array.isArray(args) || args.length !== 4 || args.some(value => typeof value !== 'string' || /[\r\n\0]/.test(value))) throw fail('setup.service_ownership');
  const root = dirname(dirname(args[0]));
  if (!sameArguments(args, bridgeArguments(root, env.runtimeDir))) throw fail('setup.service_ownership');
  await bundleTrust(env, root);
  return root;
}

function bridgeArguments(resourceDirectory, runtimeDir) {
  return [join(resourceDirectory, 'bin', 'BridgeService'), runtimeDir, join(resourceDirectory, 'bin', 'node'), join(resourceDirectory, 'Bridge', 'pool-service.mjs')];
}

export async function lifecycleEnvironment(options = {}) {
  const env = {
    homeDirectory: options.homeDirectory ?? homedir(),
    resourceDirectory: options.resourceDirectory ?? resources,
    runtimeDir: options.runtimeDir ?? runtimeDirectory(),
    run: options.runCommand ?? defaultRun,
    fetch: options.fetchImpl ?? fetch,
    wait: options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    prepareRuntime: options.prepareRuntime ?? ensureRuntime,
  };
  env.resourceDirectory = await realpath(env.resourceDirectory);
  env.expected = await loadServiceIdentity(env.resourceDirectory);
  env.target = `gui/${process.getuid()}/${serviceLabel}`;
  env.maintenanceTarget = `gui/${process.getuid()}/${maintenanceLabel}`;
  env.plist = join(env.homeDirectory, 'Library', 'LaunchAgents', `${serviceLabel}.plist`);
  env.maintenancePlist = join(env.homeDirectory, 'Library', 'LaunchAgents', `${maintenanceLabel}.plist`);
  env.recordPath = join(env.runtimeDir, 'service-maintenance.json');
  env.sparkleRecord = join(env.homeDirectory, 'Library', 'Application Support', 'Claude Codex Bridge', 'update-recovery', 'record.json');
  env.arguments = bridgeArguments(env.resourceDirectory, env.runtimeDir);
  env.publicKey = await bundleTrust(env, env.resourceDirectory);
  return env;
}

async function health(env, action, authenticated = true) {
  let key;
  if (authenticated) {
    try { key = await readClientKey(env.runtimeDir); }
    catch { throw fail('setup.service_legacy_pending', 'A autenticação desta conexão anterior precisa ser preparada após os trabalhos em andamento.'); }
  }
  const origin = 'http://127.0.0.1:18765';
  const path = action ? `/_bridge/update/${action}` : '/healthz';
  const response = await env.fetch(origin + path, {
    method: action ? 'POST' : 'GET',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(action ? { Origin: origin, 'X-Bridge-Action': 'accounts', 'Content-Type': 'application/json' } : {}) },
    ...(action ? { body: '{}' } : {}), signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw fail('setup.service_legacy_pending'); }
  if (!response.ok) { await response.body?.cancel(); throw fail('setup.service_unavailable'); }
  const bytes = await response.text();
  if (bytes.length > 32768) throw fail('setup.service_unavailable');
  let value;
  try { value = JSON.parse(bytes); } catch { throw fail('setup.service_unavailable'); }
  if (!action && authenticated && !validReadiness(value)) throw fail('setup.service_legacy_pending');
  if (action && !validReadiness({ backend: 'codex-pool', ...value })) throw fail('setup.service_unavailable');
  return action ? { backend: 'codex-pool', ...value } : value;
}

async function optionalHealth(env) {
  try { return await health(env); }
  catch (error) {
    if (error.code === 'setup.service_legacy_pending') throw error;
    return null;
  }
}

async function readRecord(env) {
  // Publishing metadata uses an exclusive hardlink. A crash before the temporary
  // name is removed may leave two links; neither copy is ever modified in place.
  const file = await privateFile(env.recordPath, 32768, [1, 2]);
  if (!file) return null;
  let record;
  try { record = JSON.parse(file.bytes); } catch { throw fail('setup.service_ownership'); }
  if (record?.version !== 1 || !uuid.test(record.id ?? '') || record.uid !== process.getuid() || record.runtime !== env.runtimeDir ||
      record.home !== env.homeDirectory || !isAbsolute(record.resources ?? '') || record.publicKey !== env.publicKey ||
      !validBuild(record.build) || record.protocol !== serviceProtocol || !phases.has(record.phase) ||
      record.previousArguments !== null && (!Array.isArray(record.previousArguments) || record.previousArguments.length !== 4) ||
      record.previousProcess !== null && !/^[1-9][0-9]*:[1-9][0-9]*:[0-9]+$/.test(record.previousProcess ?? '') ||
      record.error_code !== undefined && !/^setup\.[a-z_]+$/.test(record.error_code)) throw fail('setup.service_ownership');
  return record;
}

async function saveRecord(env, record) {
  const previous = await readRecord(env);
  if (!previous || previous.id !== record.id) throw fail('setup.service_ownership');
  await privateJSON(env.recordPath, record);
}

async function inspect(env) {
  const file = await privateFile(env.plist);
  let plistArguments = null;
  if (file) {
    const label = (await env.run('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', env.plist])).stdout.trim();
    if (label !== serviceLabel) throw fail('setup.service_ownership');
    plistArguments = JSON.parse((await env.run('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', env.plist])).stdout);
    await modernArguments(env, plistArguments);
  }
  const job = await jobAt(env, env.target);
  if (job) {
    if (job.program !== job.arguments[0]) throw fail('setup.service_ownership');
    await modernArguments(env, job.arguments);
    if (!plistArguments) throw fail('setup.service_ownership');
  }
  let value = null;
  if (job || plistArguments) value = await optionalHealth(env);
  else {
    // An unrelated listener must not be adopted just because its label is absent.
    try { await health(env, undefined, false); throw fail('setup.service_ownership'); }
    catch (error) { if (typeof error.code === 'string' && error.code.startsWith('setup.')) throw error; }
  }
  if (value?.service && (!validBuild(value.service.build) || value.service.protocol !== serviceProtocol || compareBuild(value.service.build, env.expected.build) > 0)) throw fail('setup.service_newer');
  return { job, plistArguments, health: value };
}

const outcome = (env, status, value, code) => ({
  ok: ['ready', 'pending'].includes(status), code: code ?? (status === 'ready' ? 'setup.service_ready' : 'setup.service_update_pending'),
  message: status === 'ready' ? 'Serviço preparado. Conecte suas contas para começar.' : 'A conexão será atualizada depois que as operações em andamento terminarem.',
  service: { status, expected_build: env.expected.build, active_build: value?.service?.build ?? null, protocol: serviceProtocol },
});

function maintenanceArguments(env, record) {
  return [join(record.resources, 'bin', 'BridgeService'), '--maintain', record.runtime, join(record.resources, 'bin', 'node'), join(record.resources, 'Bridge', 'service-maintenance.mjs'), record.id];
}

async function verifyMaintenanceJob(env, record) {
  const job = await jobAt(env, env.maintenanceTarget);
  if (job && (job.program !== maintenanceArguments(env, record)[0] || !sameArguments(job.arguments, maintenanceArguments(env, record)))) throw fail('setup.service_ownership');
  const file = await privateFile(env.maintenancePlist, 32768, [1, 2]);
  if (file) {
    const label = (await env.run('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', env.maintenancePlist])).stdout.trim();
    const args = JSON.parse((await env.run('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', env.maintenancePlist])).stdout);
    if (label !== maintenanceLabel || !sameArguments(args, maintenanceArguments(env, record))) throw fail('setup.service_ownership');
  }
  return { job, file };
}

async function ensureMaintenanceJob(env, record) {
  const { job, file } = await verifyMaintenanceJob(env, record);
  if (!file) {
    await mkdir(dirname(env.maintenancePlist), { recursive: true });
    const temporary = `${env.maintenancePlist}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${maintenanceLabel}</string><key>ProgramArguments</key><array>${maintenanceArguments(env, record).map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>AssociatedBundleIdentifiers</key><array><string>${bundleIdentifier}</string></array><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`, { flag: 'wx', mode: 0o600 });
      await env.run('/usr/bin/plutil', ['-lint', temporary]);
      try { await link(temporary, env.maintenancePlist); }
      catch (error) {
        if (error.code !== 'EEXIST' || !(await verifyMaintenanceJob(env, record)).file) throw error;
      }
    } finally { await rm(temporary, { force: true }); }
  }
  if (!job) {
    try { await env.run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, env.maintenancePlist]); }
    catch (error) { if (!(await verifyMaintenanceJob(env, record)).job) throw error; }
  }
  try { await env.run('/bin/launchctl', ['kickstart', env.maintenanceTarget]); }
  catch (error) { if (!(await verifyMaintenanceJob(env, record)).job?.pid) throw error; }
}

async function cleanupCompleted(env, record) {
  const { job, file } = await verifyMaintenanceJob(env, record);
  if (job?.pid) return false;
  if (job) await env.run('/bin/launchctl', ['bootout', env.maintenanceTarget]);
  if ((await readRecord(env))?.id !== record.id) throw fail('setup.service_ownership');
  if (file) await unlink(env.maintenancePlist);
  await unlink(env.recordPath);
  return true;
}

async function enqueue(env, state) {
  let record = await readRecord(env);
  if (record?.phase === 'complete') {
    if (!await cleanupCompleted(env, record)) return record;
    record = null;
  }
  if (!record) {
    record = { version: 1, id: randomUUID(), uid: process.getuid(), home: env.homeDirectory, runtime: env.runtimeDir, resources: env.resourceDirectory,
      build: env.expected.build, protocol: serviceProtocol, publicKey: env.publicKey, phase: 'queued', previousArguments: state.job?.arguments ?? state.plistArguments, previousProcess: null };
    const temporary = join(env.runtimeDir, `.service-maintenance-${record.id}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await link(temporary, env.recordPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      record = await readRecord(env);
    } finally { await rm(temporary, { force: true }); }
  }
  if (record.resources !== env.resourceDirectory) throw fail('setup.service_ownership');
  return record;
}

async function withUpdateGuard(env, operation) {
  const child = spawn(join(env.resourceDirectory, 'bin', 'BridgeService'), ['--update-guard', env.runtimeDir], { stdio: ['pipe', 'pipe', 'ignore'] });
  let timer, output = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const unavailable = () => reject(fail('setup.service_busy'));
      timer = setTimeout(() => { child.kill('SIGTERM'); unavailable(); }, 5000);
      child.once('error', () => reject(fail('setup.runtime_helper_unavailable')));
      child.once('close', unavailable);
      child.stdout.on('data', bytes => {
        output += bytes;
        if (output === 'ready\n') { clearTimeout(timer); resolve(); }
        else if (output.length > 32 || output.includes('\n')) reject(fail('setup.service_ownership'));
      });
    });
    return await operation();
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await closed;
  }
}

export async function prepareService(options = {}) {
  const env = await lifecycleEnvironment(options);
  try {
    const state = await inspect(env);
    if (currentIdentity(state.health?.service, env.expected) && !state.health.draining && sameArguments(state.job?.arguments, env.arguments)) return outcome(env, 'ready', state.health);
    if (await privateFile(env.sparkleRecord)) return outcome(env, 'pending', state.health);
    if (!state.job && !state.plistArguments) {
      await installService({ homeDirectory: env.homeDirectory, resourceDirectory: env.resourceDirectory, runtimeDir: env.runtimeDir, runCommand: env.run, prepareRuntime: env.prepareRuntime });
      // Initialization is asynchronous; the native client confirms authenticated
      // build/protocol/instance health before treating the connection as ready.
      const current = await optionalHealth(env);
      return outcome(env, currentIdentity(current?.service, env.expected) && !current.draining ? 'ready' : 'pending', current);
    }
    await readClientKey(env.runtimeDir);
    let record;
    try {
      record = await withUpdateGuard(env, async () => {
        // Both cleanup and publication belong to the same cross-process lease.
        // Re-inspect after acquiring it rather than acting on a stale snapshot.
        const latest = await inspect(env);
        if (await privateFile(env.sparkleRecord)) return null;
        if (currentIdentity(latest.health?.service, env.expected) && !latest.health.draining && sameArguments(latest.job?.arguments, env.arguments)) return null;
        return enqueue(env, latest);
      });
    } catch (error) {
      if (error.code !== 'setup.service_busy') throw error;
      const pending = await readRecord(env);
      return outcome(env, pending && pending.phase !== 'complete' ? 'pending' : 'unavailable', state.health,
        pending && pending.phase !== 'complete' ? 'setup.service_update_pending' : 'setup.service_busy');
    }
    // Start only after the short preparation lease is released, so the worker
    // can immediately acquire its maintenance/update locks without a retry race.
    if (record) await ensureMaintenanceJob(env, record);
    return outcome(env, 'pending', state.health);
  } catch (error) {
    if (error.code === 'setup.service_legacy_pending') return outcome(env, 'legacy', null, error.code);
    throw error;
  }
}

export async function serviceStatus(options = {}) {
  const env = await lifecycleEnvironment(options);
  try {
    const state = await inspect(env), record = await readRecord(env);
    if (currentIdentity(state.health?.service, env.expected) && !state.health.draining && sameArguments(state.job?.arguments, env.arguments)) return outcome(env, 'ready', state.health);
    if (record?.error_code) return outcome(env, 'unavailable', state.health, record.error_code);
    if (record && record.phase !== 'complete' || await privateFile(env.sparkleRecord) || state.job && !state.health) return outcome(env, 'pending', state.health);
    if (state.health) return outcome(env, 'unavailable', state.health, 'setup.service_update_required');
    return outcome(env, 'unavailable', state.health, 'setup.service_unavailable');
  } catch (error) {
    if (error.code === 'setup.service_legacy_pending') return outcome(env, 'legacy', null, error.code);
    throw error;
  }
}

async function processIdentity(env, pid) {
  if (!pid) return null;
  try {
    const value = (await env.run(join(env.resourceDirectory, 'bin', 'BridgeService'), ['--process-identity', String(pid)])).stdout.trim();
    if (!/^[1-9][0-9]*:[1-9][0-9]*:[0-9]+$/.test(value) || Number(value.split(':')[0]) !== pid) throw fail('setup.service_ownership');
    return value;
  } catch (error) { if (error.code === 69) return null; throw error; }
}

// A single step is replayable after a crash. Its operations are explicit so tests
// can exercise interleavings without touching launchd, accounts or the real port.
export async function advanceServiceMaintenance(record, operations) {
  if (await operations.sparklePending()) return 'yield';
  const state = await operations.inspect();
  if (operations.isCurrent(state) && !state.health.draining) { await operations.save({ ...record, phase: 'complete' }); return 'complete'; }
  if (record.previousProcess && await operations.processIsRunning(record.previousProcess) && !state.job) return 'pending';
  if (state.job && !operations.isCurrent(state)) {
    if (!state.health) {
      if (state.job.pid && await operations.processForJob(state.job)) return 'pending';
    } else {
      if (!state.health.draining) {
        record = { ...record, phase: 'draining' }; await operations.save(record);
        const drained = await operations.drain();
        if (!idleReadiness(drained)) return 'pending';
      }
      const final = await operations.inspect();
      if (!idleReadiness(final.health) || !operations.sameJob(state.job, final.job)) return 'pending';
    }
    const confirmed = await operations.inspect();
    if (!operations.sameJob(state.job, confirmed.job)) return 'pending';
    if (confirmed.job.pid && !idleReadiness(confirmed.health)) return 'pending';
    record = { ...record, phase: 'stopping', previousArguments: confirmed.job.arguments, previousProcess: await operations.processForJob(confirmed.job) };
    await operations.save(record);
    await operations.stop(confirmed.job, record.previousProcess);
    return 'pending';
  }
  if (!state.job) {
    if (record.previousProcess && await operations.processIsRunning(record.previousProcess)) return 'pending';
    if (state.health) throw fail('setup.service_ownership');
    record = { ...record, phase: 'starting' }; await operations.save(record);
    await operations.start(record.previousArguments);
    return 'pending';
  }
  if (operations.isCurrent(state)) {
    if (state.health.draining) await operations.resume();
    const confirmed = await operations.inspect();
    if (operations.isCurrent(confirmed) && !confirmed.health.draining) { await operations.save({ ...record, phase: 'complete' }); return 'complete'; }
  }
  return 'pending';
}

export async function runServiceMaintenance(id, options = {}) {
  const env = await lifecycleEnvironment(options);
  let record = await readRecord(env);
  if (!record || record.id !== id || record.resources !== env.resourceDirectory || compareBuild(env.expected.build, record.build) < 0) throw fail('setup.service_ownership');
  await verifyMaintenanceJob(env, record);
  if (record.phase === 'complete') return 'complete';
  const operations = {
    sparklePending: async () => !!await privateFile(env.sparkleRecord),
    inspect: async () => {
      const currentRecord = await readRecord(env);
      if (!currentRecord || currentRecord.id !== id) throw fail('setup.service_ownership');
      const state = await inspect(env);
      if (state.job && !sameArguments(state.job.arguments, env.arguments) && !sameArguments(state.job.arguments, record.previousArguments)) throw fail('setup.service_ownership');
      return state;
    },
    isCurrent: state => currentIdentity(state.health?.service, env.expected) && sameArguments(state.job?.arguments, env.arguments),
    sameJob: (left, right) => left && right && left.pid === right.pid && sameArguments(left.arguments, right.arguments) && left.program === right.program,
    processForJob: job => processIdentity(env, job.pid),
    processIsRunning: async identity => await processIdentity(env, Number(identity.split(':')[0])) === identity,
    save: async value => { delete value.error_code; await saveRecord(env, value); record = value; },
    drain: () => health(env, 'drain'),
    resume: () => health(env, 'resume'),
    stop: async (job, identity) => {
      const current = await jobAt(env, env.target);
      if (!operations.sameJob(job, current) || identity && await processIdentity(env, job.pid) !== identity) throw fail('setup.service_ownership');
      if (identity && !idleReadiness(await health(env))) throw fail('setup.service_busy');
      await env.run('/bin/launchctl', ['bootout', env.target]);
    },
    start: previousArguments => installService({ homeDirectory: env.homeDirectory, resourceDirectory: env.resourceDirectory, runtimeDir: env.runtimeDir, runCommand: env.run, prepareRuntime: env.prepareRuntime, previousArguments }),
  };
  try {
    for (let step = 0; step < 120; step++) {
      const result = await advanceServiceMaintenance(record, operations);
      if (result !== 'pending') return result;
      await env.wait(1000);
    }
  } catch (error) {
    try { await saveRecord(env, { ...record, error_code: typeof error.code === 'string' && /^setup\.[a-z_]+$/.test(error.code) ? error.code : 'setup.service_unavailable' }); } catch {}
    throw error;
  }
  return 'yield';
}
