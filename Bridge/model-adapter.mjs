import { resolveModelVariant } from './model-catalog.mjs';
import { appendModelInstructions } from './model-instructions.mjs';

export function adaptMessage(value, prefix, catalogue = []) {
  const variant = resolveModelVariant(value?.model);
  if (!variant) throw new Error('Este modelo não faz parte do catálogo do Claude Codex.');
  const result = { ...appendModelInstructions(value, catalogue, variant), model: `${prefix}/${variant.target}` };
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
