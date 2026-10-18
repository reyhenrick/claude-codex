// These rows come from the gateway's own catalogue, never from conversation text.
export const modelRuleMarker = '<!-- Claude Codex managed model mapping v1 -->';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u0020\u007f`<>]/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f`<>]/.test(value);

function checkedModel(model) {
  if (!plain(model) || !token(model.id) || !token(model.target) || !label(model.label)) throw new TypeError('Invalid gateway model catalogue.');
  return model;
}

export function renderModelInstructions(catalogue, { current, persistent = false } = {}) {
  if (!Array.isArray(catalogue) || catalogue.length > 64) throw new TypeError('Invalid gateway model catalogue.');
  const rows = catalogue.map(checkedModel);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new TypeError('Duplicate gateway model identifier.');
  if (current) {
    checkedModel(current);
    // A validated candidate may be newer than the catalogue snapshot.
    if (!rows.some(row => row.id === current.id)) rows.push(current);
  }
  const lines = [
    ...(persistent ? [modelRuleMarker, '# Claude Codex model names', '', 'Apply this rule only to sessions using the local Claude Codex gateway. It does not rename models in other providers or profiles.', 'This file is a catalogue snapshot. The model mapping supplied by the gateway on each request is authoritative if availability changes.', ''] : ['<claude_codex_model_mapping>']),
    'The model names below are OpenAI models routed through Claude Codex. Claude/Opus/Sonnet/Haiku identifiers are compatibility aliases, not the identity of the answering provider.',
    ...(current ? [`This request is routed to ${current.label}; gateway ID: ${current.id}; upstream routing ID: ${current.target}.`] : []),
    'Use the real names (Astra, Sol, Luna, including the requested variant) in plans, delegation descriptions and status reports. Include the selected real model and variant in Workflow labels, for example "Review contracts · Astra Fast". When the Agent schema exposes name, use a short schema-valid name such as review-astra-fast; its description can say "Astra Fast contract review". A name or label describes a verified selection; it does not select the model. Use exact gateway IDs only in tool fields that accept them.',
    '',
    'Selectable variants reported by this gateway catalogue snapshot:',
    ...(rows.length ? rows.map(model => `- ${model.label}: gateway ID ${model.id}; upstream routing ID ${model.target}.`) : ['- No selectable variant has been confirmed. Do not infer availability from an old menu or this installation\'s supported model families.']),
    '',
    'Astra, Sol and Luna without a speed suffix refer to their Normal variant in the list. Fast and Ultrafast are distinct speed variants, not reasoning effort. Preserve the requested model, speed and explicit effort; do not silently substitute another variant. Availability can change, and quota/admission checks still apply to each call.',
    'Codex Ultra is an orchestration mode that uses subagents. It is not Ultrafast speed, and the internal upstream routing suffix -ultra in this catalogue means only service_tier ultrafast. Claude Code Ultracode is a separate workflow setting. Do not interpret a request for Codex Ultra reasoning or Claude Code Ultracode as a request for Ultrafast speed; preserve the distinction and do not claim those orchestration modes were enabled by selecting a speed variant.',
    'For delegation, inspect the actual tool schema. Use an exact listed ID when the field accepts full model IDs (for example a Workflow model option). If Agent.model accepts only family aliases, do not send a full ID or invent an enum value. Omitting Agent.model follows the selected agent definition and configured subagent defaults; it does not by itself guarantee the parent model. Confirm that the resolved selection preserves the requested model and variant. A family alias alone must not be presented as a guarantee of a specific Fast or Ultrafast variant. If the tool cannot express the requested selection, use a supported delegation path or explain the limitation. Asking in prose does not change the main conversation model; use its actual selector.',
    'The native background-task panel may still format a compatibility ID as a Claude name. This display does not change the gateway routing. Never claim a model was used solely because its name appeared in prose.',
    ...(persistent ? [] : ['</claude_codex_model_mapping>']),
  ];
  return lines.join('\n') + '\n';
}

export function appendModelInstructions(value, catalogue, current) {
  let system;
  if (value.system === undefined) system = [];
  else if (typeof value.system === 'string') system = value.system ? [{ type: 'text', text: value.system }] : [];
  else if (Array.isArray(value.system) && value.system.every(block => plain(block) && block.type === 'text' && typeof block.text === 'string')) system = value.system.slice();
  else throw new TypeError('Invalid system instructions.');
  // A separate block survives attribution filtering in the Anthropic translator.
  // Preserve original blocks/cache breakpoints and never mutate client history.
  return { ...value, system: [...system, { type: 'text', text: renderModelInstructions(catalogue, { current }) }] };
}
