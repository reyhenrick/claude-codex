import { resolveModel } from './model-catalog.mjs';

export function adaptMessage(value, prefix) {
  const target = resolveModel(value?.model);
  if (!target) throw new Error('Este modelo não faz parte do catálogo do Claude Codex.');
  const result = { ...value, model: `${prefix}/${target}` };
  const effort = value.output_config?.effort;
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error('Nível de esforço inválido.');
  }
  // The Anthropic-to-Codex translator reads output_config.effort only in adaptive mode.
  // Keep an explicit disabled/budget choice; otherwise preserve the native effort pick.
  if (value.thinking?.type !== 'disabled' && effort !== undefined) {
    result.thinking = { ...value.thinking, type: 'adaptive' };
    delete result.thinking.budget_tokens;
  }
  return result;
}
