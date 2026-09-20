/* @clankImportSource ../../vendor/dom.js */
import { For, effect, signal } from "../../vendor/dom.js";
import { PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, PREVIEW_WIDTH_PRESETS, parsePreviewWidth, previewWidthPixels, type PreviewWidth } from "./preview-width-data.js";

export function PreviewWidthControls(props: { value: () => PreviewWidth; onChange: (width: PreviewWidth) => void }) {
  const draft = signal(String(previewWidthPixels(props.value()) ?? 768));
  const error = signal("");
  effect(() => { draft.value = String(previewWidthPixels(props.value()) ?? 768); error.value = ""; });
  function apply() {
    const width = parsePreviewWidth(draft.peek());
    if (typeof width !== "number") { error.value = `Enter a whole number from ${PREVIEW_WIDTH_MIN} to ${PREVIEW_WIDTH_MAX}px. The preview keeps its previous width.`; return; }
    error.value = "";
    props.onChange(width);
  }
  return (
    <div class="preview-width-controls">
      <div class="segmented viewport-segments" role="group" aria-label="Preview width presets"><For each={Object.keys(PREVIEW_WIDTH_PRESETS)}>{(value) => <button type="button" classList={{ active: props.value() === value }} aria-pressed={props.value() === value ? "true" : "false"} onClick={() => props.onChange(value as PreviewWidth)}>{value}</button>}</For></div>
      <div class="preview-custom-width"><label for="preview-custom-width">Width (px)</label><input id="preview-custom-width" type="number" inputmode="numeric" min={PREVIEW_WIDTH_MIN} max={PREVIEW_WIDTH_MAX} step={1} value={draft} aria-invalid={error.value ? "true" : undefined} aria-describedby="preview-width-hint preview-width-error" onInput={(event: InputEvent) => { draft.value = (event.currentTarget as HTMLInputElement).value; }} onKeyDown={(event: KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }} /><button type="button" class="studio-button" onClick={apply}>Apply width</button><span id="preview-width-hint">{PREVIEW_WIDTH_MIN}–{PREVIEW_WIDTH_MAX}px; fits available space.</span></div>
      <p id="preview-width-error" class="preview-width-error" role="alert">{error}</p>
    </div>
  );
}
