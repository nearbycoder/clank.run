/* @clankImportSource ../../vendor/dom.js */
import { For, Show, computed, signal } from "../../vendor/dom.js";
import { CLANK_THEME_PRESETS, clankThemeVariables, getClankTheme, type ClankTheme, type ClankThemeTokenName } from "../../vendor/ui.js";
import { SANDBOX_TOKEN_NAMES, applySandboxOverride, createThemeSandbox, resetSandboxOverride, sandboxTheme, sandboxTokenHint } from "./theme-sandbox-data.js";

export function ThemeSandbox(props: { theme: () => ClankTheme }) {
  const state = signal(createThemeSandbox(props.theme().id));
  const token = signal<ClankThemeTokenName>("accent");
  const preview = computed(() => sandboxTheme(state.value));
  const draft = signal(preview.value.tokens[token.value]);
  const error = signal("");
  const notice = signal("No overrides applied.");
  const edited = computed(() => SANDBOX_TOKEN_NAMES.filter((name) => state.value.overrides[name] !== undefined));
  function refreshDraft() { draft.value = preview.value.tokens[token.peek()]; error.value = ""; }
  function apply() {
    const result = applySandboxOverride(state.peek(), token.peek(), draft.peek());
    if (result.error !== null) { error.value = result.error; return; }
    state.value = result.state;
    refreshDraft();
    notice.value = `${token.peek()} applied to the preview.`;
  }
  function reset(all = false) {
    state.value = resetSandboxOverride(state.peek(), all ? undefined : token.peek());
    refreshDraft();
    notice.value = all ? "All overrides reset to the base preset." : `${token.peek()} reset to the base preset.`;
  }
  return (
    <div class="theme-sandbox">
      <p class="theme-tool-description">Experiment with {SANDBOX_TOKEN_NAMES.length} color, geometry, density, and motion tokens in the sample below. Typography and shadows retain their preset values. Edits stay in this preview. Changing the base clears all overrides.</p>
      <div class="theme-sandbox-fields">
        <label class="theme-tool-field" for="theme-sandbox-base"><span>Base preset</span><select id="theme-sandbox-base" value={() => state.value.baseId} onChange={(event: Event) => { const id = (event.currentTarget as HTMLSelectElement).value; if (getClankTheme(id)) { state.value = createThemeSandbox(id); refreshDraft(); notice.value = "Base changed. All overrides cleared."; } }}><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <option value={theme.id} selected={state.value.baseId === theme.id}>{theme.name}</option>}</For></select></label>
        <label class="theme-tool-field" for="theme-sandbox-token"><span>Editable token</span><select id="theme-sandbox-token" value={token} onChange={(event: Event) => { const name = (event.currentTarget as HTMLSelectElement).value as ClankThemeTokenName; if (SANDBOX_TOKEN_NAMES.includes(name)) { token.value = name; refreshDraft(); } }}><For each={SANDBOX_TOKEN_NAMES}>{(name) => <option value={name} selected={token.value === name}>{name}</option>}</For></select></label>
        <label class="theme-tool-field" for="theme-sandbox-value"><span>Token value</span><input id="theme-sandbox-value" type="text" maxlength={96} spellcheck={false} value={draft} aria-invalid={error.value ? "true" : undefined} aria-describedby="theme-sandbox-hint theme-sandbox-error" onInput={(event: InputEvent) => { draft.value = (event.currentTarget as HTMLInputElement).value; }} onKeyDown={(event: KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }} /></label>
      </div>
      <p class="theme-tool-status" id="theme-sandbox-hint">{sandboxTokenHint(token.value)}</p>
      <div class="theme-export-actions"><button type="button" class="studio-button" onClick={apply}>Apply override</button><button type="button" class="studio-button" onClick={() => reset()}>Reset token</button><button type="button" class="studio-button" onClick={() => reset(true)}>Reset all</button></div>
      <p class="theme-sandbox-error" id="theme-sandbox-error" role="alert">{error.value ? `${error.value} The preview keeps the last valid value.` : ""}</p>
      <p class="theme-tool-status" role="status" aria-live="polite">{notice} {edited.value.length} edited tokens.</p>
      <Show when={() => edited.value.length > 0}><ul class="theme-sandbox-edits" aria-label="Applied token overrides"><For each={edited}>{(name) => <li><code>{name}</code><span>{state.value.overrides[name]}</span></li>}</For></ul></Show>
      <section class="theme-sandbox-preview" aria-label="Scoped theme sandbox preview" style={clankThemeVariables(preview.value)} data-scheme={preview.value.scheme}>
        <span class="theme-sandbox-eyebrow">{getClankTheme(state.value.baseId)?.name} · live sample</span>
        <h2>Make room for your next idea.</h2><p>Primary text, quieter details, and interactive controls share the tokens you edit here.</p>
        <label for="theme-sandbox-sample-input">Project name<input id="theme-sandbox-sample-input" type="text" placeholder="A new workspace" /></label>
        <div class="theme-sandbox-sample-actions"><button type="button">Preview action</button><label><input type="checkbox" />Enable reminders</label></div>
      </section>
    </div>
  );
}
