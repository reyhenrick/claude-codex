import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const action of ['service', 'service-status']) {
  test(`the setup CLI dispatches ${action} without an unsettled module import cycle`, async () => {
    // Source checkouts have no signed Resources/service-version.json. Dispatch
    // must reach that validation and return structured failure before launchd or
    // the real runtime can be inspected or changed.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', code => resolve(code));
    });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 10000);
    child.stdin.end(JSON.stringify({ action }));
    const code = await completed; clearTimeout(timer);
    assert.equal(code, 1);
    assert.equal(stderr.includes('unsettled top-level await'), false);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, false);
    assert.equal(typeof response.code, 'string');
  });
}
