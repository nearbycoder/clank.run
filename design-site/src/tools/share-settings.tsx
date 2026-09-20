/* @clankImportSource ../../vendor/dom.js */
import { Show, computed, signal } from "../../vendor/dom.js";
import { copyPreviewLink } from "./share-settings-data.js";

export function SharePreviewLink(props: { href: () => string }) {
  const busy = signal(false);
  const result = signal<{ path: string; copied: boolean } | null>(null);
  const selected = computed(() => result.value?.path === props.href() ? result.value : null);
  const fullLink = () => typeof window === "undefined" ? props.href() : new URL(props.href(), window.location.origin).href;
  let fallback: HTMLInputElement | null = null;
  async function copy() {
    const path = props.href();
    busy.value = true;
    let copied = false;
    try { copied = await copyPreviewLink(fullLink(), navigator.clipboard); } catch {}
    result.value = { path, copied };
    busy.value = false;
    if (!copied && props.href() === path) { fallback?.focus(); fallback?.select(); }
  }
  return <div class="preview-share">
    <button type="button" class="studio-button" disabled={busy} onClick={copy}>{busy.value ? "Copying…" : "Copy preview link"}</button>
    <p role="status" aria-live="polite">{selected.value ? selected.value.copied ? "Preview link copied." : "Could not copy automatically. Select and copy the preview link below." : ""}</p>
    <Show when={() => selected.value !== null && !selected.value.copied}><label class="preview-share-fallback"><span>Preview link</span><input ref={(element: HTMLInputElement | null) => { fallback = element; }} type="text" readonly value={fullLink} onFocus={(event: FocusEvent) => { (event.currentTarget as HTMLInputElement).select(); }} /></label></Show>
  </div>;
}
