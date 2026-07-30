import type { JobState } from "./jobs.ts";

const JOB_STATES = new Set<JobState>([
  "queued",
  "running",
  "retry",
  "succeeded",
  "dead",
  "cancelled",
]);
const REQUIRED_JOB_COLUMNS = new Set([
  "id",
  "name",
  "queue",
  "state",
  "result",
  "error",
  "priority",
  "attempts",
  "max_attempts",
  "run_at",
  "scheduled_at",
  "cron_name",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "lease_until",
  "lease_token",
  "lease_owner",
  "cancel_requested",
]);
const REQUIRED_EVENT_COLUMNS = new Set([
  "id",
  "job_id",
  "event",
  "details",
  "created_at",
]);
const REQUIRED_SCHEDULE_COLUMNS = new Set([
  "name",
  "job_name",
  "expression",
  "timezone",
  "concurrency",
  "enabled",
  "next_run_at",
  "last_scheduled_at",
  "last_error",
  "updated_at",
]);

interface NativeStatement {
  all(...parameters: any[]): Array<Record<string, unknown>>;
  get(...parameters: any[]): Record<string, unknown> | undefined;
  run(...parameters: any[]): { changes: number | bigint };
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

export interface PlatformJobRecord {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly state: JobState;
  readonly priority: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly runAt: number;
  readonly scheduledAt: number | null;
  readonly cron: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly leaseUntil: number | null;
  readonly cancelRequested: boolean;
  readonly hasError: boolean;
}

export interface PlatformJobSchedule {
  readonly name: string;
  readonly job: string;
  readonly expression: string;
  readonly timezone: string;
  readonly concurrency: "allow" | "forbid" | "replace";
  readonly enabled: boolean;
  readonly nextRunAt: number;
  readonly lastScheduledAt: number | null;
  readonly updatedAt: number;
  readonly hasError: boolean;
}

export interface PlatformJobStats {
  readonly queued: number;
  readonly running: number;
  readonly retry: number;
  readonly succeeded: number;
  readonly dead: number;
  readonly cancelled: number;
  readonly due: number;
  readonly oldestDueAt: number | null;
  readonly overdue: number;
  readonly expiredLeases: number;
  readonly scheduleErrors: number;
}

export interface PlatformJobSnapshot {
  readonly available: boolean;
  readonly configured: boolean;
  readonly compatibility:
    | "ready"
    | "not_deployed"
    | "not_configured"
    | "upgrade_required"
    | "remote_unavailable";
  readonly health: "healthy" | "attention" | "unavailable";
  readonly alertDueAfterMs: number;
  readonly stats: PlatformJobStats;
  readonly jobs: readonly PlatformJobRecord[];
  readonly schedules: readonly PlatformJobSchedule[];
  readonly scheduleCount: number;
}

export interface InspectPlatformJobsOptions {
  databasePath: string | null;
  /** Prevents accidental local inspection when the database is provider-hosted. */
  remote?: boolean;
  alertDueAfterMs: number;
  state?: JobState;
  queue?: string;
  limit?: number;
  now?: number;
}

export interface MutatePlatformJobOptions {
  databasePath: string;
  id: string;
  action: "cancel" | "retry";
  runAt?: number;
  now?: number;
}

export interface PlatformJobMutation {
  readonly changed: boolean;
  readonly reason: "changed" | "not_found" | "invalid_state";
  readonly job: PlatformJobRecord | null;
}

export async function inspectPlatformJobs(
  options: InspectPlatformJobsOptions,
): Promise<PlatformJobSnapshot> {
  const alertDueAfterMs = safeInteger(
    options.alertDueAfterMs,
    "alertDueAfterMs",
    1_000,
    30 * 24 * 60 * 60_000,
  );
  if (options.remote === true) {
    return emptySnapshot("remote_unavailable", alertDueAfterMs);
  }
  if (!options.databasePath) {
    return emptySnapshot("not_deployed", alertDueAfterMs);
  }
  const state = options.state;
  if (state !== undefined && !JOB_STATES.has(state)) {
    throw new TypeError("Invalid platform job state.");
  }
  const queue = options.queue === undefined
    ? undefined
    : portableIdentifier(options.queue, "job queue", 128);
  const limit = safeInteger(options.limit ?? 100, "job limit", 1, 100);
  const now = safeInteger(options.now ?? Date.now(), "current time", 0, Number.MAX_SAFE_INTEGER);
  const database = await openNativeDatabase(options.databasePath, true);
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
    const columns = tableColumns(database, "clank_jobs");
    if (columns.size === 0) return emptySnapshot("not_configured", alertDueAfterMs);
    const eventColumns = tableColumns(database, "clank_job_events");
    const scheduleColumns = tableColumns(database, "clank_job_schedules");
    if (
      [...REQUIRED_JOB_COLUMNS].some((column) => !columns.has(column))
      || [...REQUIRED_EVENT_COLUMNS].some((column) => !eventColumns.has(column))
      || [...REQUIRED_SCHEDULE_COLUMNS].some((column) => !scheduleColumns.has(column))
    ) {
      return emptySnapshot("upgrade_required", alertDueAfterMs);
    }

    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (state !== undefined) {
      clauses.push("state = ?");
      parameters.push(state);
    }
    if (queue !== undefined) {
      clauses.push("queue = ?");
      parameters.push(queue);
    }
    const jobs = database.prepare(`SELECT
        id, name, queue, state, priority, attempts, max_attempts, run_at,
        scheduled_at, cron_name, created_at, updated_at, started_at,
        completed_at, lease_until, cancel_requested,
        CASE WHEN error IS NULL THEN 0 ELSE 1 END AS has_error
      FROM clank_jobs
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?`).all(...parameters, limit).map(publicJob);
    const stateRows = database.prepare(
      "SELECT state, count(*) AS count FROM clank_jobs GROUP BY state",
    ).all();
    const counts = Object.fromEntries(
      stateRows.map((row) => [String(row.state), storedInteger(row.count, "job count", 0)]),
    );
    const due = database.prepare(`SELECT count(*) AS count, min(run_at) AS oldest
      FROM clank_jobs WHERE state IN ('queued', 'retry') AND run_at <= ?`).get(now);
    const overdue = database.prepare(`SELECT count(*) AS count
      FROM clank_jobs WHERE state IN ('queued', 'retry') AND run_at <= ?`).get(
      Math.max(0, now - alertDueAfterMs),
    );
    const expired = database.prepare(`SELECT count(*) AS count
      FROM clank_jobs WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?`).get(now);
    const schedules = database.prepare(`SELECT name, job_name, expression, timezone, concurrency,
        enabled, next_run_at, last_scheduled_at, updated_at,
        CASE WHEN last_error IS NULL THEN 0 ELSE 1 END AS has_error
      FROM clank_job_schedules ORDER BY name LIMIT 100`).all().map(publicSchedule);
    const scheduleSummary = database.prepare(`SELECT count(*) AS count,
        sum(CASE WHEN last_error IS NULL THEN 0 ELSE 1 END) AS errors
      FROM clank_job_schedules`).get();
    const stats = Object.freeze({
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      retry: counts.retry ?? 0,
      succeeded: counts.succeeded ?? 0,
      dead: counts.dead ?? 0,
      cancelled: counts.cancelled ?? 0,
      due: storedInteger(due?.count ?? 0, "due job count", 0),
      oldestDueAt: nullableStoredInteger(due?.oldest, "oldest due time"),
      overdue: storedInteger(overdue?.count ?? 0, "overdue job count", 0),
      expiredLeases: storedInteger(expired?.count ?? 0, "expired job lease count", 0),
      scheduleErrors: storedInteger(scheduleSummary?.errors ?? 0, "schedule error count", 0),
    });
    return Object.freeze({
      available: true,
      configured: true,
      compatibility: "ready",
      health: stats.dead > 0
        || stats.overdue > 0
        || stats.expiredLeases > 0
        || stats.scheduleErrors > 0
        ? "attention"
        : "healthy",
      alertDueAfterMs,
      stats,
      jobs: Object.freeze(jobs),
      schedules: Object.freeze(schedules),
      scheduleCount: storedInteger(scheduleSummary?.count ?? 0, "schedule count", 0),
    });
  } finally {
    database.close();
  }
}

export async function mutatePlatformJob(
  options: MutatePlatformJobOptions,
): Promise<PlatformJobMutation> {
  const id = jobIdentifier(options.id);
  const now = safeInteger(options.now ?? Date.now(), "current time", 0, Number.MAX_SAFE_INTEGER);
  const runAt = options.action === "retry"
    ? safeInteger(options.runAt ?? now, "job retry runAt", 0, Number.MAX_SAFE_INTEGER)
    : now;
  const database = await openNativeDatabase(options.databasePath, false);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const columns = tableColumns(database, "clank_jobs");
    if (columns.size === 0) return Object.freeze({ changed: false, reason: "not_found", job: null });
    const eventColumns = tableColumns(database, "clank_job_events");
    if (
      [...REQUIRED_JOB_COLUMNS].some((column) => !columns.has(column))
      || [...REQUIRED_EVENT_COLUMNS].some((column) => !eventColumns.has(column))
    ) {
      throw new TypeError("The deployed job schema must be upgraded before it can be operated.");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = options.action === "cancel"
        ? database.prepare(`UPDATE clank_jobs
            SET cancel_requested = 1,
              state = CASE WHEN state IN ('queued', 'retry') THEN 'cancelled' ELSE state END,
              completed_at = CASE WHEN state IN ('queued', 'retry') THEN ? ELSE completed_at END,
              updated_at = ?
            WHERE id = ? AND state IN ('queued', 'retry', 'running')`)
            .run(now, now, id)
        : database.prepare(`UPDATE clank_jobs
            SET state = 'queued', attempts = 0, run_at = ?, result = NULL, error = NULL,
              completed_at = NULL, lease_token = NULL, lease_owner = NULL, lease_until = NULL,
              cancel_requested = 0, updated_at = ?
            WHERE id = ? AND state IN ('dead', 'cancelled')`)
            .run(runAt, now, id);
      const changed = Number(result.changes) === 1;
      if (changed) {
        database.prepare(
          "INSERT INTO clank_job_events (job_id, event, details, created_at) VALUES (?, ?, '{}', ?)",
        ).run(id, options.action === "cancel" ? "cancel_requested" : "retried", now);
        database.prepare(`DELETE FROM clank_job_events WHERE id <= (
          SELECT max(id) - 100000 FROM clank_job_events
        )`).run();
      }
      const row = database.prepare(`SELECT
          id, name, queue, state, priority, attempts, max_attempts, run_at,
          scheduled_at, cron_name, created_at, updated_at, started_at,
          completed_at, lease_until, cancel_requested,
          CASE WHEN error IS NULL THEN 0 ELSE 1 END AS has_error
        FROM clank_jobs WHERE id = ?`).get(id);
      database.exec("COMMIT");
      return Object.freeze({
        changed,
        reason: changed ? "changed" : row ? "invalid_state" : "not_found",
        job: row ? publicJob(row) : null,
      });
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original mutation failure. */ }
      throw error;
    }
  } finally {
    database.close();
  }
}

/**
 * Revalidates a serialized job snapshot received across a provider trust
 * boundary. Only the privacy-safe public shape is accepted.
 */
export function parsePlatformJobSnapshot(value: unknown): PlatformJobSnapshot {
  const input = exactObject(value, [
    "available",
    "configured",
    "compatibility",
    "health",
    "alertDueAfterMs",
    "stats",
    "jobs",
    "schedules",
    "scheduleCount",
  ], "platform job snapshot");
  const compatibility = input.compatibility;
  if (
    compatibility !== "ready"
    && compatibility !== "not_deployed"
    && compatibility !== "not_configured"
    && compatibility !== "upgrade_required"
    && compatibility !== "remote_unavailable"
  ) {
    throw new TypeError("Platform job snapshot compatibility is invalid.");
  }
  const available = strictBoolean(input.available, "platform job availability");
  const configured = strictBoolean(input.configured, "platform job configuration");
  const expectedAvailable = compatibility !== "not_deployed"
    && compatibility !== "remote_unavailable";
  if (
    available !== expectedAvailable
    || configured !== (compatibility === "ready")
  ) {
    throw new TypeError("Platform job snapshot availability is inconsistent.");
  }
  const alertDueAfterMs = safeInteger(
    input.alertDueAfterMs,
    "platform job alert threshold",
    1_000,
    30 * 24 * 60 * 60_000,
  );
  const statsInput = exactObject(input.stats, [
    "queued",
    "running",
    "retry",
    "succeeded",
    "dead",
    "cancelled",
    "due",
    "oldestDueAt",
    "overdue",
    "expiredLeases",
    "scheduleErrors",
  ], "platform job statistics");
  const stats = Object.freeze({
    queued: safeInteger(statsInput.queued, "queued job count", 0, Number.MAX_SAFE_INTEGER),
    running: safeInteger(statsInput.running, "running job count", 0, Number.MAX_SAFE_INTEGER),
    retry: safeInteger(statsInput.retry, "retry job count", 0, Number.MAX_SAFE_INTEGER),
    succeeded: safeInteger(statsInput.succeeded, "succeeded job count", 0, Number.MAX_SAFE_INTEGER),
    dead: safeInteger(statsInput.dead, "dead job count", 0, Number.MAX_SAFE_INTEGER),
    cancelled: safeInteger(statsInput.cancelled, "cancelled job count", 0, Number.MAX_SAFE_INTEGER),
    due: safeInteger(statsInput.due, "due job count", 0, Number.MAX_SAFE_INTEGER),
    oldestDueAt: serializedNullableInteger(statsInput.oldestDueAt, "oldest due time"),
    overdue: safeInteger(statsInput.overdue, "overdue job count", 0, Number.MAX_SAFE_INTEGER),
    expiredLeases: safeInteger(
      statsInput.expiredLeases,
      "expired job lease count",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    scheduleErrors: safeInteger(
      statsInput.scheduleErrors,
      "schedule error count",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  });
  const jobsInput = boundedArray(input.jobs, "platform jobs", 100);
  const schedulesInput = boundedArray(input.schedules, "platform job schedules", 100);
  const jobs = Object.freeze(jobsInput.map(serializedJob));
  const schedules = Object.freeze(schedulesInput.map(serializedSchedule));
  const scheduleCount = safeInteger(
    input.scheduleCount,
    "platform schedule count",
    schedules.length,
    Number.MAX_SAFE_INTEGER,
  );
  const expectedHealth = compatibility !== "ready"
    ? "unavailable"
    : stats.dead > 0
      || stats.overdue > 0
      || stats.expiredLeases > 0
      || stats.scheduleErrors > 0
      ? "attention"
      : "healthy";
  if (input.health !== expectedHealth) {
    throw new TypeError("Platform job snapshot health is inconsistent.");
  }
  return Object.freeze({
    available,
    configured,
    compatibility,
    health: expectedHealth,
    alertDueAfterMs,
    stats,
    jobs,
    schedules,
    scheduleCount,
  });
}

/** Revalidates a serialized, privacy-safe provider job mutation result. */
export function parsePlatformJobMutation(value: unknown): PlatformJobMutation {
  const input = exactObject(
    value,
    ["changed", "reason", "job"],
    "platform job mutation",
  );
  const changed = strictBoolean(input.changed, "platform job mutation state");
  if (
    input.reason !== "changed"
    && input.reason !== "not_found"
    && input.reason !== "invalid_state"
  ) {
    throw new TypeError("Platform job mutation reason is invalid.");
  }
  if (changed !== (input.reason === "changed")) {
    throw new TypeError("Platform job mutation state is inconsistent.");
  }
  const job = input.job === null ? null : serializedJob(input.job);
  if ((input.reason === "not_found") !== (job === null)) {
    throw new TypeError("Platform job mutation result is inconsistent.");
  }
  return Object.freeze({ changed, reason: input.reason, job });
}

function emptySnapshot(
  compatibility: Exclude<PlatformJobSnapshot["compatibility"], "ready">,
  alertDueAfterMs: number,
): PlatformJobSnapshot {
  return Object.freeze({
    available: compatibility !== "not_deployed" && compatibility !== "remote_unavailable",
    configured: false,
    compatibility,
    health: "unavailable",
    alertDueAfterMs,
    stats: Object.freeze({
      queued: 0,
      running: 0,
      retry: 0,
      succeeded: 0,
      dead: 0,
      cancelled: 0,
      due: 0,
      oldestDueAt: null,
      overdue: 0,
      expiredLeases: 0,
      scheduleErrors: 0,
    }),
    jobs: Object.freeze([]),
    schedules: Object.freeze([]),
    scheduleCount: 0,
  });
}

function publicJob(row: Record<string, unknown>): PlatformJobRecord {
  const state = String(row.state) as JobState;
  if (!JOB_STATES.has(state)) throw new TypeError("Stored job state is invalid.");
  return Object.freeze({
    id: jobIdentifier(row.id),
    name: portableIdentifier(row.name, "stored job name", 512),
    queue: portableIdentifier(row.queue, "stored job queue", 128),
    state,
    priority: storedInteger(row.priority, "stored job priority", -1_000, 1_000),
    attempt: storedInteger(row.attempts, "stored job attempts", 0, 1_000_000),
    maxAttempts: storedInteger(row.max_attempts, "stored job max attempts", 1, 100),
    runAt: storedInteger(row.run_at, "stored job run time", 0),
    scheduledAt: nullableStoredInteger(row.scheduled_at, "stored scheduled time"),
    cron: row.cron_name === null || row.cron_name === undefined
      ? null
      : printableIdentifier(row.cron_name, "stored cron name", 128),
    createdAt: storedInteger(row.created_at, "stored job created time", 0),
    updatedAt: storedInteger(row.updated_at, "stored job updated time", 0),
    startedAt: nullableStoredInteger(row.started_at, "stored job started time"),
    completedAt: nullableStoredInteger(row.completed_at, "stored job completed time"),
    leaseUntil: nullableStoredInteger(row.lease_until, "stored job lease time"),
    cancelRequested: storedInteger(row.cancel_requested, "stored job cancellation", 0, 1) === 1,
    hasError: Number(row.has_error) === 1,
  });
}

function publicSchedule(row: Record<string, unknown>): PlatformJobSchedule {
  const concurrency = String(row.concurrency);
  if (!["allow", "forbid", "replace"].includes(concurrency)) {
    throw new TypeError("Stored schedule concurrency is invalid.");
  }
  return Object.freeze({
    name: printableIdentifier(row.name, "stored schedule name", 128),
    job: portableIdentifier(row.job_name, "stored scheduled job name", 512),
    expression: printableIdentifier(row.expression, "stored schedule expression", 256),
    timezone: printableIdentifier(row.timezone, "stored schedule timezone", 128),
    concurrency: concurrency as PlatformJobSchedule["concurrency"],
    enabled: storedInteger(row.enabled, "stored schedule enabled", 0, 1) === 1,
    nextRunAt: storedInteger(row.next_run_at, "stored schedule next time", 0),
    lastScheduledAt: nullableStoredInteger(row.last_scheduled_at, "stored schedule last time"),
    updatedAt: storedInteger(row.updated_at, "stored schedule updated time", 0),
    hasError: Number(row.has_error) === 1,
  });
}

function tableColumns(database: NativeDatabase, table: string): Set<string> {
  const exists = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
  if (!exists) return new Set();
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}

async function openNativeDatabase(path: string, readOnly: boolean): Promise<NativeDatabase> {
  const moduleName = "node:sqlite";
  const sqlite = await import(moduleName) as unknown as {
    DatabaseSync: new(path: string, options?: { readOnly?: boolean; timeout?: number }) => NativeDatabase;
  };
  return new sqlite.DatabaseSync(path, { readOnly, timeout: 5_000 });
}

function jobIdentifier(value: unknown): string {
  const id = String(value);
  if (!/^job_[a-f0-9]{32}$/u.test(id)) throw new TypeError("Stored job ID is invalid.");
  return id;
}

function portableIdentifier(value: unknown, label: string, maximum: number): string {
  const text = String(value);
  if (
    text.length < 1
    || text.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(text)
  ) throw new TypeError(`${label} is invalid.`);
  return text;
}

function printableIdentifier(value: unknown, label: string, maximum: number): string {
  const text = String(value);
  if (
    text.length < 1
    || text.length > maximum
    || !/^[\x20-\x7e]+$/u.test(text)
  ) throw new TypeError(`${label} is invalid.`);
  return text;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new TypeError(`${label} is invalid.`);
  return value;
}

function storedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return number;
}

function nullableStoredInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined
    ? null
    : storedInteger(value, label, 0);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} is invalid.`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length
    || keys.some((key) => !fields.includes(key))
  ) {
    throw new TypeError(`${label} contains invalid fields.`);
  }
  return value as Record<string, unknown>;
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid.`);
  return value;
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function serializedNullableInteger(value: unknown, label: string): number | null {
  return value === null
    ? null
    : safeInteger(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function serializedJob(value: unknown): PlatformJobRecord {
  const input = exactObject(value, [
    "id",
    "name",
    "queue",
    "state",
    "priority",
    "attempt",
    "maxAttempts",
    "runAt",
    "scheduledAt",
    "cron",
    "createdAt",
    "updatedAt",
    "startedAt",
    "completedAt",
    "leaseUntil",
    "cancelRequested",
    "hasError",
  ], "platform job");
  if (!JOB_STATES.has(input.state as JobState)) {
    throw new TypeError("Platform job state is invalid.");
  }
  return Object.freeze({
    id: jobIdentifier(input.id),
    name: portableIdentifier(input.name, "platform job name", 512),
    queue: portableIdentifier(input.queue, "platform job queue", 128),
    state: input.state as JobState,
    priority: safeInteger(input.priority, "platform job priority", -1_000, 1_000),
    attempt: safeInteger(input.attempt, "platform job attempt", 0, 1_000_000),
    maxAttempts: safeInteger(input.maxAttempts, "platform job max attempts", 1, 100),
    runAt: safeInteger(input.runAt, "platform job run time", 0, Number.MAX_SAFE_INTEGER),
    scheduledAt: serializedNullableInteger(input.scheduledAt, "platform scheduled time"),
    cron: input.cron === null
      ? null
      : printableIdentifier(input.cron, "platform cron name", 128),
    createdAt: safeInteger(input.createdAt, "platform job created time", 0, Number.MAX_SAFE_INTEGER),
    updatedAt: safeInteger(input.updatedAt, "platform job updated time", 0, Number.MAX_SAFE_INTEGER),
    startedAt: serializedNullableInteger(input.startedAt, "platform job started time"),
    completedAt: serializedNullableInteger(input.completedAt, "platform job completed time"),
    leaseUntil: serializedNullableInteger(input.leaseUntil, "platform job lease time"),
    cancelRequested: strictBoolean(input.cancelRequested, "platform job cancellation"),
    hasError: strictBoolean(input.hasError, "platform job error state"),
  });
}

function serializedSchedule(value: unknown): PlatformJobSchedule {
  const input = exactObject(value, [
    "name",
    "job",
    "expression",
    "timezone",
    "concurrency",
    "enabled",
    "nextRunAt",
    "lastScheduledAt",
    "updatedAt",
    "hasError",
  ], "platform job schedule");
  if (
    input.concurrency !== "allow"
    && input.concurrency !== "forbid"
    && input.concurrency !== "replace"
  ) {
    throw new TypeError("Platform job schedule concurrency is invalid.");
  }
  return Object.freeze({
    name: printableIdentifier(input.name, "platform schedule name", 128),
    job: portableIdentifier(input.job, "platform scheduled job name", 512),
    expression: printableIdentifier(input.expression, "platform schedule expression", 256),
    timezone: printableIdentifier(input.timezone, "platform schedule timezone", 128),
    concurrency: input.concurrency,
    enabled: strictBoolean(input.enabled, "platform schedule enabled"),
    nextRunAt: safeInteger(
      input.nextRunAt,
      "platform schedule next time",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    lastScheduledAt: serializedNullableInteger(
      input.lastScheduledAt,
      "platform schedule last time",
    ),
    updatedAt: safeInteger(
      input.updatedAt,
      "platform schedule updated time",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    hasError: strictBoolean(input.hasError, "platform schedule error state"),
  });
}
