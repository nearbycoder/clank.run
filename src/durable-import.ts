import { BackendActionError, defineBackend, defineDatabase, defineTable, openBackend, type DatabaseSchema, type Id, type ReadDatabase, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";
import { parseCsv, planCsvImport, type CsvColumn } from "./csv-import.ts";
import { featureInput, featureTables, featureTransport, requireFeatureAccess, type FeatureMutation, type FeatureQuery } from "./feature-service.ts";

export type DurableImportState = "uploading" | "ready" | "running" | "failed" | "cancelled" | "completed";
export interface DurableImportIssue { readonly row: number; readonly code: "INVALID_ROW" | "FORBIDDEN" | "DUPLICATE"; }
export type DurableImportColumn<Values> = Omit<CsvColumn, "target"> & { target: Extract<keyof Values, string> };
export interface DurableImportReview {
  readonly sourceHash: string; readonly headers: readonly string[]; readonly columns: readonly CsvColumn[];
  readonly revision: number; readonly updatedRows: number; readonly duplicates: "error" | "skip" | "upsert";
}
export interface DurableImportEffect<Values = Record<string, unknown>> {
  readonly row: number; readonly action: "insert" | "update" | "skip" | "invalid";
  readonly id?: string; readonly version?: number; readonly before?: Readonly<Partial<Values>>;
  readonly after?: Readonly<Partial<Values>>; readonly issue?: DurableImportIssue["code"] | "AMBIGUOUS";
}
export interface DurableImportPreview<Values = Record<string, unknown>> {
  readonly id: string; readonly sourceHash: string; readonly processedRows: number;
  readonly revision: number; readonly jobVersion: number; readonly sourceBatchHash: string; readonly definitionHash: string; readonly digest: string;
  readonly effects: readonly DurableImportEffect<Values>[];
}
export interface DurableImportSourceWindow<Values = Record<string, unknown>> {
  readonly job: DurableImportJob;
  readonly rows: readonly { readonly row: number; readonly source: readonly string[]; readonly corrections: Readonly<Partial<Values>> }[];
  readonly nextRow: number | null;
}
export interface ReviewableImportLimits {
  duplicates?: "error" | "skip" | "upsert"; maxSourceBytes?: number; maxCorrections?: number; maxCorrectionBytes?: number; maxReceipts?: number; maxReceiptBytes?: number; maxTargetRecords?: number;
  /** Mandatory for unowned targets; checked before returning existing values. */
  authorizeRead?(context: { auth: AuthRequest<any>; db: ReadDatabase<any> }, record: Readonly<Record<string, unknown>>): boolean;
}
export interface DurableImportJob { readonly id: string; readonly name: string; readonly state: DurableImportState; readonly uploadedRows: number; readonly processedRows: number; readonly insertedRows: number; readonly skippedRows: number; readonly chunks: number; readonly issues: readonly DurableImportIssue[]; readonly review?: DurableImportReview; }
export interface DurableImportOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema: Schema; table: string; fields: readonly string[]; uniqueBy?: readonly string[]; duplicates?: "error" | "skip"; prefix?: string; maxRows?: number; batchSize?: number;
  maxJobs?: number; maxChunks?: number; maxStagedBytes?: number;
  reviewable?: ReviewableImportLimits;
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
export interface ReviewableImportClient<Values = Record<string, unknown>> extends DurableImportClient {
  /** Stage immutable raw CSV; invalid values remain available for correction. Requires a currentUser getter. */
  uploadReviewableCsv(file: Blob, columns: readonly DurableImportColumn<Values>[], options?: { id?: string; key?: string; name?: string; signal?: AbortSignal; progress?(job: DurableImportJob): void }): Promise<DurableImportJob>;
  sourceWindow(id: string, options?: { startRow?: number; limit?: number }): Promise<DurableImportSourceWindow<Values>>;
  correctMapping(id: string, revision: number, columns: readonly DurableImportColumn<Values>[], operationId: string): Promise<DurableImportJob>;
  correctRows(id: string, revision: number, rows: readonly { row: number; values: Partial<Values> }[], operationId: string): Promise<DurableImportJob>;
  preview(id: string): Promise<DurableImportPreview<Values>>;
  apply(preview: DurableImportPreview<Values>, operationId: string): Promise<DurableImportJob>;
}

interface ImportReviewMetadata extends DurableImportReview { version: 1; definitionHash: string; sourceRows: number; sourceBytes: number; initialMapping: string; }
const publicReview = (value: ImportReviewMetadata): DurableImportReview => ({ sourceHash: value.sourceHash, headers: value.headers, columns: value.columns, revision: value.revision, updatedRows: value.updatedRows, duplicates: value.duplicates });
const allowed = (value: unknown): boolean => { if (value === true) return true; void Promise.resolve(value).catch(() => undefined); return false; };
const csvText = (headers: readonly string[], rows: readonly (readonly string[])[]) => [headers, ...rows].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(",")).join("\n");
const legacyJob = (job: any) => { if (job.review) throw new BackendActionError(409, "IMPORT_REVIEW_REQUIRED", "Preview and accept this reviewable import batch."); };

/** Persist upload chunks and execution cursors beside target records; each bounded apply batch commits atomically. */
export async function openDurableImport<Schema extends DatabaseSchema<any>>(options: DurableImportOptions<Schema>): Promise<DurableImportService>;
export async function openDurableImport(options: DurableImportOptions): Promise<DurableImportService> {
  options = { ...options, fields: [...options.fields], uniqueBy: [...options.uniqueBy ?? []], reviewable: options.reviewable && { ...options.reviewable } };
  const target = options.schema.tables[options.table], maximum = options.maxRows ?? 1000000, batchSize = options.batchSize ?? 100, unique = [...options.uniqueBy ?? []];
  const maxJobs = options.maxJobs ?? 10000, maxChunks = options.maxChunks ?? 2000, maxStagedBytes = options.maxStagedBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100000 || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 10000 || !Number.isSafeInteger(maxStagedBytes) || maxStagedBytes < 1 || maxStagedBytes > 4 * 1024 * 1024 * 1024) throw new TypeError("Declare bounded import job, chunk, and staging byte limits.");
  if (!target || !options.fields.length || options.fields.some(field => !Object.hasOwn(target.fields, field)) || new Set(options.fields).size !== options.fields.length || unique.some(field => !options.fields.includes(field)) || unique.length > 10 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000000 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500 || options.duplicates && !["error", "skip"].includes(options.duplicates)) throw new TypeError("Declare a target table, mapped fields, and bounded row/batch limits.");
  if (target.ownership !== "user" && !options.authorize) throw new TypeError("Unowned import targets need explicit record authorization.");
  if (options.schema.tables.durableImportJobs || options.schema.tables.durableImportChunks) throw new TypeError("Import metadata table names are reserved.");
  const review = options.reviewable;
  const reviewLimits = { source: review?.maxSourceBytes ?? 16 * 1024 * 1024, corrections: review?.maxCorrections ?? 100000, receipts: review?.maxReceipts ?? 100000, correctionBytes: review?.maxCorrectionBytes ?? 16 * 1024 * 1024, receiptBytes: review?.maxReceiptBytes ?? 32 * 1024 * 1024, targets: review?.maxTargetRecords ?? 50000 };
  if (review && unique.some(field => { const json = target.fields[field]!.toJSONSchema(); return !["string", "number", "integer", "boolean"].includes(String(json.type)) && !["string", "number", "boolean"].includes(typeof json.const); })) throw new TypeError("Reviewable unique fields must be scalar string, number or boolean values.");
  if (review && (Object.values(reviewLimits).some(value => !Number.isSafeInteger(value) || value < 1) || reviewLimits.source > 16 * 1024 * 1024 || reviewLimits.corrections > 100000 || reviewLimits.receipts > 100000 || reviewLimits.targets > 50000 || reviewLimits.correctionBytes > 64 * 1024 * 1024 || reviewLimits.receiptBytes > 128 * 1024 * 1024 || review.duplicates && !["error", "skip", "upsert"].includes(review.duplicates) || review.duplicates === "upsert" && !unique.length || target.ownership !== "user" && !review.authorizeRead)) throw new TypeError("Reviewable imports need bounded limits, unique upsert fields and explicit unowned read authorization.");
  const schema = defineDatabase(featureTables(options.schema, {
    durableImportJobs: defineTable({ key: s.string(), name: s.string(), state: s.enum(["uploading", "ready", "running", "failed", "cancelled", "completed"] as const), uploadedRows: s.number(), processedRows: s.number(), insertedRows: s.number(), skippedRows: s.number(), chunks: s.number(), nextChunk: s.number(), nextOffset: s.number(), issues: s.string(), ...(review ? { review: s.default(s.string({ max: 65536 }), "") } : {}) }).owned().index("by_key", ["key"]),
    durableImportChunks: defineTable({ jobId: s.string(), sequence: s.number(), contents: s.string({ max: 4 * 1024 * 1024 }), rows: s.number(), ...(review ? { digest: s.default(s.string(), "") } : {}) }).owned().index("by_job", ["jobId", "sequence"]),
    ...(review ? {
      durableImportCorrections: defineTable({ jobId: s.string(), row: s.number(), values: s.string({ max: 65536 }) }).owned().index("by_row", ["jobId", "row"]),
      durableImportOperations: defineTable({ key: s.string(), jobId: s.string(), fingerprint: s.string(), result: s.string({ max: 65536 }), targets: s.string({ max: 65536 }) }).owned().index("by_key", ["key"]),
    } : {}),
  }));
  const output = (row: any): DurableImportJob => ({ id: row._id, name: row.name, state: row.state, uploadedRows: row.uploadedRows, processedRows: row.processedRows, insertedRows: row.insertedRows, skippedRows: row.skippedRows, chunks: row.chunks, issues: JSON.parse(row.issues), ...(row.review ? { review: publicReview(JSON.parse(row.review)) } : {}) });
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
    if (review) while (true) {
      const rows = native.prepare("SELECT _id FROM clank_durableImportCorrections WHERE _owner_id = ? AND json_extract(_data, '$.jobId') = ? LIMIT 100").all(context.auth.user!.id, id);
      if (!rows.length) break;
      for (const row of rows) { context.db.table("durableImportCorrections").delete(row._id); native.purgeDeletedHistory("durableImportCorrections", row._id as string); }
    }
  };
  const { createHash } = await import("node:" + "crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex") as string;
  const definitionHash = hash(JSON.stringify({ table: options.table, fields: options.fields, unique, schema: target.schema.toJSONSchema(), ownership: target.ownership, duplicates: review?.duplicates ?? "error", batchSize }));
  const conflict = (code: string, message: string): never => { throw new BackendActionError(409, code, message); };
  const metadata = (job: any): ImportReviewMetadata => {
    if (!review || !job.review) return conflict("IMPORT_NOT_REVIEWABLE", "This import does not have an immutable reviewable source.");
    let value: any; try { value = JSON.parse(job.review); } catch { return conflict("IMPORT_REVIEW_METADATA", "Invalid persisted import review metadata."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return conflict("IMPORT_REVIEW_METADATA", "Invalid persisted import review metadata.");
    if (value.version !== 1) return conflict("IMPORT_REVIEW_VERSION", "Unsupported import review metadata.");
    if (value.definitionHash !== definitionHash) return conflict("IMPORT_DEFINITION_CHANGED", "Import target definition changed; finish or cancel before changing the import contract.");
    if (!/^[a-f0-9]{64}$/.test(value.sourceHash) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.headers) || !Array.isArray(value.columns) || !Number.isSafeInteger(value.sourceRows) || value.sourceRows < 0 || value.sourceRows > 50000 || !Number.isSafeInteger(value.updatedRows) || value.updatedRows < 0 || value.updatedRows > job.processedRows || !Number.isSafeInteger(value.sourceBytes) || value.sourceBytes < 0 || value.sourceBytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(value.initialMapping) || value.duplicates !== (review.duplicates ?? "error") || value.headers.length < 1 || value.headers.length > 100 || value.headers.some((header: unknown) => typeof header !== "string" || !header || header.trim() !== header || header.length > 200) || new Set(value.headers).size !== value.headers.length) return conflict("IMPORT_REVIEW_METADATA", "Invalid persisted import review metadata.");
    try { if (JSON.stringify(mapping(value.headers, value.columns)) !== JSON.stringify(value.columns)) throw new Error("Invalid mapping."); } catch { return conflict("IMPORT_REVIEW_METADATA", "Invalid persisted import mapping."); }
    return value;
  };
  const owner = (context: any, expectedOwner: string) => requireFeatureAccess(context.auth.user?.id === expectedOwner);
  const mapping = (headers: readonly string[], value: unknown): CsvColumn[] => {
    if (!Array.isArray(value) || value.some(column => !column || typeof column !== "object" || Object.keys(column).some(key => !["source", "target", "type", "required"].includes(key)) || column.required !== undefined && typeof column.required !== "boolean" || !options.fields.includes(column.target))) return featureInput("Choose declared import fields.");
    const columns = value.map(column => ({ source: column.source, target: column.target, type: column.type, required: column.required === true }));
    try { planCsvImport(csvText(headers, []), { columns, uniqueBy: unique }); } catch { return featureInput("Choose valid source columns, types and every unique field."); }
    return columns;
  };
  const terminal = (job: any) => ["completed", "cancelled"].includes(job.state);
  const editable = (job: any, revision: number) => {
    const meta = metadata(job);
    if (terminal(job) || job.state === "uploading" || meta.revision !== revision) return conflict("IMPORT_CORRECTION_STALE", "Reload the immutable source and correction revision.");
    if (meta.revision >= Number.MAX_SAFE_INTEGER) return conflict("IMPORT_REVISION_EXHAUSTED", "Import correction revision is exhausted.");
    return meta;
  };
  const sourceRows = (context: any, job: any, startRow: number, limit: number) => {
    const result: Array<{ row: number; source: string[]; corrections: Record<string, unknown> }> = [];
    // Chunks are bounded at admission; inspect at most one page of chunk descriptors at a time.
    let sequence = 0, offset = 2;
    while (sequence < job.chunks && result.length < limit) {
      const chunk = context.db.table("durableImportChunks").query().where("jobId", job._id).where("sequence", sequence++).first();
      if (!chunk) return conflict("IMPORT_CHUNK_MISSING", "A persisted immutable source chunk is unavailable.");
      if (offset + chunk.rows <= startRow) { offset += chunk.rows; continue; }
      if (chunk.digest !== hash(chunk.contents)) return conflict("IMPORT_SOURCE_CHANGED", "Immutable source chunk checksum changed.");
      const rows = JSON.parse(chunk.contents);
      for (let index = Math.max(0, startRow - offset); index < rows.length && result.length < limit; index++) {
        const row = offset + index, correction = context.db.table("durableImportCorrections").query().where("jobId", job._id).where("row", row).first();
        result.push({ row, source: rows[index], corrections: correction ? JSON.parse(correction.values) : {} });
      }
      offset += rows.length;
    }
    return result;
  };
  const readAllowed = (context: any, value: Record<string, unknown>) => allowed(review?.authorizeRead ? review.authorizeRead(context, value) : true);
  const writeAllowed = (context: any, value: Record<string, unknown>, operation: "upload" | "apply" = "apply") => allowed(options.authorize ? options.authorize(context, value, operation) : true);
  const valuesOnly = (record: Record<string, unknown>) => Object.fromEntries(Object.keys(target.fields).filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
  const displayValues = (record: Record<string, unknown>) => Object.fromEntries(options.fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
  const makePreview = (context: any, job: any): DurableImportPreview => {
    const meta = metadata(job);
    if (terminal(job) || job.state === "uploading") return conflict("IMPORT_PREVIEW_STATE", "Seal an active import before previewing a batch.");
    const targetTable = context.db.table(options.table);
    const count = native.prepare(`SELECT count(*) AS count FROM "clank_${options.table}"${target.ownership === "user" ? " WHERE _owner_id = ?" : ""}`).get(...(target.ownership === "user" ? [context.auth.user.id] : []))!;
    if (Number(count.count) > reviewLimits.targets) throw new BackendActionError(503, "IMPORT_TARGET_CAPACITY", "Target lookup exceeds the declared record limit.");
    const effects: DurableImportEffect[] = [], seen = new Set<string>();
    const sourceBatch = sourceRows(context, job, job.processedRows + 2, batchSize);
    for (const raw of sourceBatch) {
      const invalid = (issue: DurableImportEffect["issue"]) => effects.push({ row: raw.row, action: "invalid", issue });
      const columns = meta.columns.filter(column => !Object.hasOwn(raw.corrections, column.target));
      let changes: Record<string, unknown>;
      try {
        const plan = columns.length ? planCsvImport(csvText(meta.headers, [raw.source]), { columns }) : undefined;
        if (plan && !plan.ok) { invalid("INVALID_ROW"); continue; }
        changes = { ...plan?.records[0], ...raw.corrections };
        for (const [field, value] of Object.entries(changes)) changes[field] = target.fields[field]!.parse(value);
      } catch { invalid("INVALID_ROW"); continue; }
      let existing: any;
      if (unique.length) {
        if (unique.some(field => changes[field] === undefined || changes[field] === null)) { invalid("INVALID_ROW"); continue; }
        const identity = JSON.stringify(unique.map(field => changes[field]));
        if (seen.has(identity)) { invalid("DUPLICATE"); continue; } seen.add(identity);
        let query = targetTable.query(); for (const field of unique) query = query.where(field, changes[field]);
        const matches = query.limit(2).collect();
        if (matches.some((record: any) => !readAllowed(context, record))) { invalid("FORBIDDEN"); continue; }
        if (matches.length > 1) { invalid("AMBIGUOUS"); continue; } existing = matches[0];
      }
      let full: Record<string, unknown>;
      try { full = target.schema.parse(existing ? { ...valuesOnly(existing), ...changes } : changes) as Record<string, unknown>; }
      catch { invalid("INVALID_ROW"); continue; }
      if (!writeAllowed(context, full, "upload") || !writeAllowed(context, full) || existing && !writeAllowed(context, existing)) { invalid("FORBIDDEN"); continue; }
      if (existing && meta.duplicates === "error") { invalid("DUPLICATE"); continue; }
      effects.push({ row: raw.row, action: existing ? meta.duplicates === "upsert" ? "update" : "skip" : "insert", ...(existing ? { id: existing._id, version: existing._version, before: displayValues(existing) } : {}), after: displayValues(full) });
    }
    if (!effects.some(effect => effect.action === "invalid") && Number(count.count) + effects.filter(effect => effect.action === "insert").length > reviewLimits.targets) throw new BackendActionError(503, "IMPORT_TARGET_CAPACITY", "Accepted inserts would exceed the declared target record limit.");
    const value = { id: job._id, sourceHash: meta.sourceHash, processedRows: job.processedRows, revision: meta.revision, jobVersion: job._version, sourceBatchHash: hash(JSON.stringify(sourceBatch)), definitionHash, effects };
    if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) throw new BackendActionError(400, "IMPORT_PREVIEW_BYTES", "Import preview exceeds 1 MiB; use a smaller batch size.");
    return { ...value, digest: hash(JSON.stringify(value)) };
  };
  const receipt = (context: any, job: any, key: string, fingerprint: string): DurableImportJob | undefined => {
    const row = context.db.table("durableImportOperations").query().where("key", key).first();
    if (!row) return;
    if (row.jobId !== job._id || row.fingerprint !== fingerprint) return conflict("IMPORT_OPERATION_REUSED", "Operation ID belongs to different reviewed input.");
    // Retained receipts never bypass current record authorization, even after payload retirement.
    for (const id of JSON.parse(row.targets)) {
      const record = context.db.table(options.table).get(id);
      requireFeatureAccess(Boolean(record) && readAllowed(context, record) && writeAllowed(context, record));
    }
    return JSON.parse(row.result);
  };
  const saveReceipt = (context: any, job: any, key: string, fingerprint: string, targets: string[] = []) => {
    const result = output(job), serialized = JSON.stringify(result), ids = JSON.stringify(targets);
    const capacity = native.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(json_extract(_data, '$.result') AS BLOB)) + length(CAST(json_extract(_data, '$.targets') AS BLOB))), 0) AS bytes FROM clank_durableImportOperations").get()!;
    if (Number(capacity.count) >= reviewLimits.receipts || new TextEncoder().encode(serialized).length > 65536 || Number(capacity.bytes) + new TextEncoder().encode(serialized + ids).length > reviewLimits.receiptBytes) throw new BackendActionError(503, "IMPORT_RECEIPT_CAPACITY", "Import operation receipt capacity reached; review retention before accepting work.");
    context.db.table("durableImportOperations").insert({ key, jobId: job._id, fingerprint, result: serialized, targets: ids });
    return result;
  };
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    ...(review ? {
      createReview: mutation({ args: { id: s.optional(s.id("durableImportJobs")), name: s.string({ min: 1, max: 200 }), key: s.string({ min: 1, max: 100 }), expectedOwner: s.string({ min: 1, max: 200 }), sourceHash: s.string({ pattern: /^[a-f0-9]{64}$/ }), sourceRows: s.number({ integer: true, min: 0, max: 50000 }), headers: s.string({ max: 65536 }), columns: s.string({ max: 65536 }) }, agent: false, handler: (context, input) => {
        owner(context, input.expectedOwner);
        let headers: string[]; try { headers = JSON.parse(input.headers); } catch { return featureInput("Invalid source headers."); }
        if (!Array.isArray(headers) || !headers.length || headers.length > 100 || headers.some(value => typeof value !== "string" || !value || value.trim() !== value || value.length > 200) || new Set(headers).size !== headers.length) return featureInput("Invalid source headers.");
        let proposed: unknown; try { proposed = JSON.parse(input.columns); } catch { return featureInput("Invalid mapping."); }
        const columns = mapping(headers, proposed), initialMapping = hash(JSON.stringify(columns)), table = context.db.table("durableImportJobs");
        const existing = input.id ? getJob(context, input.id) : table.query().where("key", input.key).first();
        if (existing) {
          const meta = metadata(existing);
          if (existing.name !== input.name || meta.sourceHash !== input.sourceHash || meta.initialMapping !== initialMapping || meta.sourceRows !== input.sourceRows || JSON.stringify(meta.headers) !== JSON.stringify(headers)) return conflict("IMPORT_SOURCE_CHANGED", "Import identity belongs to another source or initial mapping.");
          return output(existing);
        }
        if (input.sourceRows > maximum) return featureInput("Source exceeds the import row limit.");
        if (Number(native.prepare("SELECT count(*) AS count FROM clank_durableImportJobs").get()?.count ?? 0) >= maxJobs) throw new BackendActionError(503, "IMPORT_JOB_CAPACITY", "Import job receipt capacity reached.");
        if (table.query().where("state", "neq", "completed").where("state", "neq", "cancelled").limit(21).collect().length >= 20) return conflict("IMPORT_LIMIT", "Finish or cancel an existing import first.");
        const meta: ImportReviewMetadata = { version: 1, definitionHash, sourceHash: input.sourceHash, sourceRows: input.sourceRows, headers, columns, initialMapping, sourceBytes: new TextEncoder().encode(JSON.stringify(headers) + "\n").length, duplicates: review.duplicates ?? "error", revision: 0, updatedRows: 0 };
        if (meta.sourceBytes > reviewLimits.source) return featureInput("Source headers exceed the canonical byte limit.");
        const id = table.insert({ key: input.key, name: input.name, state: "uploading", uploadedRows: 0, processedRows: 0, insertedRows: 0, skippedRows: 0, chunks: 0, nextChunk: 0, nextOffset: 0, issues: "[]", review: JSON.stringify(meta) });
        return output(table.get(id));
      } }),
      appendReview: mutation({ args: { id: s.id("durableImportJobs"), expectedOwner: s.string(), sequence: s.number({ integer: true, min: 0 }), rows: s.string({ max: 4 * 1024 * 1024 }) }, agent: false, handler: (context, input) => {
        owner(context, input.expectedOwner); const job = getJob(context, input.id), meta = metadata(job), chunks = context.db.table("durableImportChunks");
        if (terminal(job)) throw new BackendActionError(410, "IMPORT_PAYLOAD_RETIRED", "Immutable source payload is retired; inspect its retained receipt.");
        let rows: unknown; try { rows = JSON.parse(input.rows); } catch { return featureInput("Source chunk must be JSON rows."); }
        if (!Array.isArray(rows) || !rows.length || rows.length > 500 || rows.some(row => !Array.isArray(row) || row.length !== meta.headers.length || row.some(value => typeof value !== "string" || value.length > 65536))) return featureInput("Source chunks need 1–500 bounded raw CSV rows.");
        const contents = JSON.stringify(rows), existing = chunks.query().where("jobId", input.id).where("sequence", input.sequence).first();
        if (existing) { if (existing.contents !== contents) return conflict("IMPORT_CHUNK_CHANGED", "Immutable source rows differ from this chunk."); return output(job); }
        const bytes = rows.reduce((sum, row) => sum + new TextEncoder().encode(JSON.stringify(row) + "\n").length, 0);
        if (job.state !== "uploading" || job.chunks !== input.sequence || job.uploadedRows + rows.length > meta.sourceRows || meta.sourceBytes + bytes > reviewLimits.source) return conflict("IMPORT_UPLOAD_STATE", "Source is sealed, out of sequence, or exceeds its declared bounds.");
        const capacity = native.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(json_extract(_data, '$.contents') AS BLOB))), 0) AS bytes FROM clank_durableImportChunks").get()!;
        if (job.chunks >= maxChunks || Number(capacity.count) >= 10000 || Number(capacity.bytes) + new TextEncoder().encode(contents).length > maxStagedBytes) throw new BackendActionError(503, "IMPORT_STAGING_CAPACITY", "Import staging capacity reached.");
        chunks.insert({ jobId: input.id, sequence: input.sequence, contents, rows: rows.length, digest: hash(contents) });
        context.db.table("durableImportJobs").patch(input.id, { chunks: job.chunks + 1, uploadedRows: job.uploadedRows + rows.length, review: JSON.stringify({ ...meta, sourceBytes: meta.sourceBytes + bytes }) });
        return output(context.db.table("durableImportJobs").get(input.id));
      } }),
      sealReview: mutation({ args: { id: s.id("durableImportJobs"), expectedOwner: s.string(), chunks: s.number({ integer: true, min: 0 }) }, agent: false, handler: (context, input) => {
        owner(context, input.expectedOwner); const job = getJob(context, input.id), meta = metadata(job);
        if (job.chunks !== input.chunks || job.state === "cancelled") return conflict("IMPORT_UPLOAD_STATE", "Import chunk count or state changed.");
        if (job.state !== "uploading") return output(job);
        const digest = createHash("sha256").update(JSON.stringify(meta.headers) + "\n"); let rows = 0, bytes = new TextEncoder().encode(JSON.stringify(meta.headers) + "\n").length;
        for (let sequence = 0; sequence < job.chunks; sequence++) {
          const chunk = context.db.table("durableImportChunks").query().where("jobId", input.id).where("sequence", sequence).first();
          if (!chunk) return conflict("IMPORT_CHUNK_MISSING", "Immutable source chunk is unavailable.");
          if (chunk.digest !== hash(chunk.contents)) return conflict("IMPORT_SOURCE_CHANGED", "Immutable source chunk checksum changed.");
          for (const row of JSON.parse(chunk.contents)) { const text = JSON.stringify(row) + "\n"; digest.update(text); bytes += new TextEncoder().encode(text).length; rows++; }
        }
        if (digest.digest("hex") !== meta.sourceHash || rows !== meta.sourceRows || rows !== job.uploadedRows || bytes !== meta.sourceBytes || bytes > reviewLimits.source) return conflict("IMPORT_SOURCE_CHANGED", "Uploaded rows do not match the canonical source identity.");
        context.db.table("durableImportJobs").patch(input.id, { state: rows ? "ready" : "completed" });
        if (!rows) retirePayload(context, input.id);
        return output(context.db.table("durableImportJobs").get(input.id));
      } }),
      sourceWindow: query({ args: { id: s.id("durableImportJobs"), expectedOwner: s.string(), startRow: s.optional(s.number({ integer: true, min: 2 })), limit: s.number({ integer: true, min: 1, max: 100 }) }, agent: false, handler: (context, input) => {
        owner(context, input.expectedOwner); const job = getJob(context, input.id); metadata(job);
        const start = input.startRow ?? job.processedRows + 2;
        if (terminal(job) || start < job.processedRows + 2 || start > job.uploadedRows + 2) return conflict("IMPORT_SOURCE_WINDOW", "Only unprocessed immutable source rows are available.");
        const rows = sourceRows(context, job, start, input.limit), nextRow = rows.length && rows[rows.length - 1]!.row < job.uploadedRows + 1 ? rows[rows.length - 1]!.row + 1 : null;
        const result = { job: output(job), rows, nextRow };
        if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024) throw new BackendActionError(400, "IMPORT_SOURCE_BYTES", "Source window exceeds 1 MiB; request fewer rows.");
        return result;
      } }),
      correctMapping: mutation({ args: { id: s.id("durableImportJobs"), expectedOwner: s.string(), revision: s.number({ integer: true, min: 0 }), operationId: s.string({ min: 1, max: 100 }), columns: s.string({ max: 65536 }) }, agent: false, handler: (context, input) => {
        owner(context, input.expectedOwner); const job = getJob(context, input.id); metadata(job);
        const fingerprint = hash(JSON.stringify(["mapping", input.id, input.revision, input.columns])), previous = receipt(context, job, input.operationId, fingerprint); if (previous) return previous;
        const meta = editable(job, input.revision); let proposed: unknown; try { proposed = JSON.parse(input.columns); } catch { return featureInput("Invalid mapping."); }
        const columns = mapping(meta.headers, proposed);
        context.db.table("durableImportJobs").patch(input.id, { state: "ready", issues: "[]", review: JSON.stringify({ ...meta, columns, revision: meta.revision + 1 }) });
        return saveReceipt(context, context.db.table("durableImportJobs").get(input.id), input.operationId, fingerprint);
      } }),
      correctRows: mutation({ args: { id: s.id("durableImportJobs"), expectedOwner: s.string(), revision: s.number({ integer: true, min: 0 }), operationId: s.string({ min: 1, max: 100 }), rows: s.string({ max: 1024 * 1024 }) }, agent: false, handler: (context, input) => {
        owner(context, input.expectedOwner); const job = getJob(context, input.id); metadata(job);
        const fingerprint = hash(JSON.stringify(["rows", input.id, input.revision, input.rows])), previous = receipt(context, job, input.operationId, fingerprint); if (previous) return previous;
        const meta = editable(job, input.revision), table = context.db.table("durableImportCorrections");
        let rows: any; try { rows = JSON.parse(input.rows); } catch { return featureInput("Invalid row corrections."); }
        if (!Array.isArray(rows) || !rows.length || rows.length > 100 || new Set(rows.map(row => row?.row)).size !== rows.length) return featureInput("Correct 1–100 distinct unprocessed rows.");
        for (const row of rows) {
          if (!row || Object.keys(row).some(key => !["row", "values"].includes(key)) || !Number.isSafeInteger(row.row) || row.row < job.processedRows + 2 || row.row > job.uploadedRows + 1 || !row.values || typeof row.values !== "object" || Array.isArray(row.values) || !Object.keys(row.values).length || Object.keys(row.values).some(field => !options.fields.includes(field))) return featureInput("Corrections may only change declared fields in unprocessed rows.");
          const values: Record<string, unknown> = {};
          try { for (const [field, value] of Object.entries(row.values)) values[field] = target.fields[field]!.parse(value); } catch { return featureInput("Correction values must match target field types."); }
          const old = table.query().where("jobId", input.id).where("row", row.row).first(), contents = JSON.stringify({ ...(old ? JSON.parse(old.values) : {}), ...values });
          if (new TextEncoder().encode(contents).length > 65536) return featureInput("Row corrections exceed 64 KiB.");
          if (old) { table.delete(old._id); native.purgeDeletedHistory("durableImportCorrections", old._id); }
          table.insert({ jobId: input.id, row: row.row, values: contents });
        }
        const capacity = native.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(json_extract(_data, '$.values') AS BLOB))), 0) AS bytes FROM clank_durableImportCorrections").get()!;
        if (Number(capacity.count) > reviewLimits.corrections || Number(capacity.bytes) > reviewLimits.correctionBytes) throw new BackendActionError(503, "IMPORT_CORRECTION_CAPACITY", "Import correction capacity reached.");
        context.db.table("durableImportJobs").patch(input.id, { state: "ready", issues: "[]", review: JSON.stringify({ ...meta, revision: meta.revision + 1 }) });
        return saveReceipt(context, context.db.table("durableImportJobs").get(input.id), input.operationId, fingerprint);
      } }),
      preview: query({ args: { id: s.id("durableImportJobs"), expectedOwner: s.string() }, agent: false, handler: (context, input) => { owner(context, input.expectedOwner); return makePreview(context, getJob(context, input.id)); } }),
      apply: mutation({ args: { id: s.id("durableImportJobs"), expectedOwner: s.string(), preview: s.string({ max: 1024 * 1024 }), operationId: s.string({ min: 1, max: 100 }) }, agent: false, handler: (context, input) => {
        owner(context, input.expectedOwner); const job = getJob(context, input.id), meta = metadata(job);
        const fingerprint = hash(JSON.stringify(["apply", input.id, input.preview])), previous = receipt(context, job, input.operationId, fingerprint); if (previous) return previous;
        let selected: unknown; try { selected = JSON.parse(input.preview); } catch { return featureInput("Invalid reviewed preview."); }
        const preview = makePreview(context, job);
        if (JSON.stringify(selected) !== JSON.stringify(preview)) return conflict("IMPORT_PREVIEW_STALE", "Source, corrections, progress or target versions changed; preview again.");
        if (!preview.effects.length) return conflict("IMPORT_PREVIEW_EMPTY", "No remaining batch is available.");
        if (preview.effects.some(effect => effect.action === "invalid")) {
          context.db.table("durableImportJobs").patch(input.id, { state: "failed", issues: JSON.stringify(preview.effects.filter(effect => effect.issue).map(effect => ({ row: effect.row, code: effect.issue === "AMBIGUOUS" ? "DUPLICATE" : effect.issue }))) });
          return saveReceipt(context, context.db.table("durableImportJobs").get(input.id), input.operationId, fingerprint);
        }
        let inserted = 0, updated = 0, skipped = 0; const targets: string[] = [], table = context.db.table(options.table);
        for (const effect of preview.effects) {
          if (effect.action === "insert") { targets.push(table.insert(target.schema.parse(effect.after))); inserted++; }
          else if (effect.action === "update") { table.patch(effect.id! as Id<string>, effect.after!, { ifVersion: effect.version }); targets.push(effect.id!); updated++; }
          else { targets.push(effect.id!); skipped++; }
        }
        const processedRows = job.processedRows + preview.effects.length;
        context.db.table("durableImportJobs").patch(input.id, { processedRows, insertedRows: job.insertedRows + inserted, skippedRows: job.skippedRows + skipped, state: processedRows === job.uploadedRows ? "completed" : "running", issues: "[]", review: JSON.stringify({ ...meta, updatedRows: meta.updatedRows + updated }) });
        if (processedRows === job.uploadedRows) retirePayload(context, input.id);
        return saveReceipt(context, context.db.table("durableImportJobs").get(input.id), input.operationId, fingerprint, targets);
      } }),
    } : {}),
    create: mutation({ args: { name: s.string({ min: 1, max: 200 }), key: s.string({ min: 1, max: 100 }) }, agent: false, handler: ({ db }, input) => {
      const table = db.table("durableImportJobs"), existing = table.query().where("key", input.key).first();
      if (existing) { legacyJob(existing); if (existing.name !== input.name) throw new BackendActionError(409, "IMPORT_KEY_REUSED", "Import key belongs to another source."); return output(existing); }
      if (Number(native.prepare("SELECT count(*) AS count FROM clank_durableImportJobs").get()?.count ?? 0) >= maxJobs) throw new BackendActionError(503, "IMPORT_JOB_CAPACITY", "Import job receipt capacity reached; review retention before admitting new jobs.");
      if (table.query().where("state", "neq", "completed").where("state", "neq", "cancelled").limit(21).collect().length >= 20) throw new BackendActionError(409, "IMPORT_LIMIT", "Finish or cancel an existing import first.");
      const id = table.insert({ ...input, state: "uploading", uploadedRows: 0, processedRows: 0, insertedRows: 0, skippedRows: 0, chunks: 0, nextChunk: 0, nextOffset: 0, issues: "[]" }); return output(table.get(id));
    } }),
    inspect: query({ args: { id: s.id("durableImportJobs") }, agent: false, handler: (context, { id }) => output(getJob(context, id)) }),
    append: mutation({ args: { id: s.id("durableImportJobs"), sequence: s.number({ integer: true, min: 0 }), records: s.string({ max: 4 * 1024 * 1024 }) }, agent: false, handler: (context, input) => {
      const job = getJob(context, input.id); legacyJob(job); const chunks = context.db.table("durableImportChunks");
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
    seal: mutation({ args: { id: s.id("durableImportJobs"), chunks: s.number({ integer: true, min: 0 }) }, agent: false, handler: (context, { id, chunks }) => { const job = getJob(context, id); legacyJob(job); if (job.chunks !== chunks || job.state === "cancelled") throw new BackendActionError(409, "IMPORT_UPLOAD_STATE", "Import chunk count or state changed."); if (job.state === "uploading") context.db.table("durableImportJobs").patch(id, { state: job.uploadedRows ? "ready" : "completed" }); return output(context.db.table("durableImportJobs").get(id)); } }),
    step: mutation({ args: { id: s.id("durableImportJobs"), expectedProcessed: s.number({ integer: true, min: 0 }) }, agent: false, handler: (context, { id, expectedProcessed }) => {
      const job = getJob(context, id); legacyJob(job);
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
          if (!allowed(options.authorize ? options.authorize(context as any, value, "apply") : true)) issues.push({ row, code: "FORBIDDEN" });
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
export interface DurableImportClientOptions extends SyncClientOptions { currentUser?(): string | null; }
export function createDurableImportClient<Values = Record<string, unknown>>(options: DurableImportClientOptions = {}): ReviewableImportClient<Values> {
  const settings = { ...options };
  const currentOwner = () => { const id = settings.currentUser?.(); if (!id) throw new Error("Reviewable imports require a signed-in currentUser getter."); return id; };
  const checkOwner = (id: string) => { if (settings.currentUser?.() !== id) throw new Error("Import account changed; discard this response and remount."); };
  const asOwner = async <Result>(action: (id: string) => Promise<Result>): Promise<Result> => { const id = currentOwner(), result = await action(id); checkOwner(id); return result; };
  const { client, api } = featureTransport<{
    createReview: FeatureMutation<{ id?: string; name: string; key: string; expectedOwner: string; sourceHash: string; sourceRows: number; headers: string; columns: string }, DurableImportJob>;
    appendReview: FeatureMutation<{ id: string; expectedOwner: string; sequence: number; rows: string }, DurableImportJob>;
    sealReview: FeatureMutation<{ id: string; expectedOwner: string; chunks: number }, DurableImportJob>;
    sourceWindow: FeatureQuery<{ id: string; expectedOwner: string; startRow?: number; limit: number }, DurableImportSourceWindow<Values>>;
    correctMapping: FeatureMutation<{ id: string; expectedOwner: string; revision: number; operationId: string; columns: string }, DurableImportJob>;
    correctRows: FeatureMutation<{ id: string; expectedOwner: string; revision: number; operationId: string; rows: string }, DurableImportJob>;
    preview: FeatureQuery<{ id: string; expectedOwner: string }, DurableImportPreview<Values>>;
    apply: FeatureMutation<{ id: string; expectedOwner: string; preview: string; operationId: string }, DurableImportJob>;
    create: FeatureMutation<{ name: string; key: string }, DurableImportJob>;
    inspect: FeatureQuery<{ id: string }, DurableImportJob>;
    append: FeatureMutation<{ id: string; sequence: number; records: string }, DurableImportJob>;
    seal: FeatureMutation<{ id: string; chunks: number }, DurableImportJob>;
    step: FeatureMutation<{ id: string; expectedProcessed: number }, DurableImportJob>;
    retry: FeatureMutation<{ id: string }, DurableImportJob>;
    cancel: FeatureMutation<{ id: string }, DurableImportJob>;
  }>(settings, "/__clank/imports");
  const service: ReviewableImportClient<Values> = {
    sourceWindow: (id, settings = {}) => asOwner(expectedOwner => client.query(api.sourceWindow, { id, expectedOwner, startRow: settings.startRow, limit: settings.limit ?? 20 })),
    correctMapping: (id, revision, columns, operationId) => { const serialized = JSON.stringify(columns); return asOwner(expectedOwner => client.mutate(api.correctMapping, { id, expectedOwner, revision, operationId, columns: serialized })); },
    correctRows: (id, revision, rows, operationId) => { const serialized = JSON.stringify(rows); return asOwner(expectedOwner => client.mutate(api.correctRows, { id, expectedOwner, revision, operationId, rows: serialized })); },
    preview: id => asOwner(expectedOwner => client.query(api.preview, { id, expectedOwner })),
    apply: (preview, operationId) => { const id = preview.id, serialized = JSON.stringify(preview); return asOwner(expectedOwner => client.mutate(api.apply, { id, expectedOwner, preview: serialized, operationId })); },
    async uploadReviewableCsv(file, columns, settings = {}) {
      const expectedOwner = currentOwner(), settingsSnapshot = { ...settings }, columnsSnapshot = JSON.stringify(columns);
      const check = () => { settingsSnapshot.signal?.throwIfAborted(); checkOwner(expectedOwner); };
      if (file.size > 5 * 1024 * 1024) throw new RangeError("Reviewable CSV imports are limited to 5 MiB.");
      const text = await file.text(); check(); const source = parseCsv(text, { maxRows: 50000 });
      const canonical = JSON.stringify(source.headers) + "\n" + source.rows.map(row => JSON.stringify(row) + "\n").join("");
      const bytes = new TextEncoder().encode(canonical);
      if (bytes.length > 16 * 1024 * 1024) throw new RangeError("Canonical reviewable source exceeds 16 MiB.");
      const sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join(""); check();
      let existing: DurableImportJob | undefined;
      if (settingsSnapshot.id) { existing = await service.inspect(settingsSnapshot.id); check(); }
      let job = await client.mutate(api.createReview, { id: settingsSnapshot.id, name: settingsSnapshot.name ?? existing?.name ?? "CSV import", key: settingsSnapshot.key ?? crypto.randomUUID(), expectedOwner, sourceHash, sourceRows: source.rows.length, headers: JSON.stringify(source.headers), columns: columnsSnapshot }); check(); settingsSnapshot.progress?.(job);
      if (job.state !== "uploading") return job;
      let sequence = 0, batch: (readonly string[])[] = [], size = 2;
      const send = async () => { if (!batch.length) return; check(); job = await client.mutate(api.appendReview, { id: job.id, expectedOwner, sequence: sequence++, rows: JSON.stringify(batch) }); check(); settingsSnapshot.progress?.(job); batch = []; size = 2; };
      for (const row of source.rows) {
        const rowSize = new TextEncoder().encode(JSON.stringify(row)).length + 1;
        if (rowSize > 4 * 1024 * 1024 - 2) throw new RangeError("Canonical source row exceeds the chunk limit.");
        if (batch.length >= 500 || size + rowSize > 4 * 1024 * 1024) await send(); batch.push(row); size += rowSize;
      }
      await send(); check(); job = await client.mutate(api.sealReview, { id: job.id, expectedOwner, chunks: sequence }); check(); settingsSnapshot.progress?.(job); return job;
    },

    create: (name, key = crypto.randomUUID()) => client.mutate(api.create, { name, key }), inspect: id => client.query(api.inspect, { id }),
    append: (id, sequence, records) => client.mutate(api.append, { id, sequence, records: JSON.stringify(records) }), seal: (id, chunks) => client.mutate(api.seal, { id, chunks }), step: (id, expectedProcessed) => client.mutate(api.step, { id, expectedProcessed }), retry: id => client.mutate(api.retry, { id }), cancel: id => client.mutate(api.cancel, { id }),
    async run(id, settings = {}) { let job = await service.inspect(id); if (job.review) throw new Error("Preview and accept each reviewable import batch."); while (job.state === "ready" || job.state === "running") { settings.signal?.throwIfAborted(); job = await service.step(id, job.processedRows); settings.progress?.(job); } return job; },
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

/** Review immutable source rows, save mapping/value corrections, and explicitly accept each fenced batch. */
export function mountReviewableImporter<Values = Record<string, unknown>>(container: HTMLElement, client: ReviewableImportClient<Values>, options: { columns: readonly DurableImportColumn<Values>[]; currentUser(): string | null }): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), file = document.createElement("input"), id = document.createElement("input"), status = document.createElement("p"), mappings = document.createElement("div"), rows = document.createElement("div"), previewPanel = document.createElement("pre");
  panel.setAttribute("aria-label", "Reviewable CSV import"); panel.style.maxWidth = "100%"; panel.style.overflowWrap = "anywhere";
  file.type = "file"; file.accept = ".csv,text/csv"; file.setAttribute("aria-label", "Reviewable CSV file"); id.setAttribute("aria-label", "Reviewable import ID to resume"); status.setAttribute("role", "status");
  for (const input of [file, id]) { input.style.maxWidth = "100%"; input.style.boxSizing = "border-box"; }
  previewPanel.style.whiteSpace = "pre-wrap"; previewPanel.style.overflowWrap = "anywhere";
  const mountedOwner = options.currentUser(), initialColumns = structuredClone(options.columns), controls: HTMLButtonElement[] = [], selections = new Map<string, HTMLSelectElement>(), edits = new Map<number, Record<string, unknown>>(), operations = new Map<string, string>();
  let editInputs: HTMLInputElement[] = [];
  let closed = false, busy = false, job: DurableImportJob | undefined, selected: DurableImportPreview<Values> | undefined, nextRow: number | null = null;
  const controller = new AbortController();
  const clear = () => { mappings.replaceChildren(); rows.replaceChildren(); previewPanel.textContent = ""; selections.clear(); edits.clear(); selected = undefined; job = undefined; nextRow = null; };
  const active = () => !closed && Boolean(mountedOwner) && options.currentUser() === mountedOwner;
  const guard = () => { if (!active()) { clear(); if (!closed) status.textContent = "Import account changed; remount to continue."; throw new Error("Import account changed."); } };
  const operation = (value: unknown) => { const fingerprint = JSON.stringify(value); let key = operations.get(fingerprint); if (!key) { if (operations.size >= 100) throw new Error("Reopen this importer before reviewing more changes."); key = crypto.randomUUID(); operations.set(fingerprint, key); } return key; };
  const invalidate = () => { selected = undefined; previewPanel.textContent = ""; };
  const progress = (value: DurableImportJob) => { guard(); job = value; id.value = value.id; status.textContent = `${value.state}: ${value.processedRows}/${value.uploadedRows} processed; ${value.insertedRows} inserted, ${value.review?.updatedRows ?? 0} updated, ${value.skippedRows} skipped. Save this import ID to resume.`; };
  const renderWindow = (window: DurableImportSourceWindow<Values>) => {
    guard(); progress(window.job); invalidate(); mappings.replaceChildren(); rows.replaceChildren(); selections.clear(); edits.clear(); editInputs = []; nextRow = window.nextRow;
    const meta = window.job.review!;
    for (const column of meta.columns) {
      const label = document.createElement("label"), select = document.createElement("select"); label.textContent = `Source for ${column.target} (${column.type}) `; select.setAttribute("aria-label", `Source for ${column.target}`);
      for (const header of meta.headers) { const option = document.createElement("option"); option.value = header; option.textContent = header; select.append(option); }
      select.value = column.source; select.style.maxWidth = "100%"; select.addEventListener("change", invalidate); selections.set(column.target, select); label.append(select); mappings.append(label);
    }
    for (const record of window.rows) {
      const group = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = `Source row ${record.row}`; group.append(legend); group.style.minWidth = "0";
      for (const column of meta.columns) {
        const label = document.createElement("label"), input = document.createElement("input"), corrections = record.corrections as Record<string, unknown>;
        const source = record.source[meta.headers.indexOf(column.source)] ?? ""; label.textContent = `${column.target}: source ${source} `; input.setAttribute("aria-label", `Correction for row ${record.row} ${column.target}`);
        editInputs.push(input); input.value = Object.hasOwn(corrections, column.target) ? String(corrections[column.target] ?? "") : source; input.style.maxWidth = "100%"; input.style.boxSizing = "border-box";
        input.addEventListener("input", () => { invalidate(); const values = edits.get(record.row) ?? {}; let value: unknown = input.value;
          if (column.type === "number" || column.type === "integer") value = input.value.trim() ? Number(input.value) : null;
          else if (column.type === "boolean") value = ["true", "1"].includes(input.value.toLowerCase()) ? true : ["false", "0"].includes(input.value.toLowerCase()) ? false : input.value;
          values[column.target] = value; edits.set(record.row, values);
        }); label.append(input); group.append(label);
      }
      rows.append(group);
    }
  };
  const load = async (startRow?: number) => { const window = await client.sourceWindow(id.value, { startRow, limit: 20 }); guard(); renderWindow(window); };
  const button = (text: string, action: () => Promise<void>) => {
    const node = document.createElement("button"); node.type = "button"; node.textContent = text; controls.push(node);
    node.addEventListener("click", async () => {
      if (closed || busy) return;
      try { guard(); } catch { return; } const restoreFocus = document.activeElement === node; busy = true; controls.forEach(control => { control.disabled = true; }); [file, id, ...editInputs, ...selections.values()].forEach(control => { control.disabled = true; });
      try { await action(); }
      catch (error) { if (!closed) { if (!active()) { clear(); status.textContent = "Import account changed; remount to continue."; } else { if (error && typeof error === "object" && "status" in error && [401, 403, 404].includes(Number(error.status))) clear(); else invalidate(); status.textContent = error instanceof Error ? error.message : "Import interrupted; refresh and retry the same reviewed operation."; } } }
      finally { busy = false; controls.forEach(control => { control.disabled = !active(); }); [file, id, ...editInputs, ...selections.values()].forEach(control => { control.disabled = !active(); }); if (restoreFocus && active() && document.activeElement === document.body) node.focus(); }
    }); return node;
  };
  const upload = button("Stage or resume CSV", async () => {
    const selectedFile = file.files?.[0]; if (!selectedFile) throw new Error("Choose a CSV file."); invalidate();
    progress(await client.uploadReviewableCsv(selectedFile, initialColumns, { id: id.value || undefined, key: operation(["stage", selectedFile.name, selectedFile.size, selectedFile.lastModified, initialColumns]), name: selectedFile.name, signal: controller.signal, progress })); if (job!.state !== "completed" && job!.state !== "cancelled") await load();
  });
  const refreshProgress = button("Refresh import progress", async () => { const value = await client.inspect(id.value); guard(); clear(); progress(value); if (value.state !== "completed" && value.state !== "cancelled") await load(); });
  const refresh = button("Inspect remaining source rows", () => load());
  const next = button("Next source rows", async () => { if (nextRow === null) throw new Error("No further source rows in this page."); await load(nextRow); });
  const saveMapping = button("Save corrected mapping", async () => {
    if (!job?.review) throw new Error("Inspect an import first."); const columns = job.review.columns.map(column => ({ ...column, source: selections.get(column.target)?.value ?? column.source }));
    const revision = job.review.revision; progress(await client.correctMapping(job.id, revision, columns as DurableImportColumn<Values>[], operation(["mapping", job.id, revision, columns]))); await load();
  });
  const saveRows = button("Save row corrections", async () => {
    if (!job?.review || !edits.size) throw new Error("Edit an unprocessed source row first."); const corrections = [...edits].map(([row, values]) => ({ row, values: values as Partial<Values> })), revision = job.review.revision;
    progress(await client.correctRows(job.id, revision, corrections, operation(["rows", job.id, revision, corrections]))); await load();
  });
  const preview = button("Preview next batch", async () => {
    if (edits.size) throw new Error("Save row corrections before previewing."); if (job?.review?.columns.some(column => selections.get(column.target)?.value !== column.source)) throw new Error("Save the corrected mapping before previewing.");
    const value = await client.preview(id.value); guard(); selected = value;
    previewPanel.textContent = value.effects.map(effect => `Row ${effect.row}: ${effect.action}${effect.issue ? ` (${effect.issue})` : ""}\n${effect.before ? `Before: ${JSON.stringify(effect.before)}\n` : ""}${effect.after ? `After: ${JSON.stringify(effect.after)}\n` : ""}`).join("\n");
    status.textContent = `Review ${value.effects.length} rows. Invalid rows must be corrected before any target writes.`;
  });
  const apply = button("Accept reviewed batch", async () => {
    if (!selected) throw new Error("Preview the next batch first."); const value = selected; progress(await client.apply(value, operation(["apply", value]))); invalidate();
    if (job!.state === "completed" || job!.state === "cancelled") { mappings.replaceChildren(); rows.replaceChildren(); edits.clear(); selections.clear(); } else await load();
  });
  const cancel = button("Cancel remaining rows", async () => { const value = await client.cancel(id.value); guard(); clear(); progress(value); });
  id.addEventListener("input", clear);
  panel.append(file, id, upload, refreshProgress, refresh, next, mappings, saveMapping, rows, saveRows, preview, previewPanel, apply, cancel, status); container.append(panel);
  return () => { closed = true; controller.abort(); clear(); panel.remove(); };
}
