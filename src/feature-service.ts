import { BackendActionError, createApi, createSyncClient, type BackendFunction, type DatabaseSchema, type FunctionTree, type SyncClientOptions, type TableDefinition } from "./backend.ts";
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
  if (allowed !== true) throw new BackendActionError(404, "RESOURCE_NOT_FOUND", "Resource not found or access denied.");
}
export function featureInput(message: string): never { throw new BackendActionError(400, "INVALID_INPUT", message); }
