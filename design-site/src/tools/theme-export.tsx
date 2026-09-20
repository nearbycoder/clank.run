/* @clankImportSource ../../vendor/dom.js */
import { computed, signal } from "../../vendor/dom.js";
import type { ClankTheme } from "../../vendor/ui.js";
import { copyThemeExport, createThemeExport, downloadThemeExport, type ThemeExportFormat } from "./theme-export-data.js";

export function ThemeExport(props: { theme: () => ClankTheme }) {
  const format = signal<ThemeExportFormat>("css");
  const file = computed(() => createThemeExport(props.theme().id, format.value));
  const busy = signal(false);
  const status = signal<{ filename: string; message: string } | null>(null);
  const message = computed(() => status.value?.filename === file.value.filename ? status.value.message : `${file.value.filename} is ready to copy or download.`);
  async function copy() {
    const selected = file.value;
    busy.value = true;
    try {
      status.value = { filename: selected.filename, message: await copyThemeExport(selected, navigator.clipboard) };
    } catch {
      status.value = { filename: selected.filename, message: "Could not copy. Select the preview text and copy it manually, or download the file." };
    } finally {
      busy.value = false;
    }
  }
  function download() {
    const selected = file.value;
    try {
      downloadThemeExport(selected);
      status.value = { filename: selected.filename, message: `Download requested for ${selected.filename}.` };
    } catch {
      status.value = { filename: selected.filename, message: "Could not download. Select the preview text and copy it manually." };
    }
  }
  return (
    <div class="theme-export">
      <p class="theme-tool-description">Export {props.theme().name} for your application. CSS includes the root defaults and the selected theme’s attribute selector. JSON contains the complete theme contract and token values.</p>
      <div class="theme-export-toolbar">
        <label class="theme-tool-field" for="theme-export-format"><span>Export format</span><select id="theme-export-format" value={format} onChange={(event: Event) => { const value = (event.currentTarget as HTMLSelectElement).value; if (value === "css" || value === "json") { format.value = value; status.value = null; } }}><option value="css">CSS stylesheet</option><option value="json">JSON theme</option></select></label>
        <div class="theme-export-actions"><button type="button" class="studio-button" disabled={busy} onClick={copy}>{busy.value ? "Copying…" : "Copy export"}</button><button type="button" class="studio-button" onClick={download}>Download file</button></div>
      </div>
      <p class="theme-tool-status" role="status" aria-live="polite">{message}</p>
      <pre class="theme-export-preview" tabindex={0} role="region" aria-label={`${props.theme().name} ${format.value.toUpperCase()} export preview`}><code>{file.value.contents}</code></pre>
    </div>
  );
}
