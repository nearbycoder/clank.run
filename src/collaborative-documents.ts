import { BackendActionError, defineBackend, defineDatabase, defineTable, openBackend, type DatabaseSchema, type ReadDatabase, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition, AuthRequest } from "./auth.ts";
import { s } from "./ai.ts";
import { featureInput, featureTables, featureTransport, requireFeatureAccess, type FeatureMutation, type FeatureQuery } from "./feature-service.ts";

export interface CollaborativeDocument { readonly id: string; readonly text: string; readonly revision: number; readonly acceptedRevision?: number; }
export interface CollaborativeEdit { readonly documentId: string; readonly operationId: string; readonly baseRevision: number; readonly start: number; readonly deleteCount: number; readonly insert: string; }
export interface CollaborativeDocumentsOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCharacters?: number; retainedOperations?: number;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, documentId: string, operation: "read" | "create" | "edit"): boolean;
}
export interface CollaborativeDocumentsService { handle(request: Request): Promise<Response>; close(): void; }
export interface CollaborativeDocumentsClient {
  read(id: string): Promise<CollaborativeDocument>;
  create(id: string, text?: string): Promise<CollaborativeDocument>;
  edit(operation: CollaborativeEdit): Promise<CollaborativeDocument>;
  /** Polls through a fresh authorization check; cleanup cancels future deliveries. */
  subscribe(id: string, listener: (document: CollaborativeDocument | null, error?: Error) => void, intervalMs?: number): () => void;
}
export function textEdit(before: string, after: string): { start: number; deleteCount: number; insert: string } {
  let start = 0, end = before.length, nextEnd = after.length;
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return { start, deleteCount: end - start, insert: after.slice(start, nextEnd) };
}
/** Durable text operations with disjoint-edit rebasing, conflict rejection, and transactional replay receipts. */
export async function openCollaborativeDocuments<Schema extends DatabaseSchema<any>>(options: CollaborativeDocumentsOptions<Schema>): Promise<CollaborativeDocumentsService>;
export async function openCollaborativeDocuments(options: CollaborativeDocumentsOptions): Promise<CollaborativeDocumentsService> {
  const maximum = options.maxCharacters ?? 200000, retained = options.retainedOperations ?? 1000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000000 || !Number.isSafeInteger(retained) || retained < 1 || retained > 10000 || typeof options.authorize !== "function") throw new TypeError("Declare bounded document sizes/history and an authorization policy.");
  if (options.schema?.tables.collaborativeDocs || options.schema?.tables.collaborativeOperations || options.schema?.tables.collaborativeReceipts) throw new TypeError("Collaboration table names are reserved.");
  const cryptoModule = "node:crypto";
  const { createHash } = await import(cryptoModule) as { createHash(algorithm: "sha256"): { update(value: string): { digest(encoding: "hex"): string } } };
  const schema = defineDatabase(featureTables(options.schema, {
    collaborativeDocs: defineTable({ key: s.string({ min: 1, max: 200 }), text: s.string({ max: maximum }), revision: s.number({ integer: true, min: 1 }) }).index("by_key", ["key"]),
    collaborativeReceipts: defineTable({ documentId: s.string(), userId: s.string(), operationId: s.string(), request: s.string(), revision: s.number() }).index("by_receipt", ["documentId", "userId", "operationId"]),
    collaborativeOperations: defineTable({ documentId: s.string(), revision: s.number(), start: s.number(), deleteCount: s.number(), insert: s.string(), baseLength: s.number() }).index("by_document", ["documentId"]),
  }));
  const output = (row: any, acceptedRevision?: number): CollaborativeDocument => ({ id: row.key, text: row.text, revision: row.revision, ...(acceptedRevision === undefined ? {} : { acceptedRevision }) });
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    read: query({ args: { id: s.string({ min: 1, max: 200 }) }, agent: false, handler: (context, { id }) => { requireFeatureAccess(options.authorize(context as any, id, "read")); const row = context.db.table("collaborativeDocs").query().where("key", id).first(); requireFeatureAccess(Boolean(row)); return output(row); } }),
    create: mutation({ args: { id: s.string({ min: 1, max: 200 }), text: s.default(s.string({ max: maximum }), "") }, agent: false, handler: (context, { id, text }) => { requireFeatureAccess(options.authorize(context as any, id, "create")); const table = context.db.table("collaborativeDocs"); if (table.query().where("key", id).first()) throw new BackendActionError(409, "DOCUMENT_EXISTS", "Document already exists."); const key = table.insert({ key: id, text, revision: 1 }); return output(table.get(key)); } }),
    edit: mutation({ args: { documentId: s.string({ min: 1, max: 200 }), operationId: s.string({ min: 1, max: 100 }), baseRevision: s.number({ integer: true, min: 1 }), start: s.number({ integer: true, min: 0 }), deleteCount: s.number({ integer: true, min: 0 }), insert: s.string({ max: maximum }) }, agent: false, handler: (context, input) => {
      requireFeatureAccess(options.authorize(context as any, input.documentId, "edit"));
      const table = context.db.table("collaborativeDocs"), operations = context.db.table("collaborativeOperations"), current = table.query().where("key", input.documentId).first(); requireFeatureAccess(Boolean(current));
      const request = createHash("sha256").update(JSON.stringify(input)).digest("hex"), receipt = context.db.table("collaborativeReceipts").query().where("documentId", input.documentId).where("userId", context.auth.user!.id).where("operationId", input.operationId).first();
      if (receipt) { if (receipt.request !== request) throw new BackendActionError(409, "EDIT_KEY_REUSED", "Operation ID was already used for a different edit."); return output(current, receipt.revision); }
      if (input.baseRevision > current!.revision || input.baseRevision < current!.revision - retained) throw new BackendActionError(409, "COLLAB_EDIT_CONFLICT", "Document history changed. Review your changes against the current document.");
      const intervening = operations.query().where("documentId", input.documentId).where("revision", "gt", input.baseRevision).orderBy("revision", "asc").limit(retained + 1).collect();
      if (intervening.length !== current!.revision - input.baseRevision) throw new BackendActionError(409, "COLLAB_EDIT_CONFLICT", "Required edit history is unavailable.");
      const baseLength = intervening[0]?.baseLength ?? current!.text.length;
      if (input.start > baseLength || input.start + input.deleteCount > baseLength) return featureInput("Text edit exceeds its base document.");
      let start = input.start;
      for (const operation of intervening) {
        const remoteEnd = operation.start + operation.deleteCount, end = start + input.deleteCount;
        if (remoteEnd <= start) start += operation.insert.length - operation.deleteCount;
        else if (end <= operation.start) continue;
        else throw new BackendActionError(409, "COLLAB_EDIT_CONFLICT", "Concurrent edits overlap. Choose the intended text explicitly.");
      }
      const text = current!.text.slice(0, start) + input.insert + current!.text.slice(start + input.deleteCount);
      if (text.length > maximum) return featureInput("Document exceeds its character limit.");
      const revision = current!.revision + 1;
      table.patch(current!._id, { text, revision }, { ifVersion: current!._version });
      operations.insert({ documentId: input.documentId, revision, start, deleteCount: input.deleteCount, insert: input.insert, baseLength: current!.text.length });
      context.db.table("collaborativeReceipts").insert({ documentId: input.documentId, userId: context.auth.user!.id, operationId: input.operationId, request, revision });
      for (const expired of operations.query().where("documentId", input.documentId).where("revision", "lte", revision - retained).limit(retained + 1).collect()) operations.delete(expired._id);
      return output({ ...current, text, revision }, revision);
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/documents", maxCacheEntries: 0, agent: false, maxRequestBytes: Math.max(1024 * 1024, maximum * 6) });
  return { handle: request => runtime.handle(request), close: () => runtime.close() };
}
export function createCollaborativeDocumentsClient(options: SyncClientOptions = {}): CollaborativeDocumentsClient {
  const { client, api } = featureTransport<{
    read: FeatureQuery<{ id: string }, CollaborativeDocument>;
    create: FeatureMutation<{ id: string; text: string }, CollaborativeDocument>;
    edit: FeatureMutation<CollaborativeEdit, CollaborativeDocument>;
  }>(options, "/__clank/documents");
  const read = (id: string) => client.query(api.read, { id });
  return { read, create: (id, text = "") => client.mutate(api.create, { id, text }), edit: operation => client.mutate(api.edit, operation), subscribe(id, listener, intervalMs = 1000) {
    if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new TypeError("Polling interval must be 100–60,000 ms.");
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined, revision = -1;
    const poll = async () => { try { const document = await read(id); if (!closed && document.revision !== revision) { revision = document.revision; listener(document); } } catch (error) { if (!closed) { revision = -1; listener(null, error instanceof Error ? error : new Error("Document unavailable.")); } } finally { if (!closed) timer = setTimeout(() => { void poll(); }, intervalMs); } };
    void poll(); return () => { closed = true; clearTimeout(timer); };
  } };
}
export function mountCollaborativeEditor(container: HTMLElement, client: CollaborativeDocumentsClient, documentId: string): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), editor = document.createElement("textarea"), status = document.createElement("p"), save = document.createElement("button"), reload = document.createElement("button"), rebase = document.createElement("button"), serverText = document.createElement("pre");
  panel.setAttribute("aria-label", "Shared document editor"); editor.setAttribute("aria-label", "Document text"); status.setAttribute("role", "status"); save.type = reload.type = rebase.type = "button"; save.textContent = "Save shared edit"; reload.textContent = "Use current server text"; save.disabled = true; rebase.textContent = "Keep my text using latest revision"; serverText.setAttribute("aria-label", "Current server document");
  let permissionGeneration = 0;
  let base: CollaborativeDocument | null = null, remote: CollaborativeDocument | null = null, dirty = false, closed = false, busy = false, pending: CollaborativeEdit | null = null;
  editor.addEventListener("input", () => { dirty = true; pending = null; save.disabled = !base; });
  const unsubscribe = client.subscribe(documentId, (next, error) => { if (closed) return; if (!next) { permissionGeneration++; base = null; remote = null; dirty = false; pending = null; editor.value = ""; serverText.textContent = ""; editor.disabled = true; save.disabled = true; status.textContent = error?.message ?? "Document unavailable."; return; } remote = next; serverText.textContent = next.text; editor.disabled = false; if (!dirty && !busy) { base = next; editor.value = next.text; } else if (base && next.revision !== base.revision) status.textContent = "Another editor changed this document. Saving rebases separate changes and reports overlaps."; });
  reload.addEventListener("click", () => { if (!remote || busy) return; base = remote; dirty = false; pending = null; editor.value = remote.text; save.disabled = true; status.textContent = "Loaded current server text."; });
  rebase.addEventListener("click", () => { if (!remote || busy) return; base = remote; pending = null; dirty = editor.value !== remote.text; save.disabled = !dirty; status.textContent = "Your next save will apply the displayed local text against the current server revision."; });
  save.addEventListener("click", async () => { if (!base || busy || closed) return; const expectedPermission = permissionGeneration; busy = true; save.disabled = true; editor.disabled = true; pending ??= { documentId, operationId: crypto.randomUUID(), baseRevision: base.revision, ...textEdit(base.text, editor.value) }; try { const next = await client.edit(pending); if (!closed && expectedPermission === permissionGeneration) { base = remote = next; dirty = false; pending = null; editor.value = next.text; status.textContent = `Saved revision ${next.revision}.`; } } catch { if (!closed) status.textContent = "Could not save. Your text is retained; retry the same edit or explicitly use server text to resolve overlap."; } finally { busy = false; if (!closed) { editor.disabled = !base; save.disabled = !dirty || !base; } } });
  panel.append(editor, save, serverText, reload, rebase, status); container.append(panel); return () => { closed = true; unsubscribe(); panel.remove(); };
}
