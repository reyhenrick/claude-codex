import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installService, serviceLabel } from './setup.mjs';
import { createPoolRouter } from './pool-router.mjs';

const execute = promisify(execFile);
const missingJob = () => Object.assign(new Error('Synthetic missing job'), { code: 113 });

async function fixture(t, { race = false, bootstrapFails = false, foreign = false, kickstartRaces = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-ultra-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeDirectory = join(directory, 'home');
  const resourceDirectory = join(directory, 'Resources & tools');
  const runtimeDir = join(directory, 'account data');
  const arguments_ = [join(resourceDirectory, 'bin', 'BridgeService'), runtimeDir, join(resourceDirectory, 'bin', 'node'), join(resourceDirectory, 'Bridge', 'pool-service.mjs')];
  const path = join(homeDirectory, 'Library', 'LaunchAgents', `${serviceLabel}.plist`);
  const state = { registered: foreign ? ['unrelated-service'] : null, prints: 0, bootstraps: 0, kickstarts: 0, validatedPlists: 0 };
  let releasePrints, releaseBootstraps;
  const printsReady = new Promise(resolve => { releasePrints = resolve; });
  const bootstrapsReady = new Promise(resolve => { releaseBootstraps = resolve; });
  const runCommand = async (executable, args) => {
    if (executable === '/usr/bin/plutil') return execute(executable, args);
    assert.equal(executable, '/bin/launchctl');
    if (args[0] === 'print') {
      if (!state.registered) {
        state.prints++;
        if (race && state.prints <= 2) {
          if (state.prints === 2) releasePrints();
          await printsReady;
        }
        throw missingJob();
      }
      return { stdout: `job = {\n program = ${state.registered[0]}\n arguments = {\n${state.registered.map(value => `  ${value}`).join('\n')}\n }\n pid = 4242\n}\n` };
    }
    if (args[0] === 'bootstrap') {
      assert.equal(args[2], path);
      state.bootstraps++;
      await execute('/usr/bin/plutil', ['-lint', path]);
      state.validatedPlists++;
      if (race) {
        if (state.bootstraps === 2) releaseBootstraps();
        await bootstrapsReady;
      }
      if (state.registered || bootstrapFails) throw Object.assign(new Error('Synthetic bootstrap race'), { code: 5 });
      const parsed = await execute('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', path]);
      if (state.registered) throw Object.assign(new Error('Synthetic bootstrap race'), { code: 5 });
      state.registered = JSON.parse(parsed.stdout);
      assert.deepEqual(state.registered, arguments_);
      return { stdout: '' };
    }
    assert.equal(args[0], 'kickstart');
    assert.equal(args.length, 2);
    state.kickstarts++;
    if (kickstartRaces) throw Object.assign(new Error('Synthetic already-running race'), { code: 5 });
    return { stdout: '' };
  };
  return { state, path, homeDirectory, options: { homeDirectory, resourceDirectory, runtimeDir, runCommand, prepareRuntime: async () => {} } };
}

test('racing preparations both reach authenticated resume without replacing a running service', async t => {
  const f = await fixture(t, { race: true });
  const ingressKey = 'a'.repeat(64);
  let updateDraining = true, resumes = 0;
  const controller = {
    pausedForUpdate: true,
    resetInFlight: new Map(),
    readState: async () => ({ pending_oauth: null, update_draining: updateDraining }),
    setUpdateDrain: async enabled => { updateDraining = enabled; resumes++; },
  };
  const server = createPoolRouter({ controller, getClientKey: async () => 'synthetic-upstream', getIngressKey: async () => ingressKey });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const prepareAndResume = async () => {
    const prepared = await installService(f.options);
    assert.equal(prepared.code, 'setup.service_ready');
    const response = await fetch(`${origin}/_bridge/update/resume`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Bridge-Action': 'accounts', Authorization: `Bearer ${ingressKey}` }, body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).draining, false);
  };
  await Promise.all([prepareAndResume(), prepareAndResume()]);
  assert.equal(f.state.bootstraps, 2);
  assert.equal(f.state.validatedPlists, 2);
  assert.equal(f.state.kickstarts, 2);
  assert.equal(resumes, 2);
  assert.equal(updateDraining, false);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(f.homeDirectory, 'Library', 'LaunchAgents')), [`${serviceLabel}.plist`]);
  const health = await fetch(`${origin}/healthz`, { headers: { Authorization: `Bearer ${ingressKey}` } });
  assert.equal((await health.json()).draining, false);
});

test('an unrelated registered job is rejected before publishing a service plist', async t => {
  const f = await fixture(t, { foreign: true });
  await assert.rejects(installService(f.options), /outro serviço/);
  assert.equal(f.state.bootstraps, 0);
  assert.equal(f.state.kickstarts, 0);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('bootstrap failure without an owned registered job remains a failure', async t => {
  const f = await fixture(t, { bootstrapFails: true });
  await assert.rejects(installService(f.options), /bootstrap race/);
  assert.equal(f.state.kickstarts, 0);
  await execute('/usr/bin/plutil', ['-lint', f.path]);
});

test('already-running kickstart race is accepted only after owned-job validation', async t => {
  const f = await fixture(t, { kickstartRaces: true });
  const result = await installService(f.options);
  assert.equal(result.code, 'setup.service_ready');
  assert.equal(f.state.kickstarts, 1);
});

test('repeated preparation validates and preserves a complete owned registration', async t => {
  const f = await fixture(t);
  await installService(f.options);
  const before = await readFile(f.path, 'utf8');
  await installService(f.options);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal(f.state.bootstraps, 1);
  assert.equal(f.state.kickstarts, 2);
});
