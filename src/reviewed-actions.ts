import type { Schema } from "./ai.ts";
import { AuthError, type AuthRequest, type AuthRuntime } from "./auth.ts";
import type { SQLiteDatabase, ReadDatabase, WriteDatabase, Id, DatabaseSchema } from "./backend.ts";
import { McpToolError, type McpTool } from "./mcp.ts";
import { readJsonRequest, readRequestBytes, requestOriginAllowed, RequestInputError } from "./security.ts";
import { SQLITE_INTERNAL, withReviewedExecution } from "./sqlite-internal.ts";

export interface ReviewedActionContext<DB extends DatabaseSchema<any> = any> { readonly db: ReadDatabase<DB>; readonly auth: AuthRequest<any>; }
export interface ReviewedActionWriteContext<DB extends DatabaseSchema<any> = any> { readonly db: WriteDatabase<DB>; readonly auth: AuthRequest<any>; }
export interface ReviewedRecordChange { readonly table: string; readonly id: string; readonly beforeVersion: number | null; readonly afterVersion: number | null; }
export interface ReviewedAction<Input = any, Preview = any, Output = any, DB extends DatabaseSchema<any> = any> {
  /** Change this revision whenever preview, execution, authorization, or undo semantics change. */
  readonly revision: string;
  /** Opt in only when all preview/authorization data dependencies use context.db. Default: database. */
  readonly previewDependencies?: "records" | "database";
  readonly args: Schema<Input>;
  readonly title: string;
  readonly authorize: (context: ReviewedActionContext<DB>, input: Input) => boolean;
  readonly authorizeApproval: (context: ReviewedActionContext<DB>, plan: ReviewedActionPlan<NoInfer<Preview>>) => boolean;
  readonly preview: (context: ReviewedActionContext<DB>, input: Input) => Preview;
  readonly execute: (context: ReviewedActionWriteContext<DB>, input: Input, preview: NoInfer<Preview>) => Output;
  readonly compensate?: (context: ReviewedActionWriteContext<DB>, receipt: ReviewedActionReceipt<NoInfer<Output>>) => unknown;
}
export interface ReviewedActionPlan<Preview = unknown> {
  readonly protocol: "clank-reviewed-action/1";
  readonly id: string;
  readonly action: string;
  readonly actionRevision: string;
  readonly requestedBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly databaseRevision: number;
  readonly dependencyMode?: "records";
  readonly status: "pending" | "approved" | "denied" | "expired" | "consumed";
  readonly approvedBy: string | null;
  readonly preview: Preview;
}
export interface ReviewedActionReceipt<Output = unknown> {
  readonly protocol: "clank-action-receipt/1";
  readonly id: string;
  readonly planId: string;
  readonly action: string;
  readonly owner: string;
  readonly committedAt: number;
  readonly committedRevision: number;
  readonly changes: readonly ReviewedRecordChange[];
  readonly output: Output;
  readonly compensationAvailable: boolean;
  readonly compensatedBy: string | null;
}
export interface ReviewedApprovalEvent { readonly sequence: number; readonly planId: string; readonly actor: string; readonly transition: string; readonly at: number; }
export interface ReviewedActionsOptions {
  readonly actions: Readonly<Record<string, ReviewedAction>>;
  readonly prefix?: string;
  readonly allowedOrigins?: readonly string[];
  readonly ttlMs?: number;
  /** Hard admission bound for durable plans/receipts. Defaults to 10000. */
  readonly maxEntries?: number;
  /** Retain terminal plans, receipts and audit events for this period. Defaults to 30 days. */
  readonly retentionMs?: number;
  /** Best-effort wakeup only. Poll durable inbox/events after process restarts. */
  readonly onChange?: (event: ReviewedApprovalEvent) => void;
}
export interface ReviewedActions {
  readonly tools: readonly McpTool<AuthRequest<any> | null>[];
  handles(request: Request): boolean;
  handle(request: Request): Promise<Response>;
  plan(action: string, input: unknown, auth: AuthRequest<any>): ReviewedActionPlan;
  decide(id: string, decision: "approve" | "deny", auth: AuthRequest<any>): ReviewedActionPlan;
  commit(id: string, auth: AuthRequest<any>): ReviewedActionReceipt;
  compensate(id: string, auth: AuthRequest<any>): ReviewedActionReceipt;
  inbox(auth: AuthRequest<any>): readonly ReviewedActionPlan[];
  receipt(id: string, auth: AuthRequest<any>): ReviewedActionReceipt;
  events(auth: AuthRequest<any>, after?: number): readonly ReviewedApprovalEvent[];
}

/** Infer input, preview and result types from a single reviewed action definition. */
export function defineReviewedAction<Input, Preview, Output>(action: ReviewedAction<Input, Preview, Output>): ReviewedAction<Input, Preview, Output>;
export function defineReviewedAction<DB extends DatabaseSchema<any>, Input, Preview, Output>(schema: DB, action: ReviewedAction<Input, Preview, Output, DB>): ReviewedAction<Input, Preview, Output, DB>;
export function defineReviewedAction(schemaOrAction: DatabaseSchema<any> | ReviewedAction, action?: ReviewedAction): ReviewedAction {
  return Object.freeze({ ...(action ?? schemaOrAction as ReviewedAction) });
}

/** Typed durable review -> approval -> atomic mutation, mounted by openBackend. */
export function openReviewedActions(database: SQLiteDatabase<any>, authRuntime: AuthRuntime<any>, options: ReviewedActionsOptions): ReviewedActions {
  const sql = database[SQLITE_INTERNAL];
  const prefix = options.prefix ?? "/__clank/approvals";
  if (!/^\/[A-Za-z0-9_/-]+$/u.test(prefix) || prefix.endsWith("/") || prefix.includes("//")) throw new TypeError("Invalid approval prefix.");
  const ttl = options.ttlMs ?? 300_000;
  const maximum = options.maxEntries ?? 10000;
  const retention = options.retentionMs ?? 30 * 86_400_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 86_400_000 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100000) throw new TypeError("Invalid approval limits.");
  if (!Number.isSafeInteger(retention) || retention < ttl || retention > 365 * 86_400_000) throw new TypeError("Invalid approval retention.");
  const actions = new Map(Object.entries(options.actions));
  if (!actions.size || actions.size > 100) throw new TypeError("Configure 1–100 reviewed actions.");
  for (const [name, action] of actions) {
    token(name); token(action.revision);
    if (!action.title || action.title.length > 200 || !action.args?.parse || !action.args?.toJSONSchema || !action.authorize || !action.authorizeApproval || !action.preview || !action.execute) throw new TypeError("Invalid reviewed action.");
    if (action.previewDependencies !== undefined && !["records", "database"].includes(action.previewDependencies)) throw new TypeError("Invalid preview dependency mode.");
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_reviewed_plans (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, action TEXT NOT NULL, definition TEXT NOT NULL,
    input TEXT NOT NULL, preview TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
    created INTEGER NOT NULL, expires INTEGER NOT NULL, approved_by TEXT, approved_session TEXT)`);
  if (!sql.prepare("PRAGMA table_info(clank_reviewed_plans)").all().some(column => column.name === "approved_session")) sql.exec("ALTER TABLE clank_reviewed_plans ADD COLUMN approved_session TEXT");
  if (!sql.prepare("PRAGMA table_info(clank_reviewed_plans)").all().some(column => column.name === "dependencies")) sql.exec("ALTER TABLE clank_reviewed_plans ADD COLUMN dependencies TEXT");
  sql.exec("CREATE INDEX IF NOT EXISTS clank_reviewed_plans_owner ON clank_reviewed_plans(owner, created)");
  sql.exec("CREATE TABLE IF NOT EXISTS clank_reviewed_receipts (id TEXT PRIMARY KEY, plan TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, receipt TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS clank_reviewed_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, plan TEXT NOT NULL, actor TEXT NOT NULL, transition TEXT NOT NULL, at INTEGER NOT NULL)");
  const revision = () => Number(sql.prepare("SELECT _value FROM clank_meta WHERE _key = 'global_version'").get()!._value);
  const currentAuth = (initial: AuthRequest<any>): AuthRequest<any> => {
    const current = initial?.session ? authRuntime.refreshSession(initial.session.id) : initial;
    if (!current?.user) throw new AuthError("UNAUTHENTICATED", "Sign in to review actions.", 401);
    if (authRuntime.definition.emailVerification.required) current.requireVerified();
    // OAuth tools pass freshly resolved auth, while server callers must never forge AuthRequest values.
    const row = sql.prepare("SELECT disabled, role, profile FROM clank_auth_users WHERE id = ?").get(current.user.id);
    if (!row || row.disabled !== 0 || row.role !== current.user.role || String(row.profile) !== JSON.stringify(current.user.profile)) throw new AuthError("UNAUTHENTICATED", "Refresh your authentication.", 401);
    return current;
  };
  const appendEvent = (id: string, actor: string, transition: string) => {
    const at = Date.now();
    const result = sql.prepare("INSERT INTO clank_reviewed_events(plan, actor, transition, at) VALUES (?, ?, ?, ?)").run(id, actor, transition, at);
    return { sequence: Number(result.lastInsertRowid), planId: id, actor, transition, at };
  };
  const wake = (event: ReviewedApprovalEvent | undefined) => { if (event) { try { options.onChange?.(event); } catch { /* Durable event remains available. */ } } };
  const maintain = () => sql.transaction(() => {
    const now = Date.now();
    for (const row of sql.prepare("SELECT id FROM clank_reviewed_plans WHERE status IN ('pending', 'approved') AND expires <= ? LIMIT 1000").all(now)) {
      sql.prepare("UPDATE clank_reviewed_plans SET status = 'expired' WHERE id = ?").run(row.id);
      appendEvent(String(row.id), "system", "expired");
    }
    for (const row of sql.prepare("SELECT id FROM clank_reviewed_plans WHERE status IN ('denied', 'expired', 'consumed') AND expires <= ? LIMIT 1000").all(now - retention)) {
      sql.prepare("DELETE FROM clank_reviewed_receipts WHERE plan IN (SELECT 'undo_' || id FROM clank_reviewed_receipts WHERE plan = ?)").run(row.id);
      sql.prepare("DELETE FROM clank_reviewed_receipts WHERE plan = ?").run(row.id);
      sql.prepare("DELETE FROM clank_reviewed_events WHERE plan = ?").run(row.id);
      sql.prepare("DELETE FROM clank_reviewed_plans WHERE id = ?").run(row.id);
    }
  });
  const get = (id: string) => {
    token(id);
    const row = sql.prepare("SELECT * FROM clank_reviewed_plans WHERE id = ?").get(id);
    if (!row) throw new AuthError("APPROVAL_NOT_FOUND", "Approval not found.", 404);
    return row;
  };
  const definition = (row: Record<string, unknown>) => {
    const action = actions.get(String(row.action));
    if (!action || action.revision !== row.definition) throw new AuthError("ACTION_CHANGED", "The action changed; request a new preview.", 409);
    return action;
  };
  const view = (row: Record<string, unknown>): ReviewedActionPlan => ({
    protocol: "clank-reviewed-action/1", id: String(row.id), action: String(row.action), actionRevision: String(row.definition),
    requestedBy: String(row.owner), createdAt: Number(row.created), expiresAt: Number(row.expires), databaseRevision: Number(row.revision),
    status: Number(row.expires) <= Date.now() && (row.status === "pending" || row.status === "approved") ? "expired" : row.status as ReviewedActionPlan["status"],
    approvedBy: row.approved_by === null ? null : String(row.approved_by), preview: JSON.parse(String(row.preview)),
    ...(row.dependencies == null ? {} : { dependencyMode: "records" as const }),
  });
  const previewIsCurrent = (row: Record<string, unknown>): boolean => {
    if (row.dependencies == null) return revision() === row.revision;
    if (definition(row).previewDependencies !== "records") return false;
    const dependencies = JSON.parse(String(row.dependencies)) as Array<{ table: string; id?: string; ownerId?: string }>;
    if (revision() === row.revision || !dependencies.length) return true;
    // A retention gap cannot prove absence of a relevant mutation.
    const earliest = Number(sql.prepare("SELECT min(revision) AS revision FROM clank_changes").get()?.revision ?? 0);
    if (!earliest || earliest > Number(row.revision) + 1) return false;
    return !dependencies.some(dependency => sql.prepare(`SELECT 1 FROM clank_changes WHERE revision > ? AND table_name = ?${dependency.id === undefined ? "" : " AND document_id = ?"}${dependency.ownerId === undefined ? "" : " AND owner_id = ?"} LIMIT 1`)
      .get(row.revision, dependency.table, ...(dependency.id === undefined ? [] : [dependency.id]), ...(dependency.ownerId === undefined ? [] : [dependency.ownerId])));
  };
  const context = (db: ReadDatabase<any>, auth: AuthRequest<any>) => ({ db: reader(db), auth });
  const canReview = (row: Record<string, unknown>, db: ReadDatabase<any>, auth: AuthRequest<any>) => {
    const action = actions.get(String(row.action));
    return Boolean(action && action.revision === row.definition && sync(action.authorizeApproval(context(db, auth), view(row))) === true);
  };
  const canReadOwnPlan = (row: Record<string, unknown>, db: ReadDatabase<any>, auth: AuthRequest<any>) => {
    const action = actions.get(String(row.action));
    if (row.owner !== auth.user!.id || !action || action.revision !== row.definition) return false;
    try { return sync(action.authorize(context(db, auth), action.args.parse(JSON.parse(String(row.input))))) === true; }
    catch { return false; }
  };
  const assertOwner = (row: Record<string, unknown>, auth: AuthRequest<any>) => {
    if (row.owner !== auth.user!.id) throw new AuthError("APPROVAL_NOT_FOUND", "Approval not found.", 404);
  };
  const readReceipt = (id: string, auth: AuthRequest<any>, db: ReadDatabase<any>) => {
    token(id);
    const row = sql.prepare("SELECT plan, receipt FROM clank_reviewed_receipts WHERE id = ? AND owner = ?").get(id, auth.user!.id);
    if (!row) throw new AuthError("RECEIPT_NOT_FOUND", "Receipt not found.", 404);
    // Compensation receipts inherit the original plan's current authorization.
    const original = String(row.plan).startsWith("undo_")
      ? sql.prepare("SELECT plan FROM clank_reviewed_receipts WHERE id = ? AND owner = ?").get(String(row.plan).slice(5), auth.user!.id)
      : row;
    if (!original || String(original.plan).startsWith("undo_")) throw new AuthError("RECEIPT_NOT_FOUND", "Receipt not found.", 404);
    const plan = get(String(original.plan)); definition(plan);
    if (!canReadOwnPlan(plan, db, auth)) throw new AuthError("FORBIDDEN", "This action is no longer permitted.", 403);
    return JSON.parse(String(row.receipt)) as ReviewedActionReceipt;
  };
  const saveReceipt = (receipt: ReviewedActionReceipt) => {
    sql.prepare("INSERT INTO clank_reviewed_receipts(id, plan, owner, receipt) VALUES (?, ?, ?, ?)").run(receipt.id, receipt.planId, receipt.owner, encode(receipt));
  };
  let runtime: ReviewedActions;
  runtime = {
    tools: [],
    plan(name, input, initial) {
      maintain();
      let event: ReviewedApprovalEvent | undefined;
      const result = database.transaction(db => {
        const auth = currentAuth(initial), action = actions.get(name);
        if (!action) throw new AuthError("ACTION_NOT_FOUND", "Reviewed action not found.", 404);
        if (Number(sql.prepare("SELECT COUNT(*) AS count FROM clank_reviewed_plans").get()!.count) >= maximum) throw new AuthError("APPROVAL_CAPACITY", "Approval retention capacity is full.", 503);
        const args = action.args.parse(JSON.parse(encode(input)));
        const previewWith = (readDb: ReadDatabase<any>) => {
          if (sync(action.authorize(context(readDb, auth), args)) !== true) throw new AuthError("FORBIDDEN", "This action is not permitted.", 403);
          return sync(action.preview(context(readDb, auth), args));
        };
        const tracked = action.previewDependencies === "records" ? sql.readTrackedScoped(auth.user!.id, previewWith) : undefined;
        if (tracked && tracked.dependencies.length > 1024) throw new AuthError("PREVIEW_CAPACITY", "Preview exceeds its dependency limit.", 413);
        const preview = tracked ? tracked.value : previewWith(db);
        const now = Date.now(), id = `review_${crypto.randomUUID()}`;
        sql.prepare(`INSERT INTO clank_reviewed_plans(id, owner, action, definition, input, preview, revision, status, created, expires, dependencies)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
          .run(id, auth.user!.id, name, action.revision, encode(args), encode(preview), revision(), now, now + ttl, tracked ? encode([...tracked.dependencies, { table: "__auth", id: auth.user!.id, ownerId: auth.user!.id }]) : null);
        event = appendEvent(id, auth.user!.id, "requested");
        return view(get(id));
      }, { userId: initial?.user?.id ?? null });
      wake(event); return result;
    },
    decide(id, decision, initial) {
      let event: ReviewedApprovalEvent | undefined;
      const result = database.transaction(db => {
        const auth = currentAuth(initial), row = get(id);
        definition(row);
        if (decision !== "approve" && decision !== "deny") throw new TypeError("Choose approve or deny.");
        if (!auth.session || !canReview(row, db, auth)) throw new AuthError("FORBIDDEN", "A signed-in approver must review this action.", 403);
        if (row.status !== "pending" || Number(row.expires) <= Date.now()) throw new AuthError("APPROVAL_CLOSED", "Approval is no longer pending.", 409);
        sql.prepare("UPDATE clank_reviewed_plans SET status = ?, approved_by = ?, approved_session = ? WHERE id = ? AND status = 'pending'").run(decision === "approve" ? "approved" : "denied", auth.user!.id, auth.session.id, id);
        event = appendEvent(id, auth.user!.id, decision === "approve" ? "approved" : "denied");
        return view(get(id));
      }, { userId: initial?.user?.id ?? null });
      wake(event); return result;
    },
    commit(id, initial) {
      let event: ReviewedApprovalEvent | undefined;
      const result = database.transaction(db => {
        const auth = currentAuth(initial), row = get(id); assertOwner(row, auth);
        const action = definition(row), args = action.args.parse(JSON.parse(String(row.input)));
        if (sync(action.authorize(context(db, auth), args)) !== true) throw new AuthError("FORBIDDEN", "This action is no longer permitted.", 403);
        if (row.status === "consumed") {
          const old = sql.prepare("SELECT receipt FROM clank_reviewed_receipts WHERE plan = ? AND owner = ?").get(id, auth.user!.id);
          if (!old) throw new Error("Consumed approval receipt is missing.");
          return JSON.parse(String(old.receipt)) as ReviewedActionReceipt;
        }
        if (row.status !== "approved" || Number(row.expires) <= Date.now()) throw new AuthError("APPROVAL_REQUIRED", "An unexpired approval is required.", 409);
        if (!previewIsCurrent(row)) throw new AuthError("PREVIEW_STALE", "Data changed after preview; request a new review.", 409);
        const approver = sql.prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(row.approved_by);
        if (!approver || approver.disabled !== 0) throw new AuthError("APPROVAL_REQUIRED", "The approver is no longer active.", 409);
        const approvedSession = row.approved_session ? authRuntime.refreshSession(String(row.approved_session)) : null;
        if (!approvedSession?.user || approvedSession.user.id !== row.approved_by
          || !sql.readScoped(approvedSession.user.id, reviewerDb => canReview(row, reviewerDb, approvedSession))) throw new AuthError("APPROVAL_REQUIRED", "The approver must review this action again.", 409);
        const changes = new Map<string, ReviewedRecordChange>();
        const output = withReviewedExecution(sql, { requester: auth.user!.id, approver: approvedSession.user.id, planId: id },
          () => JSON.parse(encode(sync(action.execute({ db: recordingWriter(db, changes), auth }, args, JSON.parse(String(row.preview)))))));
        const receipt: ReviewedActionReceipt = { protocol: "clank-action-receipt/1", id: `receipt_${crypto.randomUUID()}`, planId: id,
          action: String(row.action), owner: auth.user!.id, committedAt: Date.now(), committedRevision: revision() + (changes.size ? 1 : 0),
          changes: [...changes.values()], output, compensationAvailable: Boolean(action.compensate), compensatedBy: null };
        saveReceipt(receipt);
        sql.prepare("UPDATE clank_reviewed_plans SET status = 'consumed' WHERE id = ? AND status = 'approved'").run(id);
        event = appendEvent(id, auth.user!.id, "consumed");
        return receipt;
      }, { userId: initial?.user?.id ?? null });
      wake(event); return result;
    },
    compensate(id, initial) {
      let event: ReviewedApprovalEvent | undefined;
      const result = database.transaction(db => {
        const auth = currentAuth(initial), original = readReceipt(id, auth, db), row = get(original.planId), action = definition(row);
        const args = action.args.parse(JSON.parse(String(row.input)));
        if (sync(action.authorize(context(db, auth), args)) !== true) throw new AuthError("FORBIDDEN", "Compensation is not permitted.", 403);
        if (original.compensatedBy) return readReceipt(original.compensatedBy, auth, db);
        if (!action.compensate || !original.compensationAvailable) throw new AuthError("NO_COMPENSATION", "No compensating action is available.", 409);
        if (revision() !== original.committedRevision || original.changes.some(change => (db.table(change.table).get(change.id as Id<string>)?._version ?? null) !== change.afterVersion)) throw new AuthError("RECEIPT_STALE", "Records changed after execution; reconcile before undoing.", 409);
        const changes = new Map<string, ReviewedRecordChange>();
        const output = JSON.parse(encode(sync(action.compensate({ db: recordingWriter(db, changes), auth }, original))));
        const receipt: ReviewedActionReceipt = { protocol: "clank-action-receipt/1", id: `receipt_${crypto.randomUUID()}`, planId: `undo_${original.id}`,
          action: original.action, owner: original.owner, committedAt: Date.now(), committedRevision: revision() + (changes.size ? 1 : 0),
          changes: [...changes.values()], output, compensationAvailable: false, compensatedBy: null };
        saveReceipt(receipt);
        sql.prepare("UPDATE clank_reviewed_receipts SET receipt = ? WHERE id = ?").run(encode({ ...original, compensationAvailable: false, compensatedBy: receipt.id }), original.id);
        event = appendEvent(original.planId, auth.user!.id, "compensated");
        return receipt;
      }, { userId: initial?.user?.id ?? null });
      wake(event); return result;
    },
    inbox(initial) {
      maintain();
      return database.read(db => {
        const auth = currentAuth(initial);
        // Authorize before returning any preview. Never let an arbitrary user enumerate private plans.
        const own = sql.prepare("SELECT * FROM clank_reviewed_plans WHERE owner = ? ORDER BY created DESC, id DESC LIMIT 100").all(auth.user!.id).filter(row => canReadOwnPlan(row, db, auth));
        const seen = new Set(own.map(row => row.id));
        const rows = [...own];
        for (let offset = 0; offset < Math.min(maximum, 1000) && rows.length < 100; offset += 25) {
          const page = sql.prepare("SELECT * FROM clank_reviewed_plans WHERE owner != ? ORDER BY created DESC, id DESC LIMIT 25 OFFSET ?").all(auth.user!.id, offset);
          for (const row of page) if (!seen.has(row.id) && canReview(row, db, auth)) { rows.push(row); seen.add(row.id); }
          if (page.length < 25) break;
        }
        return rows.sort((a, b) => Number(b.created) - Number(a.created) || String(b.id).localeCompare(String(a.id))).slice(0, 100).map(view);
      }, { userId: initial?.user?.id ?? null });
    },
    receipt(id, initial) { return database.read(db => { const auth = currentAuth(initial); return readReceipt(id, auth, db); }, { userId: initial?.user?.id ?? null }); },
    events(initial, after = 0) {
      maintain();
      if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Invalid event cursor.");
      return database.read(db => {
        const auth = currentAuth(initial);
        return sql.prepare(`SELECT e.*, p.owner FROM clank_reviewed_events e JOIN clank_reviewed_plans p ON p.id = e.plan
          WHERE e.sequence > ? ORDER BY e.sequence LIMIT ?`).all(after, maximum * 5)
          .filter(row => { const plan = get(String(row.plan)); return row.owner === auth.user!.id ? canReadOwnPlan(plan, db, auth) : canReview(plan, db, auth); }).slice(0, 100)
          .map(row => ({ sequence: Number(row.sequence), planId: String(row.plan), actor: String(row.actor), transition: String(row.transition), at: Number(row.at) }));
      }, { userId: initial?.user?.id ?? null });
    },
    handles(request) { const path = new URL(request.url).pathname; return path === prefix || path.startsWith(`${prefix}/`); },
    async handle(request) {
      const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" };
      try {
        if (!requestOriginAllowed(request, { allowedOrigins: options.allowedOrigins })) throw new AuthError("ORIGIN_MISMATCH", "Cross-origin approval request rejected.", 403);
        const url = new URL(request.url), auth = await authRuntime.resolve(request);
        if (!auth.user || !auth.session) throw new AuthError("UNAUTHENTICATED", "Sign in to review actions.", 401);
        if (request.method === "GET" && url.pathname === prefix) {
          const plans = runtime.inbox(auth);
          if (request.headers.get("accept")?.includes("text/html")) return new Response(renderApprovalInbox(plans, prefix, auth.csrfToken ?? ""), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
          return Response.json({ protocol: "clank-approval-inbox/1", plans }, { headers });
        }
        if (request.method === "GET" && url.pathname === `${prefix}/events`) return Response.json({ events: runtime.events(auth, Number(url.searchParams.get("after") ?? 0)) }, { headers });
        if (request.method !== "POST" || url.pathname !== `${prefix}/decide`) return Response.json({ error: "NOT_FOUND" }, { status: 404, headers });
        const type = request.headers.get("content-type") ?? "";
        let input: any;
        if (type.startsWith("application/x-www-form-urlencoded")) {
          // Read bounded bytes before refreshing the session at the decision boundary.
          const raw = new TextDecoder().decode(await readRequestBytes(request, 8192));
          const form = new URLSearchParams(raw); input = Object.fromEntries(form);
          const proof = new Request(request.url, { method: "POST", headers: { origin: request.headers.get("origin") ?? "", "x-clank-csrf": String(input.csrf ?? "") } });
          await authRuntime.verifyCsrf(proof, auth);
        } else { await authRuntime.verifyCsrf(request, auth); input = await readJsonRequest(request, 8192); }
        const plan = runtime.decide(input.id, input.decision, auth);
        return Response.json({ plan }, { headers });
      } catch (error) {
        const known = error instanceof AuthError || error instanceof RequestInputError;
        return Response.json({ error: known ? error.code : "INVALID_APPROVAL", message: known ? error.message : "Approval request rejected." }, { status: known ? error.status : 400, headers });
      }
    },
  };
  const invoke = (handler: () => unknown) => { try { return handler(); } catch (error) { if (error instanceof AuthError) throw new McpToolError(error.code, error.message); throw error; } };
  const identity = (auth: AuthRequest<any> | null) => { if (!auth?.user) throw new AuthError("UNAUTHENTICATED", "Authenticate first.", 401); return auth; };
  const tools: McpTool<AuthRequest<any> | null>[] = [...actions].map(([name, action]) => ({ name: `review.plan.${name}`, description: `Preview ${action.title} and request human approval.`, inputSchema: action.args.toJSONSchema(), requiredScope: "agent:write", invoke(input, auth) { return invoke(() => runtime.plan(name, input, identity(auth))); } }));
  for (const kind of ["commit", "receipt", "compensate"] as const) tools.push({ name: `review.${kind}`, description: `${kind} an approved action by its exact ID.`, requiredScope: kind === "receipt" ? "agent:read" : "agent:write", inputSchema: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"], additionalProperties: false }, invoke(input, auth) { return invoke(() => runtime[kind]((input as { id: string }).id, identity(auth))); } });
  Object.defineProperty(runtime, "tools", { value: Object.freeze(tools) });
  return runtime;
}

/** Copy safe read methods only; preview callbacks cannot accidentally mutate through their context. */
function reader(db: ReadDatabase<any>): ReadDatabase<any> {
  return { table<Name extends string>(name: Name) { const table = db.table(name); return { get: table.get.bind(table), query: table.query.bind(table), collect: table.collect.bind(table), history: table.history.bind(table) }; } };
}
function recordingWriter(db: WriteDatabase<any>, changes: Map<string, ReviewedRecordChange>): WriteDatabase<any> {
  return { table<Name extends string>(name: Name) {
    const table = db.table(name);
    return new Proxy(table, { get(target, property) {
      if (property === "purgeDeleted") return () => { throw new Error("Reviewed actions cannot purge revision history."); };
      const fn = Reflect.get(target, property);
      if (typeof fn !== "function" || !["insert", "patch", "replace", "delete", "restore"].includes(String(property))) return typeof fn === "function" ? fn.bind(target) : fn;
      return (...args: unknown[]) => {
        const before = property === "insert" ? null : table.get(args[0] as Id<Name>)?._version ?? null;
        const result = Reflect.apply(fn, target, args), id = property === "insert" ? result : args[0];
        if (typeof id !== "string") throw new TypeError("A record ID is required.");
        const after = table.get(id as Id<Name>)?._version ?? null, key = `${name}\n${id}`;
        if (before !== after) changes.set(key, { table: name, id, beforeVersion: changes.has(key) ? changes.get(key)!.beforeVersion : before, afterVersion: after });
        if (changes.size > 1000) throw new Error("Reviewed actions may change at most 1000 records.");
        return result;
      };
    } });
  } };
}
function token(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u.test(value)) throw new TypeError("Invalid action identifier."); }
function sync<T>(value: T): T { if (value && typeof (value as any).then === "function") throw new TypeError("Reviewed callbacks must be synchronous and perform no external side effects."); return value; }
function encode(value: unknown): string { const text = JSON.stringify(value); if (text === undefined || new TextEncoder().encode(text).byteLength > 65536) throw new TypeError("Reviewed values must be JSON up to 64 KiB."); return text; }
export function renderApprovalInbox(plans: readonly ReviewedActionPlan[], prefix = "/__clank/approvals", csrf = ""): string {
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approval inbox</title><main><h1>Approval inbox</h1>${plans.length ? plans.map(plan => `<article><h2>${escape(plan.action)}</h2><p>${escape(plan.status)} · expires ${escape(new Date(plan.expiresAt).toISOString())}</p><pre>${escape(JSON.stringify(plan.preview, null, 2))}</pre>${plan.status === "pending" ? `<form method="post" action="${escape(prefix)}/decide"><input type="hidden" name="id" value="${escape(plan.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>` : ""}</article>`).join("") : "<p>No approval requests.</p>"}</main></html>`;
}
