export interface CsvExportColumn { field: string; label: string; }
export interface CsvExportOptions { delimiter?: "," | ";" | "\t"; bom?: boolean; maxRows?: number; maxBytes?: number; }
export type CsvExportRecord = Readonly<Record<string, unknown>>;
interface ExportFormat { maximum: number; byteLimit: number; header: string; row(record: CsvExportRecord): string; }
const encoder = new TextEncoder();
function format(columns: readonly CsvExportColumn[], options: CsvExportOptions): ExportFormat {
  const delimiter = options.delimiter ?? ",", maximum = options.maxRows ?? 10000, byteLimit = options.maxBytes ?? 5 * 1024 * 1024;
  if (!Array.isArray(columns) || !columns.length || columns.length > 100 || new Set(columns.map(column => column?.field)).size !== columns.length) throw new TypeError("Select 1–100 unique export columns.");
  if (![",", ";", "\t"].includes(delimiter) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000000 || !Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 100 * 1024 * 1024) throw new TypeError("Invalid CSV export limits.");
  const cell = (value: unknown): string => {
    if (value === undefined || value === null) return '""';
    if (value instanceof Date) { if (!Number.isFinite(value.getTime())) throw new TypeError("Cannot export an invalid date."); value = value.toISOString(); }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new TypeError("CSV cells must be text, numbers, booleans, dates, or empty.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("CSV numbers must be finite.");
    let text = String(value);
    if (text.length > 65536) throw new RangeError("CSV cell exceeds 65,536 characters.");
    // Quote escaping alone does not prevent spreadsheet formula execution.
    if (typeof value === "string" && (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  for (const column of columns) if (!column || typeof column.field !== "string" || !column.field || column.field.length > 100 || typeof column.label !== "string" || !column.label || column.label.length > 200) throw new TypeError("Export columns need bounded fields and labels.");
  return {
    maximum, byteLimit, header: (options.bom === false ? "" : "\uFEFF") + columns.map(column => cell(column.label)).join(delimiter) + "\r\n",
    row(record) { if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("Export records must be objects."); return columns.map(column => cell(Object.hasOwn(record, column.field) ? record[column.field] : null)).join(delimiter) + "\r\n"; },
  };
}

/** Build a complete bounded CSV before returning any bytes. Strings are always spreadsheet-safe. */
export function exportCsv(records: readonly CsvExportRecord[], columns: readonly CsvExportColumn[], options: CsvExportOptions = {}): string {
  const writer = format(columns, options);
  if (!Array.isArray(records) || records.length > writer.maximum) throw new RangeError("CSV row limit exceeded.");
  const chunks = [writer.header]; let bytes = encoder.encode(writer.header).length;
  if (bytes > writer.byteLimit) throw new RangeError("CSV byte limit exceeded.");
  for (const record of records) { const row = writer.row(record); bytes += encoder.encode(row).length; if (bytes > writer.byteLimit) throw new RangeError("CSV byte limit exceeded."); chunks.push(row); }
  return chunks.join("");
}

/** Backpressured UTF-8 stream. Cancellation closes the source iterator; late failures error the stream. */
export function streamCsvExport(records: AsyncIterable<CsvExportRecord>, columns: readonly CsvExportColumn[], options: CsvExportOptions = {}): ReadableStream<Uint8Array> {
  const writer = format(columns, options), iterator = records[Symbol.asyncIterator]();
  let header = false, count = 0, bytes = 0, closed = false, returned = false;
  const finish = async () => { closed = true; if (!returned) { returned = true; await iterator.return?.(); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        let text: string;
        if (!header) { header = true; text = writer.header; }
        else { const next = await iterator.next(); if (closed) return; if (next.done) { closed = true; controller.close(); return; } if (++count > writer.maximum) throw new RangeError("CSV row limit exceeded."); text = writer.row(next.value); }
        const chunk = encoder.encode(text); bytes += chunk.length; if (bytes > writer.byteLimit) throw new RangeError("CSV byte limit exceeded."); controller.enqueue(chunk);
      } catch (error) { try { await finish(); } finally { controller.error(error); } }
    },
    async cancel() { await finish(); },
  }, { highWaterMark: 0 });
}

function filename(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}\.csv$/.test(value)) throw new TypeError("Choose a simple CSV filename without directories."); return value; }
export function csvExportResponse(records: AsyncIterable<CsvExportRecord>, columns: readonly CsvExportColumn[], options: CsvExportOptions & { filename?: string } = {}): Response {
  const name = filename(options.filename ?? "export.csv");
  return new Response(streamCsvExport(records, columns, options), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff", "cache-control": "private, no-store" } });
}

/** Column picker and explicit local download. No upload or third-party export service is involved. */
export function mountCsvExporter(container: HTMLElement, options: { columns: readonly CsvExportColumn[]; records(): readonly CsvExportRecord[]; filename?: string; limits?: CsvExportOptions }): () => void {
  format(options.columns, options.limits ?? {}); const name = filename(options.filename ?? "export.csv");
  const document = container.ownerDocument, panel = document.createElement("fieldset"), legend = document.createElement("legend"), status = document.createElement("p"), button = document.createElement("button");
  legend.textContent = "Export CSV"; status.setAttribute("role", "status"); button.type = "button"; button.textContent = "Download CSV";
  const selected = new Set(options.columns.map(column => column.field)), urls = new Map<string, ReturnType<typeof setTimeout>>(); let closed = false;
  panel.append(legend);
  for (const column of options.columns) { const label = document.createElement("label"), input = document.createElement("input"); input.type = "checkbox"; input.checked = true; input.addEventListener("change", () => { if (input.checked) selected.add(column.field); else selected.delete(column.field); button.disabled = !selected.size; }); label.append(input, document.createTextNode(column.label)); panel.append(label); }
  button.addEventListener("click", () => {
    if (closed) return;
    try {
      const records = options.records(), csv = exportCsv(records, options.columns.filter(column => selected.has(column.field)), options.limits);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), link = document.createElement("a"); link.href = url; link.download = name; panel.append(link); link.click(); link.remove();
      urls.set(url, setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000)); status.textContent = `Downloaded ${records.length} rows.`;
    } catch { status.textContent = "Export failed. Check values and export limits, then retry."; }
  });
  panel.append(button, status); container.append(panel);
  return () => { closed = true; for (const [url, timer] of urls) { clearTimeout(timer); URL.revokeObjectURL(url); } urls.clear(); panel.remove(); };
}
