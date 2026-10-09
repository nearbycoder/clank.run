import { BackendActionError, createApi, createSyncClient, defineTable, type BackendFunction, type DatabaseSchema, type FunctionTree, type SyncClientOptions, type TableDefinition } from "./backend.ts";
import { s } from "./ai.ts";
type FeatureTables = Record<string, TableDefinition<Record<string, unknown>, Record<string, readonly string[]>, boolean>>;
export type FeatureQuery<Input, Output> = BackendFunction<"query", Input, Output, DatabaseSchema<FeatureTables>>;
export type FeatureMutation<Input, Output> = BackendFunction<"mutation", Input, Output, DatabaseSchema<FeatureTables>>;
/** Preserve typed service metadata when merging the host application's dynamic table map. */
export function featureTables<const Tables extends Record<string, TableDefinition<any, any, any>>>(schema: DatabaseSchema<any> | undefined, tables: Tables): Tables & FeatureTables {
  for (const name of Object.keys(tables)) {
    if (schema && Object.hasOwn(schema.tables, name)) {
      throw new TypeError(`Service metadata table ${name} conflicts with an application table. Rename the application table before enabling this service.`);
    }
  }
  return { ...schema?.tables, ...tables };
}
/** Internal transport adapter for feature services mounted below their own prefix. */
export function featureTransport<Functions extends FunctionTree>(options: SyncClientOptions, fallback: string) {
  const prefix = (options.url ?? fallback).replace(/\/$/u, "");
  const client = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/u, "")}`, init) });
  return { client, api: createApi<Functions>() };
}
export function requireFeatureAccess(allowed: unknown): asserts allowed is true {
  if (allowed !== true) {
    void Promise.resolve(allowed).catch(() => undefined);
    throw new BackendActionError(404, "RESOURCE_NOT_FOUND", "Resource not found or access denied.");
  }
}
export function featureInput(message: string): never { throw new BackendActionError(400, "INVALID_INPUT", message); }

/** Shared strict metadata definitions for import readers and scoped retention writers. */
export function importMetadataTables(reviewable: boolean) {
  return {
    durableImportJobs: defineTable({ key: s.string(), name: s.string(), state: s.enum(["uploading", "ready", "running", "failed", "cancelled", "completed"] as const), uploadedRows: s.number(), processedRows: s.number(), insertedRows: s.number(), skippedRows: s.number(), chunks: s.number(), nextChunk: s.number(), nextOffset: s.number(), issues: s.string(), review: s.default(s.string({ max: 65536 }), "") }).owned().index("by_key", ["key"]),
    durableImportChunks: defineTable({ jobId: s.string(), sequence: s.number(), contents: s.string({ max: 4 * 1024 * 1024 }), rows: s.number(), digest: s.default(s.string(), "") }).owned().index("by_job", ["jobId", "sequence"]),
    ...(reviewable ? {
      durableImportCorrections: defineTable({ jobId: s.string(), row: s.number(), values: s.string({ max: 65536 }) }).owned().index("by_row", ["jobId", "row"]),
      durableImportOperations: defineTable({ key: s.string(), jobId: s.string(), fingerprint: s.string(), result: s.string({ max: 65536 }), targets: s.string({ max: 65536 }), expired: s.default(s.boolean(), false) }).owned().index("by_key", ["key"]),
    } : {}),
  };
}
/** Shared collaboration metadata, including its durable accepted-base floor. */
export function collaborativeMetadataTables(maximum: number) {
  return {
    collaborativeBranches: defineTable({ key: s.string(), documentId: s.string(), name: s.string({ min: 1, max: 100 }), authorId: s.string(), baseRevision: s.number(), baseText: s.string({ max: maximum }), text: s.string({ max: maximum }), status: s.enum(["draft", "proposed", "accepted", "rejected"]), acceptedRevision: s.nullable(s.number()), decidedFromVersion: s.nullable(s.number()), decidedAgainstRevision: s.nullable(s.number()) }).index("by_document", ["documentId"]).index("by_key", ["documentId", "key"]),
    collaborativeDocs: defineTable({ key: s.string({ min: 1, max: 200 }), text: s.string({ max: maximum }), revision: s.number({ integer: true, min: 1 }), retiredThrough: s.default(s.number({ integer: true, min: 0 }), 0) }).index("by_key", ["key"]),
    collaborativeReceipts: defineTable({ documentId: s.string(), userId: s.string(), operationId: s.string(), request: s.string(), revision: s.number() }).index("by_receipt", ["documentId", "userId", "operationId"]),
    collaborativeOperations: defineTable({ documentId: s.string(), revision: s.number(), start: s.number(), deleteCount: s.number(), insert: s.string(), baseLength: s.number() }).index("by_document", ["documentId"]),
  };
}
