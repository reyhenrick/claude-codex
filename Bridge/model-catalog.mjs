export const baseModels = Object.freeze([
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', family: 'sonnet', ultra: true },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', family: 'haiku', ultra: false },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', family: 'opus', ultra: true },
].map(Object.freeze));

export const models = Object.freeze(baseModels.flatMap(base => [
  { id: `claude-${base.family}-5-5`, label: base.label, target: base.id, baseModel: base.id, mode: 'normal', serviceTier: 'default', family: base.family },
  { id: `anthropic.claude-${base.family}-5-5`, label: `${base.label} Fast`, target: `${base.id}-fast`, baseModel: base.id, mode: 'fast', serviceTier: 'priority' },
  ...(base.ultra ? [{ id: `us.anthropic.claude-${base.family}-5-5`, label: `${base.label} Ultra`, target: `${base.id}-ultra`, baseModel: base.id, mode: 'ultra', serviceTier: 'ultrafast' }] : []),
]).map(Object.freeze));

const routing = new Map(models.flatMap(model => [[model.id, model], [model.target, model]]));
for (const model of models.filter(model => model.mode === 'fast')) routing.set(`claude-${baseModels.find(base => base.id === model.baseModel).family}-5-5-fast`, model);
const helperAliases = [
  ['sonnet', 'gpt-6.1-sol'], ['default', 'gpt-6.1-sol'], ['haiku', 'gpt-6-luna'],
  ['opus', 'gpt-6-astra'], ['fable', 'gpt-6-astra'], ['best', 'gpt-6-astra'],
  ['claude-haiku-4-5', 'gpt-6-luna'], ['claude-haiku-4-5-20251001', 'gpt-6-luna'], ['claude-fable-5', 'gpt-6-astra'],
];
for (const [alias, target] of helperAliases) routing.set(alias, routing.get(target));

export function resolveModelVariant(model) {
  return typeof model === 'string' ? routing.get(model.replace(/\[1m\]$/i, '')) : undefined;
}

export function resolveModel(model) {
  return resolveModelVariant(model)?.target;
}

export function supportedModelIds(value) {
  if (!value || !Array.isArray(value.models)) return [];
  const supported = new Set();
  for (const base of baseModels) {
    const rows = value.models.filter(row => row?.slug === base.id);
    if (rows.length !== 1) continue;
    const row = rows[0];
    if (row.visibility !== 'list' || !Array.isArray(row.service_tiers) || row.service_tiers.some(tier => !tier || typeof tier.id !== 'string')) continue;
    for (const model of models.filter(model => model.baseModel === base.id)) {
      if (model.mode === 'normal' || row.service_tiers.some(tier => tier.id === model.serviceTier)) supported.add(model.id);
    }
  }
  return models.filter(model => supported.has(model.id)).map(model => model.id);
}
