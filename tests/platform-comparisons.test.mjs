import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureDeploymentComparisons, recordDeploymentActivation, deploymentComparisonWindows } from "../dist/platform-comparisons.js";

test("activation history upgrades only current releases, preserves rollback timing, and stays bounded", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY, active_release_id TEXT);
      CREATE TABLE clank_platform_releases(id TEXT PRIMARY KEY, project_id TEXT, created_at INTEGER, activated_at INTEGER);
      INSERT INTO clank_platform_projects VALUES ('project', 'old');
      INSERT INTO clank_platform_releases VALUES ('old', 'project', 10, 20), ('new', 'project', 30, NULL);`);
    ensureDeploymentComparisons(db);
    ensureDeploymentComparisons(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM clank_platform_activations").get().n, 1);
    recordDeploymentActivation(db, "project", "new", 50);
    assert.equal(db.prepare("SELECT deployment_duration_ms AS ms FROM clank_platform_activations ORDER BY id DESC").get().ms, 20);
    recordDeploymentActivation(db, "project", "old", 50);
    assert.equal(db.prepare("SELECT deployment_duration_ms AS ms FROM clank_platform_activations ORDER BY id DESC").get().ms, null);
    assert.throws(() => recordDeploymentActivation(db, "other", "old", 60), /without its project release/);
    for (let index = 0; index < 101; index++) recordDeploymentActivation(db, "project", "old", 60 + index);
    assert.equal(db.prepare("SELECT count(*) AS n FROM clank_platform_activations").get().n, 100);
    db.exec("DELETE FROM clank_platform_projects");
    assert.equal(db.prepare("SELECT count(*) AS n FROM clank_platform_activations").get().n, 0);
  } finally { db.close(); }
});

test("comparison windows exclude transition minutes, cap at fifteen minutes, and tolerate clock reversal", () => {
  const minute = 60_000;
  assert.equal(deploymentComparisonWindows(20 * minute, 0, 100 * minute).durationMs, 15 * minute);
  assert.equal(deploymentComparisonWindows(20 * minute, 0, 19 * minute).durationMs, 0);
  assert.equal(deploymentComparisonWindows(20 * minute, 20 * minute, 100 * minute).durationMs, 0);
  const report = deploymentComparisonWindows(20 * minute + 1, 18 * minute, 30 * minute);
  assert.equal(report.durationMs, minute);
  assert.deepEqual(report.before, { start: 19 * minute, end: 20 * minute });
  assert.deepEqual(report.after, { start: 21 * minute, end: 22 * minute });
});
