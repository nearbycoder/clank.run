/* @clankImportSource ../../vendor/dom.js */
import { For, Show, computed, signal } from "../../vendor/dom.js";
import { CLANK_THEME_PRESETS, getClankTheme, type ClankTheme } from "../../vendor/ui.js";
import { compareThemeTokens } from "./theme-comparison-data.js";

export function ThemeComparison(props: { theme: () => ClankTheme }) {
  const leftId = signal(props.theme().id);
  const rightId = signal((CLANK_THEME_PRESETS.find((theme) => theme.id !== leftId.peek()) ?? CLANK_THEME_PRESETS[0]).id);
  const changedOnly = signal(false);
  const left = computed(() => getClankTheme(leftId.value) ?? CLANK_THEME_PRESETS[0]);
  const right = computed(() => getClankTheme(rightId.value) ?? CLANK_THEME_PRESETS[0]);
  const comparison = computed(() => compareThemeTokens(left.value, right.value, changedOnly.value));
  return (
    <div class="theme-comparison">
      <p class="theme-tool-description">Compare the exact CSS token values of any two presets. These selections do not change the Studio theme.</p>
      <div class="theme-comparison-fields">
        <label class="theme-tool-field" for="theme-comparison-left"><span>First theme</span><select id="theme-comparison-left" value={leftId} onChange={(event: Event) => { const id = (event.currentTarget as HTMLSelectElement).value; if (getClankTheme(id)) leftId.value = id; }}><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <option value={theme.id} selected={leftId.value === theme.id}>{theme.name}</option>}</For></select></label>
        <label class="theme-tool-field" for="theme-comparison-right"><span>Second theme</span><select id="theme-comparison-right" value={rightId} onChange={(event: Event) => { const id = (event.currentTarget as HTMLSelectElement).value; if (getClankTheme(id)) rightId.value = id; }}><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <option value={theme.id} selected={rightId.value === theme.id}>{theme.name}</option>}</For></select></label>
      </div>
      <label class="theme-comparison-filter" for="theme-comparison-changed"><input id="theme-comparison-changed" type="checkbox" checked={changedOnly} onChange={(event: Event) => { changedOnly.value = (event.currentTarget as HTMLInputElement).checked; }} /><span>Show changed tokens only</span></label>
      <p class="theme-tool-status" role="status" aria-live="polite">{comparison.value.changedCount} of {comparison.value.total} tokens differ between {left.value.name} and {right.value.name}. Showing {comparison.value.tokens.length}.</p>
      <Show when={() => comparison.value.changedCount === 0}><p class="theme-tool-empty">No differences. Both selections have identical token values.</p></Show>
      <Show when={() => comparison.value.tokens.length > 0}>
        <dl class="theme-comparison-list" aria-label="Theme token comparison"><For each={() => comparison.value.tokens} by="variable">{(token) => <div class="theme-comparison-row"><dt><code>{token.variable}</code><span>{token.changed ? "Changed" : "Same"}</span></dt><dd><div><span>First: {left.value.name}</span><code>{token.leftValue}</code></div><div><span>Second: {right.value.name}</span><code>{token.rightValue}</code></div></dd></div>}</For></dl>
      </Show>
    </div>
  );
}
