import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, link, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { credentialPrefix } from './credential-files.mjs';
const root = fileURLToPath(new URL('../build/credential-files-fixtures/', import.meta.url));
await mkdir(root, { recursive: true });
async function fixture() {
  const runtimeDir = await mkdtemp(root + 'case-'); await mkdir(runtimeDir + '/auth', { mode: 0o700 });
  const name = 'synthetic.json', path = runtimeDir + '/auth/' + name;
  const value = { type: 'codex', email: 'Fixture@Example.test', account_id: 'synthetic-account', prefix: 'conta-01', access_token: 'synthetic-secret-test-only' };
  const row = { name, email: 'fixture@example.test', id_token: { chatgpt_account_id: value.account_id } };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { runtimeDir, path, row, value };
}
test('routing metadata reader returns only a private prefix bound to the management identity', async () => {
  const f = await fixture(); assert.equal(await credentialPrefix(f.runtimeDir, f.row), 'conta-01');
  for (const row of [{ ...f.row, email: 'wrong@example.test' }, { ...f.row, id_token: { chatgpt_account_id: 'wrong' } },
    { ...f.row, name: '../synthetic.json' }, { ...f.row, name: '/etc/passwd' }]) assert.equal(await credentialPrefix(f.runtimeDir, row), undefined);
});
test('routing metadata rejects broad permissions, malformed files, symlinks, hardlinks and oversized input', async () => {
  for (const change of ['file-permission', 'dir-permission', 'symlink', 'hardlink', 'invalid-json', 'too-large']) {
    const f = await fixture();
    if (change === 'file-permission') await chmod(f.path, 0o644);
    if (change === 'dir-permission') await chmod(f.runtimeDir + '/auth', 0o755);
    if (change === 'symlink') { await unlink(f.path); await symlink('/etc/passwd', f.path); }
    if (change === 'hardlink') await link(f.path, f.runtimeDir + '/duplicate.json');
    if (change === 'invalid-json') await writeFile(f.path, '{');
    if (change === 'too-large') await writeFile(f.path, 'x'.repeat(1024 * 1024 + 1));
    assert.equal(await credentialPrefix(f.runtimeDir, f.row), undefined, change);
  }
});
