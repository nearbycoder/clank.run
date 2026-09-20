/* @clankImportSource ../../vendor/dom.js */
import { For, Show, computed, signal } from "../../vendor/dom.js";
import type { ClankTheme } from "../../vendor/ui.js";
import { calculateContrast, contrastChecks, contrastTokenOptions } from "./contrast-checker-data.js";

export function ContrastChecker(props: { theme: () => ClankTheme }) {
  const foreground = signal("text");
  const background = signal("canvas");
  const options = computed(() => contrastTokenOptions(props.theme().tokens));
  const front = computed(() => options.value.find((option) => option.name === foreground.value));
  const back = computed(() => options.value.find((option) => option.name === background.value));
  const result = computed(() => calculateContrast(front.value?.value, back.value?.value));
  return (
    <div class="contrast-checker">
      <p class="theme-tool-description">Compare two color tokens in {props.theme().name}. Results cover this opaque color pair only; they do not certify a whole interface.</p>
      <div class="contrast-fields">
        <label class="theme-tool-field" for="contrast-foreground"><span>Foreground token</span><select id="contrast-foreground" value={foreground} onChange={(event: Event) => { foreground.value = (event.currentTarget as HTMLSelectElement).value; }}><For each={options} by="name">{(token) => <option value={token.name} disabled={token.color.status !== "opaque"}>{token.name} — {token.value}{token.color.status !== "opaque" ? ` (${token.color.status})` : ""}</option>}</For></select></label>
        <label class="theme-tool-field" for="contrast-background"><span>Background token</span><select id="contrast-background" value={background} onChange={(event: Event) => { background.value = (event.currentTarget as HTMLSelectElement).value; }}><For each={options} by="name">{(token) => <option value={token.name} disabled={token.color.status !== "opaque"}>{token.name} — {token.value}{token.color.status !== "opaque" ? ` (${token.color.status})` : ""}</option>}</For></select></label>
      </div>
      <p class="theme-tool-status" role="status" aria-live="polite">{result.value.ratio === null ? result.value.reason : `${result.value.ratio.toFixed(3)}:1 contrast ratio. Pass/fail uses the unrounded result.`}</p>
      <Show when={() => result.value.ratio !== null}>
        <div class="contrast-sample" role="group" style={{ color: `var(${front.value?.variable})`, background: `var(${back.value?.variable})` }} aria-label="Selected color pair preview"><strong>Readable by design</strong><span>Preview text using the selected tokens.</span></div>
        <ul class="contrast-results"><For each={() => contrastChecks(result.value.ratio)}>{(check) => <li><span>{check.label}<small>At least {check.minimum}:1</small></span><strong>{check.passes ? "Pass" : "Fail"}</strong></li>}</For></ul>
      </Show>
      <p class="theme-tool-description contrast-guidance">Large text means at least 18pt (24px), or 14pt (about 18.67px) bold. Translucent and unsupported values are unavailable because their displayed colors cannot be inferred here. <a href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html">WCAG text contrast guidance</a>.</p>
    </div>
  );
}
