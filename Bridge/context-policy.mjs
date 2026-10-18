// Context is a total window, not a promise that every token can be input.
// Claude Code 2.1.299 subtracts up to 20k for output and 13k for compaction,
// so this default starts compaction near 867k while keeping a 1M model window.
export const contextPolicy = Object.freeze({ context_window: 1000000, auto_compact_window: 900000 });
const families = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const compactWindow = value => Number.isInteger(value) && value >= 100000 && value <= 1000000 ? Math.min(value, contextPolicy.auto_compact_window) : contextPolicy.auto_compact_window;

export function applyContextDefaults(settings) {
  const result = { ...settings, autoCompactWindow: compactWindow(settings.autoCompactWindow), modelSettings: { ...(plain(settings.modelSettings) ? settings.modelSettings : {}) } };
  for (const model of families) {
    const shortName = model.slice('claude-'.length).split('-')[0];
    const equivalent = Object.entries(result.modelSettings).filter(([name, value]) => plain(value) &&
      (name.toLowerCase().includes(model) || name.toLowerCase().replace(/\[1m\]$/, '') === shortName));
    const canonical = plain(result.modelSettings[model]) ? result.modelSettings[model] : null;
    const previous = canonical ?? equivalent[0]?.[1] ?? {};
    const earlier = equivalent.map(([, value]) => value.autoCompactWindow)
      .filter(value => Number.isInteger(value) && value >= 100000 && value <= 1000000);
    result.modelSettings[model] = { ...previous,
      autoCompactWindow: earlier.length ? Math.min(contextPolicy.auto_compact_window, ...earlier) : result.autoCompactWindow };
  }
  return result;
}
