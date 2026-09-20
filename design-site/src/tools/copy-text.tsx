/* @clankImportSource ../../vendor/dom.js */
import { computed, onCleanup, signal } from "../../vendor/dom.js";
import { copyRenderedText } from "./copy-text-data.js";

export function CopyText(props: { text: () => string; preview: () => HTMLElement | null; label: string; description: string }) {
  const pending = signal<string | null>(null);
  const result = signal<{ text: string; message: string } | null>(null);
  const busy = computed(() => pending.value !== null && pending.value === props.text());
  const message = computed(() => result.value?.text === props.text() ? result.value.message : "");
  let attempt = 0;
  let mounted = true;
  onCleanup(() => { mounted = false; attempt++; });
  async function copy() {
    const text = props.text();
    const sequence = ++attempt;
    pending.value = text;
    const current = () => mounted && sequence === attempt && props.text() === text;
    let clipboard: Pick<Clipboard, "writeText"> | undefined;
    try { clipboard = navigator.clipboard; } catch {}
    const outcome = await copyRenderedText(text, props.preview, clipboard, current);
    if (sequence !== attempt || !mounted) return;
    pending.value = null;
    if (!current() || outcome === "stale") return;
    result.value = { text, message: outcome === "copied" ? `${props.description} copied.`
      : outcome === "selected" ? "Text selected. Press Ctrl+C or Command+C to copy."
        : "Could not copy automatically. Select the example text and copy it manually." };
  }
  return <div class="studio-copy"><button type="button" class="studio-button" disabled={busy} aria-busy={busy.value ? "true" : undefined} onClick={copy}>{busy.value ? "Copying…" : props.label}</button><p role="status" aria-live="polite">{message}</p></div>;
}
