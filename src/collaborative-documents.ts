import { BackendActionError, defineBackend, defineDatabase, openBackend, type DatabaseSchema, type ReadDatabase, type WriteDatabase, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition, AuthRequest, AuthRuntime } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL, isRetentionHeld, type SQLiteInternal } from "./sqlite-internal.ts";
import { featureInput, featureTables, collaborativeMetadataTables, featureTransport, requireFeatureAccess, type FeatureMutation, type FeatureQuery } from "./feature-service.ts";

export interface CollaborativeDocument { readonly id: string; readonly text: string; readonly revision: number; readonly acceptedRevision?: number; }
export interface CollaborativeEdit { readonly documentId: string; readonly operationId: string; readonly baseRevision: number; readonly start: number; readonly deleteCount: number; readonly insert: string; }
export interface DocumentSelection { readonly revision: number; readonly anchor: number; readonly head: number; }
export interface DocumentCursor extends DocumentSelection { readonly id: string; readonly userId: string; readonly expiresAt: number; }
export interface DocumentBranch {
  readonly id: string; readonly documentId: string; readonly name: string; readonly authorId: string;
  readonly version: number; readonly baseRevision: number; readonly baseText: string; readonly text: string;
  readonly status: "draft" | "proposed" | "accepted" | "rejected"; readonly acceptedRevision: number | null;
}
export type DocumentBranchSummary = Omit<DocumentBranch, "baseText" | "text">;
export interface DocumentBranchPreview { readonly branch: DocumentBranch; readonly documentRevision: number; readonly before: string; readonly after: string; }
export interface CollaborativeDocumentsOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCharacters?: number; retainedOperations?: number; retainedReceipts?: number; maxReceipts?: number; cursorTtlMs?: number; maxCursors?: number; maxBranches?: number; maxBranchBytes?: number;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, documentId: string, operation: "read" | "create" | "edit"): boolean;
  authorizeBranchDecision?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, branch: DocumentBranch, decision: "accept" | "reject"): boolean;
}
export interface CollaborativeDocumentsService { handle(request: Request): Promise<Response>; close(): void; }
export interface CollaborativeDocumentsClient {
  read(id: string): Promise<CollaborativeDocument>;
  create(id: string, text?: string): Promise<CollaborativeDocument>;
  edit(operation: CollaborativeEdit): Promise<CollaborativeDocument>;
  setCursor(documentId: string, selection: DocumentSelection): Promise<DocumentCursor>;
  cursors(documentId: string): Promise<readonly DocumentCursor[]>;
  clearCursor(documentId: string): Promise<void>;
  createBranch(documentId: string, id: string, name: string, baseRevision: number): Promise<DocumentBranch>;
  readBranch(documentId: string, id: string): Promise<DocumentBranch>;
  branches(documentId: string): Promise<readonly DocumentBranchSummary[]>;
  saveBranch(documentId: string, id: string, expectedVersion: number, text: string): Promise<DocumentBranch>;
  proposeBranch(documentId: string, id: string, expectedVersion: number): Promise<DocumentBranch>;
  previewBranch(documentId: string, id: string): Promise<DocumentBranchPreview>;
  decideBranch(documentId: string, id: string, expectedVersion: number, decision: "accept" | "reject", documentRevision: number): Promise<DocumentBranch>;
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
  const maximum = options.maxCharacters ?? 200000, retained = options.retainedOperations ?? 1000, retainedReceipts = options.retainedReceipts ?? 10000, maxReceipts = options.maxReceipts ?? 100000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000000 || !Number.isSafeInteger(retained) || retained < 1 || retained > 10000 || !Number.isSafeInteger(retainedReceipts) || retainedReceipts < retained || retainedReceipts > 10000 || !Number.isSafeInteger(maxReceipts) || maxReceipts < retainedReceipts || maxReceipts > 1000000 || typeof options.authorize !== "function") throw new TypeError("Declare bounded document sizes/history/receipts and an authorization policy.");
  const cursorTtl = options.cursorTtlMs ?? 30000, cursorMaximum = options.maxCursors ?? 1000, branchMaximum = options.maxBranches ?? 1000, branchBytes = options.maxBranchBytes ?? 64 * 1024 * 1024;
  if (options.authorizeBranchDecision !== undefined && typeof options.authorizeBranchDecision !== "function") throw new TypeError("Branch decision authorization must be a synchronous policy function.");
  if (!Number.isSafeInteger(cursorTtl) || cursorTtl < 1000 || cursorTtl > 120000 || !Number.isSafeInteger(cursorMaximum) || cursorMaximum < 1 || cursorMaximum > 10000 || !Number.isSafeInteger(branchMaximum) || branchMaximum < 1 || branchMaximum > 10000 || !Number.isSafeInteger(branchBytes) || branchBytes < 1 || branchBytes > 1024 * 1024 * 1024) throw new TypeError("Invalid cursor or branch capacity.");
  if (options.schema?.tables.collaborativeDocs || options.schema?.tables.collaborativeOperations || options.schema?.tables.collaborativeReceipts || options.schema?.tables.collaborativeBranches) throw new TypeError("Collaboration table names are reserved.");
  const cryptoModule = "node:crypto";
  const { createHash } = await import(cryptoModule) as { createHash(algorithm: "sha256"): { update(value: string): { digest(encoding: "hex"): string } } };
  const schema = defineDatabase(featureTables(options.schema, collaborativeMetadataTables(maximum)));
  const output = (row: any, acceptedRevision?: number): CollaborativeDocument => ({ id: row.key, text: row.text, revision: row.revision, ...(acceptedRevision === undefined ? {} : { acceptedRevision }) });
  let native: SQLiteInternal;
  type ReadContext = { auth: AuthRequest<any>; db: ReadDatabase<typeof schema> };
  type WriteContext = { auth: AuthRequest<any>; db: WriteDatabase<typeof schema> };
  let sessionAuth: AuthRuntime<any>;
  const presence = new Map<string, { documentId: string; sessionId: string; cursor: DocumentCursor }>();
  const document = (context: ReadContext, id: string, operation: "read" | "edit" = "read") => {
    requireFeatureAccess(options.authorize(context as any, id, operation));
    const row = context.db.table("collaborativeDocs").query().where("key", id).first(); requireFeatureAccess(Boolean(row)); return row!;
  };
  const history = (context: ReadContext, id: string, base: number, revision: number) => {
    const current = context.db.table("collaborativeDocs").query().where("key", id).first();
    if (!current || base < current.retiredThrough || base > revision || base < revision - retained) throw new BackendActionError(409, "COLLAB_EDIT_CONFLICT", "Required document revision is outside the retained window.");
    const bytes = Number(native.prepare("SELECT coalesce(sum(bytes), 0) AS bytes FROM (SELECT length(CAST(_data AS BLOB)) AS bytes FROM clank_collaborativeOperations WHERE json_extract(_data, '$.documentId') = ? AND json_extract(_data, '$.revision') > ? ORDER BY json_extract(_data, '$.revision') LIMIT ?)").get(id, base, retained)?.bytes ?? 0);
    if (bytes > 16 * 1024 * 1024) throw new BackendActionError(409, "COLLAB_EDIT_CONFLICT", "Rebase history exceeds its byte budget; reload the document and review changes against its current revision.");
    const rows = context.db.table("collaborativeOperations").query().where("documentId", id).where("revision", "gt", base).orderBy("revision", "asc").limit(retained).collect();
    if (rows.length !== revision - base || rows.some((row, index) => row.revision !== base + index + 1)) throw new BackendActionError(409, "COLLAB_EDIT_CONFLICT", "Required edit history is unavailable.");
    return rows;
  };
  const applyEdit = (context: WriteContext, input: CollaborativeEdit): CollaborativeDocument => {
      requireFeatureAccess(options.authorize(context as any, input.documentId, "edit"));
      const table = context.db.table("collaborativeDocs"), operations = context.db.table("collaborativeOperations"), current = table.query().where("key", input.documentId).first(); requireFeatureAccess(Boolean(current));
      const request = createHash("sha256").update(JSON.stringify(input)).digest("hex"), receipt = context.db.table("collaborativeReceipts").query().where("documentId", input.documentId).where("userId", context.auth.user!.id).where("operationId", input.operationId).first();
      if (receipt) { if (receipt.request !== request) throw new BackendActionError(409, "EDIT_KEY_REUSED", "Operation ID was already used for a different edit."); return output(current, receipt.revision); }
      if (input.baseRevision < current!.retiredThrough || input.baseRevision > current!.revision || input.baseRevision < current!.revision - retained) throw new BackendActionError(409, "COLLAB_EDIT_CONFLICT", "Document history changed. Review your changes against the current document.");
      const intervening = history(context, input.documentId, input.baseRevision, current!.revision);
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
      const receipts = context.db.table("collaborativeReceipts"), held = isRetentionHeld(native, "collaboration", input.documentId);
      // Every expired receipt refers to an edit whose original base revision is
      // now outside the rebase window. An exact retry cannot execute again.
      if (!held) for (const expired of receipts.query().where("documentId", input.documentId).where("revision", "lte", revision - retainedReceipts).limit(retainedReceipts).collect()) {
        receipts.delete(expired._id); native.purgeDeletedHistory("collaborativeReceipts", expired._id);
      }
      if (Number(native.prepare("SELECT count(*) AS count FROM clank_collaborativeReceipts").get()?.count ?? 0) >= maxReceipts) throw new BackendActionError(503, "COLLAB_RECEIPT_CAPACITY", "Collaboration receipt capacity reached; retire inactive documents through retention administration.");
      table.patch(current!._id, { text, revision }, { ifVersion: current!._version });
      operations.insert({ documentId: input.documentId, revision, start, deleteCount: input.deleteCount, insert: input.insert, baseLength: current!.text.length });
      receipts.insert({ documentId: input.documentId, userId: context.auth.user!.id, operationId: input.operationId, request, revision });
      if (!held) for (const expired of operations.query().where("documentId", input.documentId).where("revision", "lte", revision - retained).limit(retained).collect()) {
        operations.delete(expired._id); native.purgeDeletedHistory("collaborativeOperations", expired._id);
      }
      return output({ ...current, text, revision }, revision);
  };
  const admitBranchBytes = (additional: number) => {
    const stored = Number(native.prepare("SELECT coalesce(sum(length(CAST(json_extract(_data, '$.baseText') AS BLOB)) + length(CAST(json_extract(_data, '$.text') AS BLOB))), 0) AS bytes FROM clank_collaborativeBranches").get()?.bytes ?? 0);
    if (stored + additional > branchBytes) throw new BackendActionError(503, "BRANCH_CAPACITY", "Branch payload capacity reached; review retention before adding text.");
  };
  const getBranch = (context: ReadContext, documentId: string, id: string) => {
    document(context, documentId);
    const branch = context.db.table("collaborativeBranches").query().where("documentId", documentId).where("key", id).first(); requireFeatureAccess(Boolean(branch)); return branch!;
  };
  type StoredBranch = ReturnType<typeof getBranch>;
  const branchOutput = (row: StoredBranch): DocumentBranch => ({ id: row.key, documentId: row.documentId, name: row.name, authorId: row.authorId, version: row._version, baseRevision: row.baseRevision, baseText: row.baseText, text: row.text, status: row.status, acceptedRevision: row.acceptedRevision });
  const merged = (context: ReadContext, branch: StoredBranch) => {
    const current = document(context, branch.documentId), edit = textEdit(branch.baseText, branch.text);
    let start = edit.start;
    for (const remote of history(context, branch.documentId, branch.baseRevision, current.revision)) {
      if (remote.start + remote.deleteCount <= start) start += remote.insert.length - remote.deleteCount;
      else if (start + edit.deleteCount > remote.start) throw new BackendActionError(409, "BRANCH_MERGE_CONFLICT", "Changes overlap; create a fresh branch and resolve the intended text explicitly.");
    }
    const after = current.text.slice(0, start) + edit.insert + current.text.slice(start + edit.deleteCount);
    if (after.length > maximum) return featureInput("Merged document exceeds its character limit.");
    return { current, edit: { ...edit, start }, after };
  };
  const selectionAt = (context: ReadContext, id: string, selection: DocumentSelection): DocumentSelection => {
    const current = document(context, id), edits = history(context, id, selection.revision, current.revision);
    const baseLength = edits[0]?.baseLength ?? current.text.length;
    if (selection.anchor > baseLength || selection.head > baseLength) return featureInput("Selection exceeds its document revision.");
    const transform = (position: number) => {
      for (const edit of edits) {
        if (position >= edit.start + edit.deleteCount) position += edit.insert.length - edit.deleteCount;
        else if (position >= edit.start) position = edit.start + edit.insert.length;
      }
      return position;
    };
    return { revision: current.revision, anchor: transform(selection.anchor), head: transform(selection.head) };
  };
  const prunePresence = () => { for (const [key, entry] of presence) if (entry.cursor.expiresAt <= Date.now()) presence.delete(key); };
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    setCursor: mutation({ args: { documentId: s.string({ min: 1, max: 200 }), revision: s.number({ integer: true, min: 1 }), anchor: s.number({ integer: true, min: 0 }), head: s.number({ integer: true, min: 0 }) }, agent: false, handler: (context, input) => {
      const selection = selectionAt(context, input.documentId, input); prunePresence();
      const key = JSON.stringify([input.documentId, context.auth.session!.id]), previous = presence.get(key);
      if (!previous && (presence.size >= cursorMaximum || [...presence.values()].filter(entry => entry.documentId === input.documentId).length >= 100)) throw new BackendActionError(503, "CURSOR_CAPACITY", "Document presence capacity reached.");
      const cursor: DocumentCursor = { ...selection, id: previous?.cursor.id ?? `cursor_${crypto.randomUUID()}`, userId: context.auth.user!.id, expiresAt: Date.now() + cursorTtl };
      presence.set(key, { documentId: input.documentId, sessionId: context.auth.session!.id, cursor }); return cursor;
    } }),
    cursors: query({ args: { documentId: s.string({ min: 1, max: 200 }) }, agent: false, handler: (context, { documentId }) => {
      document(context, documentId); prunePresence(); const result: DocumentCursor[] = [];
      for (const [key, entry] of presence) {
        if (entry.documentId !== documentId) continue;
        try {
          const auth = sessionAuth.refreshSession(entry.sessionId);
          if (sessionAuth.definition.emailVerification.required && auth?.user) auth.requireVerified();
          if (!auth?.user || native.readScoped(auth.user.id, db => options.authorize({ db, auth } as any, documentId, "read")) !== true) { presence.delete(key); continue; }
          const selection = selectionAt(context, documentId, entry.cursor);
          entry.cursor = { ...entry.cursor, ...selection }; result.push(entry.cursor);
        } catch { presence.delete(key); }
      }
      return result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    } }),
    clearCursor: mutation({ args: { documentId: s.string({ min: 1, max: 200 }) }, agent: false, handler: (context, { documentId }) => {
      document(context, documentId); presence.delete(JSON.stringify([documentId, context.auth.session!.id])); return null;
    } }),
    createBranch: mutation({ args: { documentId: s.string({ min: 1, max: 200 }), id: s.string({ min: 1, max: 100 }), name: s.string({ min: 1, max: 100 }), baseRevision: s.number({ integer: true, min: 1 }) }, agent: false, handler: (context, input) => {
      const current = document(context, input.documentId, "edit"), table = context.db.table("collaborativeBranches");
      requireFeatureAccess(options.authorize(context as any, input.documentId, "read"));
      const old = table.query().where("documentId", input.documentId).where("key", input.id).first();
      if (old) {
        if (old.authorId !== context.auth.user!.id || old.name !== input.name || old.baseRevision !== input.baseRevision) throw new BackendActionError(409, "BRANCH_ID_REUSED", "Branch ID already belongs to a different proposal.");
        return branchOutput(old);
      }
      if (current.revision !== input.baseRevision) throw new BackendActionError(409, "BRANCH_BASE_STALE", "Create a branch from the current document revision.");
      if (Number(native.prepare("SELECT count(*) AS count FROM clank_collaborativeBranches").get()?.count ?? 0) >= branchMaximum || table.query().where("documentId", input.documentId).limit(100).collect().length >= 100) throw new BackendActionError(503, "BRANCH_CAPACITY", "Branch receipt capacity reached; review retention before creating another branch.");
      admitBranchBytes(new TextEncoder().encode(current.text).length * 2);
      const id = table.insert({ key: input.id, documentId: input.documentId, name: input.name, authorId: context.auth.user!.id, baseRevision: current.revision, baseText: current.text, text: current.text, status: "draft", acceptedRevision: null, decidedFromVersion: null, decidedAgainstRevision: null }); return branchOutput(table.get(id)!);
    } }),
    readBranch: query({ args: { documentId: s.string({ min: 1, max: 200 }), id: s.string({ min: 1, max: 100 }) }, agent: false, handler: (context, { documentId, id }) => branchOutput(getBranch(context, documentId, id)) }),
    branches: query({ args: { documentId: s.string({ min: 1, max: 200 }) }, agent: false, handler: (context, { documentId }) => {
      document(context, documentId);
      return context.db.table("collaborativeBranches").query().where("documentId", documentId).limit(100).collect().map(row => { const { baseText, text, ...summary } = branchOutput(row); return summary; });
    } }),
    saveBranch: mutation({ args: { documentId: s.string({ min: 1, max: 200 }), id: s.string({ min: 1, max: 100 }), expectedVersion: s.number({ integer: true, min: 1 }), text: s.string({ max: maximum }) }, agent: false, handler: (context, input) => {
      document(context, input.documentId, "edit"); const row = getBranch(context, input.documentId, input.id); requireFeatureAccess(row.authorId === context.auth.user!.id);
      if (row.status === "draft" && row._version === input.expectedVersion + 1 && row.text === input.text) return branchOutput(row);
      if (row.status !== "draft" || row._version !== input.expectedVersion) throw new BackendActionError(409, "BRANCH_STALE", "Draft changed or was submitted; reload it before editing.");
      admitBranchBytes(new TextEncoder().encode(input.text).length - new TextEncoder().encode(row.text).length);
      context.db.table("collaborativeBranches").patch(row._id, { text: input.text }, { ifVersion: input.expectedVersion }); return branchOutput(getBranch(context, input.documentId, input.id));
    } }),
    proposeBranch: mutation({ args: { documentId: s.string({ min: 1, max: 200 }), id: s.string({ min: 1, max: 100 }), expectedVersion: s.number({ integer: true, min: 1 }) }, agent: false, handler: (context, input) => {
      document(context, input.documentId, "edit"); const row = getBranch(context, input.documentId, input.id); requireFeatureAccess(row.authorId === context.auth.user!.id);
      if (row.status === "proposed" && row._version === input.expectedVersion + 1) return branchOutput(row);
      if (row.status !== "draft" || row._version !== input.expectedVersion) throw new BackendActionError(409, "BRANCH_STALE", "Draft changed or was already decided.");
      context.db.table("collaborativeBranches").patch(row._id, { status: "proposed" }, { ifVersion: input.expectedVersion }); return branchOutput(getBranch(context, input.documentId, input.id));
    } }),
    previewBranch: query({ args: { documentId: s.string({ min: 1, max: 200 }), id: s.string({ min: 1, max: 100 }) }, agent: false, handler: (context, { documentId, id }) => {
      const row = getBranch(context, documentId, id);
      if (row.status !== "proposed") throw new BackendActionError(409, "BRANCH_CLOSED", "Review a submitted proposal.");
      const result = merged(context, row); return { branch: branchOutput(row), documentRevision: result.current.revision, before: result.current.text, after: result.after };
    } }),
    decideBranch: mutation({ args: { documentId: s.string({ min: 1, max: 200 }), id: s.string({ min: 1, max: 100 }), expectedVersion: s.number({ integer: true, min: 1 }), decision: s.enum(["accept", "reject"]), documentRevision: s.number({ integer: true, min: 1 }) }, agent: false, handler: (context, input) => {
      const current = document(context, input.documentId, "edit"), row = getBranch(context, input.documentId, input.id), status = input.decision === "accept" ? "accepted" : "rejected";
      requireFeatureAccess(!options.authorizeBranchDecision || options.authorizeBranchDecision(context as any, branchOutput(row), input.decision));
      if (row.status === status && row.decidedFromVersion === input.expectedVersion && row.decidedAgainstRevision === input.documentRevision) return branchOutput(row);
      if (row.status !== "proposed" || row._version !== input.expectedVersion || current.revision !== input.documentRevision) throw new BackendActionError(409, "BRANCH_STALE", "Proposal or reviewed document changed; review again.");
      let acceptedRevision: number | null = null;
      if (input.decision === "accept") {
        const result = merged(context, row);
        acceptedRevision = applyEdit(context, { documentId: input.documentId, operationId: `branch:${row._id}`, baseRevision: current.revision, ...result.edit }).acceptedRevision!;
      }
      context.db.table("collaborativeBranches").patch(row._id, { status, acceptedRevision, decidedFromVersion: input.expectedVersion, decidedAgainstRevision: input.documentRevision }, { ifVersion: input.expectedVersion });
      return branchOutput(getBranch(context, input.documentId, input.id));
    } }),
    read: query({ args: { id: s.string({ min: 1, max: 200 }) }, agent: false, handler: (context, { id }) => { requireFeatureAccess(options.authorize(context as any, id, "read")); const row = context.db.table("collaborativeDocs").query().where("key", id).first(); requireFeatureAccess(Boolean(row)); return output(row); } }),
    create: mutation({ args: { id: s.string({ min: 1, max: 200 }), text: s.default(s.string({ max: maximum }), "") }, agent: false, handler: (context, { id, text }) => { requireFeatureAccess(options.authorize(context as any, id, "create")); const table = context.db.table("collaborativeDocs"); if (table.query().where("key", id).first()) throw new BackendActionError(409, "DOCUMENT_EXISTS", "Document already exists."); const key = table.insert({ key: id, text, revision: 1, retiredThrough: 0 }); return output(table.get(key)); } }),
    edit: mutation({ args: { documentId: s.string({ min: 1, max: 200 }), operationId: s.string({ min: 1, max: 100 }), baseRevision: s.number({ integer: true, min: 1 }), start: s.number({ integer: true, min: 0 }), deleteCount: s.number({ integer: true, min: 0 }), insert: s.string({ max: maximum }) }, agent: false, handler: (context, input) => {
      return applyEdit(context, input);
    } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "/__clank/documents", maxCacheEntries: 0, agent: false, maxRequestBytes: Math.max(1024 * 1024, maximum * 6) });
  native = (runtime.database as any)[SQLITE_INTERNAL]; sessionAuth = runtime.auth!;
  return { handle: request => runtime.handle(request), close: () => { presence.clear(); runtime.close(); } };
}
export function createCollaborativeDocumentsClient(options: SyncClientOptions = {}): CollaborativeDocumentsClient {
  const { client, api } = featureTransport<{
    setCursor: FeatureMutation<DocumentSelection & { documentId: string }, DocumentCursor>;
    cursors: FeatureQuery<{ documentId: string }, readonly DocumentCursor[]>;
    clearCursor: FeatureMutation<{ documentId: string }, null>;
    createBranch: FeatureMutation<{ documentId: string; id: string; name: string; baseRevision: number }, DocumentBranch>;
    readBranch: FeatureQuery<{ documentId: string; id: string }, DocumentBranch>;
    branches: FeatureQuery<{ documentId: string }, readonly DocumentBranchSummary[]>;
    saveBranch: FeatureMutation<{ documentId: string; id: string; expectedVersion: number; text: string }, DocumentBranch>;
    proposeBranch: FeatureMutation<{ documentId: string; id: string; expectedVersion: number }, DocumentBranch>;
    previewBranch: FeatureQuery<{ documentId: string; id: string }, DocumentBranchPreview>;
    decideBranch: FeatureMutation<{ documentId: string; id: string; expectedVersion: number; decision: "accept" | "reject"; documentRevision: number }, DocumentBranch>;
    read: FeatureQuery<{ id: string }, CollaborativeDocument>;
    create: FeatureMutation<{ id: string; text: string }, CollaborativeDocument>;
    edit: FeatureMutation<CollaborativeEdit, CollaborativeDocument>;
  }>(options, "/__clank/documents");
  const read = (id: string) => client.query(api.read, { id });
  return {
    setCursor: (documentId, selection) => client.mutate(api.setCursor, { documentId, ...selection }),
    cursors: documentId => client.query(api.cursors, { documentId }),
    async clearCursor(documentId) { await client.mutate(api.clearCursor, { documentId }); },
    createBranch: (documentId, id, name, baseRevision) => client.mutate(api.createBranch, { documentId, id, name, baseRevision }),
    readBranch: (documentId, id) => client.query(api.readBranch, { documentId, id }),
    branches: documentId => client.query(api.branches, { documentId }),
    saveBranch: (documentId, id, expectedVersion, text) => client.mutate(api.saveBranch, { documentId, id, expectedVersion, text }),
    proposeBranch: (documentId, id, expectedVersion) => client.mutate(api.proposeBranch, { documentId, id, expectedVersion }),
    previewBranch: (documentId, id) => client.query(api.previewBranch, { documentId, id }),
    decideBranch: (documentId, id, expectedVersion, decision, documentRevision) => client.mutate(api.decideBranch, { documentId, id, expectedVersion, decision, documentRevision }),
    read, create: (id, text = "") => client.mutate(api.create, { id, text }), edit: operation => client.mutate(api.edit, operation), subscribe(id, listener, intervalMs = 1000) {
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

/** Display an exact review snapshot and submit its branch/document fences. */
export function mountDocumentBranchReview(container: HTMLElement, client: CollaborativeDocumentsClient, documentId: string, branchId: string): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), before = document.createElement("pre"), after = document.createElement("pre"), status = document.createElement("p"), refresh = document.createElement("button"), accept = document.createElement("button"), reject = document.createElement("button");
  panel.setAttribute("aria-label", "Document proposal review"); before.setAttribute("aria-label", "Current document"); after.setAttribute("aria-label", "Proposed document"); status.setAttribute("role", "status"); refresh.textContent = "Review latest proposal"; accept.textContent = "Accept reviewed proposal"; reject.textContent = "Reject reviewed proposal"; refresh.type = accept.type = reject.type = "button"; accept.disabled = reject.disabled = true;
  let closed = false, generation = 0, snapshot: { branch: DocumentBranch; documentRevision: number } | null = null;
  const clear = () => { snapshot = null; before.textContent = after.textContent = ""; accept.disabled = reject.disabled = true; };
  const review = async () => {
    const expected = ++generation; clear(); refresh.disabled = true;
    try {
      const proposal = await client.previewBranch(documentId, branchId);
      if (closed || expected !== generation) return;
      snapshot = proposal; before.textContent = proposal.before; after.textContent = proposal.after; accept.disabled = reject.disabled = false;
      status.textContent = `Reviewing ${proposal.branch.name}, branch version ${proposal.branch.version}, document revision ${proposal.documentRevision}.`;
    } catch (error) {
      if (closed || expected !== generation) return;
      if (error && typeof error === "object" && "code" in error && ["BRANCH_MERGE_CONFLICT", "COLLAB_EDIT_CONFLICT"].includes(String(error.code))) {
        try {
          const [branch, current] = await Promise.all([client.readBranch(documentId, branchId), client.read(documentId)]);
          if (closed || expected !== generation) return;
          if (branch.status === "proposed") { snapshot = { branch, documentRevision: current.revision }; before.textContent = current.text; after.textContent = branch.text; reject.disabled = false; }
          status.textContent = "Proposal requires explicit conflict resolution. Acceptance is blocked; rejection is available.";
        } catch { if (!closed && expected === generation) { clear(); status.textContent = "Proposal unavailable or access revoked."; } }
      } else { clear(); status.textContent = "Proposal unavailable, already decided, or access revoked."; }
    } finally { if (!closed && expected === generation) refresh.disabled = false; }
  };
  const decide = async (decision: "accept" | "reject") => {
    if (!snapshot || closed) return;
    const expected = ++generation, reviewed = snapshot; accept.disabled = reject.disabled = refresh.disabled = true;
    try {
      const result = await client.decideBranch(documentId, branchId, reviewed.branch.version, decision, reviewed.documentRevision);
      if (closed || expected !== generation) return;
      clear(); status.textContent = result.status === "accepted" ? `Proposal accepted at revision ${result.acceptedRevision}.` : "Proposal rejected.";
    } catch {
      if (!closed && expected === generation) { clear(); status.textContent = "Decision unavailable or review changed. Refresh and review the current proposal."; }
    } finally { if (!closed && expected === generation) refresh.disabled = false; }
  };
  refresh.addEventListener("click", () => { void review(); }); accept.addEventListener("click", () => { void decide("accept"); }); reject.addEventListener("click", () => { void decide("reject"); });
  panel.append(before, after, refresh, accept, reject, status); container.append(panel); void review();
  return () => { closed = true; generation++; clear(); panel.remove(); };
}

/** Poll bounded, revision-aware presence. Return null from selection for unsaved text. */
export function mountDocumentCursorPresence(container: HTMLElement, client: CollaborativeDocumentsClient, documentId: string, selection: () => DocumentSelection | null, intervalMs = 1000): () => void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new TypeError("Presence polling interval must be 100–60,000 ms.");
  const document = container.ownerDocument, panel = document.createElement("section"), list = document.createElement("ul"), status = document.createElement("p");
  panel.setAttribute("aria-label", "Document cursors"); status.setAttribute("role", "status"); panel.append(list, status); container.append(panel);
  let closed = false, published = false, timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> = Promise.resolve();
  const poll = async () => {
    try {
      const current = selection();
      if (current) { published = true; await client.setCursor(documentId, current); }
      else if (published) { await client.clearCursor(documentId); published = false; }
      if (closed) return;
      const cursors = await client.cursors(documentId);
      if (closed) return;
      list.replaceChildren();
      for (const cursor of cursors) { const row = document.createElement("li"); row.textContent = `${cursor.userId}: selection ${cursor.anchor}–${cursor.head} at revision ${cursor.revision}`; list.append(row); }
      status.textContent = `${cursors.length} active document cursors.`;
    } catch { if (!closed) { list.replaceChildren(); status.textContent = "Document presence unavailable or access revoked."; } }
    finally { if (!closed) timer = setTimeout(() => { pending = poll(); }, intervalMs); }
  };
  pending = poll();
  return () => { closed = true; clearTimeout(timer); list.replaceChildren(); panel.remove(); void pending.then(() => client.clearCursor(documentId)).catch(() => {}); };
}
