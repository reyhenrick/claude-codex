import { writeFile } from 'node:fs/promises';
import { createPoolRouter } from '../Bridge/pool-router.mjs';
import { models } from '../Bridge/model-catalog.mjs';
const key = 'S'.repeat(64);
const controller = { availableModels: async () => models.filter(model => model.baseModel === 'gpt-6-luna') };
const server = createPoolRouter({ controller, getClientKey: async () => key, getIngressKey: async () => key });
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error('Synthetic catalog endpoint failed');
  await writeFile(process.argv[2], await response.text(), { mode: 0o600 });
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
