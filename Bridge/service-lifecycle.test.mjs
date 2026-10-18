import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, realpath, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareService, serviceStatus, runServiceMaintenance, advanceServiceMaintenance } from './service-lifecycle.mjs';
import { loadServiceIdentity, compareBuild, maintenanceLabel } from './service-contract.mjs';
import { serviceLabel } from './setup.mjs';
import { ensureTestRuntime, runtimeHelper } from './test-support/runtime-helper.mjs';

const run = promisify(execFile);
const publicKey = Buffer.alloc(32, 19).toString('base64');
const missingJob = () => Object.assign(new Error('Synthetic missing job'), { code: 113 });
const commandFailure = () => Object.assign(new Error('Synthetic command failure'), { code: 5 });
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const plist = (label, args) => `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array></dict></plist>`;
const printJob = job => ({ stdout: `job = {\nprogram = ${job.program}\narguments = {\n${job.arguments.join('\n')}\n}\n${job.pid ? `pid = ${job.pid}\n` : ''}}\n` });

async function fixture(t, { fresh = false, legacy = false, current = false, missingIdentity = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-codex-lifecycle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDirectory = join(root, 'home'), runtimeDir = join(root, 'runtime'), resourceDirectory = join(root, 'Claude Codex.app', 'Contents', 'Resources');
  await mkdir(resourceDirectory, { recursive: true });
  await mkdir(join(resourceDirectory, 'bin'));
  await copyFile(await runtimeHelper(), join(resourceDirectory, 'bin', 'BridgeService'));
  await writeFile(join(resourceDirectory, 'service-version.json'), JSON.stringify({ build: '6', protocol: 1 }));
  await writeFile(join(resourceDirectory, '..', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.henrick.codex-accounts</string><key>SUPublicEDKey</key><string>${publicKey}</string></dict></plist>`);
  const launchDirectory = join(homeDirectory, 'Library', 'LaunchAgents');
  await mkdir(launchDirectory, { recursive: true });
  const args = [join(resourceDirectory, 'bin', 'BridgeService'), runtimeDir, join(resourceDirectory, 'bin', 'node'), join(resourceDirectory, 'Bridge', 'pool-service.mjs')];
  const bridgeTarget = `gui/${process.getuid()}/${serviceLabel}`, maintenanceTarget = `gui/${process.getuid()}/${maintenanceLabel}`;
  const state = {
    jobs: new Map(), processes: new Map(), calls: [], prepares: 0, waits: 0, drainCalls: 0, resumeCalls: 0,
    active: 0, resets: 0, oauth: 0, actions: 0, draining: false, available: !fresh,
    identity: missingIdentity ? undefined : { build: current ? '6' : '5', protocol: 1, resources: resourceDirectory },
    beforeWait: null, failStart: false, failKickstart: false,
  };
  if (!fresh) {
    await ensureTestRuntime(runtimeDir);
    const registeredArgs = legacy ? [join(resourceDirectory, 'bin', 'node'), join(resourceDirectory, 'Bridge', 'old-service.mjs')] : args;
    const job = { program: registeredArgs[0], arguments: registeredArgs, pid: 7001 };
    state.jobs.set(bridgeTarget, job); state.processes.set(7001, '7001:1900000000:11');
    await writeFile(join(launchDirectory, `${serviceLabel}.plist`), plist(serviceLabel, registeredArgs), { mode: 0o600 });
  }
  const runCommand = async (executable, argv) => {
    if (executable === '/usr/bin/plutil') return run(executable, argv);
    if (executable === join(resourceDirectory, 'bin', 'BridgeService')) {
      assert.equal(argv[0], '--process-identity');
      const value = state.processes.get(Number(argv[1]));
      if (!value) throw Object.assign(new Error('Synthetic finished process'), { code: 69 });
      return { stdout: value + '\n' };
    }
    assert.equal(executable, '/bin/launchctl');
    state.calls.push([...argv]);
    assert.ok(!argv.includes('-k'), 'A running bridge must never be forcibly restarted');
    if (argv[0] === 'print') {
      const job = state.jobs.get(argv[1]); if (!job) throw missingJob(); return printJob(job);
    }
    if (argv[0] === 'bootstrap') {
      if (state.failStart && argv[2].endsWith(`${serviceLabel}.plist`)) throw commandFailure();
      const label = (await run('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', argv[2]])).stdout.trim();
      const arguments_ = JSON.parse((await run('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', argv[2]])).stdout);
      const pid = label === serviceLabel ? 7002 : 8001;
      state.jobs.set(`gui/${process.getuid()}/${label}`, { program: arguments_[0], arguments: arguments_, pid });
      if (label === serviceLabel) {
        state.processes.set(pid, `${pid}:1900000001:22`); state.available = true;
        state.identity = { build: '6', protocol: 1, resources: resourceDirectory };
      }
      return { stdout: '' };
    }
    if (argv[0] === 'bootout') {
      const job = state.jobs.get(argv[1]);
      assert.ok(job);
      if (argv[1] === bridgeTarget) {
        assert.equal(state.active + state.resets + state.oauth + state.actions, 0);
        assert.equal(state.draining, true);
      }
      state.jobs.delete(argv[1]);
      return { stdout: '' };
    }
    assert.equal(argv[0], 'kickstart');
    if (state.failKickstart) throw commandFailure();
    return { stdout: '' };
  };
  const readiness = () => ({ backend: 'codex-pool', active_requests: state.active, reset_requests: state.resets,
    pending_oauth: state.oauth, pending_actions: state.actions, draining: state.draining, ...(state.identity ? { service: state.identity } : {}) });
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).host, '127.0.0.1:18765');
    if (!state.available) throw new TypeError('Synthetic connection refused');
    if (url.endsWith('/drain')) { state.draining = true; state.drainCalls++; }
    if (url.endsWith('/resume')) { state.draining = false; state.resumeCalls++; }
    return new Response(JSON.stringify(readiness()));
  };
  const wait = async () => {
    state.waits++;
    if (state.beforeWait) await state.beforeWait();
    if (!state.jobs.has(bridgeTarget)) { state.processes.delete(7001); state.available = false; }
  };
  const options = { homeDirectory, runtimeDir, resourceDirectory, runCommand, fetchImpl, wait,
    prepareRuntime: async directory => { state.prepares++; return ensureTestRuntime(directory); } };
  const record = async () => JSON.parse(await readFile(join(runtimeDir, 'service-maintenance.json'), 'utf8'));
  return { root, state, options, args, bridgeTarget, maintenanceTarget, runtimeDir, resourceDirectory, launchDirectory, record, readiness };
}

test('service identity is captured once and numeric builds stay monotonic across the visible version reset', async t => {
  const f = await fixture(t);
  const identity = await loadServiceIdentity(f.resourceDirectory);
  await writeFile(join(f.resourceDirectory, 'service-version.json'), JSON.stringify({ build: '7', protocol: 1 }));
  assert.deepEqual(identity, { build: '6', protocol: 1, resources: f.resourceDirectory });
  assert.ok(Object.isFrozen(identity));
  assert.equal(compareBuild('6', '5'), 1); assert.equal(compareBuild('10', '9'), 1); assert.equal(compareBuild('6.0', '6'), 0);
});

test('fresh installation uses private initialization and confirms the authenticated service identity', async t => {
  const f = await fixture(t, { fresh: true });
  const result = await prepareService(f.options);
  assert.equal(result.ok, true); assert.equal(result.service.status, 'ready');
  assert.equal(result.service.active_build, '6'); assert.equal(f.state.prepares, 1);
  assert.equal(f.state.drainCalls, 0); assert.ok(!f.state.jobs.has(f.maintenanceTarget));
});

test('current service is reused with no configuration writes, drains or process replacements', async t => {
  const f = await fixture(t, { current: true });
  const before = await readFile(join(f.runtimeDir, 'accounts-state.json'));
  const result = await prepareService(f.options);
  assert.equal(result.service.status, 'ready'); assert.equal(f.state.prepares, 0);
  assert.equal(f.state.jobs.get(f.bridgeTarget).pid, 7001);
  assert.ok(f.state.calls.every(call => call[0] === 'print'));
  assert.deepEqual(await readFile(join(f.runtimeDir, 'accounts-state.json')), before);
});

test('the two-argument legacy prototype is diagnosed before changing keys, service files or processes', async t => {
  const f = await fixture(t, { legacy: true });
  const before = await Promise.all(['client.key', 'management.key', 'accounts-state.json', 'config.yaml'].map(name => readFile(join(f.runtimeDir, name))));
  const names = await readdir(f.runtimeDir);
  const result = await prepareService(f.options), status = await serviceStatus(f.options);
  assert.equal(result.ok, false); assert.equal(result.code, 'setup.service_legacy_pending'); assert.equal(result.service.status, 'legacy');
  assert.equal(status.service.status, 'legacy'); assert.equal(f.state.prepares, 0); assert.equal(f.state.drainCalls, 0);
  assert.deepEqual(await readdir(f.runtimeDir), names);
  assert.deepEqual(await Promise.all(['client.key', 'management.key', 'accounts-state.json', 'config.yaml'].map(name => readFile(join(f.runtimeDir, name)))), before);
  assert.ok(f.state.calls.every(call => call[0] === 'print'));
});

test('manual replacement is queued and waits for inference, reset, OAuth and account actions without holding the GUI', async t => {
  const f = await fixture(t, { missingIdentity: true });
  const before = await readFile(join(f.runtimeDir, 'accounts-state.json'));
  f.state.active = 2; f.state.resets = 1; f.state.oauth = 1; f.state.actions = 1;
  const queued = await prepareService(f.options);
  assert.equal(queued.service.status, 'pending'); assert.equal(f.state.drainCalls, 0);
  const record = await f.record();
  assert.equal((await stat(join(f.runtimeDir, 'service-maintenance.json'))).mode & 0o777, 0o600);
  assert.ok(f.state.jobs.has(f.maintenanceTarget));
  let observations = 0;
  f.state.beforeWait = async () => {
    if (observations < 4) {
      assert.equal(f.state.jobs.get(f.bridgeTarget).pid, 7001);
      assert.equal((await serviceStatus(f.options)).service.status, 'pending');
      if (observations === 0) f.state.active = 0;
      if (observations === 1) f.state.resets = 0;
      if (observations === 2) f.state.oauth = 0; // A pending authorization can be cancelled by the GUI while the worker waits.
      if (observations === 3) f.state.actions = 0;
      observations++;
    }
  };
  // No UI object is involved after queuing. The supervised transaction continues
  // to completion when the application is closed and later reads back ready.
  assert.equal(await runServiceMaintenance(record.id, f.options), 'complete');
  assert.equal(observations, 4); assert.equal(f.state.drainCalls, 1); assert.equal(f.state.resumeCalls, 1);
  assert.equal(f.state.jobs.get(f.bridgeTarget).pid, 7002);
  assert.equal((await f.record()).phase, 'complete');
  assert.equal((await serviceStatus(f.options)).service.status, 'ready');
  assert.deepEqual(await readFile(join(f.runtimeDir, 'accounts-state.json')), before);
});

test('a crash after drain or bootout resumes the same recorded transaction and never spends or removes accounts', async t => {
  for (const crashAt of ['draining', 'stopping', 'starting']) await t.test(crashAt, async t => {
    const f = await fixture(t); f.state.active = crashAt === 'draining' ? 1 : 0;
    await prepareService(f.options); const record = await f.record();
    let interrupted = false;
    f.state.beforeWait = async () => {
      if (!interrupted && (await f.record()).phase === crashAt) { interrupted = true; throw new Error('Synthetic worker interruption'); }
    };
    await assert.rejects(runServiceMaintenance(record.id, f.options), /Synthetic worker interruption/);
    assert.equal((await f.record()).id, record.id);
    assert.equal((await serviceStatus(f.options)).service.status, 'unavailable');
    f.state.active = 0; f.state.beforeWait = null;
    assert.equal(await runServiceMaintenance(record.id, f.options), 'complete');
    assert.equal((await f.record()).id, record.id); assert.equal((await f.record()).error_code, undefined);
    assert.equal((await serviceStatus(f.options)).service.status, 'ready');
  });
});

test('an installer recovery takes precedence and the manual worker yields without drain', async t => {
  const f = await fixture(t);
  await prepareService(f.options); const record = await f.record();
  const path = join(f.options.homeDirectory, 'Library', 'Application Support', 'Claude Codex Bridge', 'update-recovery', 'record.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '{}', { mode: 0o600 });
  assert.equal(await runServiceMaintenance(record.id, f.options), 'yield');
  assert.equal(f.state.drainCalls, 0); assert.equal(f.state.jobs.get(f.bridgeTarget).pid, 7001);
});

test('unknown jobs and newer protocols/builds are preserved without preparing or draining them', async t => {
  for (const condition of ['arguments', 'build', 'protocol']) {
    const f = await fixture(t);
    if (condition === 'arguments') f.state.jobs.get(f.bridgeTarget).arguments[1] = join(f.root, 'another-runtime');
    if (condition === 'build') f.state.identity.build = '7';
    if (condition === 'protocol') f.state.identity.protocol = 2;
    await assert.rejects(prepareService(f.options), { code: condition === 'arguments' ? 'setup.service_ownership' : 'setup.service_newer' });
    assert.equal(f.state.prepares, 0); assert.equal(f.state.drainCalls, 0);
    assert.ok(!f.state.jobs.has(f.maintenanceTarget));
  }
});

test('maintenance kickstart races are accepted only for the exact owned worker job', async t => {
  const f = await fixture(t); f.state.failKickstart = true;
  assert.equal((await prepareService(f.options)).service.status, 'pending');
  const record = await f.record();
  f.state.jobs.get(f.maintenanceTarget).arguments = ['unrelated'];
  await assert.rejects(prepareService(f.options), { code: 'setup.service_ownership' });
  assert.equal((await f.record()).id, record.id); assert.equal(f.state.drainCalls, 0);
});

test('failure starting the replacement stays diagnosable and a supervised retry recovers', async t => {
  const f = await fixture(t); await prepareService(f.options); const record = await f.record();
  f.state.failStart = true;
  await assert.rejects(runServiceMaintenance(record.id, f.options));
  assert.equal((await serviceStatus(f.options)).service.status, 'unavailable');
  assert.equal(f.state.draining, true);
  f.state.failStart = false;
  assert.equal(await runServiceMaintenance(record.id, f.options), 'complete');
  assert.equal((await serviceStatus(f.options)).service.status, 'ready');
});

test('a changed PID or new activity between the drain and stop checks cannot be stopped', async () => {
  const job = { pid: 123, program: 'owned', arguments: ['owned'] }, events = [];
  const idle = { backend: 'codex-pool', active_requests: 0, reset_requests: 0, pending_oauth: 0, pending_actions: 0, draining: true };
  let reads = 0;
  const result = await advanceServiceMaintenance({ phase: 'draining', previousProcess: null }, {
    sparklePending: async () => false, inspect: async () => ({ job: ++reads > 1 ? { ...job, pid: 124 } : job, health: idle }),
    isCurrent: () => false, sameJob: (a, b) => a?.pid === b?.pid,
    save: async () => events.push('save'), stop: async () => events.push('stop'),
  });
  assert.equal(result, 'pending'); assert.deepEqual(events, []);
});

test('concurrent preparations cannot delete a newer journal after interrupted completed-record cleanup', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    await prepareService(f.options);
    const previous = await f.record();
    await writeFile(join(f.runtimeDir, 'service-maintenance.json'), JSON.stringify({ ...previous, phase: 'complete' }), { mode: 0o600 });
    f.state.jobs.delete(f.maintenanceTarget);
    await rm(join(f.launchDirectory, `${maintenanceLabel}.plist`));
    const results = await Promise.all(Array.from({ length: 6 }, () => prepareService(f.options)));
    assert.ok(results.every(result => ['pending', 'unavailable'].includes(result.service.status)));
    const result = await prepareService(f.options);
    assert.equal(result.service.status, 'pending');
    const current = await f.record();
    assert.notEqual(current.id, previous.id);
    assert.equal(f.state.jobs.get(f.maintenanceTarget).arguments.at(-1), current.id);
    assert.equal((await serviceStatus(f.options)).service.status, 'pending');
  }
  assert.equal(f.state.drainCalls, 0);
});
