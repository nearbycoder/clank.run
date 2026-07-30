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
  readonly compatibility: "ready" | "not_deployed" | "not_configured" | "upgrade_required";
  readonly health: "healthy" | "attention" | "unavailable";
  readonly alertDueAfterMs: number;
  readonly stats: PlatformJobStats;
  readonly jobs: readonly PlatformJobRecord[];
  readonly schedules: readonly PlatformJobSchedule[];
  readonly scheduleCount: number;
}

export interface InspectPlatformJobsOptions {
  databasePath: string | null;
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

function emptySnapshot(
  compatibility: Exclude<PlatformJobSnapshot["compatibility"], "ready">,
  alertDueAfterMs: number,
): PlatformJobSnapshot {
  return Object.freeze({
    available: compatibility !== "not_deployed",
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
