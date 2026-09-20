/* @clankImportSource ../../vendor/dom.js */
import { For, computed, signal } from "../../vendor/dom.js";
import type { ClankTheme } from "../../vendor/ui.js";
import { TOKEN_GROUPS, inspectThemeTokens } from "./token-inspector-data.js";

export function TokenInspector(props: { theme: () => ClankTheme }) {
  const query = signal("");
  const tokens = computed(() => inspectThemeTokens(props.theme().tokens, query.value));
  const groups = computed(() => TOKEN_GROUPS.filter((group) => tokens.value.some((token) => token.group === group)));
  return (
    <div class="token-inspector">
      <p class="theme-tool-description">Inspect the exact values in {props.theme().name}. Search token names, CSS variables, values, or groups.</p>
      <label class="theme-tool-field" for="theme-token-search"><span>Search theme tokens</span><input id="theme-token-search" type="search" placeholder="Try accent, radius, or motion" maxlength="200" value={query} onInput={(event: InputEvent) => { query.value = (event.currentTarget as HTMLInputElement).value; }} /></label>
      <p class="theme-tool-status" role="status" aria-live="polite">{tokens.value.length} of {Object.keys(props.theme().tokens).length} tokens in {props.theme().name}</p>
      <div class="token-groups">
        <For each={groups} fallback={<p class="theme-tool-empty">No matching tokens. Try a different name, value, or group.</p>}>
          {(group) => <section class="token-group" aria-label={`${group} tokens`}><h2>{group}</h2><dl class="token-list"><For each={() => tokens.value.filter((token) => token.group === group)} by="name">{(token) => <div class="token-row"><dt><code>{token.variable}</code><span>{token.name}</span></dt><dd>{token.group === "Colors" ? <span class="token-swatch" aria-hidden="true" style={{ background: token.value }} /> : null}<code>{token.value}</code></dd></div>}</For></dl></section>}
        </For>
      </div>
    </div>
  );
}
