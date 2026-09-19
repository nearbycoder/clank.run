import type { SQLiteInternal } from "./sqlite-internal.ts";

const MINUTE = 60_000;

export function ensureDeploymentComparisons(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    release_id TEXT NOT NULL,
    activated_at INTEGER NOT NULL,
    deployment_duration_ms INTEGER
  )`);
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_activations_project ON clank_platform_activations(project_id, id DESC)");
  // Only the current activation can be recovered reliably from legacy release rows:
  // rollback overwrites their activated_at field. Do not invent older history.
  internal.exec(`INSERT INTO clank_platform_activations(project_id, release_id, activated_at)
    SELECT p.id, r.id, r.activated_at FROM clank_platform_projects p
    JOIN clank_platform_releases r ON r.id = p.active_release_id
    WHERE r.activated_at IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM clank_platform_activations a WHERE a.project_id = p.id)`);
}

/** Called inside the activation transaction, before the release timestamp changes. */
export function recordDeploymentActivation(internal: SQLiteInternal, projectId: string, releaseId: string, at: number): void {
  const release = internal.prepare("SELECT created_at, activated_at FROM clank_platform_releases WHERE id = ? AND project_id = ?").get(releaseId, projectId);
  if (!release) throw new Error("Cannot record an activation without its project release.");
  internal.prepare(`INSERT INTO clank_platform_activations(project_id, release_id, activated_at, deployment_duration_ms)
    VALUES (?, ?, ?, ?)`).run(projectId, releaseId, at,
      release.activated_at === null ? Math.max(0, at - Number(release.created_at)) : null);
  internal.prepare(`DELETE FROM clank_platform_activations WHERE project_id = ? AND id NOT IN
    (SELECT id FROM clank_platform_activations WHERE project_id = ? ORDER BY id DESC LIMIT 100)`)
    .run(projectId, projectId);
}

/** Equal, complete-minute windows with no activation bucket or preceding release overlap. */
export function deploymentComparisonWindows(currentAt: number, previousAt: number, now: number) {
  const afterStart = Math.floor(currentAt / MINUTE) * MINUTE + MINUTE;
  const beforeEnd = Math.floor(currentAt / MINUTE) * MINUTE;
  const previousStart = Math.floor(previousAt / MINUTE) * MINUTE + MINUTE;
  const available = Math.min(Math.floor(now / MINUTE) * MINUTE - afterStart, beforeEnd - previousStart);
  const durationMs = Math.max(0, Math.min(15 * MINUTE, available));
  return { durationMs, before: { start: beforeEnd - durationMs, end: beforeEnd },
    after: { start: afterStart, end: afterStart + durationMs } };
}
