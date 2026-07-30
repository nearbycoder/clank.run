import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDeploymentBundle } from "../dist/deploy.js";
import { openDeploymentProviderDataStore } from "../dist/provider-data.js";
import {
  deploymentProviderDiagnosticsPath,
  deploymentProviderJobMutationPath,
  deploymentProviderJobsPath,
  deploymentProviderSnapshotPath,
  DEPLOYMENT_PROVIDER_DIAGNOSTICS_MEDIA_TYPE,
  DEPLOYMENT_PROVIDER_JOBS_MEDIA_TYPE,
  DEPLOYMENT_PROVIDER_JOBS_PROTOCOL,
  DEPLOYMENT_PROVIDER_SNAPSHOT_MEDIA_TYPE,
  DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
  openDeploymentProviderService,
} from "../dist/provider-service.js";
import { createDeploymentRuntimeCapsule } from "../dist/runtime-placement.js";

test("provider service orders durable data, deferred jobs, ingress, stop, and restart recovery", async () => {
  const fixture = await serviceFixture("lifecycle");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_service_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "initial"),
      jobs: true,
    });
    const request = providerInput(runtime, 1);
    const first = await fixture.open();
    await first.service.reconcile(request);
    assert.deepEqual(first.events, [
      "launch-web:1",
      "activate-background:1",
      "ingress-activate:1",
    ]);
    const firstState = await first.service.inspect("project_service_01");
    assert.deepEqual(firstState, {
      protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
      projectId: "project_service_01",
      operationId: "operation_1_1",
      fence: 1,
      generation: 1,
      state: "running",
      releaseId: "release_service_01",
      capsuleSha256: runtime.sha256,
      phase: "running",
      updatedAt: firstState.updatedAt,
    });
    const persisted = await readFile(join(
      fixture.providerRoot,
      "service",
      "project_service_01.json",
    ), "utf8");
    assert.equal(persisted.includes("service-secret-canary"), false);
    assert.equal(
      persisted.includes("clankc_provider-service-control-token"),
      false,
    );
    const providerData = await fixture.data.inspect("project_service_01");
    const providerDatabaseFile = join(
      fixture.providerRoot,
      "projects",
      "project_service_01",
      providerData.databasePath,
    );
    seedJobsDatabase(providerDatabaseFile);
    const expectedSnapshot = await first.service.snapshot("project_service_01");
    assert.equal(expectedSnapshot.generation, 1);
    const snapshotPath = deploymentProviderSnapshotPath("project_service_01");
    const deniedSnapshot = await first.service.handle(new Request(
      `https://provider.example${snapshotPath}`,
    ));
    assert.equal(deniedSnapshot.status, 404);
    assert.equal((await deniedSnapshot.json()).error.code, "CONTROL_NOT_FOUND");
    assert.equal((await first.service.handle(new Request(
      `https://provider.example${snapshotPath}?generation=1`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ))).status, 404);
    assert.equal((await first.service.handle(new Request(
      `https://provider.example${snapshotPath}`,
      {
        method: "POST",
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ))).status, 404);
    const remoteSnapshot = await first.service.handle(new Request(
      `https://provider.example${snapshotPath}`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ));
    assert.equal(remoteSnapshot.status, 200);
    assert.equal(
      remoteSnapshot.headers.get("content-type"),
      DEPLOYMENT_PROVIDER_SNAPSHOT_MEDIA_TYPE,
    );
    assert.equal(remoteSnapshot.headers.get("cache-control"), "private, no-store");
    assert.equal(
      remoteSnapshot.headers.get("x-clank-content-sha256"),
      expectedSnapshot.sha256,
    );
    assert.equal(
      remoteSnapshot.headers.get("x-clank-release-id"),
      "release_service_01",
    );
    assert.equal(remoteSnapshot.headers.get("x-clank-runtime-generation"), "1");
    const remoteBytes = new Uint8Array(await remoteSnapshot.arrayBuffer());
    assert.deepEqual(remoteBytes, expectedSnapshot.bytes);
    assert.equal(
      Number(remoteSnapshot.headers.get("content-length")),
      remoteBytes.byteLength,
    );
    const diagnosticsPath = deploymentProviderDiagnosticsPath(
      "project_service_01",
    );
    assert.equal((await first.service.handle(new Request(
      `https://provider.example${diagnosticsPath}`,
    ))).status, 404);
    assert.equal((await first.service.handle(new Request(
      `https://provider.example${diagnosticsPath}?unknown=1`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ))).status, 404);
    const remoteDiagnostics = await first.service.handle(new Request(
      `https://provider.example${diagnosticsPath}?logs=20`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ));
    assert.equal(remoteDiagnostics.status, 200);
    assert.equal(
      remoteDiagnostics.headers.get("content-type"),
      DEPLOYMENT_PROVIDER_DIAGNOSTICS_MEDIA_TYPE,
    );
    assert.equal(
      remoteDiagnostics.headers.get("x-clank-release-id"),
      "release_service_01",
    );
    assert.equal(
      remoteDiagnostics.headers.get("x-clank-runtime-generation"),
      "1",
    );
    const diagnostics = await remoteDiagnostics.json();
    assert.equal(diagnostics.projectId, "project_service_01");
    assert.equal(diagnostics.releaseId, "release_service_01");
    assert.equal(diagnostics.generation, 1);
    assert.equal(diagnostics.statisticsAvailable, true);
    assert.equal(diagnostics.logs[0].message, "fake provider runtime output");
    assert.deepEqual(
      await first.service.diagnostics("project_service_01", 1),
      diagnostics,
    );
    assert.deepEqual(
      (await first.service.diagnostics("project_service_01", 0)).logs,
      [],
    );
    const jobsPath = deploymentProviderJobsPath("project_service_01");
    assert.equal((await first.service.handle(new Request(
      "https://provider.example/v1/clank/control/project_service_01/jobs/not-a-job/cancel",
    ))).status, 404);
    assert.equal((await first.service.handle(new Request(
      `https://provider.example${jobsPath}`,
    ))).status, 404);
    const remoteJobs = await first.service.handle(new Request(
      `https://provider.example${jobsPath}?queue=default&limit=10&alertDueAfterMs=60000`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ));
    assert.equal(remoteJobs.status, 200);
    assert.equal(
      remoteJobs.headers.get("content-type"),
      DEPLOYMENT_PROVIDER_JOBS_MEDIA_TYPE,
    );
    const jobs = await remoteJobs.json();
    assert.equal(jobs.protocol, DEPLOYMENT_PROVIDER_JOBS_PROTOCOL);
    assert.equal(jobs.projectId, "project_service_01");
    assert.equal(jobs.releaseId, "release_service_01");
    assert.equal(jobs.generation, 1);
    assert.equal(jobs.snapshot.compatibility, "ready");
    assert.equal(jobs.snapshot.jobs[0].id, "job_0123456789abcdef0123456789abcdef");
    assert.equal("payload" in jobs.snapshot.jobs[0], false);
    assert.equal("result" in jobs.snapshot.jobs[0], false);
    assert.equal("error" in jobs.snapshot.jobs[0], false);

    const cancelBody = JSON.stringify({});
    const remoteCancel = await first.service.handle(new Request(
      `https://provider.example${deploymentProviderJobMutationPath(
        "project_service_01",
        "job_0123456789abcdef0123456789abcdef",
        "cancel",
      )}`,
      {
        method: "POST",
        body: cancelBody,
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
          "content-length": String(Buffer.byteLength(cancelBody)),
          "content-type": "application/json",
        },
      },
    ));
    assert.equal(remoteCancel.status, 200);
    assert.equal((await remoteCancel.json()).mutation.job.state, "cancelled");

    const retryBody = JSON.stringify({ runAt: 1_750_000_000_000 });
    const remoteRetry = await first.service.handle(new Request(
      `https://provider.example${deploymentProviderJobMutationPath(
        "project_service_01",
        "job_0123456789abcdef0123456789abcdef",
        "retry",
      )}`,
      {
        method: "POST",
        body: retryBody,
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
          "content-length": String(Buffer.byteLength(retryBody)),
          "content-type": "application/json",
        },
      },
    ));
    assert.equal(remoteRetry.status, 200);
    const retried = await remoteRetry.json();
    assert.equal(retried.mutation.job.state, "queued");
    assert.equal(retried.mutation.job.runAt, 1_750_000_000_000);
    const outsideSidecar = join(fixture.root, "outside-provider-wal");
    await writeFile(outsideSidecar, "not a provider database sidecar");
    await symlink(outsideSidecar, `${providerDatabaseFile}-wal`);
    assert.equal((await first.service.handle(new Request(
      `https://provider.example${jobsPath}`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ))).status, 503);
    await rm(`${providerDatabaseFile}-wal`, { force: true });
    assert.equal(await (await first.service.handle(new Request(
      "https://provider.example/v1/clank/apps/project_service_01",
    ))).text(), "fake ingress");

    const beforeRetry = first.events.length;
    await first.service.reconcile(request);
    assert.deepEqual(first.events.slice(beforeRetry), [
      "launch-retry:1",
      "activate-retry:1",
      "ingress-retry:1",
    ]);
    assert.equal(first.events.includes("runtime-stop:1"), false);
    await first.service.close();

    const restarted = await fixture.open();
    assert.equal((await restarted.service.handle(new Request(
      `https://provider.example${snapshotPath}`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ))).status, 404);
    await restarted.service.reconcile(request);
    assert.deepEqual(restarted.events, [
      "launch-web:1",
      "activate-background:1",
      "ingress-activate:1",
    ]);
    const stopped = stoppedInput(2, 2);
    await restarted.service.reconcile(stopped);
    assert.deepEqual(restarted.events.slice(-2), [
      "ingress-deactivate:1",
      "runtime-stop:1",
    ]);
    assert.equal((await restarted.service.inspect("project_service_01")).phase, "stopped");
    assert.equal((await fixture.data.inspect("project_service_01")).generation, 1);
    assert.equal((await restarted.service.handle(new Request(
      `https://provider.example${snapshotPath}`,
      {
        headers: {
          authorization:
            "Bearer clankc_provider-service-control-token-12345678901234567890",
        },
      },
    ))).status, 404);
    await assert.rejects(
      restarted.service.reconcile(providerInput(runtime, 3)),
      /generation is stale/u,
    );
    await restarted.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service fences, drains, retries, rolls back, and deletes project data", async () => {
  const fixture = await serviceFixture("destructive-lifecycle");
  try {
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_lifecycle_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "first"),
    });
    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_lifecycle_02",
      mode: "preserve",
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
        ["0002_done.sql", "ALTER TABLE todo ADD COLUMN done INTEGER DEFAULT 0;\n"],
      ],
    });
    const opened = await fixture.open();
    await opened.service.reconcile(providerInput(firstRuntime, 1));
    await opened.service.reconcile(providerInput(secondRuntime, 2));

    await assert.rejects(
      opened.service.rollback(lifecycleInput("rollback", 2, 2)),
      /conflicts with its durable fence/u,
    );
    await assert.rejects(
      opened.service.rollback({
        ...lifecycleInput("rollback", 2, 3),
        confirmation: "rollback another_project 2",
      }),
      /confirmation must equal/u,
    );
    const credentialBearing = lifecycleInput("rollback", 2, 3);
    await assert.rejects(
      opened.service.rollback({
        ...credentialBearing,
        operation: {
          ...credentialBearing.operation,
          leaseToken: "must-not-cross-provider-boundary",
        },
      }),
      /rollback operation is invalid/u,
    );
    const restored = await opened.service.rollback(lifecycleInput("rollback", 2, 3));
    assert.equal(restored.generation, 1);
    assert.equal(restored.fence, 3);
    assert.equal(restored.rollbackAvailable, false);
    assert.deepEqual(opened.events.slice(-2), [
      "ingress-deactivate:2",
      "runtime-stop:2",
    ]);
    const rolledBack = await opened.service.inspect("project_service_01");
    assert.equal(rolledBack.phase, "rolled-back");
    assert.equal(rolledBack.generation, 2);
    assert.equal(rolledBack.operationId, "operation_rollback_2_3");
    assert.equal((await opened.service.rollback(
      lifecycleInput("rollback", 2, 3),
    )).generation, 1);

    const resumedRuntime = await fixture.runtime({
      generation: 3,
      releaseId: "release_lifecycle_01",
      mode: "preserve",
    });
    await opened.service.reconcile(providerInput(resumedRuntime, 4));
    assert.equal((await opened.service.inspect("project_service_01")).phase, "running");

    opened.ingress.shouldDrain = false;
    await assert.rejects(
      opened.service.delete(lifecycleInput("delete", 3, 5)),
      /did not drain/u,
    );
    assert.equal((await fixture.data.inspect("project_service_01")).generation, 3);
    assert.equal(opened.runtimes.inspect()[0].generation, 3);
    opened.ingress.shouldDrain = true;
    assert.equal(
      await opened.service.delete(lifecycleInput("delete", 3, 5)),
      true,
    );
    assert.equal(await fixture.data.inspect("project_service_01"), null);
    assert.equal(await opened.service.inspect("project_service_01"), null);
    assert.equal(
      await opened.service.delete(lifecycleInput("delete", 3, 5)),
      false,
    );
    await opened.service.close();
    await assert.rejects(
      opened.service.snapshot("project_service_01"),
      /service is closed/u,
    );
  } finally {
    await fixture.close();
  }
});

test("provider service resumes rollback and deletion after their data commit points", async () => {
  const fixture = await serviceFixture("lifecycle-crash-recovery");
  try {
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_crash_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "first"),
    });
    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_crash_02",
      mode: "preserve",
    });
    const first = await fixture.open();
    await first.service.reconcile(providerInput(firstRuntime, 1));
    await first.service.reconcile(providerInput(secondRuntime, 2));
    await first.service.close();

    const statePath = join(
      fixture.providerRoot,
      "service",
      "project_service_01.json",
    );
    const rollbackRequest = lifecycleInput("rollback", 2, 3);
    await writeFile(statePath, JSON.stringify({
      protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
      projectId: "project_service_01",
      operationId: rollbackRequest.operation.id,
      fence: rollbackRequest.operation.fence,
      generation: rollbackRequest.generation,
      state: "stopped",
      releaseId: null,
      capsuleSha256: null,
      phase: "rolling-back",
      updatedAt: Date.now(),
    }), { mode: 0o600 });
    const interruptedRollback = await fixture.open();
    await assert.rejects(
      interruptedRollback.service.reconcile(providerInput(secondRuntime, 3)),
      /lifecycle operation is incomplete/u,
    );
    await interruptedRollback.service.close();
    await fixture.data.rollback({
      projectId: "project_service_01",
      generation: 2,
      confirmation: "rollback project_service_01 2",
      fence: 3,
    });

    const afterRollbackCrash = await fixture.open();
    assert.equal(
      (await afterRollbackCrash.service.rollback(rollbackRequest)).generation,
      1,
    );
    assert.equal(
      (await afterRollbackCrash.service.inspect("project_service_01")).phase,
      "rolled-back",
    );
    const resumedRuntime = await fixture.runtime({
      generation: 3,
      releaseId: "release_crash_01",
      mode: "preserve",
    });
    await afterRollbackCrash.service.reconcile(providerInput(resumedRuntime, 4));
    await afterRollbackCrash.service.close();

    const deleteRequest = lifecycleInput("delete", 3, 5);
    await writeFile(statePath, JSON.stringify({
      protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
      projectId: "project_service_01",
      operationId: deleteRequest.operation.id,
      fence: deleteRequest.operation.fence,
      generation: deleteRequest.generation,
      state: "stopped",
      releaseId: null,
      capsuleSha256: null,
      phase: "deleting",
      updatedAt: Date.now(),
    }), { mode: 0o600 });
    await fixture.data.delete({
      projectId: "project_service_01",
      confirmation: "delete project_service_01",
    });

    const afterDeleteCrash = await fixture.open();
    assert.equal(await afterDeleteCrash.service.delete(deleteRequest), true);
    assert.equal(await afterDeleteCrash.service.inspect("project_service_01"), null);
    await afterDeleteCrash.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service rejects unsafe roots and verifies capsules before durable intent", async () => {
  const linked = await serviceFixture("linked-state");
  try {
    const outside = join(linked.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(linked.providerRoot, "service"), "dir");
    await assert.rejects(
      linked.open(),
      /owner-controlled real directory|outside its provider root/u,
    );
  } finally {
    await linked.close();
  }

  const fixture = await serviceFixture("capsule-admission");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_admission_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "initial"),
    });
    const opened = await fixture.open();
    const tampered = new Uint8Array(runtime.bytes);
    tampered[tampered.byteLength - 1] ^= 1;
    await assert.rejects(
      opened.service.reconcile({
        ...providerInput(runtime, 5),
        operation: {
          ...providerInput(runtime, 5).operation,
          id: "operation_tampered_5",
          fence: 5,
        },
        runtime: {
          ...runtime,
          bytes: tampered,
        },
      }),
      /requires a running runtime capsule/u,
    );
    assert.equal(await opened.service.inspect("project_service_01"), null);
    await opened.service.reconcile(providerInput(runtime, 1));
    assert.equal((await opened.service.inspect("project_service_01")).generation, 1);
    await opened.service.close();
    await assert.rejects(
      opened.service.reconcile(providerInput(runtime, 2)),
      /service is closed/u,
    );
  } finally {
    await fixture.close();
  }
});

test("provider service bootstraps its durable high-water mark from existing provider data", async () => {
  const fixture = await serviceFixture("existing-data");
  try {
    const runtime = await fixture.runtime({
      generation: 3,
      releaseId: "release_existing_03",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "existing"),
    });
    await fixture.data.apply(providerInput(runtime, 4), async () => {});
    const opened = await fixture.open();
    await assert.rejects(
      opened.service.reconcile(stoppedInput(3, 5)),
      /conflicts with provider data/u,
    );
    await assert.rejects(
      opened.service.reconcile({
        ...stoppedInput(4, 4),
        operation: {
          ...stoppedInput(4, 4).operation,
          id: "operation_stop_4_4",
        },
      }),
      /fence is stale against provider data/u,
    );
    assert.equal(await opened.service.inspect("project_service_01"), null);
    await opened.service.reconcile(providerInput(runtime, 4));
    assert.equal((await opened.service.inspect("project_service_01")).phase, "running");
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service fails closed after activation failure and retries committed data", async () => {
  const fixture = await serviceFixture("activation");
  try {
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_activation_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "first"),
      jobs: true,
    });
    const opened = await fixture.open();
    await opened.service.reconcile(providerInput(firstRuntime, 1));
    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_activation_02",
      mode: "preserve",
      jobs: true,
      migrations: [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
        ["0002_done.sql", "ALTER TABLE todo ADD COLUMN done INTEGER DEFAULT 0;\n"],
      ],
    });
    opened.ingress.failGeneration = 2;
    const secondRequest = providerInput(secondRuntime, 2);
    await assert.rejects(
      opened.service.reconcile(secondRequest),
      /synthetic ingress activation failure/u,
    );
    assert.equal((await fixture.data.inspect("project_service_01")).generation, 2);
    assert.equal((await opened.service.inspect("project_service_01")).phase, "reconciling");
    assert.equal(opened.runtimes.inspect().length, 0);
    assert.equal(opened.ingress.inspect().length, 0);
    assert.deepEqual(opened.events.slice(-5), [
      "ingress-deactivate:1",
      "runtime-stop:1",
      "launch-web:2",
      "activate-background:2",
      "runtime-stop:2",
    ]);

    opened.ingress.failGeneration = null;
    await opened.service.reconcile(secondRequest);
    assert.equal((await opened.service.inspect("project_service_01")).phase, "running");
    assert.equal(opened.runtimes.inspect()[0].generation, 2);
    assert.equal(opened.ingress.inspect()[0].generation, 2);
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service preserves writers when traffic cannot drain and protects durable fences", async () => {
  const fixture = await serviceFixture("fences");
  try {
    const firstRuntime = await fixture.runtime({
      generation: 1,
      releaseId: "release_fence_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "first"),
    });
    const opened = await fixture.open();
    await opened.service.reconcile(providerInput(firstRuntime, 1));
    const secondRuntime = await fixture.runtime({
      generation: 2,
      releaseId: "release_fence_02",
      mode: "preserve",
    });
    opened.ingress.shouldDrain = false;
    await assert.rejects(
      opened.service.reconcile(providerInput(secondRuntime, 2)),
      /did not drain/u,
    );
    assert.equal(opened.runtimes.inspect()[0].generation, 1);
    assert.equal((await fixture.data.inspect("project_service_01")).generation, 1);
    assert.equal((await opened.service.inspect("project_service_01")).phase, "reconciling");
    assert.equal(opened.events.includes("runtime-stop:1"), false);

    await assert.rejects(
      opened.service.reconcile({
        ...providerInput(secondRuntime, 2),
        operation: {
          ...providerInput(secondRuntime, 2).operation,
          id: "operation_conflicting_fence",
        },
      }),
      /conflicts with its durable fence/u,
    );
    opened.ingress.shouldDrain = true;
    await opened.service.reconcile(providerInput(secondRuntime, 2));
    assert.equal((await opened.service.inspect("project_service_01")).phase, "running");

    const statePath = join(
      fixture.providerRoot,
      "service",
      "project_service_01.json",
    );
    await chmod(statePath, 0o644);
    await assert.rejects(
      opened.service.inspect("project_service_01"),
      /private regular file/u,
    );
    await chmod(statePath, 0o600);
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

test("provider service cleans a tracked runtime even when launch returns no candidate", async () => {
  const fixture = await serviceFixture("uncertain-runtime");
  try {
    const runtime = await fixture.runtime({
      generation: 1,
      releaseId: "release_uncertain_01",
      mode: "initialize",
      snapshot: await sqliteSnapshot(fixture.root, "uncertain"),
    });
    const opened = await fixture.open({ failLaunchAfterRecord: true });
    await assert.rejects(
      opened.service.reconcile(providerInput(runtime, 1)),
      /synthetic runtime launch failure/u,
    );
    assert.deepEqual(opened.events, [
      "launch-web:1",
      "runtime-stop:1",
    ]);
    assert.deepEqual(opened.runtimes.inspect(), []);
    assert.equal(await fixture.data.inspect("project_service_01"), null);
    await opened.service.close();
  } finally {
    await fixture.close();
  }
});

async function serviceFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `clank-provider-service-${name}-`));
  const providerRoot = join(root, "provider");
  const data = await openDeploymentProviderDataStore({
    rootDirectory: providerRoot,
    maxDatabaseBytes: 16 * 1024 * 1024,
  });
  return {
    root,
    providerRoot,
    data,
    async runtime(options) {
      const source = join(root, `source-${options.generation}-${options.releaseId}`);
      await mkdir(join(source, "dist"), { recursive: true });
      await mkdir(join(source, "migrations"), { recursive: true });
      await writeFile(
        join(source, "dist", "server.js"),
        `export const generation = ${options.generation};\n`,
      );
      await writeFile(
        join(source, "dist", "jobs.js"),
        `export const generation = ${options.generation};\n`,
      );
      const migrations = options.migrations ?? [
        ["0001_init.sql", "CREATE TABLE todo (id TEXT PRIMARY KEY);\n"],
      ];
      for (const [filename, sql] of migrations) {
        await writeFile(join(source, "migrations", filename), sql);
      }
      const artifact = await createDeploymentBundle(source, {
        version: 1,
        entry: "dist/server.js",
        include: ["dist", "migrations"],
        database: {
          path: "app.sqlite",
          migrations: "migrations",
          allowUnsafeMigrations: false,
        },
        health: { path: "/healthz", timeoutMs: 15_000 },
        env: {},
        ...(options.jobs
          ? {
              jobs: {
                entry: "dist/jobs.js",
                workers: 2,
                concurrency: 2,
                queues: [],
                scheduler: true,
              },
            }
          : {}),
      }, {
        frameworkVersion: "0.9.4-test",
        nodeVersion: "22.16.0",
      });
      return createDeploymentRuntimeCapsule({
        projectId: "project_service_01",
        releaseId: options.releaseId,
        generation: options.generation,
        environment: {
          CLANK_MANAGED_INGRESS: "1",
          PRIVATE_SECRET: "service-secret-canary",
        },
        database: {
          path: "app.sqlite",
          mode: options.mode,
          snapshot: options.snapshot,
        },
        ingress: {
          route: "/v1/clank/apps/project_service_01",
          token: "clanki_provider-service-token-12345678901234567890",
          controlToken:
            "clankc_provider-service-control-token-12345678901234567890",
        },
        artifact,
      }, {
        maxDatabaseBytes: 16 * 1024 * 1024,
      });
    },
    async open(runtimeOptions = {}) {
      const events = [];
      const runtimes = fakeRuntimes(events, runtimeOptions);
      const ingress = fakeIngress(events);
      const service = await openDeploymentProviderService({
        rootDirectory: providerRoot,
        data,
        runtimes,
        ingress,
        drainTimeoutMs: 100,
      });
      return { service, runtimes, ingress, events };
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fakeRuntimes(events, options = {}) {
  const records = new Map();
  const candidates = new Map();
  let closed = false;
  return {
    async launch({ prepared, deferBackground }) {
      if (closed) throw new Error("fake runtimes closed");
      const existing = records.get(prepared.projectId);
      if (existing) {
        if (
          existing.releaseId === prepared.releaseId
          && existing.generation === prepared.generation
          && existing.capsuleSha256 === prepared.capsuleSha256
        ) {
          events.push(`launch-retry:${prepared.generation}`);
          return existing.candidate;
        }
        throw new Error("fake runtime conflict");
      }
      const candidate = Object.freeze({
        protocol: "clank-provider-docker/1",
        projectId: prepared.projectId,
        releaseId: prepared.releaseId,
        generation: prepared.generation,
        capsuleSha256: prepared.capsuleSha256,
        upstream: `http://127.0.0.1:${46_000 + prepared.generation}`,
      });
      const record = {
        ...candidate,
        candidate,
        status: "candidate",
        port: 46_000 + prepared.generation,
        containers: 1,
        launchedAt: Date.now(),
        deferBackground,
        jobs: prepared.config.jobs
          ? prepared.config.jobs.workers + (prepared.config.jobs.scheduler ? 1 : 0)
          : 0,
      };
      records.set(prepared.projectId, record);
      candidates.set(candidate, record);
      events.push(`launch-web:${prepared.generation}`);
      if (options.failLaunchAfterRecord) {
        throw new Error("synthetic runtime launch failure");
      }
      return candidate;
    },
    async activate(candidate) {
      const record = candidates.get(candidate);
      if (!record) throw new Error("fake candidate unknown");
      if (record.status === "active") {
        events.push(`activate-retry:${record.generation}`);
        return runtimeState(record);
      }
      events.push(`activate-background:${record.generation}`);
      record.containers += record.jobs;
      record.status = "active";
      return runtimeState(record);
    },
    commit(candidate) {
      const record = candidates.get(candidate);
      if (!record) throw new Error("fake candidate unknown");
      record.status = "active";
      return runtimeState(record);
    },
    inspect() {
      return Object.freeze([...records.values()].map(runtimeState));
    },
    async diagnostics(projectId, logLimit = 200) {
      const record = records.get(projectId);
      if (!record) return null;
      return Object.freeze({
        protocol: "clank-provider-docker-diagnostics/1",
        projectId: record.projectId,
        releaseId: record.releaseId,
        generation: record.generation,
        sampledAt: 1_750_000_000_000,
        statisticsAvailable: true,
        containers: Object.freeze([Object.freeze({
          role: "web",
          instance: 0,
          running: true,
          memoryBytes: 64 * 1024 * 1024,
          memoryLimitBytes: 512 * 1024 * 1024,
          cpuPercent: 1.5,
          networkReceiveBytes: 1_500,
          networkTransmitBytes: 2_500,
          blockReadBytes: 4_096,
          blockWriteBytes: 8_192,
          pids: 7,
        })]),
        totals: Object.freeze({
          memoryBytes: 64 * 1024 * 1024,
          memoryLimitBytes: 512 * 1024 * 1024,
          cpuPercent: 1.5,
          networkReceiveBytes: 1_500,
          networkTransmitBytes: 2_500,
          blockReadBytes: 4_096,
          blockWriteBytes: 8_192,
          pids: 7,
        }),
        logs: Object.freeze(logLimit === 0 ? [] : [Object.freeze({
          sequence: 1,
          createdAt: 1_750_000_000_000,
          role: "web",
          instance: 0,
          stream: "stdout",
          message: "fake provider runtime output",
        })].slice(-logLimit)),
        retainedLogBytes: 28,
        logsTruncated: false,
      });
    },
    async stop(projectId, generation) {
      const record = records.get(projectId);
      if (!record || (generation !== undefined && record.generation !== generation)) return false;
      events.push(`runtime-stop:${record.generation}`);
      records.delete(projectId);
      candidates.delete(record.candidate);
      return true;
    },
    forget() {
      return false;
    },
    async close() {
      closed = true;
      records.clear();
      candidates.clear();
    },
  };
}

function runtimeState(record) {
  return Object.freeze({
    protocol: record.protocol,
    projectId: record.projectId,
    releaseId: record.releaseId,
    generation: record.generation,
    capsuleSha256: record.capsuleSha256,
    upstream: record.upstream,
    status: record.status,
    port: record.port,
    containers: record.containers,
    launchedAt: record.launchedAt,
  });
}

function fakeIngress(events) {
  const bindings = new Map();
  let closed = false;
  const ingress = {
    failGeneration: null,
    shouldDrain: true,
    async activate(binding) {
      if (closed) throw new Error("fake ingress closed");
      if (ingress.failGeneration === binding.generation) {
        throw new Error("synthetic ingress activation failure");
      }
      const key = `${binding.projectId}:${binding.generation}`;
      const existing = bindings.get(key);
      if (existing) {
        events.push(`ingress-retry:${binding.generation}`);
        return ingressState(existing);
      }
      bindings.set(key, { ...binding, activatedAt: Date.now() });
      events.push(`ingress-activate:${binding.generation}`);
      return ingressState(bindings.get(key));
    },
    inspect() {
      return Object.freeze([...bindings.values()].map(ingressState));
    },
    async handle() {
      return new Response("fake ingress");
    },
    async drain() {
      return ingress.shouldDrain;
    },
    async deactivate(projectId, generation) {
      const key = `${projectId}:${generation}`;
      const existing = bindings.get(key);
      if (!existing) return Object.freeze({ removed: false, drained: true });
      bindings.delete(key);
      events.push(`ingress-deactivate:${generation}`);
      return Object.freeze({ removed: true, drained: ingress.shouldDrain });
    },
    forget() {
      return false;
    },
    async close() {
      closed = true;
      bindings.clear();
      return true;
    },
  };
  return ingress;
}

function ingressState(binding) {
  return Object.freeze({
    protocol: "clank-provider-ingress/1",
    projectId: binding.projectId,
    releaseId: binding.releaseId,
    generation: binding.generation,
    path: binding.path,
    activatedAt: binding.activatedAt,
    inFlight: 0,
    latest: true,
  });
}

function providerInput(runtime, fence) {
  return {
    operation: {
      id: `operation_${runtime.manifest.generation}_${fence}`,
      projectId: runtime.manifest.projectId,
      fence,
      attempt: 1,
      maxAttempts: 3,
    },
    desired: {
      generation: runtime.manifest.generation,
      releaseId: runtime.manifest.releaseId,
      state: "running",
      runtimeProtocol: "clank-runtime/1",
    },
    artifact: runtime.artifact,
    runtime,
    signal: new AbortController().signal,
  };
}

function stoppedInput(generation, fence) {
  return {
    operation: {
      id: `operation_stop_${generation}_${fence}`,
      projectId: "project_service_01",
      fence,
      attempt: 1,
      maxAttempts: 3,
    },
    desired: {
      generation,
      releaseId: null,
      state: "stopped",
      runtimeProtocol: null,
    },
    artifact: null,
    runtime: null,
    signal: new AbortController().signal,
  };
}

function lifecycleInput(action, generation, fence) {
  return {
    operation: {
      id: `operation_${action}_${generation}_${fence}`,
      projectId: "project_service_01",
      fence,
      attempt: 1,
      maxAttempts: 3,
    },
    generation,
    confirmation: action === "rollback"
      ? `rollback project_service_01 ${generation}`
      : "delete project_service_01",
    signal: new AbortController().signal,
  };
}

async function sqliteSnapshot(root, value) {
  const filename = join(root, `snapshot-${value}-${crypto.randomUUID()}.sqlite`);
  const database = new DatabaseSync(filename);
  database.exec("CREATE TABLE seed (value TEXT NOT NULL)");
  database.prepare("INSERT INTO seed (value) VALUES (?)").run(value);
  database.close();
  return new Uint8Array(await readFile(filename));
}

function seedJobsDatabase(filename) {
  const database = new DatabaseSync(filename);
  database.exec(`CREATE TABLE clank_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    queue TEXT NOT NULL,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT,
    error TEXT,
    owner_id TEXT,
    priority INTEGER NOT NULL,
    group_key TEXT,
    attempts INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    timeout_ms INTEGER NOT NULL,
    run_at INTEGER NOT NULL,
    idempotency_key TEXT,
    scheduled_at INTEGER,
    cron_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    lease_token TEXT,
    lease_owner TEXT,
    lease_until INTEGER,
    cancel_requested INTEGER NOT NULL
  );
  CREATE TABLE clank_job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    event TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE clank_job_schedules (
    name TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    expression TEXT NOT NULL,
    timezone TEXT NOT NULL,
    payload TEXT NOT NULL,
    concurrency TEXT NOT NULL,
    starting_deadline_ms INTEGER NOT NULL,
    max_catch_up INTEGER NOT NULL,
    definition_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_run_at INTEGER NOT NULL,
    last_scheduled_at INTEGER,
    last_error TEXT,
    lease_token TEXT,
    lease_owner TEXT,
    lease_until INTEGER,
    updated_at INTEGER NOT NULL
  )`);
  database.prepare(`INSERT INTO clank_jobs (
    id, name, queue, state, payload, priority, attempts, max_attempts,
    timeout_ms, run_at, created_at, updated_at, cancel_requested
  ) VALUES (?, 'sync.todo', 'default', 'queued', '{"secret":"hidden"}', 0, 0, 3,
    30000, ?, ?, ?, 0)`).run(
    "job_0123456789abcdef0123456789abcdef",
    1_750_000_000_000,
    1_750_000_000_000,
    1_750_000_000_000,
  );
  database.close();
}
