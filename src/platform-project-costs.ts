import type { SQLiteInternal } from "./sqlite-internal.ts";
import type { ProjectCostMeter, ProjectCostRateCard, ProjectCostMeasurement, ProjectCostSnapshot, ProjectCostPolicy, ProjectCostOverride, ProjectCostReport } from "./project-costs.ts";

export interface PlatformProjectCostOptions {
  readonly rateCards: readonly ProjectCostRateCard[];
  /** Read-only trusted host collector. Browser input never supplies measurements. */
  readonly measure: (input: { readonly projectId: string; readonly periodStartedAt: number; readonly periodEndsAt: number; readonly asOf: number; readonly signal: AbortSignal }) => Promise<ProjectCostMeasurement>;
  readonly timeoutMs?: number;
  readonly maxObservations?: number;
  readonly maxReceipts?: number;
  readonly maxPolicies?: number;
}
export interface ProjectCostAuthority {
  readonly actorId: string;
  /** Synchronous current project scope; admin also requires a fresh human session. */
  authorize(admin: boolean): void;
  audit(action: string, metadata: Record<string, unknown>): void;
}
export class ProjectCostError extends Error {
  declare readonly status: number;
  declare readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "ProjectCostError"; this.status = status; this.code = code; }
}
const meters: readonly ProjectCostMeter[] = ["storageByteMilliseconds", "transferBytes", "runtimeMilliseconds"];
const fail = (status: number, code: string, message: string): never => { throw new ProjectCostError(status, code, message); };
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(422, "COST_INPUT", "Choose a supported cost number.");
  return Number(value);
};
const opaque = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(value)) fail(422, "COST_INPUT", "Choose an opaque cost identifier.");
  return value as string;
};
const decimal = (value: unknown): string => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,35})$/u.test(value)) fail(422, "COST_INPUT", "Choose a bounded exact nonnegative quantity.");
  return value as string;
};
const currency = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) fail(422, "COST_INPUT", "Choose an explicit currency code.");
  return value as string;
};
const reason = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) fail(422, "COST_INPUT", "Record a reason up to 1024 UTF-8 bytes.");
  return value as string;
};
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(422, "COST_INPUT", "Choose the exact supported cost fields.");
  return value as Record<string, unknown>;
};
const monthStart = (at: number): number => { const date = new Date(at); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); };
const monthEnd = (at: number): number => { const date = new Date(at); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); };
const monthKey = (at: number): string => new Date(at).toISOString().slice(0, 7);
function period(value: unknown, now: number): { key: string; start: number; end: number } {
  if (typeof value !== "string" || !/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/u.test(value)) fail(422, "COST_INPUT", "Choose a supported UTC month.");
  const start = Date.parse(`${value}-01T00:00:00.000Z`), latest = monthStart(now), date = new Date(latest);
  const earliest = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 23, 1);
  if (start < earliest || start > latest) fail(422, "COST_PERIOD_UNAVAILABLE", "Choose one of the latest 24 UTC months.");
  return {key: value as string, start, end: monthEnd(start)};
}
function card(value: unknown): ProjectCostRateCard {
  const input = exact(value, ["id", "revision", "currency", "effectiveFrom", "rates"]), rates = exact(input.rates, meters);
  const normalized = {} as Record<ProjectCostMeter, {amountMinor: number; perUnits: number}>;
  for (const meter of meters) {
    const rate = exact(rates[meter], ["amountMinor", "perUnits"]);
    normalized[meter] = Object.freeze({amountMinor: integer(rate.amountMinor, 0, 1_000_000_000_000), perUnits: integer(rate.perUnits, 1, 1_000_000_000_000_000)});
  }
  const at = integer(input.effectiveFrom, Date.UTC(2000, 0, 1), Date.UTC(2099, 11, 1));
  if (monthStart(at) !== at) fail(422, "COST_INPUT", "Rate cards begin at a UTC month boundary.");
  return Object.freeze({id: opaque(input.id), revision: integer(input.revision, 1), currency: currency(input.currency), effectiveFrom: at, rates: Object.freeze(normalized)});
}
function measurement(value: unknown, start: number, until: number): ProjectCostMeasurement {
  const input = exact(value, ["source", "sourceRevision", "periodStartedAt", "observedUntil", "meters"]), fields = exact(input.meters, meters);
  if (integer(input.periodStartedAt) !== start) fail(409, "COST_MEASUREMENT_MISMATCH", "Collector returned another cost period.");
  const observedUntil = integer(input.observedUntil, start, until), normalized = {} as Record<ProjectCostMeter, {units: string | null; complete: boolean}>;
  for (const meter of meters) {
    const field = exact(fields[meter], ["units", "complete"]);
    if (typeof field.complete !== "boolean" || field.units === null && field.complete) fail(422, "COST_INPUT", "Unavailable measurement cannot claim complete coverage.");
    normalized[meter] = Object.freeze({units: field.units === null ? null : decimal(field.units), complete: field.complete as boolean});
  }
  return Object.freeze({source: opaque(input.source), sourceRevision: opaque(input.sourceRevision), periodStartedAt: start, observedUntil, meters: Object.freeze(normalized)});
}
function arithmetic(value: ProjectCostMeasurement, rateCard: ProjectCostRateCard) {
  let known = 0n;
  const components = meters.map(meter => {
    const rate = rateCard.rates[meter], field = value.meters[meter];
    const numerator = field.units === null ? null : BigInt(field.units) * BigInt(rate.amountMinor);
    const amount = numerator === null ? null : (numerator + BigInt(rate.perUnits) - 1n) / BigInt(rate.perUnits);
    if (amount !== null) known += amount;
    return Object.freeze({meter, units: field.units, complete: field.complete, numerator: numerator?.toString() ?? null, denominator: rate.perUnits, amountMinor: amount?.toString() ?? null});
  });
  return {components: Object.freeze(components), knownAmountMinor: known.toString(), amountMinor: components.every(component => component.complete && component.units !== null) ? known.toString() : null};
}

/** Retained admission policies remain active even when the collector is disabled. */
export function openPlatformProjectCosts(sql: SQLiteInternal, options?: PlatformProjectCostOptions, clock = Date.now) {
  const exists = !!sql.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_project_cost_state'").get();
  const protocol = () => { if (sql.prepare("SELECT protocol FROM clank_project_cost_state WHERE singleton=1").get()?.protocol !== 1) fail(409, "COST_PROTOCOL_UNSUPPORTED", "Unsupported project cost storage protocol."); };
  if (!exists && !options) return undefined;
  if (exists) protocol();
  const now = () => integer(clock(), Date.UTC(2000, 0, 1), Date.UTC(2099, 11, 31));
  const timeout = integer(options?.timeoutMs ?? 10_000, 100, 60_000), maximum = integer(options?.maxObservations ?? 10_000, 1, 100_000), receipts = integer(options?.maxReceipts ?? 10_000, 1, 100_000);
  const maxPolicies = integer(options?.maxPolicies ?? 1_000, 1, 5_000);
  const configured = options?.rateCards.map(card) ?? [];
  if (options && (typeof options.measure !== "function" || !configured.length || configured.length > 100 || new Set(configured.map(value => value.effectiveFrom)).size !== configured.length)) fail(422, "COST_INPUT", "Declare bounded, uniquely effective rate cards and a trusted collector.");
  const collect = options?.measure;
  sql.transaction(() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS clank_project_cost_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL);
      INSERT OR IGNORE INTO clank_project_cost_state VALUES(1,1);
      CREATE TABLE IF NOT EXISTS clank_project_cost_rates(id TEXT NOT NULL,revision INTEGER NOT NULL,effective_from INTEGER NOT NULL UNIQUE,card TEXT NOT NULL CHECK(json_valid(card)),PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS clank_project_cost_observations(project_id TEXT NOT NULL,month TEXT NOT NULL,version INTEGER NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),PRIMARY KEY(project_id,month,version));
      CREATE TABLE IF NOT EXISTS clank_project_cost_policies(project_id TEXT PRIMARY KEY,version INTEGER NOT NULL,policy TEXT NOT NULL CHECK(json_valid(policy)));
      CREATE TABLE IF NOT EXISTS clank_project_cost_overrides(project_id TEXT PRIMARY KEY,version INTEGER NOT NULL,override TEXT NOT NULL CHECK(json_valid(override)));
      CREATE TABLE IF NOT EXISTS clank_project_cost_receipts(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(project_id,actor_id,operation_id));`);
    protocol();
    for (const value of configured) {
      const retained = sql.prepare("SELECT card FROM clank_project_cost_rates WHERE id=? AND revision=?").get(value.id, value.revision), serialized = JSON.stringify(value);
      if (retained && retained.card !== serialized) fail(409, "COST_RATE_CHANGED", "An accepted rate card revision cannot be reinterpreted.");
      const sameTime = sql.prepare("SELECT id,revision FROM clank_project_cost_rates WHERE effective_from=?").get(value.effectiveFrom);
      if (sameTime && (sameTime.id !== value.id || sameTime.revision !== value.revision)) fail(409, "COST_RATE_CHANGED", "An accepted rate effective date cannot be reinterpreted.");
      if (!retained) {
        if (Number(sql.prepare("SELECT count(*) AS n FROM clank_project_cost_rates").get()?.n) >= 100) fail(409, "COST_CAPACITY", "Rate card history is full.");
        const inserted = sql.prepare("INSERT INTO clank_project_cost_rates VALUES(?,?,?,?)").run(value.id, value.revision, value.effectiveFrom, serialized);
        if (Number(inserted.changes) !== 1 || sql.prepare("SELECT card FROM clank_project_cost_rates WHERE id=? AND revision=?").get(value.id, value.revision)?.card !== serialized) fail(503, "COST_WRITE_FAILED", "Rate card storage was not acknowledged.");
      }
    }
  });
  let closed = false;
  const flights = new Set<AbortController>();
  const check = (authority?: ProjectCostAuthority, admin = false) => {
    if (closed) fail(503, "COST_CLOSED", "Project cost controller is closed.");
    protocol(); authority?.authorize(admin);
  };
  const parse = <T>(text: unknown): T => {
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 16_384) fail(409, "COST_STORAGE_INVALID", "Retained cost metadata is invalid.");
    try { return JSON.parse(text as string); } catch { return fail(409, "COST_STORAGE_INVALID", "Retained cost metadata is invalid."); }
  };
  const snapshot = (projectId: string, month: string, retainedVersion?: number): ProjectCostSnapshot | null => {
    const row = retainedVersion === undefined ? sql.prepare("SELECT version,snapshot FROM clank_project_cost_observations WHERE project_id=? AND month=? ORDER BY version DESC LIMIT 1").get(projectId, month)
      : sql.prepare("SELECT version,snapshot FROM clank_project_cost_observations WHERE project_id=? AND month=? AND version=?").get(projectId, month, integer(retainedVersion, 1));
    if (!row) return null;
    const value = parse<ProjectCostSnapshot>(row.snapshot);
    exact(value, ["protocol", "projectId", "month", "version", "observedUntil", "reconciledAt", "source", "sourceRevision", "rateCard", "components", "knownAmountMinor", "amountMinor", "reason"]);
    if (value.protocol !== "clank-project-costs/1" || value.projectId !== projectId || value.month !== month || integer(value.version, 1) !== row.version || !Array.isArray(value.components) || value.components.length !== 3) fail(409, "COST_STORAGE_INVALID", "Retained cost identity is invalid.");
    const savedCard = card(value.rateCard);
    const start = Date.parse(month + "-01T00:00:00.000Z"), fields = Object.fromEntries(value.components.map(component => [component.meter, {units: component.units, complete: component.complete}]));
    const retainedCard = sql.prepare("SELECT effective_from,card FROM clank_project_cost_rates WHERE id=? AND revision=?").get(savedCard.id, savedCard.revision);
    if (retainedCard?.card !== JSON.stringify(savedCard) || retainedCard.effective_from !== savedCard.effectiveFrom || savedCard.effectiveFrom > start) fail(409, "COST_RATE_CHANGED", "Retained cost rate identity changed.");
    const measured = measurement({source: value.source, sourceRevision: value.sourceRevision, periodStartedAt: start, observedUntil: value.observedUntil, meters: fields}, start, Math.min(monthEnd(start), now()));
    const computed = arithmetic(measured, savedCard);
    if (JSON.stringify(value.components) !== JSON.stringify(computed.components) || value.knownAmountMinor !== computed.knownAmountMinor || value.amountMinor !== computed.amountMinor) fail(409, "COST_STORAGE_INVALID", "Retained cost arithmetic changed.");
    integer(value.reconciledAt, value.observedUntil, now()); reason(value.reason);
    return value;
  };
  const policy = (projectId: string): ProjectCostPolicy | null => {
    const row = sql.prepare("SELECT version,policy FROM clank_project_cost_policies WHERE project_id=?").get(projectId);
    if (!row) return null;
    const value = parse<ProjectCostPolicy>(row.policy);
    exact(value, ["version", "currency", "limitMinor", "warningPercent", "admission", "maxMeasurementAgeMs", "reason", "updatedAt"]);
    if (integer(value.version, 1) !== row.version || !["observe", "deny-at-observed-limit"].includes(value.admission)) fail(409, "COST_STORAGE_INVALID", "Retained cost policy is invalid.");
    currency(value.currency); decimal(value.limitMinor); integer(value.warningPercent, 1, 100); integer(value.maxMeasurementAgeMs, 1_000, 24 * 60 * 60_000); integer(value.updatedAt, 0, now()); reason(value.reason);
    return value;
  };
  const override = (projectId: string, current: ProjectCostPolicy | null): ProjectCostOverride | null => {
    const row = sql.prepare("SELECT version,override FROM clank_project_cost_overrides WHERE project_id=?").get(projectId);
    if (!row) return null;
    const value = parse<Omit<ProjectCostOverride, "active">>(row.override);
    exact(value, ["version", "policyVersion", "expiresAt", "createdAt", "reason"]);
    if (integer(value.version, 1) !== row.version) fail(409, "COST_STORAGE_INVALID", "Retained cost override is invalid.");
    integer(value.policyVersion, 1); integer(value.createdAt, 0, now()); integer(value.expiresAt, 0, value.createdAt + 3_600_000); reason(value.reason);
    return {...value, active: !!current && value.policyVersion === current.version && value.expiresAt > now()};
  };
  const report = (projectId: string, key = monthKey(now())): ProjectCostReport => {
    check(); opaque(projectId); const selected = period(key, now()), current = policy(projectId), measured = snapshot(projectId, selected.key), exception = override(projectId, current), asOf = now();
    let status: ProjectCostReport["status"] = !current ? "unconfigured" : "unknown";
    if (current && measured?.amountMinor !== null && measured?.amountMinor !== undefined && current.currency === measured.rateCard.currency) {
      const stale = asOf - measured.observedUntil > current.maxMeasurementAgeMs;
      const used = BigInt(measured.amountMinor), limit = BigInt(current.limitMinor);
      status = stale ? "stale" : used >= limit ? "exhausted" : used * 100n >= limit * BigInt(current.warningPercent) ? "warning" : "within-budget";
    }
    const denied = key === monthKey(asOf) && current?.admission === "deny-at-observed-limit" && ["unknown", "stale", "exhausted"].includes(status);
    return {protocol: "clank-project-costs/1", projectId, month: key, snapshot: measured, policy: current, override: exception, status, admission: denied ? exception?.active ? "overridden" : "blocked" : "allowed", asOf};
  };
  const retry = (projectId: string, authority: ProjectCostAuthority, operationId: string, request: string): unknown => {
    const row = sql.prepare("SELECT request,result FROM clank_project_cost_receipts WHERE project_id=? AND actor_id=? AND operation_id=?").get(projectId, authority.actorId, operationId);
    if (!row) return undefined;
    if (row.request !== request) fail(409, "COST_RETRY_CHANGED", "The cost operation ID names a different reviewed intent.");
    const value = parse<Record<string, unknown>>(row.result), intent = JSON.parse(request);
    if (intent.kind === "reconcile") {
      const observed = snapshot(projectId, intent.month, intent.expectedVersion + 1);
      if (!observed || JSON.stringify(value) !== JSON.stringify(observed) || observed.reason !== intent.reason) fail(409, "COST_STORAGE_INVALID", "Retained cost acknowledgment no longer matches its observation.");
    } else if (intent.kind === "policy") {
      exact(value, ["version", "currency", "limitMinor", "warningPercent", "admission", "maxMeasurementAgeMs", "reason", "updatedAt"]);
      if (value.version !== intent.expectedVersion + 1 || ["currency", "limitMinor", "warningPercent", "admission", "maxMeasurementAgeMs", "reason"].some(key => value[key] !== intent[key])) fail(409, "COST_STORAGE_INVALID", "Retained budget acknowledgment no longer matches its reviewed intent.");
      integer(value.updatedAt, 0, now());
    } else if (intent.kind === "override") {
      exact(value, ["version", "policyVersion", "expiresAt", "createdAt", "reason"]);
      if (value.version !== intent.expectedVersion + 1 || ["policyVersion", "expiresAt", "reason"].some(key => value[key] !== intent[key])) fail(409, "COST_STORAGE_INVALID", "Retained override acknowledgment no longer matches its reviewed intent.");
      const createdAt = integer(value.createdAt, 0, now()); integer(value.expiresAt, 0, createdAt + 3_600_000);
    } else fail(409, "COST_STORAGE_INVALID", "Retained cost acknowledgment has an unsupported intent.");
    return value;
  };
  const save = <T>(projectId: string, authority: ProjectCostAuthority, operationId: string, request: string, value: T, action: string): T => {
    check(authority, true);
    if (Number(sql.prepare("SELECT count(*) AS n FROM clank_project_cost_receipts").get()?.n) >= receipts) fail(409, "COST_CAPACITY", "Cost receipt history is full; reconcile capacity explicitly.");
    const result = JSON.stringify(value);
    if (new TextEncoder().encode(result).byteLength > 16_384) fail(409, "COST_CAPACITY", "Cost acknowledgment exceeds its envelope.");
    const inserted = sql.prepare("INSERT INTO clank_project_cost_receipts VALUES(?,?,?,?,?)").run(projectId, authority.actorId, operationId, request, result);
    const retained = sql.prepare("SELECT request,result FROM clank_project_cost_receipts WHERE project_id=? AND actor_id=? AND operation_id=?").get(projectId, authority.actorId, operationId);
    if (Number(inserted.changes) !== 1 || retained?.request !== request || retained.result !== result) fail(503, "COST_WRITE_FAILED", "Cost acknowledgment was not durably stored.");
    authority.audit(action, {month: Reflect.get(Object(value), "month") ?? null, operationId, version: Reflect.get(Object(value), "version"), reason: Reflect.get(Object(value), "reason")});
    check(authority, true);
    return value;
  };
  const stored = (table: "clank_project_cost_policies" | "clank_project_cost_overrides", column: "policy" | "override", projectId: string, expected: number, value: unknown) => {
    const version = expected + 1, json = JSON.stringify(value);
    const changed = expected === 0 ? sql.prepare(`INSERT INTO ${table}(project_id,version,${column}) VALUES(?,?,?)`).run(projectId, version, json)
      : sql.prepare(`UPDATE ${table} SET version=?,${column}=? WHERE project_id=? AND version=?`).run(version, json, projectId, expected);
    const row = sql.prepare(`SELECT version,${column} FROM ${table} WHERE project_id=?`).get(projectId);
    if (Number(changed.changes) !== 1 || row?.version !== version || row[column] !== json) fail(503, "COST_WRITE_FAILED", "Cost policy storage was not acknowledged.");
  };
  return {
    read(projectId: string, authority: ProjectCostAuthority, key?: string) { check(authority); const result = report(projectId, key); check(authority); return result; },
    history(projectId: string, authority: ProjectCostAuthority, key: string) {
      check(authority); opaque(projectId); period(key, now());
      const result = sql.prepare("SELECT version FROM clank_project_cost_observations WHERE project_id=? AND month=? ORDER BY version DESC LIMIT 25").all(projectId, key).map(row => snapshot(projectId, key, Number(row.version))!);
      check(authority); return result;
    },
    async reconcile(projectId: string, authority: ProjectCostAuthority, value: unknown): Promise<ProjectCostSnapshot> {
      check(authority, true); opaque(projectId);
      const input = exact(value, ["month", "expectedVersion", "operationId", "reason"]), selected = period(input.month, now()), expected = integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), operationId = opaque(input.operationId), why = reason(input.reason);
      const request = JSON.stringify({kind: "reconcile", month: selected.key, expectedVersion: expected, reason: why});
      const retained = retry(projectId, authority, operationId, request); if (retained !== undefined) return retained as ProjectCostSnapshot;
      if (!collect) fail(409, "COST_COLLECTOR_DISABLED", "Cost collection is disabled; retained admission remains active.");
      if ((snapshot(projectId, selected.key)?.version ?? 0) !== expected) fail(409, "COST_STALE", "Refresh the current cost revision before reconciling.");
      const controller = new AbortController(); flights.add(controller); const asOf = now(); let timer: ReturnType<typeof setTimeout>;
      const expiration = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProjectCostError(503, "COST_COLLECTOR_TIMEOUT", "The cost collector did not finish within its bound.")); }, timeout); });
      let measured: ProjectCostMeasurement;
      try {
        const result = await Promise.race([Promise.resolve().then(() => collect!({projectId, periodStartedAt: selected.start, periodEndsAt: selected.end, asOf, signal: controller.signal})), expiration]);
        check(authority, true); if (controller.signal.aborted) fail(503, "COST_COLLECTOR_TIMEOUT", "The cost collector was interrupted.");
        measured = measurement(result, selected.start, Math.min(selected.end, asOf));
      } finally { clearTimeout(timer!); flights.delete(controller); }
      return sql.transaction(() => {
        check(authority, true); const acknowledged = retry(projectId, authority, operationId, request); if (acknowledged !== undefined) return acknowledged as ProjectCostSnapshot;
        const previous = snapshot(projectId, selected.key);
        if ((previous?.version ?? 0) !== expected) fail(409, "COST_STALE", "Cost reconciliation changed while collecting.");
        if (previous && (measured.observedUntil < previous.observedUntil || measured.source !== previous.source)) fail(409, "COST_MEASUREMENT_MISMATCH", "Reconciliation cannot move coverage backward or substitute a collector.");
        if (Number(sql.prepare("SELECT count(*) AS n FROM clank_project_cost_observations").get()?.n) >= maximum) fail(409, "COST_CAPACITY", "Cost observation history is full; preserve and reconcile it explicitly.");
        let rateCard = previous?.rateCard;
        if (!rateCard) {
          const selectedCard = sql.prepare("SELECT id,revision,effective_from,card FROM clank_project_cost_rates WHERE effective_from<=? ORDER BY effective_from DESC LIMIT 1").get(selected.start);
          if (!selectedCard) fail(409, "COST_RATE_UNAVAILABLE", "No declared rate card covers this cost period.");
          rateCard = card(parse(selectedCard!.card));
          if (selectedCard!.id !== rateCard.id || selectedCard!.revision !== rateCard.revision || selectedCard!.effective_from !== rateCard.effectiveFrom) fail(409, "COST_RATE_CHANGED", "Stored rate card identity changed.");
        }
        const result: ProjectCostSnapshot = {protocol: "clank-project-costs/1", projectId, month: selected.key, version: expected + 1, observedUntil: measured.observedUntil, reconciledAt: now(), source: measured.source, sourceRevision: measured.sourceRevision, rateCard, ...arithmetic(measured, rateCard), reason: why};
        const serialized = JSON.stringify(result), changed = sql.prepare("INSERT INTO clank_project_cost_observations VALUES(?,?,?,?)").run(projectId, selected.key, result.version, serialized);
        if (Number(changed.changes) !== 1 || sql.prepare("SELECT snapshot FROM clank_project_cost_observations WHERE project_id=? AND month=? AND version=?").get(projectId, selected.key, result.version)?.snapshot !== serialized) fail(503, "COST_WRITE_FAILED", "Cost observation was not durably stored.");
        return save(projectId, authority, operationId, request, result, "project.cost.reconcile");
      });
    },
    changePolicy(projectId: string, authority: ProjectCostAuthority, value: unknown): ProjectCostPolicy {
      check(authority, true); opaque(projectId); const input = exact(value, ["expectedVersion", "operationId", "currency", "limitMinor", "warningPercent", "admission", "maxMeasurementAgeMs", "reason"]);
      const expected = integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), operationId = opaque(input.operationId);
      if (!["observe", "deny-at-observed-limit"].includes(String(input.admission))) fail(422, "COST_INPUT", "Choose the supported observed-usage admission policy.");
      const fields = {currency: currency(input.currency), limitMinor: decimal(input.limitMinor), warningPercent: integer(input.warningPercent, 1, 100), admission: input.admission as ProjectCostPolicy["admission"], maxMeasurementAgeMs: integer(input.maxMeasurementAgeMs, 1_000, 24 * 60 * 60_000), reason: reason(input.reason)};
      const request = JSON.stringify({kind: "policy", expectedVersion: expected, ...fields});
      return sql.transaction(() => {
        check(authority, true); const retained = retry(projectId, authority, operationId, request); if (retained !== undefined) return retained as ProjectCostPolicy;
        if ((policy(projectId)?.version ?? 0) !== expected) fail(409, "COST_STALE", "Refresh the current budget policy before changing it.");
        if (expected === 0 && Number(sql.prepare("SELECT count(*) AS n FROM clank_project_cost_policies").get()?.n) >= maxPolicies) fail(409, "COST_CAPACITY", "Project budget inventory is full; preserve and reconcile it explicitly.");
        const result = {version: expected + 1, ...fields, updatedAt: now()}; stored("clank_project_cost_policies", "policy", projectId, expected, result);
        return save(projectId, authority, operationId, request, result, "project.cost.policy");
      });
    },
    changeOverride(projectId: string, authority: ProjectCostAuthority, value: unknown): ProjectCostOverride {
      check(authority, true); opaque(projectId); const input = exact(value, ["expectedVersion", "policyVersion", "operationId", "expiresAt", "reason"]), expected = integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), policyVersion = integer(input.policyVersion, 1), operationId = opaque(input.operationId), why = reason(input.reason), expiresAt = integer(input.expiresAt, 0, now() + 3_600_000);
      const request = JSON.stringify({kind: "override", expectedVersion: expected, policyVersion, expiresAt, reason: why});
      return sql.transaction(() => {
        check(authority, true); const retained = retry(projectId, authority, operationId, request);
        if (retained !== undefined) {
          const historical = retained as Omit<ProjectCostOverride, "active">, current = override(projectId, policy(projectId));
          return {...historical, active: !!current?.active && current.version === historical.version};
        }
        if (expiresAt !== 0 && expiresAt <= now()) fail(422, "COST_INPUT", "Choose a future override expiry within one hour, or zero to revoke.");
        const current = policy(projectId);
        if (!current || current.version !== policyVersion || (override(projectId, current)?.version ?? 0) !== expected) fail(409, "COST_STALE", "Refresh the current policy and override before changing access.");
        const result = {version: expected + 1, policyVersion, expiresAt, createdAt: now(), reason: why}; stored("clank_project_cost_overrides", "override", projectId, expected, result);
        save(projectId, authority, operationId, request, result, "project.cost.override"); return {...result, active: expiresAt > now()};
      });
    },
    admission(projectId: string): {allowed: boolean; code?: string; message?: string; retryAfterSeconds?: number} {
      const value = report(projectId);
      return value.admission === "blocked" ? {allowed: false, code: "PROJECT_COST_BUDGET_BLOCKED", message: "Project cost admission needs complete fresh measurements within its observed budget, or a current reviewed override.", retryAfterSeconds: 60} : {allowed: true};
    },
    signals() {
      check();
      const rows = sql.prepare("SELECT p.project_id FROM clank_project_cost_policies p JOIN clank_platform_projects project ON project.id=p.project_id ORDER BY p.project_id LIMIT ?").all(maxPolicies + 1);
      if (rows.length > maxPolicies) fail(409, "COST_CAPACITY", "Budget alert inventory exceeds its declared bound.");
      return rows.map(row => {
        const projectId = String(row.project_id), value = report(projectId);
        return {key: `project_cost:${projectId}`, kind: "cost_budget" as const, resourceId: projectId, severity: value.status === "exhausted" ? "critical" as const : "warning" as const,
          active: ["unknown", "stale", "warning", "exhausted"].includes(value.status), message: "Project measured cost coverage is incomplete, stale, near its budget, or exhausted."};
      });
    },
    close() { closed = true; for (const controller of flights) controller.abort(); flights.clear(); },
  };
}
