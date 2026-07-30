import type { BackupManifest } from "./recovery.ts";
import type { SQLiteInternal } from "./sqlite-internal.ts";

export interface PlatformBackupPolicy {
  enabled: boolean;
  intervalMs: number | null;
  batchSize: number;
  concurrency: number;
  maxBackups: number;
  maxAgeMs: number;
  maxDatabaseBytes: number;
}

export interface PlatformBackupStatus extends PlatformBackupPolicy {
  available: boolean;
  running: boolean;
  nextBackupAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastBackupId: string | null;
  lastError: string | null;
}

export interface PlatformBackupScheduler {
  start(): void;
  registerProject(projectId: string): void;
  recordBackup(projectId: string, backup: BackupManifest): void;
  status(projectId: string, available: boolean): PlatformBackupStatus;
  close(): Promise<void>;
}

interface BackupClaim {
  projectId: string;
  token: string;
}

export function createPlatformBackupScheduler(options: {
  internal: SQLiteInternal;
  policy: PlatformBackupPolicy;
  createBackup(projectId: string): Promise<BackupManifest>;
  retryMs?: number;
  leaseMs?: number;
  onError?: (error: unknown) => void;
}): PlatformBackupScheduler {
  const { internal, policy } = options;
  const retryMs = integerRange(
    options.retryMs ?? Math.min(policy.intervalMs ?? 5 * 60_000, 5 * 60_000),
    "backup retryMs",
    1_000,
    24 * 60 * 60_000,
  );
  const leaseMs = integerRange(options.leaseMs ?? 30 * 60_000, "backup leaseMs", 10_000, 60 * 60_000);
  ensureSchema(internal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let closed = false;

  const report = (error: unknown): void => {
    try { options.onError?.(error); }
    catch { /* Operator reporting must not alter backup scheduling. */ }
  };

  const registerProject = (projectId: string): void => {
    if (!policy.enabled || closed) return;
    const now = Date.now();
    try {
      internal.prepare(`INSERT INTO clank_platform_backup_schedules
        (project_id, next_backup_at, lease_token, lease_until, last_started_at,
         last_completed_at, last_backup_id, last_error, updated_at)
        VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(project_id) DO NOTHING`)
        .run(projectId, now + policy.intervalMs!, now);
    } catch (error) {
      report(error);
    }
  };

  const recordBackup = (projectId: string, backup: BackupManifest): void => {
    if (closed) return;
    const now = Date.now();
    try {
      internal.prepare(`INSERT INTO clank_platform_backup_schedules
        (project_id, next_backup_at, lease_token, lease_until, last_started_at,
         last_completed_at, last_backup_id, last_error, updated_at)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          next_backup_at = excluded.next_backup_at,
          lease_token = NULL,
          lease_until = NULL,
          last_started_at = excluded.last_started_at,
          last_completed_at = excluded.last_completed_at,
          last_backup_id = excluded.last_backup_id,
          last_error = NULL,
          updated_at = excluded.updated_at`)
        .run(projectId, policy.enabled ? now + policy.intervalMs! : null, now, now, backup.id, now);
    } catch (error) {
      report(error);
    }
  };

  const claim = (now: number): BackupClaim[] => internal.transaction(() => {
    const candidates = internal.prepare(`SELECT s.project_id
      FROM clank_platform_backup_schedules s
      JOIN clank_platform_projects p ON p.id = s.project_id
      WHERE p.database_path IS NOT NULL
        AND s.next_backup_at IS NOT NULL
        AND s.next_backup_at <= ?
        AND (s.lease_until IS NULL OR s.lease_until <= ?)
      ORDER BY s.next_backup_at, s.project_id
      LIMIT ?`).all(now, now, policy.batchSize);
    const output: BackupClaim[] = [];
    for (const candidate of candidates) {
      const projectId = String(candidate.project_id);
      const token = `backup_${crypto.randomUUID()}`;
      const result = internal.prepare(`UPDATE clank_platform_backup_schedules
        SET lease_token = ?, lease_until = ?, last_started_at = ?, last_error = NULL, updated_at = ?
        WHERE project_id = ? AND next_backup_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?)`)
        .run(token, now + leaseMs, now, now, projectId, now, now);
      if (Number(result.changes) === 1) output.push({ projectId, token });
    }
    return output;
  });

  const work = async (claim: BackupClaim): Promise<void> => {
    let leaseLost = false;
    const renewer = setInterval(() => {
      try {
        const now = Date.now();
        const result = internal.prepare(`UPDATE clank_platform_backup_schedules
          SET lease_until = ?, updated_at = ?
          WHERE project_id = ? AND lease_token = ? AND lease_until > ?`)
          .run(now + leaseMs, now, claim.projectId, claim.token, now);
        if (Number(result.changes) !== 1) leaseLost = true;
      } catch (error) {
        leaseLost = true;
        report(error);
      }
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    renewer.unref?.();
    try {
      const backup = await options.createBackup(claim.projectId);
      if (leaseLost) return;
      const now = Date.now();
      internal.prepare(`UPDATE clank_platform_backup_schedules SET
        next_backup_at = ?, lease_token = NULL, lease_until = NULL,
        last_completed_at = ?, last_backup_id = ?, last_error = NULL, updated_at = ?
        WHERE project_id = ? AND lease_token = ?`)
        .run(now + policy.intervalMs!, now, backup.id, now, claim.projectId, claim.token);
    } catch (error) {
      const now = Date.now();
      internal.prepare(`UPDATE clank_platform_backup_schedules SET
        next_backup_at = ?, lease_token = NULL, lease_until = NULL,
        last_completed_at = ?, last_error = ?, updated_at = ?
        WHERE project_id = ? AND lease_token = ?`)
        .run(
          now + retryMs,
          now,
          "Scheduled backup failed. See private operator logs.",
          now,
          claim.projectId,
          claim.token,
        );
      report(error);
    } finally {
      clearInterval(renewer);
    }
  };

  const run = async (): Promise<void> => {
    if (!policy.enabled || closed || flight) return;
    const claims = claim(Date.now());
    try {
      await runBounded(claims, policy.concurrency, work, () => closed);
    } finally {
      internal.transaction(() => {
        for (const entry of claims) {
          internal.prepare(`UPDATE clank_platform_backup_schedules
            SET lease_token = NULL, lease_until = NULL, updated_at = ?
            WHERE project_id = ? AND lease_token = ?`)
            .run(Date.now(), entry.projectId, entry.token);
        }
      });
    }
  };

  const nextDelay = (): number => {
    const intervalMs = policy.intervalMs!;
    const now = Date.now();
    const row = internal.prepare(`SELECT min(
        CASE
          WHEN lease_until IS NOT NULL AND lease_until > ? THEN lease_until
          ELSE next_backup_at
        END
      ) AS runnable_at
      FROM clank_platform_backup_schedules
      WHERE next_backup_at IS NOT NULL`).get(now);
    if (row?.runnable_at === null || row?.runnable_at === undefined) return intervalMs;
    return Math.max(0, Math.min(intervalMs, Number(row.runnable_at) - now));
  };

  const schedule = (requestedDelayMs?: number): void => {
    if (!policy.enabled || closed || timer) return;
    let delayMs = requestedDelayMs;
    if (delayMs === undefined) {
      try {
        delayMs = nextDelay();
      } catch (error) {
        report(error);
        delayMs = retryMs;
      }
    }
    timer = setTimeout(() => {
      timer = undefined;
      const current = run().catch(report);
      flight = current;
      void current.then(() => {
        if (flight === current) flight = undefined;
        if (!closed) schedule();
      });
    }, delayMs);
    timer.unref?.();
  };

  return {
    start() {
      if (!policy.enabled || closed) return;
      const now = Date.now();
      try {
        internal.prepare(`INSERT INTO clank_platform_backup_schedules
          (project_id, next_backup_at, lease_token, lease_until, last_started_at,
           last_completed_at, last_backup_id, last_error, updated_at)
          SELECT id, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?
          FROM clank_platform_projects p WHERE p.database_path IS NOT NULL
          ON CONFLICT(project_id) DO NOTHING`).run(now, now);
        schedule(0);
      } catch (error) {
        report(error);
        schedule(retryMs);
      }
    },
    registerProject,
    recordBackup,
    status(projectId, available) {
      const row = internal.prepare(`SELECT next_backup_at, lease_until, last_started_at,
        last_completed_at, last_backup_id, last_error
        FROM clank_platform_backup_schedules WHERE project_id = ?`).get(projectId);
      return {
        ...policy,
        available,
        running: policy.enabled && Boolean(row?.lease_until && Number(row.lease_until) > Date.now()),
        nextBackupAt: policy.enabled ? nullableNumber(row?.next_backup_at) : null,
        lastStartedAt: nullableNumber(row?.last_started_at),
        lastCompletedAt: nullableNumber(row?.last_completed_at),
        lastBackupId: nullableString(row?.last_backup_id),
        lastError: nullableString(row?.last_error),
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await flight?.catch(() => undefined);
    },
  };
}

function ensureSchema(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_backup_schedules (
    project_id TEXT PRIMARY KEY REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    next_backup_at INTEGER,
    lease_token TEXT,
    lease_until INTEGER,
    last_started_at INTEGER,
    last_completed_at INTEGER,
    last_backup_id TEXT,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_platform_backup_schedules_due
    ON clank_platform_backup_schedules (next_backup_at, lease_until)`);
}

async function runBounded<Input>(
  inputs: readonly Input[],
  concurrency: number,
  worker: (input: Input) => Promise<void>,
  stopped: () => boolean,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (!stopped()) {
      const index = cursor++;
      if (index >= inputs.length) return;
      await worker(inputs[index]!);
    }
  });
  await Promise.all(runners);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function integerRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
