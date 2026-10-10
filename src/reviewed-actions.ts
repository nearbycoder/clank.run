import type { Schema } from "./ai.ts";
import { AuthError, authRuntimeDatabase, type AuthRequest, type AuthRuntime } from "./auth.ts";
import type { SQLiteDatabase, ReadDatabase, WriteDatabase, Id, DatabaseSchema } from "./backend.ts";
import { McpToolError, type McpTool } from "./mcp.ts";
import { readJsonRequest, readRequestBytes, requestOriginAllowed, RequestInputError } from "./security.ts";
import { SQLITE_INTERNAL, withReviewedExecution } from "./sqlite-internal.ts";

export interface ReviewedActionContext<DB extends DatabaseSchema<any> = any> { readonly db: ReadDatabase<DB>; readonly auth: AuthRequest<any>; }
export interface ReviewedActionWriteContext<DB extends DatabaseSchema<any> = any> { readonly db: WriteDatabase<DB>; readonly auth: AuthRequest<any>; }
export interface ReviewedRecordChange { readonly table: string; readonly id: string; readonly beforeVersion: number | null; readonly afterVersion: number | null; }
export interface ReviewedApprovalMembership {
  readonly scope: string;
  readonly role: string;
  /** Native membership incarnation/version. Never reuse a removed incarnation. */
  readonly version: string;
  readonly policyVersion: string;
}
export interface ReviewedApprovalQuorum<Preview = any, DB extends DatabaseSchema<any> = any> {
  readonly revision: string;
  readonly minimum: number;
  readonly requiredRoles?: readonly string[];
  readonly separateRequester?: boolean;
  readonly voteTtlMs?: number;
  /** Read current membership through context.db in this same native store. */
  readonly membership: (context: ReviewedActionContext<DB>, plan: ReviewedActionPlan<Preview>) => ReviewedApprovalMembership | null;
}
export interface ReviewedApprovalProgress {
  readonly revision: string;
  readonly minimum: number;
  readonly requiredRoles: readonly string[];
  readonly separateRequester: boolean;
  readonly voteTtlMs: number;
  /** Recorded votes are historical progress, not proof of commit authority. */
  readonly recordedVotes: number;
}
export interface ReviewedAction<Input = any, Preview = any, Output = any, DB extends DatabaseSchema<any> = any> {
  /** Change this revision whenever preview, execution, authorization, or undo semantics change. */
  readonly revision: string;
  /** Opt in only when all preview/authorization data dependencies use context.db. Default: database. */
  readonly previewDependencies?: "records" | "database";
  readonly args: Schema<Input>;
  readonly title: string;
  readonly authorize: (context: ReviewedActionContext<DB>, input: Input) => boolean;
  readonly authorizeApproval: (context: ReviewedActionContext<DB>, plan: ReviewedActionPlan<NoInfer<Preview>>) => boolean;
  readonly approvalQuorum?: ReviewedApprovalQuorum<NoInfer<Preview>, DB>;
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
  readonly quorum?: ReviewedApprovalProgress;
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
  /** Current server admission, repeated inside each guarded read/write transaction. */
  readonly authorizeCaller?: (current: AuthRequest<any>) => undefined;
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
    if (action.approvalQuorum) {
      quorumPolicy(action.approvalQuorum);
      if (authRuntimeDatabase(authRuntime) !== database) throw new TypeError("Approval quorums require auth and membership in the same native database.");
    }
  }
  const retainedQuorum = Boolean(sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_reviewed_quorum_state'").get());
  if (retainedQuorum && sql.prepare('SELECT protocol FROM clank_reviewed_quorum_state WHERE singleton=1').get()?.protocol !== 1) throw new AuthError('QUORUM_PROTOCOL', 'Unsupported retained approval quorum protocol.', 503);
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_reviewed_plans (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, action TEXT NOT NULL, definition TEXT NOT NULL,
    input TEXT NOT NULL, preview TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
    created INTEGER NOT NULL, expires INTEGER NOT NULL, approved_by TEXT, approved_session TEXT)`);
  if (!sql.prepare("PRAGMA table_info(clank_reviewed_plans)").all().some(column => column.name === "approved_session")) sql.exec("ALTER TABLE clank_reviewed_plans ADD COLUMN approved_session TEXT");
  if (!sql.prepare("PRAGMA table_info(clank_reviewed_plans)").all().some(column => column.name === "dependencies")) sql.exec("ALTER TABLE clank_reviewed_plans ADD COLUMN dependencies TEXT");
  if (!sql.prepare("PRAGMA table_info(clank_reviewed_plans)").all().some(column => column.name === "quorum")) sql.exec("ALTER TABLE clank_reviewed_plans ADD COLUMN quorum TEXT");
  sql.exec("CREATE INDEX IF NOT EXISTS clank_reviewed_plans_owner ON clank_reviewed_plans(owner, created)");
  sql.exec("CREATE TABLE IF NOT EXISTS clank_reviewed_receipts (id TEXT PRIMARY KEY, plan TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, receipt TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS clank_reviewed_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, plan TEXT NOT NULL, actor TEXT NOT NULL, transition TEXT NOT NULL, at INTEGER NOT NULL)");
  sql.transaction(() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS clank_reviewed_quorum_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,clock INTEGER NOT NULL);
      INSERT OR IGNORE INTO clank_reviewed_quorum_state VALUES(1,1,0);
      CREATE TABLE IF NOT EXISTS clank_reviewed_votes(plan TEXT NOT NULL,actor TEXT NOT NULL,record TEXT NOT NULL,invalidated INTEGER NOT NULL CHECK(invalidated IN(0,1)),PRIMARY KEY(plan,actor));`);
    const legacyFence="CREATE TRIGGER clank_reviewed_quorum_legacy BEFORE UPDATE OF quorum,approved_session ON clank_reviewed_plans WHEN OLD.quorum IS NOT NULL AND (NEW.quorum IS NOT OLD.quorum OR NEW.approved_session IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Native quorum metadata is immutable and requires all current votes.'); END";
    if (!sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_reviewed_quorum_legacy'").get()) sql.exec(legacyFence);
    if (sql.prepare("SELECT sql FROM sqlite_schema WHERE name='clank_reviewed_quorum_legacy'").get()?.sql!==legacyFence) throw new AuthError('QUORUM_STATE','The native legacy quorum fence does not match its protocol.',503);
    // Retire authority on reopen; retained votes remain historical evidence.
    sql.prepare('UPDATE clank_reviewed_votes SET invalidated=1 WHERE invalidated=0').run();
    if (sql.prepare('SELECT 1 FROM clank_reviewed_votes WHERE invalidated=0 LIMIT 1').get()) throw new AuthError('QUORUM_WRITE','Restart retirement was not stored.',503);
    sql.prepare("UPDATE clank_reviewed_plans SET status='pending',approved_by=NULL,approved_session=NULL WHERE quorum IS NOT NULL AND status='approved'").run();
    if (sql.prepare("SELECT 1 FROM clank_reviewed_plans WHERE quorum IS NOT NULL AND status='approved' LIMIT 1").get()) throw new AuthError('QUORUM_WRITE','Restart plan retirement was not stored.',503);
  });
  let observedClock = Number(sql.prepare('SELECT clock FROM clank_reviewed_quorum_state WHERE singleton=1').get()?.clock);
  if (!Number.isSafeInteger(observedClock) || observedClock < 0 || observedClock>4102444800000) throw new AuthError('QUORUM_STATE','Invalid retained approval clock.',503);
  const time = (persist = false) => {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 946684800000 || now > 4102444800000) throw new AuthError('QUORUM_CLOCK','Approval clock is outside its supported range.',503);
    observedClock = Math.max(observedClock, now);
    if (persist) {
      if (sql.prepare('SELECT protocol FROM clank_reviewed_quorum_state WHERE singleton=1').get()?.protocol !== 1) throw new AuthError('QUORUM_PROTOCOL','Unsupported approval quorum protocol.',503);
      const old = Number(sql.prepare('SELECT clock FROM clank_reviewed_quorum_state WHERE singleton=1').get()?.clock);
      if (!Number.isSafeInteger(old) || old < 0 || old>4102444800000) throw new AuthError('QUORUM_STATE','Invalid retained approval clock.',503);
      observedClock = Math.max(observedClock,old);
      sql.prepare('UPDATE clank_reviewed_quorum_state SET clock=? WHERE singleton=1').run(observedClock);
      if (sql.prepare('SELECT clock FROM clank_reviewed_quorum_state WHERE singleton=1').get()?.clock !== observedClock) throw new AuthError('QUORUM_WRITE','Approval clock was not stored.',503);
    }
    return observedClock;
  };
  const revision = () => Number(sql.prepare("SELECT _value FROM clank_meta WHERE _key = 'global_version'").get()!._value);
  const currentAuth = (initial: AuthRequest<any>): AuthRequest<any> => {
    const current = initial?.session ? authRuntime.refreshSession(initial.session.id) : initial;
    if (!current?.user) throw new AuthError("UNAUTHENTICATED", "Sign in to review actions.", 401);
    if (authRuntime.definition.emailVerification.required) current.requireVerified();
    // OAuth tools pass freshly resolved auth, while server callers must never forge AuthRequest values.
    const row = sql.prepare("SELECT disabled, role, profile FROM clank_auth_users WHERE id = ?").get(current.user.id);
    if (!row || row.disabled !== 0 || row.role !== current.user.role || String(row.profile) !== JSON.stringify(current.user.profile)) throw new AuthError("UNAUTHENTICATED", "Refresh your authentication.", 401);
    if (options.authorizeCaller && sync(options.authorizeCaller(current)) !== undefined) throw new TypeError("Reviewed action admission must complete synchronously without a result.");
    return current;
  };
  const appendEvent = (id: string, actor: string, transition: string, verified = false) => {
    const at = Date.now();
    const result = sql.prepare("INSERT INTO clank_reviewed_events(plan, actor, transition, at) VALUES (?, ?, ?, ?)").run(id, actor, transition, at);
    if (verified) {
      const stored = sql.prepare('SELECT plan,actor,transition,at FROM clank_reviewed_events WHERE sequence=?').get(result.lastInsertRowid);
      if (Number(result.changes)!==1 || stored?.plan!==id || stored.actor!==actor || stored.transition!==transition || stored.at!==at) throw new AuthError('QUORUM_WRITE','Approval event was not stored.',503);
    }
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
      sql.prepare('DELETE FROM clank_reviewed_votes WHERE plan=?').run(row.id);
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
    if (row.quorum != null) {
      const retained = parseQuorum(row.quorum);
      if (!action.approvalQuorum || encode(quorumPolicy(action.approvalQuorum)) !== encode(retained.policy)) throw new AuthError('QUORUM_POLICY_CHANGED','Approval policy changed; request a new preview.',409);
    } else if (action.approvalQuorum) throw new AuthError('QUORUM_POLICY_CHANGED','This plan predates the current quorum policy.',409);
    return action;
  };
  const view = (row: Record<string, unknown>): ReviewedActionPlan => ({
    protocol: "clank-reviewed-action/1", id: String(row.id), action: String(row.action), actionRevision: String(row.definition),
    requestedBy: String(row.owner), createdAt: Number(row.created), expiresAt: Number(row.expires), databaseRevision: Number(row.revision),
    status: Number(row.expires) <= (row.quorum==null?Date.now():Math.max(Date.now(),observedClock)) && (row.status === "pending" || row.status === "approved") ? "expired" : row.status as ReviewedActionPlan["status"],
    approvedBy: row.approved_by === null ? null : String(row.approved_by), preview: JSON.parse(String(row.preview)),
    ...(row.dependencies == null ? {} : { dependencyMode: "records" as const }),
    ...(row.quorum == null ? {} : {quorum: {...parseQuorum(row.quorum).policy,
      recordedVotes: Number(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_votes WHERE plan=? AND invalidated=0').get(row.id)?.n)}}),
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
    if (!action || action.revision!==row.definition) return false;
    if (row.quorum!=null) {
      try {samePolicy(row,membership(row,db,auth));}
      catch (error) {if (error instanceof AuthError && error.status<500) return false;throw error;}
    }
    return sync(action.authorizeApproval(context(db, auth), view(row))) === true;
  };
  const membership = (row: Record<string, unknown>, db: ReadDatabase<any>, auth: AuthRequest<any>): ReviewedApprovalMembership => {
    const action = definition(row), resolver = action.approvalQuorum?.membership;
    if (!resolver) throw new AuthError('QUORUM_POLICY_CHANGED','Approval policy changed; request a new preview.',409);
    const result = sync(resolver(context(db,auth),view(row)));
    if (result === null) throw new AuthError('QUORUM_MEMBERSHIP','Current approval membership is required.',403);
    return approvalMember(result);
  };
  const samePolicy = (row: Record<string, unknown>, member: ReviewedApprovalMembership) => {
    const pinned = parseQuorum(row.quorum);
    if (member.scope !== pinned.scope || member.policyVersion !== pinned.policyVersion) throw new AuthError('QUORUM_POLICY_CHANGED','Approval scope or security policy changed; request a new preview.',409);
    return pinned;
  };
  const dependenciesCurrent = (vote: QuorumVote): boolean => {
    if (sql.readDependenciesChanged(vote.dependencies)) return false;
    if (revision() === vote.revision) return true;
    const first = Number(sql.prepare('SELECT min(revision) AS revision FROM clank_changes').get()?.revision ?? 0);
    if (!first || first > vote.revision + 1) return false;
    return !vote.dependencies.some(dependency => sql.prepare(`SELECT 1 FROM clank_changes WHERE revision>? AND table_name=?${dependency.id===undefined?'':' AND document_id=?'}${dependency.ownerId===undefined?'':' AND owner_id=?'} LIMIT 1`)
      .get(vote.revision,dependency.table,...(dependency.id===undefined?[]:[dependency.id]),...(dependency.ownerId===undefined?[]:[dependency.ownerId])));
  };
  const votes = (row: Record<string, unknown>): Array<{actor: string; record: QuorumVote; auth: AuthRequest<any>}> => {
    const pinned = parseQuorum(row.quorum), at = time(true);
    const rows = sql.prepare('SELECT * FROM clank_reviewed_votes WHERE plan=? ORDER BY actor LIMIT 9').all(row.id);
    if (rows.length>8) throw new AuthError('QUORUM_CAPACITY','Approval vote capacity is exceeded.',503);
    const admitted: Array<{actor: string; record: QuorumVote; auth: AuthRequest<any>}> = [];
    for (const stored of rows) {
      const vote = parseVote(stored.record);
      if (vote.planId!==row.id || vote.actorId!==stored.actor || vote.policy!==String(row.quorum)
        || vote.createdAt<Number(row.created) || vote.expiresAt>Number(row.expires)) throw new AuthError('QUORUM_STATE','Retained approval vote does not match its plan.',503);
      if (stored.invalidated!==0 || vote.expiresAt<=at || !dependenciesCurrent(vote)) continue;
      const refreshed = authRuntime.refreshSession(vote.sessionId);
      if (!refreshed?.user || refreshed.user.id!==vote.actorId || pinned.policy.separateRequester && vote.actorId===row.owner) continue;
      try {
        const current = currentAuth(refreshed);
        const member = sql.readScoped(current.user!.id, db => {
          const result = membership(row,db,current);samePolicy(row,result);
          if (!canReview(row,db,current)) throw new AuthError('QUORUM_MEMBERSHIP','Approval is no longer permitted.',403);
          return result;
        });
        if (encode(member)!==encode(vote.member)) continue;
        admitted.push({actor:vote.actorId,record:vote,auth:current});
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        // Current security/membership denial never contributes to a quorum.
        if (error.status>=500) throw error;
      }
    }
    return admitted;
  };
  const enough = (row: Record<string, unknown>, current: ReturnType<typeof votes>) => {
    const policy = parseQuorum(row.quorum).policy;
    return current.length>=policy.minimum && policy.requiredRoles.every(role=>current.some(vote=>vote.record.member.role===role));
  };
  const assertQuorum = (row: Record<string, unknown>, db: ReadDatabase<any>, caller: AuthRequest<any>) => {
    samePolicy(row,membership(row,db,currentAuth(caller)));
    const current = votes(row);
    if (!enough(row,current)) throw new AuthError('QUORUM_REQUIRED','Current distinct human approvals and required roles are needed.',409);
    return current;
  };
  const canReadOwnPlan = (row: Record<string, unknown>, db: ReadDatabase<any>, auth: AuthRequest<any>) => {
    const action = actions.get(String(row.action));
    if (row.owner !== auth.user!.id || !action || action.revision !== row.definition) return false;
    try {if(row.quorum!=null)samePolicy(row,membership(row,db,auth)); return sync(action.authorize(context(db, auth), action.args.parse(JSON.parse(String(row.input))))) === true; }
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
  const saveReceipt = (receipt: ReviewedActionReceipt, verified = false) => {
    const encoded=encode(receipt), result=sql.prepare("INSERT INTO clank_reviewed_receipts(id, plan, owner, receipt) VALUES (?, ?, ?, ?)").run(receipt.id, receipt.planId, receipt.owner, encoded);
    if (verified) {
      const stored=sql.prepare('SELECT plan,owner,receipt FROM clank_reviewed_receipts WHERE id=?').get(receipt.id);
      if (Number(result.changes)!==1 || stored?.plan!==receipt.planId || stored.owner!==receipt.owner || stored.receipt!==encoded) throw new AuthError('QUORUM_WRITE','Approval receipt was not stored.',503);
    }
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
        const now = action.approvalQuorum ? time(true) : Date.now(), id = `review_${crypto.randomUUID()}`;
        const draft: ReviewedActionPlan = {protocol:'clank-reviewed-action/1',id,action:name,actionRevision:action.revision,requestedBy:auth.user!.id,
          createdAt:now,expiresAt:now+ttl,databaseRevision:revision(),status:'pending',approvedBy:null,preview};
        let quorum: string | null = null;
        if (action.approvalQuorum) {
          const member = sql.readTrackedScoped(auth.user!.id, readDb => approvalMember(sync(action.approvalQuorum!.membership(context(readDb,auth),draft))));
          if (!member.dependencies.length || member.dependencies.length>128) throw new AuthError('QUORUM_DEPENDENCIES','Read bounded native membership through context.db.',422);
          quorum=encode({protocol:1,policy:quorumPolicy(action.approvalQuorum),scope:member.value.scope,policyVersion:member.value.policyVersion});
        }
        const encodedInput=encode(args),encodedPreview=encode(preview);
        const insertion=sql.prepare(`INSERT INTO clank_reviewed_plans(id, owner, action, definition, input, preview, revision, status, created, expires, dependencies,quorum)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?,?)`)
          .run(id, auth.user!.id, name, action.revision, encodedInput, encodedPreview, revision(), now, now + ttl, tracked ? encode([...tracked.dependencies, { table: "__auth", id: auth.user!.id, ownerId: auth.user!.id }]) : null,quorum);
        if (quorum) {
          const stored=get(id);
          if (Number(insertion.changes)!==1 || stored.owner!==auth.user!.id || stored.action!==name || stored.definition!==action.revision
            || stored.input!==encodedInput || stored.preview!==encodedPreview || stored.revision!==revision() || stored.created!==now || stored.expires!==now+ttl
            || stored.status!=='pending' || stored.quorum!==quorum || stored.approved_by!==null || stored.approved_session!==null) throw new AuthError('QUORUM_WRITE','Approval plan was not stored exactly.',503);
        }
        event = appendEvent(id, auth.user!.id, "requested",Boolean(quorum));
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
        if (row.quorum != null) {
          const at=time(true), pinned=parseQuorum(row.quorum);
          if (!['pending','approved'].includes(String(row.status)) || Number(row.expires)<=at) throw new AuthError('APPROVAL_CLOSED','Approval is no longer pending.',409);
          if (pinned.policy.separateRequester && row.owner===auth.user!.id) throw new AuthError('QUORUM_REQUESTER','The requester cannot approve or deny this quorum.',403);
          const tracked=sql.readTrackedScoped(auth.user!.id,readDb=>{
            const member=membership(row,readDb,auth);samePolicy(row,member);
            if (!canReview(row,readDb,auth)) throw new AuthError('FORBIDDEN','Current approval authority is required.',403);
            return member;
          });
          if (!tracked.dependencies.length || tracked.dependencies.length>128) throw new AuthError('QUORUM_DEPENDENCIES','Read bounded native membership through context.db.',422);
          if (decision==='deny') {
            const result=sql.prepare("UPDATE clank_reviewed_plans SET status='denied',approved_by=?,approved_session=NULL WHERE id=? AND status IN('pending','approved')").run(auth.user!.id,id);
            if (Number(result.changes)!==1 || get(id).status!=='denied' || get(id).approved_by!==auth.user!.id || get(id).approved_session!==null) throw new AuthError('QUORUM_WRITE','Approval denial was not stored.',503);
            event=appendEvent(id,auth.user!.id,'denied',true);return view(get(id));
          }
          const current=votes(row),duplicate=current.find(vote=>vote.actor===auth.user!.id);
          if (duplicate) return view(row);
          const prior=sql.prepare('SELECT 1 FROM clank_reviewed_votes WHERE plan=? AND actor=?').get(id,auth.user!.id);
          if (!prior && Number(sql.prepare('SELECT count(*) AS n FROM clank_reviewed_votes WHERE plan=?').get(id)?.n)>=8) throw new AuthError('QUORUM_CAPACITY','This plan has reached its retained vote limit; request a new preview.',409);
          const vote:QuorumVote={protocol:1,planId:id,actorId:auth.user!.id,sessionId:auth.session.id,member:tracked.value,policy:String(row.quorum),createdAt:at,
            expiresAt:Math.min(Number(row.expires),at+pinned.policy.voteTtlMs),revision:revision(),dependencies:[...tracked.dependencies,{table:'__auth',id:auth.user!.id,ownerId:auth.user!.id}]};
          const encoded=encode(vote), result=sql.prepare(`INSERT INTO clank_reviewed_votes(plan,actor,record,invalidated) VALUES(?,?,?,0)
            ON CONFLICT(plan,actor) DO UPDATE SET record=excluded.record,invalidated=0`).run(id,auth.user!.id,encoded);
          const stored=sql.prepare('SELECT record,invalidated FROM clank_reviewed_votes WHERE plan=? AND actor=?').get(id,auth.user!.id);
          if (Number(result.changes)!==1 || stored?.record!==encoded || stored.invalidated!==0) throw new AuthError('QUORUM_WRITE','Approval vote was not stored exactly.',503);
          const admitted=votes(row),ready=enough(row,admitted),status=ready?'approved':'pending';
          const update=sql.prepare('UPDATE clank_reviewed_plans SET status=?,approved_by=?,approved_session=NULL WHERE id=?').run(status,ready?admitted[0]!.actor:null,id);
          const updated=get(id);
          if (Number(update.changes)!==1 || updated.status!==status || updated.approved_by!==(ready?admitted[0]!.actor:null) || updated.approved_session!==null) throw new AuthError('QUORUM_WRITE','Approval progress was not stored.',503);
          event=appendEvent(id,auth.user!.id,'vote.approved',true);return view(updated);
        }
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
        if (row.status !== "approved" || Number(row.expires) <= (row.quorum==null?Date.now():time(true))) throw new AuthError("APPROVAL_REQUIRED", "An unexpired approval is required.", 409);
        if (!previewIsCurrent(row)) throw new AuthError("PREVIEW_STALE", "Data changed after preview; request a new review.", 409);
        let approvedSession:AuthRequest<any> | null;
        if (row.quorum!=null) approvedSession=assertQuorum(row,db,auth)[0]!.auth;
        else {
          const approver = sql.prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(row.approved_by);
          if (!approver || approver.disabled !== 0) throw new AuthError("APPROVAL_REQUIRED", "The approver is no longer active.", 409);
          const refreshed = row.approved_session ? authRuntime.refreshSession(String(row.approved_session)) : null;
          if (refreshed && options.authorizeCaller && sync(options.authorizeCaller(refreshed)) !== undefined) throw new TypeError("Reviewed action admission must complete synchronously without a result.");
          if (!refreshed?.user || refreshed.user.id !== row.approved_by
            || !sql.readScoped(refreshed.user.id, reviewerDb => canReview(row, reviewerDb, refreshed))) throw new AuthError("APPROVAL_REQUIRED", "The approver must review this action again.", 409);
          approvedSession=refreshed;
        }
        if (!approvedSession?.user) throw new AuthError('APPROVAL_REQUIRED','A current human approval is required.',409);
        const changes = new Map<string, ReviewedRecordChange>();
        const output = withReviewedExecution(sql, { requester: auth.user!.id, approver: approvedSession.user.id, planId: id },
          () => JSON.parse(encode(sync(action.execute({ db: recordingWriter(db, changes), auth }, args, JSON.parse(String(row.preview)))))));
        if (row.quorum!=null) {
          const latest=currentAuth(auth);
          if (sync(action.authorize(context(db,latest),args))!==true) throw new AuthError('FORBIDDEN','Requester authority changed during execution.',403);
          assertQuorum(row,db,latest);
        }
        const receipt: ReviewedActionReceipt = { protocol: "clank-action-receipt/1", id: `receipt_${crypto.randomUUID()}`, planId: id,
          action: String(row.action), owner: auth.user!.id, committedAt: Date.now(), committedRevision: revision() + (changes.size ? 1 : 0),
          changes: [...changes.values()], output, compensationAvailable: row.quorum==null && Boolean(action.compensate), compensatedBy: null };
        saveReceipt(receipt,row.quorum!=null);
        const consumed=sql.prepare("UPDATE clank_reviewed_plans SET status = 'consumed' WHERE id = ? AND status = 'approved'").run(id);
        if (row.quorum!=null && (Number(consumed.changes)!==1 || get(id).status!=='consumed')) throw new AuthError('QUORUM_WRITE','Approval consumption was not stored.',503);
        event = appendEvent(id, auth.user!.id, "consumed",row.quorum!=null);
        if (row.quorum!=null) {
          const latest=currentAuth(auth);
          if (sync(action.authorize(context(db,latest),args))!==true) throw new AuthError('FORBIDDEN','Requester authority changed before commit.',403);
          assertQuorum(row,db,latest);
        }
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
        if (row.quorum!=null) throw new AuthError('QUORUM_COMPENSATION_REVIEW','Request a new reviewed quorum action for compensation.',409);
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
        if (type.startsWith("application/x-www-form-urlencoded") && request.headers.get("accept")?.includes("text/html")) {
          return new Response(null, { status: 303, headers: { ...headers, location: prefix } });
        }
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
type QuorumPolicy = Omit<ReviewedApprovalProgress,'recordedVotes'>;
interface QuorumStamp {readonly protocol:1;readonly policy:QuorumPolicy;readonly scope:string;readonly policyVersion:string;}
interface QuorumVote {
  readonly protocol:1;readonly planId:string;readonly actorId:string;readonly sessionId:string;readonly member:ReviewedApprovalMembership;
  readonly policy:string;readonly createdAt:number;readonly expiresAt:number;readonly revision:number;
  readonly dependencies:readonly {readonly table:string;readonly id?:string;readonly ownerId?:string|null}[];
}
function exactQuorum(value:unknown,keys:readonly string[]):Record<string,any> {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype
    || Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))) throw new AuthError('QUORUM_STATE','Invalid approval quorum fields.',503);
  return value as Record<string,any>;
}
function quorumPolicy(value:ReviewedApprovalQuorum):QuorumPolicy {
  if (!value || typeof value.membership!=='function') throw new TypeError('Supply a synchronous native quorum membership resolver.');
  token(value.revision);
  const roles=value.requiredRoles??[],separateRequester=value.separateRequester??true,voteTtlMs=value.voteTtlMs??300000;
  if (!Number.isSafeInteger(value.minimum) || value.minimum<2 || value.minimum>8 || !Array.isArray(roles) || roles.length>value.minimum
    || new Set(roles).size!==roles.length || typeof separateRequester!=='boolean' || !Number.isSafeInteger(voteTtlMs) || voteTtlMs<1000 || voteTtlMs>86400000) throw new TypeError('Invalid approval quorum limits.');
  for (const role of roles) token(role);
  return {revision:value.revision,minimum:value.minimum,requiredRoles:[...roles].sort(),separateRequester,voteTtlMs};
}
function approvalMember(value:unknown):ReviewedApprovalMembership {
  if (value===null) throw new AuthError('QUORUM_MEMBERSHIP','Current native membership is required.',403);
  const raw=exactQuorum(value,['scope','role','version','policyVersion']);
  for (const key of ['scope','role','version','policyVersion']) quorumToken(raw[key]);
  return {scope:raw.scope,role:raw.role,version:raw.version,policyVersion:raw.policyVersion};
}
function parseQuorum(value:unknown):QuorumStamp {
  if (typeof value!=='string' || new TextEncoder().encode(value).byteLength>4096) throw new AuthError('QUORUM_STATE','Invalid retained quorum policy.',503);
  let raw:Record<string,any>;
  try {raw=exactQuorum(JSON.parse(value),['protocol','policy','scope','policyVersion']);}
  catch {throw new AuthError('QUORUM_STATE','Invalid retained quorum policy.',503);}
  if (raw.protocol!==1) throw new AuthError('QUORUM_PROTOCOL','Unsupported retained quorum policy.',503);
  const fields=exactQuorum(raw.policy,['revision','minimum','requiredRoles','separateRequester','voteTtlMs']);
  const policy=quorumPolicy({revision:fields.revision,minimum:fields.minimum,requiredRoles:fields.requiredRoles,
    separateRequester:fields.separateRequester,voteTtlMs:fields.voteTtlMs,membership:()=>null});
  quorumToken(raw.scope);quorumToken(raw.policyVersion);
  if (encode(policy)!==encode(raw.policy)) throw new AuthError('QUORUM_STATE','Invalid retained quorum policy normalization.',503);
  return {protocol:1,policy,scope:raw.scope,policyVersion:raw.policyVersion};
}
function parseVote(value:unknown):QuorumVote {
  if (typeof value!=='string' || new TextEncoder().encode(value).byteLength>65536) throw new AuthError('QUORUM_STATE','Invalid retained approval vote.',503);
  let raw:Record<string,any>;
  try {raw=exactQuorum(JSON.parse(value),['protocol','planId','actorId','sessionId','member','policy','createdAt','expiresAt','revision','dependencies']);}
  catch {throw new AuthError('QUORUM_STATE','Invalid retained approval vote.',503);}
  if (raw.protocol!==1) throw new AuthError('QUORUM_PROTOCOL','Unsupported retained approval vote.',503);
  for (const key of ['planId','actorId','sessionId']) quorumToken(raw[key]);
  const member=approvalMember(raw.member),policy=parseQuorum(raw.policy);
  if (![raw.createdAt,raw.expiresAt,raw.revision].every(Number.isSafeInteger) || raw.createdAt<946684800000 || raw.expiresAt<=raw.createdAt
    || raw.expiresAt>raw.createdAt+policy.policy.voteTtlMs || raw.expiresAt>4102444800000 || raw.revision<0
    || !Array.isArray(raw.dependencies) || !raw.dependencies.length || raw.dependencies.length>129) throw new AuthError('QUORUM_STATE','Invalid retained approval vote bounds.',503);
  for (const dependency of raw.dependencies) {
    if (!dependency || typeof dependency!=='object' || Array.isArray(dependency) || Object.keys(dependency).some(key=>!['table','id','ownerId'].includes(key))) throw new AuthError('QUORUM_STATE','Invalid retained vote dependencies.',503);
    quorumToken(dependency.table);if (dependency.id!==undefined) quorumToken(dependency.id);if (dependency.ownerId!==undefined && dependency.ownerId!==null) quorumToken(dependency.ownerId);
  }
  if (!raw.dependencies.some((dependency:any)=>dependency.table==='__auth' && dependency.id===raw.actorId && dependency.ownerId===raw.actorId)) throw new AuthError('QUORUM_STATE','Native approver identity dependency is missing.',503);
  return {...raw,member} as QuorumVote;
}
function token(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u.test(value)) throw new TypeError("Invalid action identifier."); }
function quorumToken(value:unknown):asserts value is string {if (typeof value!=='string' || !/^[A-Za-z0-9_-][A-Za-z0-9._:/@-]{0,199}$/u.test(value)) throw new AuthError('QUORUM_STATE','Invalid native quorum identifier.',503);}
function sync<T>(value: T): T { if (value && typeof (value as any).then === "function") throw new TypeError("Reviewed callbacks must be synchronous and perform no external side effects."); return value; }
function encode(value: unknown): string { const text = JSON.stringify(value); if (text === undefined || new TextEncoder().encode(text).byteLength > 65536) throw new TypeError("Reviewed values must be JSON up to 64 KiB."); return text; }
export function renderApprovalInbox(plans: readonly ReviewedActionPlan[], prefix = "/__clank/approvals", csrf = ""): string {
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approval inbox</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:auto;padding:1rem;color:#172126;background:#f7f8f9}article{padding:1rem;margin-block:1rem;border:1px solid #a8b4bd;border-radius:.5rem;background:#fff}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;min-height:44px;padding:.5rem 1rem;margin:.25rem}button:focus-visible{outline:3px solid #185cc8;outline-offset:3px}</style>
<main><h1>Approval inbox</h1>${plans.length ? plans.map(plan => `<article><h2>${escape(plan.action)}</h2><p>${escape(plan.status)} · expires ${escape(new Date(plan.expiresAt).toISOString())}</p>${plan.quorum?`<p>${escape(plan.quorum.recordedVotes)} recorded votes · ${escape(plan.quorum.minimum)} distinct approvals required${plan.quorum.requiredRoles.length?` · required roles: ${escape(plan.quorum.requiredRoles.join(', '))}`:''}</p><p>Current membership, roles, sessions and expiry are checked again at commit. New human votes are required after controller restart.${plan.quorum.separateRequester?' The requester cannot vote.':''}</p>`:''}<pre>${escape(JSON.stringify(plan.preview, null, 2))}</pre>${plan.status === "pending" || plan.quorum && plan.status==='approved' ? `<form method="post" action="${escape(prefix)}/decide"><input type="hidden" name="id" value="${escape(plan.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="approve">${plan.quorum?'Approve with my current role':'Approve'}</button><button name="decision" value="deny">Deny</button></form>` : ""}</article>`).join("") : "<p>No approval requests.</p>"}</main></html>`;
}
