import type { Schema } from "./ai.ts";
import type { DatabaseSchema, ReadDatabase, SQLiteDatabase, WriteDatabase } from "./backend.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";

export interface AgentBudgetAmounts {
  readonly calls: number;
  readonly writes: number;
  readonly records: number;
  readonly externalOperations: number;
}
export interface AgentBudgetIdentity { readonly ownerId: string; readonly principalId: string; }
export interface AgentBudgetContext<Context = unknown, DB extends DatabaseSchema<any> = any> {
  readonly caller: Context;
  readonly identity: AgentBudgetIdentity;
  readonly db: ReadDatabase<DB>;
}
export interface AgentBudgetWriteContext<Context = unknown, DB extends DatabaseSchema<any> = any> extends AgentBudgetContext<Context, DB> {
  readonly db: WriteDatabase<DB>;
  /** Stable identity for transactional outbox work and idempotent provider calls. */
  readonly operationId: string;
}
export interface AgentBudgetAction<Input = any, Output = any, Context = any, DB extends DatabaseSchema<any> = any> {
  /** Change revision when authorization, execution or external-operation costs change. */
  readonly revision: string;
  readonly args: Schema<Input>;
  readonly authorize: (context: AgentBudgetContext<Context, DB>, input: Input) => boolean;
  readonly execute: (context: AgentBudgetWriteContext<Context, DB>, input: Input) => Output;
  /** Accepted transactional outbox operations, never a cost supplied by the client. */
  readonly externalOperations?: number;
}
export interface AgentBudgetGrant {
  readonly protocol: "clank-agent-budget/1";
  readonly id: string;
  readonly ownerId: string;
  readonly principalId: string;
  readonly actions: Readonly<Record<string, string>>;
  readonly limits: AgentBudgetAmounts;
  readonly used: AgentBudgetAmounts;
  readonly remaining: AgentBudgetAmounts;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: "active" | "revoked" | "expired";
  readonly reason: string;
}
export interface AgentBudgetReceipt<Output = unknown> {
  readonly protocol: "clank-agent-budget-receipt/1";
  readonly grantId: string;
  readonly operationId: string;
  readonly action: string;
  readonly actionRevision: string;
  readonly acceptedAt: number;
  readonly cost: AgentBudgetAmounts;
  readonly output: Output;
}
export interface AgentBudgetGrantInput {
  readonly principalId: string;
  readonly actions: readonly string[];
  readonly limits: AgentBudgetAmounts;
  readonly expiresAt: number;
  readonly reason: string;
}
type InputOf<Action> = Action extends AgentBudgetAction<infer Input, any, any, any> ? Input : never;
type OutputOf<Action> = Action extends AgentBudgetAction<any, infer Output, any, any> ? Output : never;
export interface AgentBudgets<Context, Actions extends Record<string, AgentBudgetAction>> {
  grant(input: AgentBudgetGrantInput, caller: Context): AgentBudgetGrant;
  preview(id: string, caller: Context): AgentBudgetGrant;
  revoke(id: string, caller: Context): AgentBudgetGrant;
  execute<Name extends keyof Actions & string>(input: { readonly grantId: string; readonly operationId: string; readonly action: Name; readonly input: InputOf<Actions[Name]> }, caller: Context): AgentBudgetReceipt<OutputOf<Actions[Name]>>;
  /** Retire only this owner's grants after expiry/revocation and the retention window. */
  prune(caller: Context): number;
}
export interface AgentBudgetsOptions<Context, Actions extends Record<string, AgentBudgetAction>> {
  readonly actions: Actions;
  /** Resolve CURRENT trusted credentials, including revocation, on every invocation. Never trust request IDs. */
  readonly identity: (caller: Context) => AgentBudgetIdentity | null;
  readonly authorizeManage: (context: AgentBudgetContext<Context>) => boolean;
  readonly now?: () => number;
  readonly maxGrants?: number;
  readonly maxReceipts?: number;
  readonly maxValueBytes?: number;
  readonly retentionMs?: number;
}
export type AgentBudgetErrorCode = "BUDGET_UNAUTHENTICATED" | "BUDGET_FORBIDDEN" | "BUDGET_NOT_FOUND" | "BUDGET_CLOSED" | "BUDGET_EXCEEDED" | "BUDGET_RETRY_CONFLICT" | "BUDGET_ACTION_CHANGED" | "BUDGET_CAPACITY";
export class AgentBudgetError extends Error {
  readonly code: AgentBudgetErrorCode;
  constructor(code: AgentBudgetErrorCode, message: string) {
    super(message); this.name = "AgentBudgetError"; this.code = code;
  }
}

export function defineAgentBudgetAction<Input, Output, Context = any>(action: AgentBudgetAction<Input, Output, Context>): AgentBudgetAction<Input, Output, Context>;
export function defineAgentBudgetAction<DB extends DatabaseSchema<any>, Input, Output, Context = any>(schema: DB, action: AgentBudgetAction<Input, Output, Context, DB>): AgentBudgetAction<Input, Output, Context, DB>;
export function defineAgentBudgetAction(schemaOrAction: DatabaseSchema<any> | AgentBudgetAction, action?: AgentBudgetAction): AgentBudgetAction {
  return Object.freeze({ ...(action ?? schemaOrAction as AgentBudgetAction) });
}

/** Durable budgets and local application writes share one SQLite write transaction. */
export async function openAgentBudgets<Context, Actions extends Record<string, AgentBudgetAction>>(
  database: SQLiteDatabase<any>, options: AgentBudgetsOptions<Context, Actions>,
): Promise<AgentBudgets<Context, Actions>> {
  const sql = database[SQLITE_INTERNAL];
  const maximumGrants = integer(options.maxGrants ?? 1000, 1, 10000);
  const maximumReceipts = integer(options.maxReceipts ?? 10000, 1, 100000);
  const maximumValue = integer(options.maxValueBytes ?? 16384, 128, 65536);
  const retention = integer(options.retentionMs ?? 86_400_000, 1000, 365 * 86_400_000);
  const actions = new Map(Object.entries(options.actions).map(([name, action]) => {
    token(name); token(action.revision);
    if (!action.args?.parse || typeof action.authorize !== "function" || typeof action.execute !== "function") throw new TypeError("Invalid budget action.");
    return [name, Object.freeze({ ...action, externalOperations: integer(action.externalOperations ?? 0, 0, 1_000_000) })] as const;
  }));
  if (!actions.size || actions.size > 100 || typeof options.identity !== "function" || typeof options.authorizeManage !== "function") throw new TypeError("Invalid budget configuration.");
  const cryptoName = "node:crypto";
  const { createHash } = await import(cryptoName) as typeof import("node:crypto");
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_agent_budget_grants (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, principal TEXT NOT NULL, actions TEXT NOT NULL,
    limits TEXT NOT NULL, used TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
    revoked INTEGER, reason TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS clank_agent_budget_owner ON clank_agent_budget_grants(owner, expires);
  CREATE TABLE IF NOT EXISTS clank_agent_budget_receipts (
    grant_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL,
    PRIMARY KEY (grant_id, operation_id)
  );`);
  const now = () => integer((options.now ?? Date.now)(), 0, Number.MAX_SAFE_INTEGER);
  const resolve = (caller: Context): AgentBudgetIdentity => {
    const value = synchronous(options.identity(caller));
    if (!value) throw new AgentBudgetError("BUDGET_UNAUTHENTICATED", "Current credentials are required.");
    identityToken(value.ownerId); identityToken(value.principalId);
    return Object.freeze({ ownerId: value.ownerId, principalId: value.principalId });
  };
  const transact = <Value>(caller: Context, handler: (context: AgentBudgetContext<Context>, db: WriteDatabase<any>) => Value): Value => {
    const before = resolve(caller);
    return database.transaction(db => {
      const identity = resolve(caller);
      if (identity.ownerId !== before.ownerId || identity.principalId !== before.principalId) throw new AgentBudgetError("BUDGET_FORBIDDEN", "The authenticated principal changed.");
      let active = true;
      const ensureActive = () => { if (!active) throw new Error("Budget context is no longer active."); };
      try { return handler({ caller, identity, db: reader(db, ensureActive) }, db); }
      finally { active = false; }
    }, { userId: before.ownerId });
  };
  const manage = (context: AgentBudgetContext<Context>) => {
    if (synchronous(options.authorizeManage(context)) !== true) throw new AgentBudgetError("BUDGET_FORBIDDEN", "Budget administration is not permitted.");
  };
  const rowFor = (id: string, identity: AgentBudgetIdentity) => {
    token(id);
    const row = sql.prepare("SELECT * FROM clank_agent_budget_grants WHERE id = ? AND owner = ?").get(id, identity.ownerId);
    if (!row) throw new AgentBudgetError("BUDGET_NOT_FOUND", "Budget grant not found.");
    return row;
  };
  const view = (row: Record<string, unknown>, at: number): AgentBudgetGrant => {
    const limits = amounts(JSON.parse(String(row.limits))), used = amounts(JSON.parse(String(row.used)));
    const status = row.revoked != null ? "revoked" : Number(row.expires) <= at ? "expired" : "active";
    const remaining = dimensions(limits, used, (limit, spent) => status === "active" ? Math.max(0, limit - spent) : 0);
    return freeze({ protocol: "clank-agent-budget/1", id: String(row.id), ownerId: String(row.owner), principalId: String(row.principal), actions: JSON.parse(String(row.actions)),
      limits, used, remaining, createdAt: Number(row.created), expiresAt: Number(row.expires), status, reason: String(row.reason) });
  };
  const pruneOwner = (owner: string, at: number) => {
    const rows = sql.prepare("SELECT id FROM clank_agent_budget_grants WHERE owner = ? AND (expires <= ? OR (revoked IS NOT NULL AND revoked <= ?)) LIMIT 500").all(owner, at - retention, at - retention);
    for (const row of rows) {
      sql.prepare("DELETE FROM clank_agent_budget_receipts WHERE grant_id = ?").run(row.id);
      sql.prepare("DELETE FROM clank_agent_budget_grants WHERE id = ? AND owner = ?").run(row.id, owner);
    }
    return rows.length;
  };
  return Object.freeze<AgentBudgets<Context, Actions>>({
    grant(input, caller) {
      identityToken(input.principalId);
      const limits = amounts(input.limits);
      if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 100 || new Set(input.actions).size !== input.actions.length) throw new TypeError("Choose distinct registered budget actions.");
      const revisions: Record<string, string> = Object.create(null);
      for (const name of input.actions) { const action = actions.get(token(name)); if (!action) throw new TypeError("Unknown budget action."); revisions[name] = action.revision; }
      const reason = input.reason;
      if (typeof reason !== "string" || !reason.trim() || reason.length > 500) throw new TypeError("A bounded grant reason is required.");
      const expires = integer(input.expiresAt, 0, Number.MAX_SAFE_INTEGER);
      return transact(caller, context => {
        manage(context); const at = now();
        if (expires <= at || expires - at > 30 * 86_400_000) throw new TypeError("Budget grants expire within 30 days.");
        pruneOwner(context.identity.ownerId, at);
        if (Number(sql.prepare("SELECT count(*) AS n FROM clank_agent_budget_grants").get()!.n) >= maximumGrants) throw new AgentBudgetError("BUDGET_CAPACITY", "Budget grant capacity is full.");
        const id = `budget_${crypto.randomUUID()}`;
        sql.prepare("INSERT INTO clank_agent_budget_grants(id, owner, principal, actions, limits, used, created, expires, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, context.identity.ownerId, input.principalId, JSON.stringify(revisions), JSON.stringify(limits), JSON.stringify(zero()), at, expires, reason);
        return view(rowFor(id, context.identity), at);
      });
    },
    preview(id, caller) {
      return transact(caller, context => {
        const row = rowFor(id, context.identity);
        if (row.principal !== context.identity.principalId) manage(context);
        return view(row, now());
      });
    },
    revoke(id, caller) {
      return transact(caller, context => {
        manage(context); rowFor(id, context.identity); const at = now();
        sql.prepare("UPDATE clank_agent_budget_grants SET revoked = COALESCE(revoked, ?) WHERE id = ? AND owner = ?").run(at, id, context.identity.ownerId);
        return view(rowFor(id, context.identity), at);
      });
    },
    execute(input, caller) {
      token(input.operationId); token(input.action);
      return transact(caller, (context, db) => {
        const row = rowFor(input.grantId, context.identity), at = now();
        if (row.principal !== context.identity.principalId) throw new AgentBudgetError("BUDGET_FORBIDDEN", "This budget belongs to another principal.");
        const grant = view(row, at);
        if (grant.status !== "active") throw new AgentBudgetError("BUDGET_CLOSED", "Budget grant is revoked or expired.");
        const action = actions.get(input.action);
        if (!action || !Object.hasOwn(grant.actions, input.action) || grant.actions[input.action] !== action.revision) throw new AgentBudgetError("BUDGET_ACTION_CHANGED", "Budget action is unavailable or changed.");
        const args = action.args.parse(JSON.parse(encode(input.input, maximumValue)));
        if (synchronous(action.authorize(context, args)) !== true) throw new AgentBudgetError("BUDGET_FORBIDDEN", "Budget action is not permitted.");
        const fingerprint = createHash("sha256").update(encode({ action: input.action, revision: action.revision, input: args }, maximumValue)).digest("hex");
        const old = sql.prepare("SELECT fingerprint, receipt FROM clank_agent_budget_receipts WHERE grant_id = ? AND operation_id = ?").get(input.grantId, input.operationId);
        if (old) {
          if (old.fingerprint !== fingerprint) throw new AgentBudgetError("BUDGET_RETRY_CONFLICT", "The operation ID was already used for different input.");
          return freeze(JSON.parse(String(old.receipt)));
        }
        if (Number(sql.prepare("SELECT count(*) AS n FROM clank_agent_budget_receipts").get()!.n) >= maximumReceipts) throw new AgentBudgetError("BUDGET_CAPACITY", "Budget receipt capacity is full.");
        const cost = { ...zero(), calls: 1, externalOperations: action.externalOperations };
        let active = true, exceeded = false;
        const records = new Set<string>();
        const ensureActive = () => { if (!active) throw new Error("Budget execution context is no longer active."); };
        const check = () => {
          if (keys.some(key => cost[key] > grant.remaining[key])) { exceeded = true; throw new AgentBudgetError("BUDGET_EXCEEDED", "The operation exceeds remaining budget."); }
        };
        check();
        const writer: WriteDatabase<any> = { table<Name extends string>(name: Name) {
          ensureActive(); const table = db.table(name);
          const guarded = new Proxy(table, { get(target, property) {
            const fn = Reflect.get(target, property);
            if (typeof fn !== "function") return fn;
            return (...args: unknown[]) => {
              ensureActive();
              if (property === "purgeDeleted") throw new TypeError("Budget actions cannot purge history.");
              if (!["insert", "patch", "replace", "delete", "restore"].includes(String(property))) return guardedQuery(Reflect.apply(fn, target, args), ensureActive);
              cost.writes++; check();
              const result = Reflect.apply(fn, target, args), id = property === "insert" ? result : args[0];
              if (typeof id !== "string") throw new TypeError("A record ID is required.");
              // Deleted records count too; write invocations have already been admitted.
              if (result != null && result !== false) records.add(`${name}\n${id}`);
              cost.records = records.size; check();
              return result;
            };
          } });
          // Retain only guarded own methods, including when callers inspect descriptors.
          return Object.freeze(Object.fromEntries(Object.keys(table).map(key => [key, Reflect.get(guarded, key)]))) as typeof table;
        } };
        let output: unknown;
        try {
          output = JSON.parse(encode(synchronous(action.execute({ ...context, db: writer, operationId: `${input.grantId}/${input.operationId}` }, args)), maximumValue));
          if (exceeded) throw new AgentBudgetError("BUDGET_EXCEEDED", "The operation exceeds remaining budget.");
        } finally { active = false; }
        const receipt = { protocol: "clank-agent-budget-receipt/1", grantId: input.grantId, operationId: input.operationId, action: input.action, actionRevision: action.revision, acceptedAt: at, cost, output };
        const encodedReceipt = encode(receipt, maximumValue + 4096);
        sql.prepare("UPDATE clank_agent_budget_grants SET used = ? WHERE id = ?").run(JSON.stringify(dimensions(grant.used, cost, (spent, debit) => spent + debit)), input.grantId);
        sql.prepare("INSERT INTO clank_agent_budget_receipts(grant_id, operation_id, fingerprint, receipt) VALUES (?, ?, ?, ?)").run(input.grantId, input.operationId, fingerprint, encodedReceipt);
        return freeze(JSON.parse(encodedReceipt));
      });
    },
    prune(caller) { return transact(caller, context => { manage(context); return pruneOwner(context.identity.ownerId, now()); }); },
  });
}

const keys = ["calls", "writes", "records", "externalOperations"] as const;
function zero(): AgentBudgetAmounts { return { calls: 0, writes: 0, records: 0, externalOperations: 0 }; }
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("Invalid bounded budget number.");
  return value;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value)) throw new TypeError("Invalid budget identifier.");
  return value;
}
// Native authentication IDs are base64url and may begin with '-' or '_'.
// Keep action/revision/operation identifiers on their existing token contract.
function identityToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._:@/-]{0,199}$/u.test(value)) throw new TypeError("Invalid budget identity.");
  return value;
}
function amounts(value: AgentBudgetAmounts): AgentBudgetAmounts {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key as typeof keys[number]))) throw new TypeError("Invalid budget amounts.");
  return Object.freeze(Object.fromEntries(keys.map(key => [key, integer(value[key], 0, 1_000_000)])) as unknown as AgentBudgetAmounts);
}
function dimensions(left: AgentBudgetAmounts, right: AgentBudgetAmounts, combine: (a: number, b: number) => number): AgentBudgetAmounts {
  return Object.freeze(Object.fromEntries(keys.map(key => [key, combine(left[key], right[key])])) as unknown as AgentBudgetAmounts);
}
function synchronous<Value>(value: Value): Value {
  if (value && (typeof value === "object" || typeof value === "function") && typeof Reflect.get(value, "then") === "function") {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError("Budget callbacks must be synchronous; queue external work transactionally.");
  }
  return value;
}
function encode(value: unknown, maximum: number): string {
  const seen = new Set<object>(); let nodes = 0;
  const canonical = (item: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 32) throw new TypeError("Budget value exceeds structural limits.");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item) || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError("Budget values must be finite JSON.");
    seen.add(item);
    const result = Array.isArray(item) ? Array.from(item, child => canonical(child, depth + 1)) : Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(Reflect.get(item, key), depth + 1)]));
    seen.delete(item); return result;
  };
  const json = JSON.stringify(canonical(value, 0));
  if (Buffer.byteLength(json) > maximum) throw new TypeError("Budget value exceeds its byte limit.");
  return json;
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function guardedQuery<Value>(value: Value, ensureActive: () => void): Value {
  if (!value || typeof value !== "object" || typeof Reflect.get(value, "collect") !== "function" || typeof Reflect.get(value, "where") !== "function") return value;
  return Object.freeze(Object.fromEntries(Object.keys(value).map(key => {
    const fn = Reflect.get(value, key);
    return [key, typeof fn === "function" ? (...args: unknown[]) => { ensureActive(); return guardedQuery(Reflect.apply(fn, value, args), ensureActive); } : fn];
  }))) as Value;
}
function reader(db: ReadDatabase<any>, ensureActive: () => void): ReadDatabase<any> {
  return { table<Name extends string>(name: Name) {
    ensureActive(); const table = db.table(name);
    const wrap = <Function extends (...args: any[]) => any>(fn: Function): Function => new Proxy(fn, {
      apply(target, _receiver, args) { ensureActive(); return guardedQuery(Reflect.apply(target, table, args), ensureActive); },
    });
    return { get: wrap(table.get), collect: wrap(table.collect), history: wrap(table.history), query: wrap(table.query) };
  } };
}
