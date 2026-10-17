import { resolveModel } from './model-catalog.mjs';

export function adaptMessage(value, prefix) {
  const target = resolveModel(value?.model);
  if (!target) throw new Error('Este perfil aceita somente GPT-6.1 Sol e GPT-6 Astra, normal ou Fast.');
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
  } else if (!value.thinking && effort === undefined) {
    result.thinking = { type: 'adaptive' };
    result.output_config = { ...value.output_config, effort: 'xhigh' };
  }
  return result;
}
