export type CsvValue = string | number | boolean | null;
export interface CsvColumn { source: string; target: string; type: "text" | "number" | "integer" | "boolean" | "date"; required?: boolean; }
export interface CsvImportOptions { columns: readonly CsvColumn[]; delimiter?: "," | ";" | "\t"; uniqueBy?: readonly string[]; existing?: readonly Readonly<Record<string, CsvValue>>[]; duplicates?: "error" | "skip"; maxRows?: number; }
export interface CsvIssue { row: number; column: string; code: "required" | "type" | "duplicate"; }
export interface CsvImportPlan { readonly id: string; readonly ok: boolean; readonly sourceRows: number; readonly skipped: number; readonly records: readonly Readonly<Record<string, CsvValue>>[]; readonly issues: readonly CsvIssue[]; }
export interface ParsedCsv { headers: readonly string[]; rows: readonly (readonly string[])[]; }
const encoder = new TextEncoder();
const plans = new WeakMap<object, "ready" | "running" | "done">();

/** Strict quoted CSV parser with bounded rows, columns, cells, and input bytes. */
export function parseCsv(text: string, options: { delimiter?: "," | ";" | "\t"; maxRows?: number } = {}): ParsedCsv {
  const delimiter = options.delimiter ?? ",", maximum = options.maxRows ?? 10000;
  if (![",", ";", "\t"].includes(delimiter) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50000) throw new TypeError("Invalid CSV parser options.");
  if (typeof text !== "string" || text.length > 5 * 1024 * 1024 || encoder.encode(text).length > 5 * 1024 * 1024) throw new RangeError("CSV input must be at most 5 MiB.");
  text = text.replace(/^\uFEFF/, "");
  const records: string[][] = []; let row: string[] = [], cell = "", quoted = false, closedQuote = false, started = false;
  const finishCell = () => { if (row.length >= 100) throw new RangeError("CSV has more than 100 columns."); row.push(cell); cell = ""; closedQuote = false; started = false; };
  const finishRow = () => { finishCell(); records.push(row); row = []; if (records.length > maximum + 1) throw new RangeError("CSV exceeds its row limit."); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closedQuote = true; } } else cell += char; }
    else if (char === delimiter) finishCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; finishRow(); }
    else if (char === '"' && !started && !closedQuote && !cell) { quoted = true; started = true; }
    else { if (closedQuote || char === '"') throw new SyntaxError(`Invalid quote in CSV record ${records.length + 1}.`); cell += char; started = true; }
    if (cell.length > 65536) throw new RangeError("CSV cell exceeds 65,536 characters.");
  }
  if (quoted) throw new SyntaxError("CSV has an unclosed quoted field.");
  if (started || closedQuote || cell || row.length) finishRow();
  if (!records.length) throw new TypeError("CSV needs a header row.");
  const headers = records.shift()!.map(header => header.trim());
  if (headers.some(header => !header || header.length > 200) || new Set(headers).size !== headers.length) throw new TypeError("CSV headers must be unique, nonempty, and at most 200 characters.");
  if (records.some(record => record.length !== headers.length)) throw new SyntaxError("Every CSV record must have the same number of fields as the header.");
  return { headers: Object.freeze(headers), rows: Object.freeze(records.map(record => Object.freeze(record))) };
}

/** Prepare every row before any write, preserving row/column error locations without echoing values. */
export function planCsvImport(text: string, options: CsvImportOptions): CsvImportPlan {
  const parsed = parseCsv(text, options), columns = options.columns;
  if (!Array.isArray(columns) || !columns.length || columns.length > 100 || new Set(columns.map(column => column?.target)).size !== columns.length) throw new TypeError("Choose 1–100 unique target fields.");
  for (const column of columns) if (!column || !parsed.headers.includes(column.source) || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(column.target) || ["constructor", "prototype"].includes(column.target) || !["text", "number", "integer", "boolean", "date"].includes(column.type)) throw new TypeError("Invalid import mapping.");
  const unique = options.uniqueBy ?? [];
  if (unique.length > 10 || new Set(unique).size !== unique.length || unique.some(field => !columns.some(column => column.target === field))) throw new TypeError("Unique fields must be mapped target fields.");
  if (options.duplicates !== undefined && !["error", "skip"].includes(options.duplicates)) throw new TypeError("Invalid duplicate policy.");
  const existing = options.existing ?? []; if (!Array.isArray(existing) || existing.length > 100000) throw new RangeError("Existing-key evidence exceeds its limit.");
  const key = (record: Readonly<Record<string, CsvValue>>) => JSON.stringify(unique.map(field => Object.hasOwn(record, field) ? record[field] : null));
  const seen = new Set(unique.length ? existing.map(key) : []), issues: CsvIssue[] = [], records: Readonly<Record<string, CsvValue>>[] = []; let skipped = 0;
  for (let i = 0; i < parsed.rows.length; i++) {
    const record: Record<string, CsvValue> = {}, before = issues.length;
    for (const column of columns) {
      const raw = parsed.rows[i]![parsed.headers.indexOf(column.source)]!.trim(); let value: CsvValue = raw, invalid = false;
      if (!raw) { value = null; if (column.required) issues.push({ row: i + 2, column: column.target, code: "required" }); }
      else if (column.type === "number" || column.type === "integer") { value = Number(raw); invalid = !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(value) || (column.type === "integer" && !Number.isSafeInteger(value)); }
      else if (column.type === "boolean") { invalid = !["true", "false", "1", "0"].includes(raw.toLowerCase()); value = ["true", "1"].includes(raw.toLowerCase()); }
      else if (column.type === "date") { const date = new Date(raw); invalid = !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw; }
      if (invalid) issues.push({ row: i + 2, column: column.target, code: "type" }); record[column.target] = value;
    }
    if (issues.length === before) {
      const identity = key(record);
      if (unique.length && seen.has(identity)) { if (options.duplicates === "skip") skipped++; else issues.push({ row: i + 2, column: unique.join(","), code: "duplicate" }); }
      else { if (unique.length) seen.add(identity); records.push(Object.freeze(record)); }
    }
    if (issues.length > 1000) throw new RangeError("More than 1,000 validation issues; fix the file before continuing.");
  }
  const plan = Object.freeze({ id: crypto.randomUUID(), ok: !issues.length, sourceRows: parsed.rows.length, skipped, records: Object.freeze(records), issues: Object.freeze(issues.map(issue => Object.freeze(issue))) });
  plans.set(plan, "ready"); return plan;
}

/** Invoke one host transaction with a stable idempotency key. The host must enforce server authorization. */
export async function commitCsvImport(plan: CsvImportPlan, commit: (records: CsvImportPlan["records"], context: { idempotencyKey: string; signal: AbortSignal }) => Promise<void>, signal: AbortSignal = new AbortController().signal): Promise<number> {
  signal.throwIfAborted();
  if (!plan.ok || !plan.records.length || plans.get(plan) !== "ready") throw new Error("Import needs a valid, nonempty, uncommitted plan.");
  plans.set(plan, "running");
  try { await commit(plan.records, { idempotencyKey: plan.id, signal }); plans.set(plan, "done"); return plan.records.length; }
  catch (error) { plans.set(plan, "ready"); throw error; }
}

export interface CsvImporterOptions {
  fields: readonly { name: string; type: CsvColumn["type"]; required?: boolean }[];
  uniqueBy?: readonly string[];
  commit: Parameters<typeof commitCsvImport>[1];
}
/** Paste/upload, map columns, preview typed rows/errors, and explicitly commit a validated plan. */
export function mountCsvImporter(container: HTMLElement, options: CsvImporterOptions): () => void {
  if (!options.fields.length || options.fields.length > 100 || new Set(options.fields.map(field => field.name)).size !== options.fields.length) throw new TypeError("Declare unique import fields.");
  const document = container.ownerDocument, panel = document.createElement("section"), source = document.createElement("textarea"), file = document.createElement("input"), status = document.createElement("p"), mapping = document.createElement("div"), preview = document.createElement("div");
  panel.setAttribute("aria-label", "Import CSV"); source.setAttribute("aria-label", "CSV data"); source.maxLength = 5 * 1024 * 1024; file.type = "file"; file.accept = ".csv,text/csv"; file.setAttribute("aria-label", "Choose CSV file"); status.setAttribute("role", "status");
  const mapButton = document.createElement("button"), previewButton = document.createElement("button"), commitButton = document.createElement("button");
  for (const [button, text] of [[mapButton, "Map columns"], [previewButton, "Preview import"], [commitButton, "Import rows"]] as const) { button.type = "button"; button.textContent = text; }
  const controller = new AbortController(); let plan: CsvImportPlan | null = null, closed = false, busy = false, generation = 0;
  const selects = new Map<string, HTMLSelectElement>();
  const invalidate = () => { plan = null; commitButton.disabled = true; preview.replaceChildren(); };
  source.addEventListener("input", () => { generation++; invalidate(); mapping.replaceChildren(); selects.clear(); previewButton.disabled = true; });
  file.addEventListener("change", async () => { const selected = file.files?.[0], expected = ++generation; invalidate(); if (!selected) return; if (selected.size > 5 * 1024 * 1024) { status.textContent = "File exceeds 5 MiB."; return; } try { const text = await selected.text(); if (!closed && generation === expected) { source.value = text; mapping.replaceChildren(); selects.clear(); previewButton.disabled = true; status.textContent = "File loaded. Map its columns."; } } catch { if (!closed) status.textContent = "Could not read this file."; } });
  mapButton.addEventListener("click", () => {
    if (busy) return; invalidate(); mapping.replaceChildren(); selects.clear(); previewButton.disabled = true;
    try { const parsed = parseCsv(source.value); for (const field of options.fields) { const label = document.createElement("label"), select = document.createElement("select"); label.textContent = `${field.name}${field.required ? " (required)" : ""} `; select.setAttribute("aria-label", `Source for ${field.name}`); for (const name of ["", ...parsed.headers]) { const option = document.createElement("option"); option.value = name; option.textContent = name || "Skip this field"; select.append(option); } select.value = parsed.headers.includes(field.name) ? field.name : ""; select.addEventListener("change", invalidate); selects.set(field.name, select); label.append(select); mapping.append(label); } previewButton.disabled = false; status.textContent = `${parsed.rows.length} rows available.`; }
    catch { status.textContent = "Invalid CSV. Check headers, quoting, and row widths."; }
  });
  previewButton.addEventListener("click", () => {
    if (busy) return; invalidate();
    try {
      if (options.fields.some(field => field.required && !selects.get(field.name)?.value)) throw new Error("Required field is unmapped.");
      plan = planCsvImport(source.value, { columns: options.fields.filter(field => selects.get(field.name)?.value).map(field => ({ source: selects.get(field.name)!.value, target: field.name, type: field.type, required: field.required })), uniqueBy: options.uniqueBy });
      const display = document.createElement("pre"); display.style.overflowX = "auto"; display.textContent = JSON.stringify(plan.ok ? plan.records.slice(0, 20) : plan.issues.slice(0, 20), null, 2); preview.append(display);
      status.textContent = `${plan.records.length} valid rows; ${plan.issues.length} issues. Preview shows at most 20 entries.`; commitButton.disabled = !plan.ok || !plan.records.length;
    } catch { status.textContent = "Choose every required mapping and fix invalid data."; }
  });
  commitButton.addEventListener("click", async () => {
    if (!plan || busy || closed) return; const selected = plan; busy = true; commitButton.disabled = true; panel.setAttribute("aria-busy", "true");
    for (const control of panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input,button,select,textarea")) control.disabled = true;
    try { const count = await commitCsvImport(selected, options.commit, controller.signal); if (!closed) { invalidate(); status.textContent = `Imported ${count} rows.`; } }
    catch { if (!closed) { status.textContent = "Import failed. Retry uses the same operation key."; commitButton.disabled = plan !== selected; } }
    finally { busy = false; panel.removeAttribute("aria-busy");
      for (const control of panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input,button,select,textarea")) control.disabled = false;
      commitButton.disabled = !plan || !plan.ok || !plan.records.length; previewButton.disabled = !selects.size;
    }
  });
  commitButton.disabled = true; previewButton.disabled = true; panel.append(file, source, mapButton, mapping, previewButton, preview, commitButton, status); container.append(panel);
  return () => { closed = true; generation++; controller.abort(); panel.remove(); };
}
