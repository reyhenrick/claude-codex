import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function oauthFixture(runtimeDir) {
  const sessions = new Map();
  const fixture = { sessions, latest: null, startGate: null, events: [] };
  fixture.manager = {
    async create({ email }) {
      const ref = { id: randomUUID(), email, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300000).toISOString() };
      const session = { ...ref, status: 'created', account_id: 'new-account', plan: 'pro' };
      sessions.set(ref.id, session); fixture.latest = session; return ref;
    },
    async start(id) {
      const session = sessions.get(id); await fixture.startGate?.();
      Object.assign(session, { status: 'pending', auth_url: 'https://auth.openai.com/oauth/authorize?state=synthetic' });
      return session;
    },
    async recover(id) { return { ...sessions.get(id) }; },
    async withValidatedCredential(id, { expectedEmail }, callback) {
      const session = sessions.get(id);
      if (session.status !== 'ready' || session.email !== expectedEmail) throw Object.assign(Error('rejected'), { code: 'oauth.account_mismatch' });
      const content = Buffer.from(JSON.stringify({ type: 'codex', email: session.email, account_id: session.account_id, plan_type: session.plan, access_token: 'synthetic-test-only', refresh_token: 'synthetic-test-only' }));
      try { return await callback({ name: 'broker-only.json', email: session.email, account_id: session.account_id, plan: session.plan, content }); }
      finally { content.fill(0); }
    },
    async finish(id) { fixture.events.push('finish'); sessions.get(id).status = 'consumed'; },
    async cancel(id) { fixture.events.push('cancel'); sessions.get(id).status = 'cancelled'; },
  };
  fixture.installManagement = (management, rows) => {
    management.credentials = async () => structuredClone(rows);
    management.importCredential = async (name, content) => {
      fixture.events.push('import'); const value = JSON.parse(content.toString());
      if (rows.some(row => row.name === name)) throw Error('duplicate import');
      rows.push({ name, provider: 'codex', email: value.email, auth_index: name, prefix: value.prefix, disabled: value.disabled,
        id_token: { chatgpt_account_id: value.account_id, plan_type: value.plan_type } });
      await mkdir(join(runtimeDir, 'auth'), { recursive: true });
      await writeFile(join(runtimeDir, 'auth', name), content, { mode: 0o600 });
    };
    management.patchCredential = async (name, fields) => {
      fixture.events.push('patch'); const row = rows.find(row => row.name === name); if (!row) throw Error('missing'); Object.assign(row, fields);
    };
    management.setCredentialDisabled = async (name, disabled) => {
      fixture.events.push(disabled ? 'disable' : 'enable'); const row = rows.find(row => row.name === name); if (!row) throw Error('missing'); row.disabled = disabled;
    };
    management.deleteCredential = async name => {
      fixture.events.push('delete'); const index = rows.findIndex(row => row.name === name); if (index >= 0) rows.splice(index, 1);
    };
  };
  return fixture;
}
