import { mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ensureRuntime } from '../runtime.mjs';

const run = promisify(execFile);
let compiling;
export function runtimeHelper() {
  return compiling ??= (async () => {
    const directory = fileURLToPath(new URL('../../build/test-helpers/', import.meta.url));
    await mkdir(directory, { recursive: true });
    const path = join(directory, `BridgeService-${process.pid}`);
    await run('xcrun', ['clang', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('../../Launcher/BridgeService.c', import.meta.url)), '-o', path]);
    return path;
  })();
}

export async function ensureTestRuntime(runtimeDir, options = {}) {
  return ensureRuntime(runtimeDir, { ...options, initializerHelper: await runtimeHelper() });
}

export async function retireTestModelMap(runtimeDir) {
  const helper = await runtimeHelper();
  const source = `import {ensureRuntime} from ${JSON.stringify(new URL('../runtime.mjs', import.meta.url).href)}; await ensureRuntime(${JSON.stringify(runtimeDir)}, {initializerHelper:${JSON.stringify(helper)},removeTemporaryInstructions:true});`;
  await run(helper, [runtimeDir, process.execPath, '--input-type=module', '-e', source]);
  return JSON.parse(await readFile(join(runtimeDir, 'config.yaml'), 'utf8'));
}
