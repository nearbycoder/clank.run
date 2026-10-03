import { BackendActionError, defineBackend, openBackend, type DatabaseSchema, type Id, type ReadDatabase, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { featureInput, featureTransport, requireFeatureAccess, type FeatureMutation, type FeatureQuery } from "./feature-service.ts";

export interface BulkEditRecord { readonly id: string; readonly version: number; readonly before: Readonly<Record<string, unknown>>; readonly after: Readonly<Record<string, unknown>>; }
export interface BulkEditPreview { readonly changes: Readonly<Record<string, unknown>>; readonly records: readonly BulkEditRecord[]; }
export interface BulkEditOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema: Schema; table: string; fields: readonly string[]; prefix?: string; maxRecords?: number;
  /** Synchronous current ACL check inside the same transaction as reads/writes. */
  authorize?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, record: Readonly<Record<string, unknown>>, operation: "preview" | "apply"): boolean;
}
export interface BulkEditService { handle(request: Request): Promise<Response>; close(): void; }
export interface BulkEditClient { preview(ids: readonly string[], changes: Readonly<Record<string, unknown>>): Promise<BulkEditPreview>; apply(preview: BulkEditPreview): Promise<{ updated: number }>; }

/** Bounded, schema-validated multi-record edits. Any missing, forbidden or stale row aborts the whole batch. */
export async function openBulkEditor<Schema extends DatabaseSchema<any>>(options: BulkEditOptions<Schema>): Promise<BulkEditService>;
export async function openBulkEditor(options: BulkEditOptions): Promise<BulkEditService> {
  const table = options.schema.tables[options.table], maximum = options.maxRecords ?? 200;
  if (!table || !options.fields.length || options.fields.some(field => !Object.hasOwn(table.fields, field)) || new Set(options.fields).size !== options.fields.length || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) throw new TypeError("Declare a table, editable schema fields, and at most 1,000 records.");
  if (table.ownership !== "user" && !options.authorize) throw new TypeError("Unowned tables require an explicit bulk edit authorization policy.");
  const input = (idsJson: string, changesJson: string) => {
    let ids: unknown, changes: any;
    try { ids = JSON.parse(idsJson); changes = JSON.parse(changesJson); } catch { return featureInput("Expected JSON arrays and objects."); }
    if (!Array.isArray(ids) || !ids.length || ids.length > maximum || ids.some(id => typeof id !== "string" || !/^[a-f0-9]{32}$/u.test(id)) || new Set(ids).size !== ids.length) return featureInput("Choose a bounded set of unique record IDs.");
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(field => !options.fields.includes(field))) return featureInput("Choose declared editable fields.");
    return { ids: ids as string[], changes };
  };
  const build = (context: any, ids: readonly string[], changes: Record<string, unknown>, operation: "preview" | "apply"): BulkEditRecord[] => ids.map(id => {
    const record = context.db.table(options.table).get(id);
    requireFeatureAccess(record && (!options.authorize || options.authorize(context, record, operation)));
    const current = Object.fromEntries(Object.keys(table.fields).filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
    const next = table.schema.parse({ ...current, ...changes });
    return { id, version: record._version, before: current, after: next };
  });
  const backend = defineBackend({ schema: options.schema, auth: options.auth }).functions(({ query, mutation }) => ({
    preview: query({ args: { ids: s.string({ max: 65536 }), changes: s.string({ max: 65536 }) }, agent: false, handler: (context, args) => { const { ids, changes } = input(args.ids, args.changes); return { changes, records: build(context, ids, changes, "preview") }; } }),
    apply: mutation({ args: { ids: s.string({ max: 65536 }), changes: s.string({ max: 65536 }), versions: s.string({ max: 65536 }) }, agent: false, handler: (context, args) => {
      const { ids, changes } = input(args.ids, args.changes);
      let versions: unknown; try { versions = JSON.parse(args.versions); } catch { return featureInput("Versions must be an array."); }
      if (!Array.isArray(versions) || versions.length !== ids.length || versions.some(value => !Number.isSafeInteger(value) || value < 1)) return featureInput("Supply the exact reviewed record versions.");
      const records = build(context, ids, changes, "apply");
      for (let index = 0; index < records.length; index++) if (records[index]!.version !== versions[index]) throw new BackendActionError(409, "BULK_PREVIEW_STALE", "Records changed. Review the batch again.");
      for (const record of records) context.db.table(options.table).patch(record.id as Id<string>, changes, { ifVersion: record.version });
      return { updated: records.length };
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/bulk", maxCacheEntries: 0, agent: false });
  return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createBulkEditClient(options: SyncClientOptions = {}): BulkEditClient {
  const { client, api } = featureTransport<{
    preview: FeatureQuery<{ ids: string; changes: string }, BulkEditPreview>;
    apply: FeatureMutation<{ ids: string; changes: string; versions: string }, { updated: number }>;
  }>(options, "/__clank/bulk");
  return { preview: (ids, changes) => client.query(api.preview, { ids: JSON.stringify(ids), changes: JSON.stringify(changes) }), apply: preview => client.mutate(api.apply, { ids: JSON.stringify(preview.records.map(row => row.id)), changes: JSON.stringify(preview.changes), versions: JSON.stringify(preview.records.map(row => row.version)) }) };
}
export function mountBulkEditor(container: HTMLElement, client: BulkEditClient, options: { selection(): readonly string[]; changes(): Readonly<Record<string, unknown>>; applied?(count: number): void }): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), status = document.createElement("p"), output = document.createElement("pre"), preview = document.createElement("button"), apply = document.createElement("button");
  panel.setAttribute("aria-label", "Bulk edit"); status.setAttribute("role", "status"); preview.type = apply.type = "button"; preview.textContent = "Preview selected changes"; apply.textContent = "Apply reviewed changes"; apply.disabled = true;
  let review: BulkEditPreview | null = null, closed = false, busy = false;
  preview.addEventListener("click", async () => { if (busy || closed) return; busy = true; apply.disabled = true; try { const result = await client.preview(options.selection(), options.changes()); if (!closed) { review = result; output.textContent = JSON.stringify(result.records, null, 2); apply.disabled = false; status.textContent = `${result.records.length} records ready for review.`; } } catch { if (!closed) status.textContent = "Cannot preview these records or fields."; } finally { busy = false; } });
  apply.addEventListener("click", async () => { if (!review || busy || closed) return; busy = true; apply.disabled = true; try { const result = await client.apply(review); if (!closed) { status.textContent = `Updated ${result.updated} records.`; review = null; options.applied?.(result.updated); } } catch { if (!closed) status.textContent = "Batch could not be confirmed. Refresh records and preview again."; } finally { busy = false; } });
  panel.append(preview, output, apply, status); container.append(panel); return () => { closed = true; panel.remove(); };
}
