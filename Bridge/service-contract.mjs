import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export const serviceProtocol = 1;
export const bundleIdentifier = 'com.henrick.codex-accounts';
export const maintenanceLabel = 'com.henrick.codex-accounts.service-maintenance';
export const validBuild = value => typeof value === 'string' && value.length <= 40 && /^[0-9]+(?:\.[0-9]+)*$/.test(value);
export function compareBuild(left, right) {
  if (!validBuild(left) || !validBuild(right)) throw new Error('Invalid service build.');
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0n) > (b[index] ?? 0n)) return 1;
    if ((a[index] ?? 0n) < (b[index] ?? 0n)) return -1;
  }
  return 0;
}
export async function loadServiceIdentity(resourceDirectory) {
  const value = JSON.parse(await readFile(join(resourceDirectory, 'service-version.json'), 'utf8'));
  if (!value || !validBuild(value.build) || value.protocol !== serviceProtocol) throw new Error('A identidade desta versão do serviço é inválida.');
  return Object.freeze({ build: value.build, protocol: serviceProtocol, resources: await realpath(resourceDirectory) });
}
export function validReadiness(value) {
  return value?.backend === 'codex-pool' && typeof value.draining === 'boolean' &&
    ['active_requests', 'reset_requests', 'pending_oauth', 'pending_actions'].every(name => Number.isSafeInteger(value[name]) && value[name] >= 0);
}
export const idleReadiness = value => validReadiness(value) && value.draining &&
  ['active_requests', 'reset_requests', 'pending_oauth', 'pending_actions'].every(name => value[name] === 0);
export const currentIdentity = (value, expected) => value?.protocol === expected.protocol && value?.build === expected.build && value?.resources === expected.resources;
