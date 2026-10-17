export const models = Object.freeze([
  { id: 'claude-sonnet-5-5', label: 'GPT-6.1 Sol', target: 'gpt-6.1-sol', family: 'sonnet' },
  { id: 'claude-sonnet-5-5-fast', label: 'GPT-6.1 Sol Fast', target: 'gpt-6.1-sol-fast' },
  { id: 'claude-opus-5-5', label: 'GPT-6 Astra', target: 'gpt-6-astra', family: 'opus' },
  { id: 'claude-opus-5-5-fast', label: 'GPT-6 Astra Fast', target: 'gpt-6-astra-fast' },
]);

const helperAliases = new Map([
  ['sonnet', 'gpt-6.1-sol'], ['haiku', 'gpt-6.1-sol'], ['default', 'gpt-6.1-sol'],
  ['opus', 'gpt-6-astra'], ['fable', 'gpt-6-astra'], ['best', 'gpt-6-astra'],
  ['claude-haiku-4-5', 'gpt-6.1-sol'], ['claude-haiku-4-5-20251001', 'gpt-6.1-sol'],
  ['claude-haiku-5-5', 'gpt-6.1-sol'], ['claude-fable-5', 'gpt-6-astra'],
]);
const routing = new Map([...models.map(m => [m.id, m.target]), ...helperAliases]);
for (const m of models) routing.set(m.target, m.target);

export function resolveModel(model) {
  return typeof model === 'string' ? routing.get(model.replace(/\[1m\]$/i, '')) : undefined;
}
