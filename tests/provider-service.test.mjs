import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
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
  openDockerDeploymentProviderService,
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
    assert.equal(diagnostics.filesystem.availableBytes, 70 * 1024 * 1024 * 1024);
    assert.equal(diagnostics.filesystem.utilization, 0.25);
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

test("configured provider canaries retain native cleanup intent, isolate a checkpoint and preserve the latest primary data", async () => {
  const fixture=await serviceFixture("canary-checkpoint");let opened;
  try {
    let candidatePath;
    opened=await fixture.open({canaries:{readPaths:["/healthz"],maxOperations:2},onLaunch:async({prepared,isolatedReadOnly})=> {
      if (!isolatedReadOnly) return;
      const journal=JSON.parse(await readFile(join(fixture.providerRoot,"service","project_service_01.canary.json"),"utf8"));
      assert.equal(journal.current.phase,"preparing");
      assert.equal(journal.current.candidateProjectId,prepared.projectId);
      assert.deepEqual(Object.keys(prepared.environment),[]);
      assert.equal(prepared.migrationCount,0);
      candidatePath=prepared.databasePath;
    }});
    const primary=await fixture.runtime({generation:1,releaseId:"release_primary_01",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary-before")});
    await opened.service.reconcile(providerInput(primary,1));
    const binding=await opened.service.canaries.binding("project_service_01");
    const runtime=await fixture.runtime({generation:2,releaseId:"release_candidate_02",mode:"preserve"});
    const input={primary:binding,controllerEpoch:7,operationId:"canary_checkpoint_01",runtime,signal:new AbortController().signal};
    const candidate=await opened.service.canaries.prepare(input);
    assert.equal(candidate.phase,"running");
    const ordinary=await createDeploymentRuntimeCapsule({projectId:candidate.candidateProjectId,releaseId:"ordinary_candidate_takeover",generation:2,
      environment:{},database:{path:"app.sqlite",mode:"preserve"},artifact:runtime.artifact.bytes,
      ingress:{route:candidate.route.path,token:candidate.route.token}});
    await assert.rejects(opened.service.reconcile(providerInput(ordinary,2)),/cannot use ordinary lifecycle/u);
    for(const action of ["rollback","delete"]){
      const request=lifecycleInput(action,1,3);request.operation.projectId=candidate.candidateProjectId;
      request.confirmation=action==="rollback"?`rollback ${candidate.candidateProjectId} 1`:`delete ${candidate.candidateProjectId}`;
      await assert.rejects(opened.service[action](request),/cannot use ordinary lifecycle/u);
    }
    assert.equal((await fixture.data.inspect(candidate.candidateProjectId)).generation,1);
    assert.equal(opened.runtimes.inspect().filter(row=>row.projectId==="project_service_01")[0].status,"active");
    assert.deepEqual(await opened.service.canaries.prepare(input),candidate);
    const primaryData=await fixture.data.inspect("project_service_01");
    const primaryPath=join(fixture.providerRoot,"projects","project_service_01",primaryData.databasePath);
    const db=new DatabaseSync(primaryPath);db.prepare("UPDATE seed SET value=?").run("primary-after-stage");db.close();
    const isolated=new DatabaseSync(candidatePath);assert.equal(isolated.prepare("SELECT value FROM seed").get().value,"primary-before");
    // This trusted host-side unit mutation proves that candidate data is never promoted.
    // Actual read-only kernel enforcement is verified by the separate Docker profile.
    isolated.prepare("UPDATE seed SET value=?").run("candidate-must-never-promote");isolated.close();
    const url="http://provider.test"+candidate.route.path+"/healthz";
    const headers={"x-clank-project-id":candidate.route.projectId,"x-clank-runtime-protocol":"clank-runtime/1","x-clank-runtime-generation":"1","x-clank-runtime-ingress":candidate.route.token,"x-private-secret":"do-not-forward"};
    assert.equal((await opened.service.handle(new Request(url,{headers}))).status,200);
    assert.equal(opened.ingress.lastRequest.headers.has("x-private-secret"),false);
    const originalNow=Date.now;
    try {
      Date.now=()=>candidate.expiresAt-31*60_000;
      assert.equal((await opened.service.handle(new Request(url,{headers}))).status,503);
      await assert.rejects(opened.service.canaries.prepare(input),/retired or needs cleanup/u);
      Date.now=()=>candidate.expiresAt+1;
      assert.equal((await opened.service.handle(new Request(url,{headers}))).status,503);
    } finally {Date.now=originalNow;}
    for (const request of [new Request(url,{method:"POST",headers,body:"private-body"}),new Request(url+"?token=private",{headers}),new Request(url,{headers:{...headers,cookie:"private-session"}}),new Request(url,{headers:{...headers,authorization:"Bearer private"}})]) assert.equal((await opened.service.handle(request)).status,404);
    const stopped=await opened.service.canaries.stop(input);assert.equal(stopped.phase,"stopped");
    assert.equal(await fixture.data.inspect(candidate.candidateProjectId),null);
    assert.equal(opened.runtimes.inspect().length,1);
    assert.equal((await opened.service.handle(new Request(url,{headers}))).status,503);
    assert.equal((await opened.service.handle(new Request("http://provider.test/v1/clank/apps/canary_"+"f".repeat(64)+"/healthz"))).status,503);
    await assert.rejects(opened.service.canaries.prepare(input),/retired/u);
    await opened.service.reconcile(providerInput(runtime,2));
    const after=await fixture.data.inspect("project_service_01");const latest=new DatabaseSync(join(fixture.providerRoot,"projects","project_service_01",after.databasePath),{readOnly:true});
    assert.equal(latest.prepare("SELECT value FROM seed").get().value,"primary-after-stage");latest.close();
    assert.notEqual((await opened.service.canaries.binding("project_service_01")).incarnation,binding.incarnation);
    await assert.rejects(opened.service.canaries.prepare({...input,operationId:"canary_stale_02"}),/binding is stale/u);
  } finally {await opened?.service.close();await fixture.close();}
});

test("provider canary reservation excludes ordinary reconciliation while native data preflight is pending", {timeout:30_000}, async () => {
  const fixture=await serviceFixture("canary-held-preflight");let opened,preparing;
  let releasePreflight,reachedPreflight,rejectPreflight;
  const held=new Promise(resolve=>{releasePreflight=resolve;});
  const reached=new Promise((resolve,reject)=>{reachedPreflight=resolve;rejectPreflight=reject;});
  let heldOnce=false,candidateApplies=0,snapshots=0;
  try {
    const data={...fixture.data,
      async inspect(projectId) {
        const state=await fixture.data.inspect(projectId);
        if(projectId.startsWith("canary_")&&!heldOnce){
          heldOnce=true;reachedPreflight(projectId);await held;
        }
        return state;
      },
      async apply(input,...rest) {
        if(input.operation.projectId.startsWith("canary_"))candidateApplies++;
        return fixture.data.apply(input,...rest);
      },
      async snapshot(projectId) {snapshots++;return fixture.data.snapshot(projectId);},
    };
    opened=await fixture.open({canaries:{readPaths:["/healthz"]},data});
    const primary=await fixture.runtime({generation:1,releaseId:"release_preflight_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"preflight-primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const runtime=await fixture.runtime({generation:2,releaseId:"release_preflight_candidate",mode:"preserve"});
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:4,operationId:"canary_preflight_01",runtime,signal:new AbortController().signal};
    preparing=opened.service.canaries.prepare(input);
    preparing.catch(rejectPreflight);
    const projectId=await reached;
    const journalPath=join(fixture.providerRoot,"service","project_service_01.canary.json");
    await assert.rejects(readFile(journalPath),{code:"ENOENT"});
    assert.equal(await fixture.data.inspect(projectId),null);
    const beforeEvents=[...opened.events];
    const ordinary=await createDeploymentRuntimeCapsule({projectId,releaseId:"ordinary_preflight_takeover",generation:1,
      environment:{},database:{path:"app.sqlite",mode:"initialize"},artifact:runtime.artifact.bytes,
      ingress:{route:`/v1/clank/apps/${projectId}`,token:"clanki_ordinary_preflight_12345678901234567890"}});
    await assert.rejects(opened.service.reconcile(providerInput(ordinary,1)),/cannot use ordinary lifecycle/u);
    assert.deepEqual(opened.events,beforeEvents,"The competing request cannot quiesce or launch any runtime.");
    assert.equal(candidateApplies,0,"The competing request cannot apply candidate data before preflight completes.");
    assert.equal(snapshots,0);
    assert.equal(await fixture.data.inspect(projectId),null);
    await assert.rejects(readFile(join(fixture.providerRoot,"service",`${projectId}.json`)),{code:"ENOENT"});
    releasePreflight();
    const candidate=await preparing;
    assert.equal(candidate.candidateProjectId,projectId);assert.equal(candidate.phase,"running");
    assert.equal(candidateApplies,1);assert.equal(snapshots,1);
    assert.equal((await fixture.data.inspect(projectId)).generation,1);
    assert.equal((await opened.service.canaries.stop(input)).phase,"stopped");
    assert.equal(await fixture.data.inspect(projectId),null);
    assert.equal(opened.runtimes.inspect().length,1);
    assert.equal(opened.runtimes.inspect()[0].projectId,"project_service_01");
  } finally {releasePreflight();await preparing?.catch(()=>{});await opened?.service.close();await fixture.close();}
});

test("provider ownership rejects a second live service while checkpoint preparation and close are pending", async () => {
  const fixture=await serviceFixture("canary-held-replacement");let first,second,release;
  const held=new Promise(resolve=>{release=resolve;});let reached;const ready=new Promise(resolve=>{reached=resolve;});
  try {
    const data={...fixture.data,snapshot:async projectId=>{const snapshot=await fixture.data.snapshot(projectId);reached();await held;return snapshot;}};
    first=await fixture.open({canaries:{readPaths:["/healthz"]},data});
    const primary=await fixture.runtime({generation:1,releaseId:"release_held_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await first.service.reconcile(providerInput(primary,1));
    const binding=await first.service.canaries.binding("project_service_01"),runtime=await fixture.runtime({generation:2,releaseId:"release_held_candidate",mode:"preserve"});
    const input={primary:binding,controllerEpoch:3,operationId:"canary_held_01",runtime,signal:new AbortController().signal};
    const preparing=first.service.canaries.prepare(input);
    const rejected=assert.rejects(preparing,/binding is stale/u);
    await ready;
    await assert.rejects(first.service.canaries.prepare({primary:binding,controllerEpoch:3,operationId:"canary_busy_02",runtime,signal:new AbortController().signal}),/intake is unavailable/u);
    const ownerFile=join(fixture.providerRoot,"service",".canary-controller.json");
    const before=await readFile(ownerFile,"utf8");
    await assert.rejects(fixture.open(),/already has an active writer/u);
    // Invalid Docker options would fail inside the launcher. Ownership rejection
    // must happen first, before launcher validation or its startup orphan cleanup.
    await assert.rejects(openDockerDeploymentProviderService({rootDirectory:fixture.providerRoot,owner:"invalid owner",image:"invalid image"}),/already has an active writer/u);
    assert.equal(await readFile(ownerFile,"utf8"),before);
    const closing=first.service.close();
    const closingAgain=first.service.close();
    await assert.rejects(fixture.open(),/already has an active writer/u);
    release();await rejected;await Promise.all([closing,closingAgain]);
    await assert.rejects(first.service.canaries.stop(input),/service is closed/u);
    second=await fixture.open();
    assert.equal(second.service.canaries,undefined);
    assert.equal(await first.service.canaries.binding("project_service_01"),null);
    const journal=JSON.parse(await readFile(join(fixture.providerRoot,"service","project_service_01.canary.json"),"utf8"));
    assert.equal(journal.current.phase,"stopped");
    assert.equal(await fixture.data.inspect(journal.current.candidateProjectId),null);
    assert.equal(first.events.filter(event=>event.startsWith("launch-web")).length,1);
    assert.equal((await fixture.data.inspect("project_service_01")).generation,1);
  } finally {release();await first?.service.close();await second?.service.close();await fixture.close();}
});

test("native process death releases provider ownership and a replacement retires the persisted canary intent", {timeout:30_000}, async () => {
  const fixture=await serviceFixture("canary-process-ownership");let child,opened;
  try {
    const primary=await fixture.runtime({generation:1,releaseId:"release_process_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    const candidate=await fixture.runtime({generation:2,releaseId:"release_process_candidate",mode:"preserve"});
    const primaryPath=join(fixture.root,"primary.capsule"),candidatePath=join(fixture.root,"candidate.capsule");
    await writeFile(primaryPath,primary.bytes,{mode:0o600});await writeFile(candidatePath,candidate.bytes,{mode:0o600});
    child=fork(new URL("./fixtures/provider-service-owner.mjs",import.meta.url),[fixture.providerRoot,primaryPath,candidatePath],{stdio:["ignore","ignore","pipe","ipc"],execArgv:[]});
    let diagnostics="";child.stderr.setEncoding("utf8");child.stderr.on("data",chunk=>{diagnostics=(diagnostics+chunk).slice(-4096);});
    const exited=once(child,"exit");
    const ready=await Promise.race([once(child,"message").then(([message])=>message),exited.then(([code,signal])=>{throw new Error(`Ownership fixture exited ${code}/${signal}: ${diagnostics}`);})]);
    assert.equal(ready.phase,"checkpoint-held",JSON.stringify(ready));
    const file=join(fixture.providerRoot,"service","project_service_01.canary.json");
    const intent=JSON.parse(await readFile(file,"utf8"));assert.equal(intent.current.phase,"preparing");
    await assert.rejects(fixture.open(),/already has an active writer/u);
    assert.equal(child.kill("SIGKILL"),true);const [,signal]=await exited;assert.equal(signal,"SIGKILL");
    opened=await fixture.open();
    assert.equal(JSON.parse(await readFile(file,"utf8")).current.phase,"stopped");
    assert.equal(await fixture.data.inspect(intent.current.candidateProjectId),null);
    assert.equal((await fixture.data.inspect("project_service_01")).generation,1);
    assert.equal(opened.runtimes.inspect().length,0);
  } finally {
    if(child && child.exitCode===null && child.signalCode===null){const exited=once(child,"exit");child.kill("SIGKILL");await exited;}
    await opened?.service.close();await fixture.close();
  }
});

test("provider canary quota refusal precedes checkpoint and candidate data work", async () => {
  const fixture=await serviceFixture("canary-quota-refusal");let opened;
  try {
    let snapshots=0,candidateApplies=0;
    const data={...fixture.data,snapshot:async projectId=>{snapshots++;return fixture.data.snapshot(projectId);},apply:async(input,...rest)=>{if(input.operation.projectId.startsWith("canary_"))candidateApplies++;return fixture.data.apply(input,...rest);}};
    opened=await fixture.open({canaries:{readPaths:["/healthz"]},data,prepareProject:async projectId=>{if(projectId.startsWith("canary_"))throw new Error("controlled quota refusal");}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_quota_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    await assert.rejects(opened.service.canaries.prepare({primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:1,operationId:"canary_quota_01",runtime:await fixture.runtime({generation:2,releaseId:"release_quota_candidate",mode:"preserve"}),signal:new AbortController().signal}),/controlled quota refusal/u);
    assert.equal(snapshots,0);assert.equal(candidateApplies,0);
    const state=await opened.service.canaries.inspect("project_service_01");assert.equal(state.phase,"stopped");
    assert.equal(await fixture.data.inspect(state.candidateProjectId),null);
    assert.equal(opened.runtimes.inspect().length,1);
  } finally {await opened?.service.close();await fixture.close();}
});

test("provider ownership releases after factory failure and rejects malformed or linked native lock state", async () => {
  const fixture=await serviceFixture("ownership-invalid-state");let opened;
  try {
    await assert.rejects(openDockerDeploymentProviderService({rootDirectory:fixture.providerRoot,owner:"invalid owner",image:"invalid image"}),/owner/u);
    opened=await fixture.open();
    const runtime=await fixture.runtime({generation:1,releaseId:"release_closed_decode",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    const rejected=assert.rejects(opened.service.reconcile(providerInput(runtime,1)),/service is closed/u);
    await opened.service.close();await rejected;
    assert.equal(await fixture.data.inspect("project_service_01"),null);
    const catalog=join(fixture.providerRoot,"service",".writer.sqlite");
    const database=new DatabaseSync(catalog);
    database.exec("DROP TABLE clank_provider_service_owner; CREATE TABLE clank_provider_service_owner(protocol INTEGER); INSERT INTO clank_provider_service_owner VALUES(999)");database.close();
    await assert.rejects(fixture.open(),/ownership protocol is unsupported/u);
    const repair=new DatabaseSync(catalog);repair.exec("UPDATE clank_provider_service_owner SET protocol=1");repair.close();
    const outside=join(fixture.root,"outside-lock");await writeFile(outside,"unchanged",{mode:0o600});
    await symlink(outside,`${catalog}-journal`);
    await assert.rejects(fixture.open(),/private bounded native SQLite/u);
    assert.equal(await readFile(outside,"utf8"),"unchanged");await rm(`${catalog}-journal`);
    opened=await fixture.open();
  } finally {await opened?.service.close();await fixture.close();}
});

test("ordinary provider project IDs with the generated canary prefix retain their ingress", async () => {
  const fixture=await serviceFixture("ordinary-canary-prefix");let opened;
  try {
    const projectId=`canary_${"a".repeat(64)}`;
    const runtime=await fixture.runtime({generation:1,releaseId:"release_ordinary_prefix",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary"),projectId,controlToken:false});
    opened=await fixture.open();await opened.service.reconcile(providerInput(runtime,1));
    assert.equal((await opened.service.handle(new Request(`http://provider.test/v1/clank/apps/${projectId}/healthz`))).status,200);
  } finally {await opened?.service.close();await fixture.close();}
});

test("unresolved canary cleanup blocks authoritative admission and unknown journal protocols fail closed", async () => {
  const fixture=await serviceFixture("canary-cleanup-refusal");let opened;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_cleanup_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:9,operationId:"canary_cleanup_01",runtime:await fixture.runtime({generation:2,releaseId:"release_cleanup_candidate",mode:"preserve"}),signal:new AbortController().signal};
    const candidate=await opened.service.canaries.prepare(input);
    const originalStop=opened.runtimes.stop;
    opened.runtimes.stop=async(projectId,...rest)=>{if (projectId===candidate.candidateProjectId) throw new Error("controlled cleanup refusal");return originalStop(projectId,...rest);};
    await assert.rejects(opened.service.canaries.stop(input),/cleanup failed/u);
    assert.equal((await opened.service.canaries.inspect("project_service_01")).phase,"stopping");
    await assert.rejects(opened.service.reconcile(providerInput(input.runtime,2)),/cleanup failed/u);
    assert.equal((await opened.service.inspect("project_service_01")).phase,"running");
    assert.equal(opened.runtimes.inspect().find(row=>row.projectId==="project_service_01").status,"active");
    opened.runtimes.stop=originalStop;await opened.service.canaries.stop(input);
    await opened.service.close();
    const file=join(fixture.providerRoot,"service","project_service_01.canary.json"),original=await readFile(file,"utf8");
    const invalid=JSON.parse(original);invalid.protocol="clank-provider-canary/999";
    await writeFile(file,JSON.stringify(invalid),{mode:0o600});
    await assert.rejects(fixture.open(),/journal protocol/u);
    await writeFile(file,original,{mode:0o600});
    const ownerFile=join(fixture.providerRoot,"service",".canary-controller.json"),owner=await readFile(ownerFile,"utf8");
    await writeFile(ownerFile,JSON.stringify({protocol:"clank-provider-canary-owner/1",incarnation:"invalid"}),{mode:0o600});
    await assert.rejects(fixture.open(),/owner protocol/u);
    await writeFile(ownerFile,owner,{mode:0o600});
    opened=await fixture.open();
  } finally {await opened?.service.close();await fixture.close();}
});

test("provider canary intake captures capsule bytes before asynchronous verification", async () => {
  const fixture=await serviceFixture("canary-byte-substitution");let opened;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"],maxOperations:1}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_bytes_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const runtime=await fixture.runtime({generation:2,releaseId:"release_bytes_candidate",mode:"preserve"}),binding=await opened.service.canaries.binding("project_service_01");
    const preparing=opened.service.canaries.prepare({primary:binding,controllerEpoch:2,operationId:"canary_bytes_01",runtime,signal:new AbortController().signal});
    runtime.bytes.fill(0);
    const prepared=await preparing;
    assert.equal(prepared.capsuleSha256,runtime.sha256);
    assert.equal(prepared.phase,"running");
    await opened.service.canaries.stop({primary:binding,controllerEpoch:2,operationId:"canary_bytes_01"});
    const next=await fixture.runtime({generation:2,releaseId:"release_bytes_next",mode:"preserve"});
    await assert.rejects(opened.service.canaries.prepare({primary:binding,controllerEpoch:2,operationId:"canary_bytes_02",runtime:next,signal:new AbortController().signal}),/capacity is exhausted/u);
    assert.equal((await fixture.data.inspect("project_service_01")).generation,1);
  } finally {await opened?.service.close();await fixture.close();}
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
      const projectId=options.projectId??"project_service_01";
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
        projectId,
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
          route: `/v1/clank/apps/${projectId}`,
          token: "clanki_provider-service-token-12345678901234567890",
          ...(options.controlToken===false?{}:{controlToken:
            "clankc_provider-service-control-token-12345678901234567890"}),
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
        data: runtimeOptions.data ?? data,
        runtimes,
        ingress,
        drainTimeoutMs: 100,
        canaries: runtimeOptions.canaries,
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
    async prepareProject(projectId,signal) {await options.prepareProject?.(projectId,signal);},
    async launch({ prepared, deferBackground, isolatedReadOnly }) {
      if (closed) throw new Error("fake runtimes closed");
      await options.onLaunch?.({prepared,isolatedReadOnly});
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
        ...(isolatedReadOnly ? {isolatedReadOnly:true} : {}),
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
        protocol: "clank-provider-docker-diagnostics/2",
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
        filesystem: Object.freeze({
          available: true,
          capacityBytes: 100 * 1024 * 1024 * 1024,
          usedBytes: 25 * 1024 * 1024 * 1024,
          availableBytes: 70 * 1024 * 1024 * 1024,
          utilization: 0.25,
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
    async handle(request) {
      ingress.lastRequest=request;
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

test("planned evacuation durably stops all writers before its final snapshot and rejects source resurrection", async()=>{
 const fixture=await serviceFixture('evacuation');try{
  const runtime=await fixture.runtime({generation:1,releaseId:'release_evacuate_01',mode:'initialize',snapshot:await sqliteSnapshot(fixture.root,'before-evacuation'),jobs:true});const input=providerInput(runtime,1);let first;first=await fixture.open({data:{...fixture.data,snapshot:async project=>{assert.equal(first.runtimes.inspect().length,0,'web, workers and scheduler must be stopped before snapshot');return fixture.data.snapshot(project)}}});await first.service.reconcile(input);
  const url='https://provider.example/v1/clank/control/project_service_01/evacuate',token='clankc_provider-service-control-token-12345678901234567890',plan='evac_exact_plan_01';const request=(id=plan,credential=token)=>new Request(url,{method:'POST',headers:{authorization:'Bearer '+credential,'x-clank-evacuation-id':id}});
  assert.equal((await first.service.handle(request(plan,'wrong'))).status,404);assert.equal((await first.service.handle(new Request(url,{headers:{authorization:'Bearer '+token}}))).status,404);
  const response=await first.service.handle(request());assert.equal(response.status,200,await response.clone().text());const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(response.headers.get('x-clank-writers-stopped'),'true');assert.equal(response.headers.get('x-clank-evacuation-id'),plan);assert.deepEqual(first.events.slice(-2),['ingress-deactivate:1','runtime-stop:1']);assert.equal((await first.service.inspect('project_service_01')).phase,'evacuating');
  assert.equal((await first.service.handle(request('evac_wrong_plan_01'))).status,409);await assert.rejects(first.service.reconcile(input),/fenced for planned evacuation/);await first.service.close();
  const restarted=await fixture.open();const replay=await restarted.service.handle(request());assert.equal(replay.status,200);assert.deepEqual(new Uint8Array(await replay.arrayBuffer()),bytes);await assert.rejects(restarted.service.reconcile(input),/fenced for planned evacuation/);assert.equal(restarted.runtimes.inspect().length,0);await restarted.service.close();
 }finally{await fixture.close()}
});

test("failed final snapshot leaves a durable source barrier and exact retry completes safely",async()=>{
 const fixture=await serviceFixture('evacuation-failure');try{
  const runtime=await fixture.runtime({generation:1,releaseId:'release_evacuate_02',mode:'initialize',snapshot:await sqliteSnapshot(fixture.root,'failure-test'),jobs:true});let fail=true;const wrapped={...fixture.data,snapshot:async project=>{if(fail)throw Error('snapshot storage unavailable');return fixture.data.snapshot(project)}};const first=await fixture.open({data:wrapped});const input=providerInput(runtime,1);await first.service.reconcile(input);
  const request=()=>new Request('https://provider.example/v1/clank/control/project_service_01/evacuate',{method:'POST',headers:{authorization:'Bearer clankc_provider-service-control-token-12345678901234567890','x-clank-evacuation-id':'evac_failure_plan_01'}});
  assert.equal((await first.service.handle(request())).status,503);assert.equal(first.runtimes.inspect().length,0);await assert.rejects(first.service.reconcile(input),/fenced for planned evacuation/);await first.service.close();fail=false;const resumed=await fixture.open();assert.equal((await resumed.service.handle(request())).status,200);await resumed.service.close();
 }finally{await fixture.close()}
});
