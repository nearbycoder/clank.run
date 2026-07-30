import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defineDatabase,
  defineJobs,
  defineTable,
  openJobs,
  openPlatform,
  openSQLite,
  s,
} from "../dist/index.js";
import {
  parsePlatformJobMutation,
  parsePlatformJobSnapshot,
} from "../dist/platform-jobs.js";

function jsonRequest(path, {
  method = "GET",
  body,
  token,
  cookie,
  csrf,
  origin = "http://127.0.0.1:4200",
} = {}) {
  return new Request(`http://127.0.0.1:4200${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        origin,
      }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-clank-csrf": csrf } : {}),
      "x-clank-client-ip": "127.0.0.1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function payload(platform, request, expected = 200) {
  const response = await platform.handle(request);
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

async function authorizeCli(platform, email) {
  const registered = await platform.handle(jsonRequest("/__clank/auth/register", {
    method: "POST",
    body: {
      email,
      password: "correct horse battery staple",
      profile: { name: "Job operator" },
    },
  }));
  assert.equal(registered.status, 201);
  const session = await registered.json();
  const cookie = registered.headers.get("set-cookie").split(";", 1)[0];
  const started = await payload(platform, jsonRequest("/api/device/start", {
    method: "POST",
    body: { clientName: "job operations test" },
  }), 201);
  await payload(platform, new Request("http://127.0.0.1:4200/api/device/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:4200",
      "x-clank-csrf": session.csrfToken,
      "x-clank-client-ip": "127.0.0.1",
    },
    body: JSON.stringify({ code: started.userCode }),
  }));
  const token = await payload(platform, jsonRequest("/api/device/token", {
    method: "POST",
    body: { deviceCode: started.deviceCode },
  }));
  return {
    accessToken: token.accessToken,
    cookie,
    csrfToken: session.csrfToken,
  };
}

async function seedProject(root) {
  const dataDirectory = join(root, "platform");
  const platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const authorization = await authorizeCli(platform, "jobs@example.com");
    const accessToken = authorization.accessToken;
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", { token: accessToken }));
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: accessToken,
      body: {
        name: "Job Operations",
        slug: `job-operations-${crypto.randomUUID().slice(0, 8)}`,
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    return {
      accessToken,
      cookie: authorization.cookie,
      csrfToken: authorization.csrfToken,
      dataDirectory,
      projectId: created.project.id,
    };
  } finally {
    await platform.close();
  }
}

async function seedJobs(seed) {
  const databaseDirectory = join(seed.dataDirectory, "projects", seed.projectId, "data");
  const databasePath = join(databaseDirectory, "app.sqlite");
  await mkdir(databaseDirectory, { recursive: true });
  const schema = defineDatabase({
    events: defineTable({ value: s.string() }),
  });
  const definition = defineJobs({ schema }).jobs(({ job }) => ({
    sendEmail: job({
      args: { recipient: s.string(), secret: s.string() },
      queue: "email",
      schedules: [{
        name: "daily-email",
        cron: "0 9 * * *",
        timezone: "America/Chicago",
        args: { recipient: "scheduled@example.com", secret: "scheduled-private" },
      }],
      handler: () => ({ delivered: true }),
    }),
    buildReport: job({
      args: { report: s.string() },
      queue: "reports",
      handler: () => ({ url: "private-result" }),
    }),
  }));
  const database = await openSQLite(schema, { path: databasePath, changePollIntervalMs: 0 });
  const jobs = openJobs(definition, { database });
  const dead = jobs.enqueue(definition.jobs.sendEmail, {
    recipient: "private@example.com",
    secret: "payload-secret",
  });
  const overdue = jobs.enqueue(definition.jobs.buildReport, { report: "private-overdue" });
  const running = jobs.enqueue(definition.jobs.buildReport, { report: "private-running" });
  const succeeded = jobs.enqueue(definition.jobs.buildReport, { report: "private-success" });
  jobs.close();
  database.close();

  const now = Date.now();
  const raw = new DatabaseSync(databasePath);
  raw.prepare(`UPDATE clank_jobs SET state = 'dead', attempts = max_attempts,
    error = ?, completed_at = ?, updated_at = ?, owner_id = ?, group_key = ?
    WHERE id = ?`).run(
    "Error: SMTP password payload-secret rejected",
    now - 60_000,
    now - 60_000,
    "private-owner",
    "private-group",
    dead.id,
  );
  raw.prepare(`UPDATE clank_jobs SET state = 'retry', run_at = ?, error = ?, updated_at = ?
    WHERE id = ?`).run(now - 20 * 60_000, "private retry failure", now - 20 * 60_000, overdue.id);
  raw.prepare(`UPDATE clank_jobs SET state = 'running', attempts = 1, started_at = ?,
    lease_token = ?, lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ?`).run(
    now - 10 * 60_000,
    "private-lease-token",
    "private-worker",
    now - 60_000,
    now - 60_000,
    running.id,
  );
  raw.prepare(`UPDATE clank_jobs SET state = 'succeeded', result = ?, completed_at = ?,
    updated_at = ? WHERE id = ?`).run(
    JSON.stringify({ private: "result-secret" }),
    now - 30_000,
    now - 30_000,
    succeeded.id,
  );
  raw.prepare("UPDATE clank_job_schedules SET last_error = ?").run(
    "private schedule error payload-secret",
  );
  raw.close();

  const control = new DatabaseSync(join(seed.dataDirectory, "control.sqlite"));
  control.prepare(
    "UPDATE clank_platform_projects SET database_path = ?, updated_at = ? WHERE id = ?",
  ).run("app.sqlite", now, seed.projectId);
  control.close();
  return { databasePath, dead, overdue, running, succeeded };
}

test("platform job operations are bounded, privacy-preserving, state-safe, and audited", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-jobs-"));
  const seed = await seedProject(root);
  const records = await seedJobs(seed);
  const platform = await openPlatform({
    dataDirectory: seed.dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: { intervalMs: false },
    jobs: { alertDueAfterMs: 5 * 60_000 },
  });
  try {
    const base = `/api/projects/${seed.projectId}/jobs`;
    const listed = await payload(platform, jsonRequest(`${base}?limit=10`, {
      token: seed.accessToken,
    }));
    assert.equal(listed.available, true);
    assert.equal(listed.configured, true);
    assert.equal(listed.compatibility, "ready");
    assert.equal(listed.health, "attention");
    assert.equal(listed.stats.dead, 1);
    assert.equal(listed.stats.overdue, 1);
    assert.equal(listed.stats.expiredLeases, 1);
    assert.equal(listed.stats.scheduleErrors, 1);
    assert.equal(listed.schedules[0].hasError, true);
    assert.deepEqual(listed.privacy, {
      arguments: "hidden",
      results: "hidden",
      errors: "presence_only",
      identities: "hidden",
    });
    const serialized = JSON.stringify(listed);
    for (const secret of [
      "payload-secret",
      "private@example.com",
      "private-overdue",
      "private-running",
      "private-success",
      "private-result",
      "private-owner",
      "private-group",
      "private-worker",
      "private-lease-token",
      "private schedule error",
    ]) assert.doesNotMatch(serialized, new RegExp(secret, "u"));
    assert.equal("args" in listed.jobs[0], false);
    assert.equal("result" in listed.jobs[0], false);
    assert.equal("error" in listed.jobs[0], false);
    assert.equal("ownerId" in listed.jobs[0], false);
    assert.equal("leaseOwner" in listed.jobs[0], false);

    const filtered = await payload(platform, jsonRequest(`${base}?state=dead&queue=email&limit=1`, {
      token: seed.accessToken,
    }));
    assert.deepEqual(filtered.jobs.map((job) => job.id), [records.dead.id]);
    const badFilter = await platform.handle(jsonRequest(`${base}?state=unknown`, {
      token: seed.accessToken,
    }));
    assert.equal(badFilter.status, 422);
    const duplicateFilter = await platform.handle(jsonRequest(`${base}?limit=1&limit=2`, {
      token: seed.accessToken,
    }));
    assert.equal(duplicateFilter.status, 422);
    const badQueueFilter = await platform.handle(jsonRequest(`${base}?queue=private%20queue`, {
      token: seed.accessToken,
    }));
    assert.equal(badQueueFilter.status, 422);
    assert.equal((await badQueueFilter.json()).error.code, "INVALID_JOB_FILTER");

    const readToken = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}/tokens`,
      {
        method: "POST",
        token: seed.accessToken,
        body: {
          name: "read-only queue monitor",
          permissions: ["read"],
          expiresIn: 3_600,
        },
      },
    ), 201);
    const monitored = await payload(platform, jsonRequest(`${base}?limit=1`, {
      token: readToken.token.accessToken,
    }));
    assert.equal(monitored.jobs.length, 1);
    const readTokenDetail = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}`,
      { token: readToken.token.accessToken },
    ));
    assert.equal(readTokenDetail.access.canOperateJobs, false);
    const deniedMutation = await platform.handle(jsonRequest(
      `${base}/${records.overdue.id}/cancel`,
      { method: "POST", token: readToken.token.accessToken, body: {} },
    ));
    assert.equal(deniedMutation.status, 403);
    assert.equal((await deniedMutation.json()).error.code, "TOKEN_SCOPE_DENIED");
    const missingCsrf = await platform.handle(jsonRequest(
      `${base}/${records.overdue.id}/cancel`,
      {
        method: "POST",
        cookie: seed.cookie,
        body: {},
      },
    ));
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error.code, "INVALID_CSRF");

    const jobsToken = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}/tokens`,
      {
        method: "POST",
        token: seed.accessToken,
        body: {
          name: "queue operator",
          permissions: ["read", "jobs"],
          expiresIn: 3_600,
        },
      },
    ), 201);
    const jobsTokenDetail = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}`,
      { token: jobsToken.token.accessToken },
    ));
    assert.equal(jobsTokenDetail.access.canOperateJobs, true);
    const cancelled = await payload(
      platform,
      jsonRequest(`${base}/${records.overdue.id}/cancel`, {
        method: "POST",
        token: jobsToken.token.accessToken,
        body: {},
      }),
    );
    assert.equal(cancelled.job.state, "cancelled");
    assert.equal(cancelled.job.cancelRequested, true);
    const runningCancellation = await payload(
      platform,
      jsonRequest(`${base}/${records.running.id}/cancel`, {
        method: "POST",
        cookie: seed.cookie,
        csrf: seed.csrfToken,
        body: {},
      }),
    );
    assert.equal(runningCancellation.job.state, "running");
    assert.equal(runningCancellation.job.cancelRequested, true);
    const retried = await payload(platform, jsonRequest(`${base}/${records.dead.id}/retry`, {
      method: "POST",
      token: seed.accessToken,
      body: { runAt: Date.now() + 1_000 },
    }));
    assert.equal(retried.job.state, "queued");
    assert.equal(retried.job.attempt, 0);
    assert.equal(retried.job.hasError, false);

    const stateConflict = await platform.handle(jsonRequest(
      `${base}/${records.succeeded.id}/cancel`,
      { method: "POST", token: seed.accessToken, body: {} },
    ));
    assert.equal(stateConflict.status, 409);
    assert.equal((await stateConflict.json()).error.code, "JOB_STATE_CONFLICT");
    const missing = await platform.handle(jsonRequest(
      `${base}/job_${"0".repeat(32)}/retry`,
      { method: "POST", token: seed.accessToken, body: {} },
    ));
    assert.equal(missing.status, 404);

    const control = new DatabaseSync(join(seed.dataDirectory, "control.sqlite"), { readOnly: true });
    const actions = control.prepare(`SELECT action, metadata FROM clank_platform_audit
      WHERE project_id = ? AND action LIKE 'job.%' ORDER BY id`).all(seed.projectId);
    control.close();
    assert.deepEqual(actions.map((row) => row.action), [
      "job.cancel",
      "job.cancel",
      "job.retry",
    ]);
    assert.doesNotMatch(JSON.stringify(actions), /payload-secret|private@example\.com|private-worker/u);
    const app = new DatabaseSync(records.databasePath, { readOnly: true });
    const events = app.prepare(`SELECT event, details FROM clank_job_events
      WHERE job_id IN (?, ?, ?) ORDER BY id`).all(
      records.overdue.id,
      records.running.id,
      records.dead.id,
    );
    app.close();
    assert.equal(events.filter((event) => event.event === "cancel_requested").length, 2);
    assert.equal(events.filter((event) => event.event === "retried").length, 1);
    assert.equal(events.every((event) => event.details === "{}"
      || !event.details.includes("jobs@example.com")), true);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("job inspection explains undeployed, unconfigured, and legacy-schema states", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-job-compatibility-"));
  const seed = await seedProject(root);
  let platform = await openPlatform({
    dataDirectory: seed.dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const undeployed = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}/jobs`,
      { token: seed.accessToken },
    ));
    assert.equal(undeployed.compatibility, "not_deployed");
    await platform.close();

    const databaseDirectory = join(seed.dataDirectory, "projects", seed.projectId, "data");
    await mkdir(databaseDirectory, { recursive: true });
    const databasePath = join(databaseDirectory, "app.sqlite");
    let database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE app_data (id INTEGER PRIMARY KEY)");
    database.close();
    const control = new DatabaseSync(join(seed.dataDirectory, "control.sqlite"));
    control.prepare(
      "UPDATE clank_platform_projects SET database_path = 'app.sqlite', updated_at = ? WHERE id = ?",
    ).run(Date.now(), seed.projectId);
    control.close();
    platform = await openPlatform({
      dataDirectory: seed.dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      signup: true,
      backups: { intervalMs: false },
    });
    const unconfigured = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}/jobs`,
      { token: seed.accessToken },
    ));
    assert.equal(unconfigured.compatibility, "not_configured");
    await platform.close();

    database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE clank_jobs (id TEXT PRIMARY KEY, payload TEXT)");
    database.close();
    platform = await openPlatform({
      dataDirectory: seed.dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      signup: true,
      backups: { intervalMs: false },
    });
    const legacy = await payload(platform, jsonRequest(
      `/api/projects/${seed.projectId}/jobs`,
      { token: seed.accessToken },
    ));
    assert.equal(legacy.compatibility, "upgrade_required");
    const mutation = await platform.handle(jsonRequest(
      `/api/projects/${seed.projectId}/jobs/job_${"0".repeat(32)}/retry`,
      { method: "POST", token: seed.accessToken, body: {} },
    ));
    assert.equal(mutation.status, 409);
    assert.equal((await mutation.json()).error.code, "JOB_SCHEMA_UPGRADE_REQUIRED");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider job payload parsing rejects extra private data and inconsistent state", () => {
  const snapshot = {
    available: true,
    configured: true,
    compatibility: "ready",
    health: "healthy",
    alertDueAfterMs: 300_000,
    stats: {
      queued: 1,
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
    },
    jobs: [{
      id: `job_${"1".repeat(32)}`,
      name: "sync.todo",
      queue: "default",
      state: "queued",
      priority: 0,
      attempt: 0,
      maxAttempts: 3,
      runAt: 1_850_000_000_000,
      scheduledAt: null,
      cron: null,
      createdAt: 1_750_000_000_000,
      updatedAt: 1_750_000_000_000,
      startedAt: null,
      completedAt: null,
      leaseUntil: null,
      cancelRequested: false,
      hasError: false,
    }],
    schedules: [],
    scheduleCount: 0,
  };
  const parsed = parsePlatformJobSnapshot(snapshot);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(parsed.jobs[0].name, "sync.todo");

  assert.throws(
    () => parsePlatformJobSnapshot({
      ...snapshot,
      jobs: [{ ...snapshot.jobs[0], payload: { secret: "must-not-cross" } }],
    }),
    /invalid fields/u,
  );
  assert.throws(
    () => parsePlatformJobSnapshot({ ...snapshot, health: "attention" }),
    /health is inconsistent/u,
  );
  assert.throws(
    () => parsePlatformJobMutation({
      changed: false,
      reason: "changed",
      job: snapshot.jobs[0],
    }),
    /state is inconsistent/u,
  );
});
