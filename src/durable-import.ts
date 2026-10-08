import { BackendActionError, defineBackend, defineDatabase, defineTable, openBackend, type DatabaseSchema, type ReadDatabase, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";
import { planCsvImport, type CsvColumn } from "./csv-import.ts";
import { featureInput, featureTables, featureTransport, requireFeatureAccess, type FeatureMutation, type FeatureQuery } from "./feature-service.ts";

export type DurableImportState = "uploading" | "ready" | "running" | "failed" | "cancelled" | "completed";
export interface DurableImportIssue { readonly row: number; readonly code: "INVALID_ROW" | "FORBIDDEN" | "DUPLICATE"; }
export interface DurableImportJob { readonly id: string; readonly name: string; readonly state: DurableImportState; readonly uploadedRows: number; readonly processedRows: number; readonly insertedRows: number; readonly skippedRows: number; readonly chunks: number; readonly issues: readonly DurableImportIssue[]; }
export interface DurableImportOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema: Schema; table: string; fields: readonly string[]; uniqueBy?: readonly string[]; duplicates?: "error" | "skip"; prefix?: string; maxRows?: number; batchSize?: number;
  maxJobs?: number; maxChunks?: number; maxStagedBytes?: number;
  authorize?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Readonly<Record<string, unknown>>, operation: "upload" | "apply"): boolean;
}
export interface DurableImportService { handle(request: Request): Promise<Response>; close(): void; }
export interface DurableImportClient {
  create(name: string, key?: string): Promise<DurableImportJob>;
  inspect(id: string): Promise<DurableImportJob>;
  append(id: string, sequence: number, records: readonly Readonly<Record<string, unknown>>[]): Promise<DurableImportJob>;
  seal(id: string, chunks: number): Promise<DurableImportJob>;
  step(id: string, expectedProcessed: number): Promise<DurableImportJob>;
  retry(id: string): Promise<DurableImportJob>;
  cancel(id: string): Promise<DurableImportJob>;
  run(id: string, options?: { signal?: AbortSignal; progress?(job: DurableImportJob): void }): Promise<DurableImportJob>;
  uploadCsv(file: Blob, columns: readonly CsvColumn[], options?: { id?: string; name?: string; signal?: AbortSignal; progress?(job: DurableImportJob): void }): Promise<DurableImportJob>;
}

/** Persist upload chunks and execution cursors beside target records; each bounded apply batch commits atomically. */
export async function openDurableImport<Schema extends DatabaseSchema<any>>(options: DurableImportOptions<Schema>): Promise<DurableImportService>;
export async function openDurableImport(options: DurableImportOptions): Promise<DurableImportService> {
  const target = options.schema.tables[options.table], maximum = options.maxRows ?? 1000000, batchSize = options.batchSize ?? 100, unique = [...options.uniqueBy ?? []];
  const maxJobs = options.maxJobs ?? 10000, maxChunks = options.maxChunks ?? 2000, maxStagedBytes = options.maxStagedBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100000 || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 10000 || !Number.isSafeInteger(maxStagedBytes) || maxStagedBytes < 1 || maxStagedBytes > 4 * 1024 * 1024 * 1024) throw new TypeError("Declare bounded import job, chunk, and staging byte limits.");
  if (!target || !options.fields.length || options.fields.some(field => !Object.hasOwn(target.fields, field)) || new Set(options.fields).size !== options.fields.length || unique.some(field => !options.fields.includes(field)) || unique.length > 10 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000000 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500 || options.duplicates && !["error", "skip"].includes(options.duplicates)) throw new TypeError("Declare a target table, mapped fields, and bounded row/batch limits.");
  if (target.ownership !== "user" && !options.authorize) throw new TypeError("Unowned import targets need explicit record authorization.");
  if (options.schema.tables.durableImportJobs || options.schema.tables.durableImportChunks) throw new TypeError("Import metadata table names are reserved.");
  const schema = defineDatabase(featureTables(options.schema, {
    durableImportJobs: defineTable({ key: s.string(), name: s.string(), state: s.enum(["uploading", "ready", "running", "failed", "cancelled", "completed"] as const), uploadedRows: s.number(), processedRows: s.number(), insertedRows: s.number(), skippedRows: s.number(), chunks: s.number(), nextChunk: s.number(), nextOffset: s.number(), issues: s.string() }).owned().index("by_key", ["key"]),
    durableImportChunks: defineTable({ jobId: s.string(), sequence: s.number(), contents: s.string({ max: 4 * 1024 * 1024 }), rows: s.number() }).owned().index("by_job", ["jobId", "sequence"]),
  }));
  const output = (row: any): DurableImportJob => ({ id: row._id, name: row.name, state: row.state, uploadedRows: row.uploadedRows, processedRows: row.processedRows, insertedRows: row.insertedRows, skippedRows: row.skippedRows, chunks: row.chunks, issues: JSON.parse(row.issues) });
  const getJob = (context: any, id: string) => { const row = context.db.table("durableImportJobs").get(id); requireFeatureAccess(Boolean(row)); return row; };
  const normalize = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(field => !options.fields.includes(field))) return featureInput("Import contains undeclared fields.");
    return target.schema.parse(value) as Record<string, unknown>;
  };
  let native: SQLiteInternal;
  const retirePayload = (context: any, id: string) => {
    const chunks = context.db.table("durableImportChunks");
    // Page IDs instead of materializing every payload. Legacy jobs may have
    // exceeded today's admission limit; every page still has bounded memory.
    while (true) {
      const rows = native.prepare("SELECT _id FROM clank_durableImportChunks WHERE _owner_id = ? AND json_extract(_data, '$.jobId') = ? LIMIT 100").all(context.auth.user!.id, id);
      if (!rows.length) break;
      for (const row of rows) { chunks.delete(row._id); native.purgeDeletedHistory("durableImportChunks", row._id as string); }
    }
  };
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    create: mutation({ args: { name: s.string({ min: 1, max: 200 }), key: s.string({ min: 1, max: 100 }) }, agent: false, handler: ({ db }, input) => {
      const table = db.table("durableImportJobs"), existing = table.query().where("key", input.key).first();
      if (existing) { if (existing.name !== input.name) throw new BackendActionError(409, "IMPORT_KEY_REUSED", "Import key belongs to another source."); return output(existing); }
      if (Number(native.prepare("SELECT count(*) AS count FROM clank_durableImportJobs").get()?.count ?? 0) >= maxJobs) throw new BackendActionError(503, "IMPORT_JOB_CAPACITY", "Import job receipt capacity reached; review retention before admitting new jobs.");
      if (table.query().where("state", "neq", "completed").where("state", "neq", "cancelled").limit(21).collect().length >= 20) throw new BackendActionError(409, "IMPORT_LIMIT", "Finish or cancel an existing import first.");
      const id = table.insert({ ...input, state: "uploading", uploadedRows: 0, processedRows: 0, insertedRows: 0, skippedRows: 0, chunks: 0, nextChunk: 0, nextOffset: 0, issues: "[]" }); return output(table.get(id));
    } }),
    inspect: query({ args: { id: s.id("durableImportJobs") }, agent: false, handler: (context, { id }) => output(getJob(context, id)) }),
    append: mutation({ args: { id: s.id("durableImportJobs"), sequence: s.number({ integer: true, min: 0 }), records: s.string({ max: 4 * 1024 * 1024 }) }, agent: false, handler: (context, input) => {
      const job = getJob(context, input.id), chunks = context.db.table("durableImportChunks");
      if (["completed", "cancelled"].includes(job.state)) throw new BackendActionError(410, "IMPORT_PAYLOAD_RETIRED", "Import source payload has been retired; inspect the retained job receipt.");
      let values: unknown; try { values = JSON.parse(input.records); } catch { return featureInput("Chunk must be JSON records."); }
      if (!Array.isArray(values) || !values.length || values.length > 500) return featureInput("A chunk must contain 1–500 rows.");
      const records = values.map(value => { const record = normalize(value); requireFeatureAccess(!options.authorize || options.authorize(context as any, record, "upload")); return record; }), contents = JSON.stringify(records);
      const existing = chunks.query().where("jobId", input.id).where("sequence", input.sequence).first();
      if (existing) { if (existing.contents !== contents) throw new BackendActionError(409, "IMPORT_CHUNK_CHANGED", "Previously uploaded rows differ from this chunk."); return output(job); }
      if (job.state !== "uploading" || job.chunks !== input.sequence || job.uploadedRows + records.length > maximum) throw new BackendActionError(409, "IMPORT_UPLOAD_STATE", "Import is sealed, out of sequence, or exceeds its row limit.");
      const capacity = native.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(json_extract(_data, '$.contents') AS BLOB))), 0) AS bytes FROM clank_durableImportChunks").get()!;
      if (job.chunks >= maxChunks || Number(capacity.count) >= 10000 || Number(capacity.bytes) + new TextEncoder().encode(contents).length > maxStagedBytes) throw new BackendActionError(503, "IMPORT_STAGING_CAPACITY", "Import staging capacity reached; finish or cancel staged jobs.");
      chunks.insert({ jobId: input.id, sequence: input.sequence, contents, rows: records.length });
      context.db.table("durableImportJobs").patch(input.id, { chunks: job.chunks + 1, uploadedRows: job.uploadedRows + records.length }); return output(context.db.table("durableImportJobs").get(input.id));
    } }),
    seal: mutation({ args: { id: s.id("durableImportJobs"), chunks: s.number({ integer: true, min: 0 }) }, agent: false, handler: (context, { id, chunks }) => { const job = getJob(context, id); if (job.chunks !== chunks || job.state === "cancelled") throw new BackendActionError(409, "IMPORT_UPLOAD_STATE", "Import chunk count or state changed."); if (job.state === "uploading") context.db.table("durableImportJobs").patch(id, { state: job.uploadedRows ? "ready" : "completed" }); return output(context.db.table("durableImportJobs").get(id)); } }),
    step: mutation({ args: { id: s.id("durableImportJobs"), expectedProcessed: s.number({ integer: true, min: 0 }) }, agent: false, handler: (context, { id, expectedProcessed }) => {
      const job = getJob(context, id);
      if (job.processedRows > expectedProcessed || ["completed", "cancelled", "failed"].includes(job.state)) return output(job);
      if (!["ready", "running"].includes(job.state) || job.processedRows !== expectedProcessed) throw new BackendActionError(409, "IMPORT_CURSOR_CHANGED", "Reload import progress before continuing.");
      const records: Array<{ row: number; value: Record<string, unknown>; skip: boolean }> = [], issues: DurableImportIssue[] = [], seen = new Set<string>();
      let nextChunk = job.nextChunk, nextOffset = job.nextOffset;
      while (records.length < batchSize && nextChunk < job.chunks) {
        const chunk = context.db.table("durableImportChunks").query().where("jobId", id).where("sequence", nextChunk).first();
        if (!chunk) throw new BackendActionError(409, "IMPORT_CHUNK_MISSING", "A persisted import chunk is unavailable.");
        const values = JSON.parse(chunk.contents);
        for (; nextOffset < values.length && records.length < batchSize; nextOffset++) {
          const row = job.processedRows + records.length + 2;
          let value: Record<string, unknown>, skip = false;
          try { value = target.schema.parse(values[nextOffset]) as Record<string, unknown>; } catch { issues.push({ row, code: "INVALID_ROW" }); value = {}; }
          if (options.authorize && options.authorize(context as any, value, "apply") !== true) issues.push({ row, code: "FORBIDDEN" });
          if (unique.length && !issues.some(issue => issue.row === row)) {
            let query = context.db.table(options.table).query();
            const identity = JSON.stringify(unique.map(field => value[field] ?? null));
            for (const field of unique) query = query.where(field, value[field] ?? null);
            if (seen.has(identity) || query.limit(1).first()) { if (options.duplicates === "skip") skip = true; else issues.push({ row, code: "DUPLICATE" }); }
            seen.add(identity);
          }
          records.push({ row, value, skip });
        }
        if (nextOffset >= values.length) { nextChunk++; nextOffset = 0; }
      }
      if (issues.length) { context.db.table("durableImportJobs").patch(id, { state: "failed", issues: JSON.stringify(issues) }); return output(context.db.table("durableImportJobs").get(id)); }
      for (const record of records) if (!record.skip) context.db.table(options.table).insert(record.value);
      const skipped = records.filter(record => record.skip).length, processedRows = job.processedRows + records.length;
      context.db.table("durableImportJobs").patch(id, { processedRows, insertedRows: job.insertedRows + records.length - skipped, skippedRows: job.skippedRows + skipped, nextChunk, nextOffset, state: processedRows === job.uploadedRows ? "completed" : "running", issues: "[]" });
      if (processedRows === job.uploadedRows) retirePayload(context, id);
      return output(context.db.table("durableImportJobs").get(id));
    } }),
    retry: mutation({ args: { id: s.id("durableImportJobs") }, agent: false, handler: (context, { id }) => { const job = getJob(context, id); if (job.state !== "failed") throw new BackendActionError(409, "IMPORT_RETRY_STATE", "Only a failed batch may be retried."); context.db.table("durableImportJobs").patch(id, { state: "ready", issues: "[]" }); return output(context.db.table("durableImportJobs").get(id)); } }),
    cancel: mutation({ args: { id: s.id("durableImportJobs") }, agent: false, handler: (context, { id }) => { const job = getJob(context, id); if (job.state !== "completed") context.db.table("durableImportJobs").patch(id, { state: "cancelled" }); retirePayload(context, id); return output(context.db.table("durableImportJobs").get(id)); } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/imports", maxCacheEntries: 0, agent: false, maxRequestBytes: 8 * 1024 * 1024 });
  native = (runtime.database as any)[SQLITE_INTERNAL];
  return { handle: request => runtime.handle(request), close: () => runtime.close() };
}

/** Stream complete CSV records, preserving quoted newlines and split CRLF/escaped quote pairs. */
async function* csvRecords(file: Blob, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = file.stream().getReader(), decoder = new TextDecoder(); let buffer = "", quoted = false, skipLF = false;
  try {
    while (true) {
      signal?.throwIfAborted(); const chunk = await reader.read(); const text = decoder.decode(chunk.value, { stream: !chunk.done });
      for (const char of text) {
        if (skipLF && char === "\n") { skipLF = false; continue; } skipLF = false;
        if (char === '"') quoted = !quoted;
        if (!quoted && (char === "\r" || char === "\n")) { yield buffer; buffer = ""; skipLF = char === "\r"; }
        else buffer += char;
        if (buffer.length > 1024 * 1024) throw new RangeError("CSV record exceeds 1 MiB.");
      }
      if (chunk.done) break;
    }
    if (quoted) throw new SyntaxError("CSV has an unclosed quote.");
    if (buffer) yield buffer;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createDurableImportClient(options: SyncClientOptions = {}): DurableImportClient {
  const { client, api } = featureTransport<{
    create: FeatureMutation<{ name: string; key: string }, DurableImportJob>;
    inspect: FeatureQuery<{ id: string }, DurableImportJob>;
    append: FeatureMutation<{ id: string; sequence: number; records: string }, DurableImportJob>;
    seal: FeatureMutation<{ id: string; chunks: number }, DurableImportJob>;
    step: FeatureMutation<{ id: string; expectedProcessed: number }, DurableImportJob>;
    retry: FeatureMutation<{ id: string }, DurableImportJob>;
    cancel: FeatureMutation<{ id: string }, DurableImportJob>;
  }>(options, "/__clank/imports");
  const service: DurableImportClient = {
    create: (name, key = crypto.randomUUID()) => client.mutate(api.create, { name, key }), inspect: id => client.query(api.inspect, { id }),
    append: (id, sequence, records) => client.mutate(api.append, { id, sequence, records: JSON.stringify(records) }), seal: (id, chunks) => client.mutate(api.seal, { id, chunks }), step: (id, expectedProcessed) => client.mutate(api.step, { id, expectedProcessed }), retry: id => client.mutate(api.retry, { id }), cancel: id => client.mutate(api.cancel, { id }),
    async run(id, settings = {}) { let job = await service.inspect(id); while (job.state === "ready" || job.state === "running") { settings.signal?.throwIfAborted(); job = await service.step(id, job.processedRows); settings.progress?.(job); } return job; },
    async uploadCsv(file, columns, settings = {}) {
      if (file.size > 100 * 1024 * 1024) throw new RangeError("Streamed CSV imports are limited to 100 MiB.");
      let job = settings.id ? await service.inspect(settings.id) : await service.create(settings.name ?? "CSV import"); settings.progress?.(job);
      let header: string | undefined, batch: string[] = [], sequence = 0, bytes = 0, rows = 0;
      const upload = async () => { if (!batch.length) return; const plan = planCsvImport(`${header}\n${batch.join("\n")}\n`, { columns, maxRows: 500 }); if (!plan.ok) throw new Error(`CSV validation failed at row ${rows + plan.issues[0]!.row}.`); settings.signal?.throwIfAborted(); job = await service.append(job.id, sequence++, plan.records); settings.progress?.(job); rows += batch.length; batch = []; bytes = 0; };
      for await (const record of csvRecords(file, settings.signal)) { if (header === undefined) { header = record; continue; } const size = new TextEncoder().encode(record).length; if (batch.length >= 500 || bytes + size > 4 * 1024 * 1024) await upload(); batch.push(record); bytes += size; }
      if (header === undefined) throw new Error("CSV needs a header row."); await upload(); job = await service.seal(job.id, sequence); settings.progress?.(job); return job;
    },
  }; return service;
}
export function mountDurableImporter(container: HTMLElement, client: DurableImportClient, options: { columns: readonly CsvColumn[] }): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), file = document.createElement("input"), id = document.createElement("input"), status = document.createElement("p"), issues = document.createElement("pre"), controls: HTMLButtonElement[] = [];
  file.type = "file"; file.accept = ".csv,text/csv"; file.setAttribute("aria-label", "CSV file"); id.setAttribute("aria-label", "Import ID to resume"); status.setAttribute("role", "status"); panel.setAttribute("aria-label", "Resumable CSV import");
  let closed = false, busy = false; const controller = new AbortController();
  const progress = (job: DurableImportJob) => { if (closed) return; id.value = job.id; status.textContent = `${job.state}: ${job.processedRows}/${job.uploadedRows} processed, ${job.insertedRows} inserted, ${job.skippedRows} skipped. Save this import ID to resume later.`; issues.textContent = job.issues.length ? JSON.stringify(job.issues, null, 2) : ""; };
  const button = (text: string, action: () => Promise<DurableImportJob>) => { const node = document.createElement("button"); node.type = "button"; node.textContent = text; controls.push(node); node.addEventListener("click", async () => { if (closed || busy) return; busy = true; controls.forEach(control => { control.disabled = true; }); try { progress(await action()); } catch (error) { if (!closed) status.textContent = error instanceof Error ? error.message : "Import interrupted. Resume using the same import ID and file."; } finally { busy = false; controls.forEach(control => { control.disabled = false; }); } }); return node; };
  panel.append(file, id, button("Upload or resume file", async () => { const selected = file.files?.[0]; if (!selected) throw new Error("Choose a CSV file."); return client.uploadCsv(selected, options.columns, { id: id.value || undefined, name: selected.name, signal: controller.signal, progress }); }), button("Run or resume import", () => client.run(id.value, { signal: controller.signal, progress })), button("Refresh progress", () => client.inspect(id.value)), button("Retry failed batch", () => client.retry(id.value)), button("Cancel remaining rows", () => client.cancel(id.value)), status, issues); container.append(panel); return () => { closed = true; controller.abort(); panel.remove(); };
}
