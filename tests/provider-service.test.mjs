import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer, request as nativeHttpRequest } from "node:http";
import { Readable } from "node:stream";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  access,
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
import { createDeploymentRuntimeIngress } from "../dist/provider-runtime.js";
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
import { createDeploymentRuntimeCapsule, deploymentRuntimeDigest } from "../dist/runtime-placement.js";

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

test("provider canary preparation and retirement use the real ingress binding contract", async () => {
  const fixture=await serviceFixture("canary-real-ingress"),ingress=createDeploymentRuntimeIngress();let opened;
  try {
    opened=await fixture.open({ingress,canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_real_ingress_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const primaryBinding=ingress.inspect();assert.equal(primaryBinding.length,1);
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:1,operationId:"canary_real_ingress_01",
      runtime:await fixture.runtime({generation:2,releaseId:"release_real_ingress_candidate",mode:"preserve"}),signal:new AbortController().signal};
    const prepared=await opened.service.canaries.prepare(input);
    assert.equal(prepared.phase,"running");assert.deepEqual(prepared.route.readPaths,["/healthz"]);
    const bindings=ingress.inspect();assert.equal(bindings.length,2);
    const candidate=bindings.find(binding=>binding.projectId===prepared.candidateProjectId);assert.ok(candidate);
    assert.equal(candidate.releaseId,prepared.releaseId);assert.equal(candidate.path,prepared.route.path);assert.equal(candidate.latest,true);
    assert.equal((await opened.service.canaries.stop(input)).phase,"stopped");
    assert.deepEqual(ingress.inspect(),primaryBinding);
    assert.equal((await opened.service.canaries.inspect("project_service_01")).phase,"stopped");
  } finally {await opened?.service.close();await ingress.close();await fixture.close();}
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

test("a delayed canary journal read cannot reclaim a retired project from its ordinary runtime", {timeout:30_000}, async () => {
  const fixture=await serviceFixture("canary-retired-journal-read");let opened,heldRequest,releaseRead;
  const originalDigest=crypto.subtle.digest;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retired_read_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:1,operationId:"canary_retired_read_01",
      runtime:await fixture.runtime({generation:2,releaseId:"release_retired_read_candidate",mode:"preserve"}),signal:new AbortController().signal};
    const prepared=await opened.service.canaries.prepare(input);
    const ordinary=await fixture.runtime({projectId:prepared.candidateProjectId,generation:1,releaseId:"release_reused_ordinary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"ordinary")});
    const identity=[input.primary.projectId,input.primary.incarnation,input.controllerEpoch,input.operationId,input.runtime.sha256].join("\n");
    let reachedRead,pauseOnce=true;
    const entered=new Promise(resolve=>{reachedRead=resolve;}),held=new Promise(resolve=>{releaseRead=resolve;});
    // Hold the request after it read the running native journal, before its
    // asynchronous identity check returns. Other lifecycle checks still run.
    crypto.subtle.digest=async function(algorithm,bytes) {
      if (pauseOnce && new TextDecoder().decode(bytes)===identity) {pauseOnce=false;reachedRead();await held;}
      return originalDigest.call(this,algorithm,bytes);
    };
    const request=()=>new Request(`http://provider.test${prepared.route.path}/healthz`);
    heldRequest=opened.service.handle(request());
    await entered;
    assert.equal((await opened.service.canaries.stop(input)).phase,"stopped");
    assert.equal(await fixture.data.inspect(prepared.candidateProjectId),null);
    await opened.service.reconcile(providerInput(ordinary,2));
    assert.equal((await opened.service.handle(request())).status,200);
    releaseRead();assert.equal((await heldRequest).status,503);
    assert.equal((await opened.service.handle(request())).status,200,"A completed retirement cannot be reversed by a stale request read.");
    await opened.service.reconcile(providerInput(ordinary,3));
    assert.equal((await opened.service.inspect(prepared.candidateProjectId)).releaseId,ordinary.manifest.releaseId);
    assert.equal((await opened.service.inspect("project_service_01")).releaseId,primary.manifest.releaseId);
  } finally {
    releaseRead?.();await heldRequest?.catch(()=>{});crypto.subtle.digest=originalDigest;
    await opened?.service.close();await fixture.close();
  }
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

test("canary startup refuses replayed cleanup when its project identity has an ordinary owner", async () => {
  const fixture=await serviceFixture("canary-replayed-cleanup");let opened,deletes=0;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_replayed_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:2,operationId:"canary_replayed_cleanup",runtime:await fixture.runtime({generation:2,releaseId:"release_replayed_candidate",mode:"preserve"}),signal:new AbortController().signal};
    const candidate=await opened.service.canaries.prepare(input),journalFile=join(fixture.providerRoot,"service","project_service_01.canary.json");
    const runningJournal=await readFile(journalFile,"utf8");
    await opened.service.canaries.stop(input);
    const ordinary=await fixture.runtime({projectId:candidate.candidateProjectId,generation:1,releaseId:"release_replayed_ordinary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"ordinary")});
    await opened.service.reconcile(providerInput(ordinary,1));
    await opened.service.close();opened=undefined;
    const stateFile=join(fixture.providerRoot,"service",`${candidate.candidateProjectId}.json`),state=await readFile(stateFile,"utf8"),data=await fixture.data.inspect(candidate.candidateProjectId);
    // A stopped historical journal permits normal reuse. A partial metadata
    // restore must not turn that same project back into disposable canary data.
    opened=await fixture.open();await opened.service.close();opened=undefined;
    await writeFile(journalFile,runningJournal,{mode:0o600});
    for(const canaries of [undefined,{readPaths:["/healthz"]}]) {
      let failure;
      try {opened=await fixture.open({canaries,data:{...fixture.data,delete:async(...args)=>{deletes++;return fixture.data.delete(...args);}}});}
      catch(error) {failure=error;}
      assert.equal(deletes,0,"Replayed cleanup must not delete the newer ordinary owner's data.");
      assert.match(failure?.message??"",/cleanup collides with ordinary/u);
      assert.deepEqual(await fixture.data.inspect(candidate.candidateProjectId),data);
      assert.equal(await readFile(stateFile,"utf8"),state);
      assert.equal(await readFile(journalFile,"utf8"),runningJournal);
    }
  } finally {await opened?.service.close();await fixture.close();}
});

test("durable canary retirement fences a held native capsule decode before candidate effects", {timeout:30_000}, async () => {
  const fixture=await serviceFixture("retire-held-decode");let opened,pending,barrier,snapshots=0,applies=0;
  try {
    const data={...fixture.data,snapshot:async(...args)=>{snapshots++;return fixture.data.snapshot(...args);},apply:async(input,...rest)=>{if(input.operation.projectId.startsWith("canary_"))applies++;return fixture.data.apply(input,...rest);}};
    opened=await fixture.open({data,canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:3,operationId:"retire_held_decode",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_candidate",mode:"preserve"}),signal:new AbortController().signal};
    barrier=holdNativeDigest(input.runtime.bytes);
    pending=opened.service.canaries.prepare(input);pending.catch(()=>{});await barrier.entered;
    const requested={...retirementFor(input,5),primary:{...input.primary}};
    const retiring=opened.service.canaries.retire(requested);
    requested.releaseId="changed_after_intake";requested.retirementEpoch=1;requested.primary.fence++;
    const receipt=await retiring;
    assert.equal(receipt.phase,"retired");assert.equal(receipt.releaseId,input.runtime.manifest.releaseId);assert.equal(receipt.retirementEpoch,5);
    assert.deepEqual(receipt.primary,input.primary);
    const retained=JSON.parse(await readFile(retirementFile(fixture),"utf8"));assert.equal(retained.epochFloor,5);assert.equal(retained.entries[0].phase,"retired");
    barrier.release();await assert.rejects(pending,/retired/u);
    await assert.rejects(opened.service.canaries.prepare({...input,controllerEpoch:4,operationId:"other_delayed_prepare"}),/epoch is retired/u);
    assert.equal(snapshots,0);assert.equal(applies,0);assert.equal(opened.runtimes.inspect().length,1);
    assert.equal(await opened.service.canaries.inspect("project_service_01"),null);
    await assert.rejects(access(join(fixture.providerRoot,"projects",receipt.candidateProjectId)),{code:"ENOENT"});
  } finally {barrier?.release();barrier?.restore();await pending?.catch(()=>{});await opened?.service.close();await fixture.close();}
});

test("exact old canary retirement cannot lower its floor or disturb a later live candidate", async () => {
  const fixture=await serviceFixture("retire-takeover"),ingress=createDeploymentRuntimeIngress();let opened;
  try {
    opened=await fixture.open({ingress,canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_takeover_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:3,operationId:"retire_original",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_original",mode:"preserve"}),signal:new AbortController().signal};
    const original=await opened.service.canaries.prepare(input);
    const first=await opened.service.canaries.retire(retirementFor(input,5));assert.equal(first.candidateProjectId,original.candidateProjectId);
    const later={...input,controllerEpoch:6,operationId:"retire_later",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_later",mode:"preserve"})};
    const current=await opened.service.canaries.prepare(later),routes=ingress.inspect();
    assert.equal((await opened.service.canaries.retire(retirementFor(input,4))).retirementEpoch,5);
    assert.equal(JSON.parse(await readFile(retirementFile(fixture),"utf8")).epochFloor,6);
    assert.deepEqual(ingress.inspect(),routes);assert.deepEqual(await opened.service.canaries.prepare(later),current);
    for(const changed of [{capsuleSha256:"f".repeat(64)},{releaseId:"release_conflict"},{controllerEpoch:2},{primary:{...input.primary,fence:input.primary.fence+1}}]) {
      await assert.rejects(opened.service.canaries.retire({...retirementFor(input,6),...changed}),/identity conflicts/u);
      assert.deepEqual(ingress.inspect(),routes);
    }
    await assert.rejects(opened.service.canaries.retire(retirementFor(later,5)),/epoch or release is invalid/u);
    await opened.service.canaries.stop(later);
    const newest={...later,controllerEpoch:7,operationId:"retire_newest",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_newest",mode:"preserve"})};
    await opened.service.canaries.prepare(newest);const newestRoutes=ingress.inspect();
    await assert.rejects(opened.service.canaries.retire(retirementFor(later,7)),/historical operation identity/u);
    assert.deepEqual(ingress.inspect(),newestRoutes);
  } finally {await opened?.service.close();await ingress.close();await fixture.close();}
});

test("canary retirement resumes torn cleanup with canaries disabled and retries after a changed primary binding", async () => {
  const fixture=await serviceFixture("retire-restart");let opened,failDelete=true;
  try {
    const data={...fixture.data,delete:async input=>{if(failDelete&&input.projectId.startsWith("canary_")){failDelete=false;throw new Error("owned interrupted retirement cleanup");}return fixture.data.delete(input);}};
    opened=await fixture.open({data,canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_restart_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:2,operationId:"retire_restart",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_restart_candidate",mode:"preserve"}),signal:new AbortController().signal};
    await opened.service.canaries.prepare(input);
    await assert.rejects(opened.service.canaries.retire(retirementFor(input,4)),/interrupted retirement cleanup/u);
    assert.equal(JSON.parse(await readFile(retirementFile(fixture),"utf8")).entries[0].phase,"retiring");
    await assert.rejects(opened.service.canaries.prepare({...input,operationId:"retire_unresolved",controllerEpoch:5}),/cleanup is unresolved/u);
    await opened.service.close();opened=await fixture.open();assert.equal(opened.service.canaries,undefined);
    const recovered=JSON.parse(await readFile(retirementFile(fixture),"utf8"));assert.equal(recovered.entries[0].phase,"retired");
    await opened.service.close();opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    await opened.service.reconcile(providerInput(primary,2));
    const binding=await opened.service.canaries.binding("project_service_01");assert.notEqual(binding.incarnation,input.primary.incarnation);
    const later={...input,primary:binding,controllerEpoch:1,operationId:"retire_new_incarnation"};
    const live=await opened.service.canaries.prepare(later);
    const receipt=await opened.service.canaries.retire(retirementFor(input,3));assert.equal(receipt.phase,"retired");assert.equal(receipt.retirementEpoch,4);
    assert.deepEqual(await opened.service.canaries.prepare(later),live);
  } finally {await opened?.service.close();await fixture.close();}
});

test("canary retirement capacity counts prepared and lost operations together", async () => {
  const fixture=await serviceFixture("retire-capacity");let opened;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"],maxOperations:2}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_capacity_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:2,operationId:"retire_lost_capacity",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_capacity_candidate",mode:"preserve"}),signal:new AbortController().signal};
    await opened.service.canaries.retire(retirementFor(input));
    const second={...input,operationId:"retire_prepared_capacity"};await opened.service.canaries.prepare(second);await opened.service.canaries.stop(second);
    const third={...input,operationId:"retire_exhausted_capacity"};
    await assert.rejects(opened.service.canaries.prepare(third),/capacity is exhausted/u);
    await assert.rejects(opened.service.canaries.retire(retirementFor(third)),/capacity is exhausted/u);
    assert.equal((await opened.service.canaries.retire(retirementFor(second))).phase,"retired");
    assert.equal(JSON.parse(await readFile(retirementFile(fixture),"utf8")).entries.length,2);
  } finally {await opened?.service.close();await fixture.close();}
});

test("canary retirement refuses ordinary candidate identity collisions without deleting data or routes", async () => {
  const fixture=await serviceFixture("retire-collision");let opened;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_collision_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:2,operationId:"retire_collision",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_collision_candidate",mode:"preserve"}),signal:new AbortController().signal};
    const id=`canary_${await deploymentRuntimeDigest(new TextEncoder().encode([input.primary.projectId,input.primary.incarnation,input.controllerEpoch,input.operationId,input.runtime.sha256].join("\n")))}`;
    const ordinary=await fixture.runtime({projectId:id,generation:1,releaseId:"release_ordinary_collision",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"ordinary")});
    await opened.service.reconcile(providerInput(ordinary,1));
    const state=await opened.service.inspect(id),data=await fixture.data.inspect(id),routes=opened.ingress.inspect();
    await assert.rejects(opened.service.canaries.retire(retirementFor(input,3)),/collides with ordinary/u);
    assert.deepEqual(await opened.service.inspect(id),state);assert.deepEqual(await fixture.data.inspect(id),data);assert.deepEqual(opened.ingress.inspect(),routes);
    await opened.service.close();opened=undefined;
    await assert.rejects(fixture.open(),/collides with ordinary/u);
    assert.deepEqual(await fixture.data.inspect(id),data);
  } finally {await opened?.service.close();await fixture.close();}
});

test("canary retirement startup preserves ordinary data when retained cleanup collides with a newer owner", async () => {
  const fixture=await serviceFixture("retire-startup-collision");let opened,deletes=0;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_replay_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:2,operationId:"retire_replay",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_replay_candidate",mode:"preserve"}),signal:new AbortController().signal};
    const prepared=await opened.service.canaries.prepare(input),journalFile=join(fixture.providerRoot,"service","project_service_01.canary.json");
    const retainedJournal=await readFile(journalFile,"utf8");
    await opened.service.canaries.retire(retirementFor(input,3));
    const ordinary=await fixture.runtime({projectId:prepared.candidateProjectId,generation:1,releaseId:"release_retire_replay_ordinary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"ordinary")});
    await opened.service.reconcile(providerInput(ordinary,1));
    const stateFile=join(fixture.providerRoot,"service",`${prepared.candidateProjectId}.json`),state=await readFile(stateFile,"utf8"),data=await fixture.data.inspect(prepared.candidateProjectId);
    await opened.service.close();opened=undefined;
    // Replay internally valid old cleanup metadata alongside the newer ordinary
    // owner, as can happen with a partial metadata restore. Never delete it.
    const retired=JSON.parse(await readFile(retirementFile(fixture),"utf8"));
    for(const phase of ["retiring","retired"]) {
      retired.entries[0].phase=phase;
      await writeFile(retirementFile(fixture),JSON.stringify(retired),{mode:0o600});await writeFile(journalFile,retainedJournal,{mode:0o600});
      await assert.rejects(async()=>{opened=await fixture.open({data:{...fixture.data,delete:async(...args)=>{deletes++;return fixture.data.delete(...args);}}});},/collides with ordinary|retirement conflicts/u);
      assert.equal(deletes,0,"Retirement startup must validate ownership before any candidate deletion.");
      assert.deepEqual(await fixture.data.inspect(prepared.candidateProjectId),data);assert.equal(await readFile(stateFile,"utf8"),state);
      assert.equal(await readFile(journalFile,"utf8"),retainedJournal);
      assert.equal(JSON.parse(await readFile(retirementFile(fixture),"utf8")).entries[0].phase,phase);
    }
  } finally {await opened?.service.close();await fixture.close();}
});

test("canary retirement journals reject corrupt retained identities and epoch floors during disabled startup", async () => {
  const fixture=await serviceFixture("retire-corruption");let opened;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_corrupt_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:2,operationId:"retire_corrupt",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_corrupt_candidate",mode:"preserve"}),signal:new AbortController().signal};
    await opened.service.canaries.retire(retirementFor(input,3));
    const prepared={...input,operationId:"retire_corrupt_prepared",controllerEpoch:3};
    await opened.service.canaries.prepare(prepared);await opened.service.canaries.stop(prepared);
    const original=await readFile(retirementFile(fixture),"utf8");await opened.service.close();opened=undefined;
    for(const corrupt of [value=>{value.protocol="unknown";},value=>{value.epochFloor=1;},value=>{value.entries.push({...value.entries[0]});},value=>{value.entries[0].candidateProjectId="canary_"+"f".repeat(64);},value=>{value.entries[0].unexpected=true;},value=>{value.primary.projectId="another_project";}]) {
      const value=JSON.parse(original);corrupt(value);await writeFile(retirementFile(fixture),JSON.stringify(value),{mode:0o600});
      await assert.rejects(fixture.open(),/retirement/u);
    }
    await writeFile(retirementFile(fixture),original,{mode:0o600});
    const journalFile=join(fixture.providerRoot,"service","project_service_01.canary.json"),journalText=await readFile(journalFile,"utf8"),journal=JSON.parse(journalText);
    journal.spent=[prepared.operationId,...Array.from({length:63},(_,index)=>`retire_corrupt_history_${index}`)];
    await writeFile(journalFile,JSON.stringify(journal),{mode:0o600});
    await assert.rejects(fixture.open(),/combined capacity/u);
    assert.equal(await readFile(journalFile,"utf8"),JSON.stringify(journal),"Invalid combined history must be refused before startup cleanup mutates it.");
    await writeFile(journalFile,journalText,{mode:0o600});opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    assert.equal((await opened.service.canaries.retire(retirementFor(input,3))).phase,"retired");
  } finally {await opened?.service.close();await fixture.close();}
});

test("provider close fences a held retirement before durable absence acknowledgment", {timeout:30_000}, async () => {
  const fixture=await serviceFixture("retire-close");let opened,pending,closing,barrier;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});
    const primary=await fixture.runtime({generation:1,releaseId:"release_retire_close_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"primary")});
    await opened.service.reconcile(providerInput(primary,1));
    const input={primary:await opened.service.canaries.binding("project_service_01"),controllerEpoch:2,operationId:"retire_close",runtime:await fixture.runtime({generation:2,releaseId:"release_retire_close_candidate",mode:"preserve"})};
    barrier=holdNativeDigest(new TextEncoder().encode([input.primary.projectId,input.primary.incarnation,input.controllerEpoch,input.operationId,input.runtime.sha256].join("\n")));
    pending=opened.service.canaries.retire(retirementFor(input));pending.catch(()=>{});await barrier.entered;
    let finished=false;closing=opened.service.close().then(()=>{finished=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(finished,false);
    barrier.release();await assert.rejects(pending,/service is closed/u);await closing;
    await assert.rejects(access(retirementFile(fixture)),{code:"ENOENT"});
  } finally {barrier?.release();barrier?.restore();await pending?.catch(()=>{});await closing?.catch(()=>{});await opened?.service.close();await fixture.close();}
});

function retirementFile(fixture) {return join(fixture.providerRoot,"service","project_service_01.canary-retirements.json");}
function retirementFor(input,retirementEpoch=input.controllerEpoch) {return {primary:input.primary,operationId:input.operationId,controllerEpoch:input.controllerEpoch,releaseId:input.runtime.manifest.releaseId,capsuleSha256:input.runtime.sha256,retirementEpoch};}
function holdNativeDigest(expected) {
  const original=crypto.subtle.digest;let enter,release,held=false;
  const entered=new Promise(resolve=>{enter=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  crypto.subtle.digest=async function(algorithm,value) {
    const bytes=ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
    if(!held&&bytes.length===expected.length&&bytes.every((value,index)=>value===expected[index])){held=true;enter();await pending;}
    return original.call(this,algorithm,value);
  };
  return {entered,release,restore(){crypto.subtle.digest=original;}};
}

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
            options.controlToken??"clankc_provider-service-control-token-12345678901234567890"}),
        },
        artifact,
      }, {
        maxDatabaseBytes: 16 * 1024 * 1024,
      });
    },
    async open(runtimeOptions = {}) {
      const events = [];
      const runtimes = fakeRuntimes(events, runtimeOptions);
      const ingress = runtimeOptions.ingress ?? fakeIngress(events);
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

const canaryHttpToken="clankc_provider-service-control-token-12345678901234567890";
const canaryHttpPath=operation=>`/v1/clank/control/project_service_01/canary/${operation}`;
function canaryHttpInput(primary,runtime,operationId="canary_http_01",controllerEpoch=1) {
  return {primary,operationId,controllerEpoch,releaseId:runtime.manifest.releaseId,capsuleSha256:runtime.sha256};
}
function canaryHttpOptions(operation,input,token=canaryHttpToken,runtime) {
  if(operation==="binding") return {headers:{authorization:`Bearer ${token}`},redirect:"error"};
  const body=runtime?runtime.bytes:JSON.stringify(input);
  return {method:"POST",body,redirect:"error",headers:{authorization:`Bearer ${token}`,"content-type":runtime?"application/vnd.clank.runtime":"application/json",
    "content-length":String(typeof body==="string"?Buffer.byteLength(body):body.byteLength),...(runtime?{"x-clank-canary-input":JSON.stringify(input)}:{})}};
}
async function openCanaryHttp(service,onBodyRead) {
  const server=createServer(async(incoming,outgoing)=>{
    try {
      const controller=new AbortController();incoming.on("aborted",()=>controller.abort());
      const request=new Request(`http://127.0.0.1${incoming.url}`,{method:incoming.method,headers:incoming.headers,signal:controller.signal,
        ...(["GET","HEAD"].includes(incoming.method)?{}:{body:Readable.toWeb(incoming),duplex:"half"})});
      if(onBodyRead&&request.body) {const original=request.body.getReader.bind(request.body);request.body.getReader=(...args)=>{onBodyRead(incoming.url);return original(...args);};}
      const response=await service.handle(request);
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {outgoing.writeHead(500);outgoing.end();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function httpCanaryPrimary(fixture,opened) {
  const primary=await fixture.runtime({generation:1,releaseId:"release_http_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"http-primary")});
  await opened.service.reconcile(providerInput(primary,1));return primary;
}
async function expectCanaryJson(response) {assert.equal(response.status,200,await response.clone().text());const json=await response.json();assert.equal(json.protocol,"clank-provider-canary-control/1");return json;}
function heldCanaryHttp(url,options) {
  let resolve,reject;
  const response=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const request=nativeHttpRequest(url,{method:options.method,headers:options.headers},incoming=>{
    const chunks=[];incoming.on("data",chunk=>chunks.push(chunk));incoming.on("end",()=>resolve({status:incoming.statusCode,body:Buffer.concat(chunks).toString()}));
  });
  request.on("error",reject);response.catch(()=>{});
  request.write(options.body.subarray(0,1));
  return {request,response,finish(){request.end(options.body.subarray(1));}};
}

test("HTTP canary controls issue durable bindings and expose route credentials only on exact prepare", {timeout:30_000}, async()=>{
  const fixture=await serviceFixture("http-controls");let opened,http;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});await httpCanaryPrimary(fixture,opened);http=await openCanaryHttp(opened.service);
    const call=(operation,input,runtime,token=canaryHttpToken)=>fetch(http.url+canaryHttpPath(operation),canaryHttpOptions(operation,input,token,runtime));
    assert.equal((await call("binding",null,null,"invalid-token-123456789012345678901234567890")).status,404);
    const first=await expectCanaryJson(await call("binding")),primary=first.binding;
    const file=join(fixture.providerRoot,"service","project_service_01.canary-binding.json"),stored=await readFile(file,"utf8");
    assert(!stored.includes(canaryHttpToken));assert(!JSON.stringify(first).includes("tokenDigest"));
    assert.deepEqual(await expectCanaryJson(await call("binding")),first);assert.equal(await readFile(file,"utf8"),stored);
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_candidate",mode:"preserve"}),input=canaryHttpInput(primary,runtime);
    const prepared=(await expectCanaryJson(await call("prepare",input,runtime))).state;
    assert.equal(prepared.phase,"running");assert.match(prepared.route.token,/^clanki_/u);
    assert.deepEqual((await expectCanaryJson(await call("prepare",input,runtime))).state,prepared);
    const identity={primary,operationId:input.operationId,controllerEpoch:input.controllerEpoch};
    const inspected=await expectCanaryJson(await call("inspect",identity));assert.equal(inspected.state.phase,"running");assert(!JSON.stringify(inspected).includes(prepared.route.token));assert(!("route" in inspected.state));
    const stopped=await expectCanaryJson(await call("stop",identity));assert.equal(stopped.state.phase,"stopped");assert(!("route" in stopped.state));
    const retired=await expectCanaryJson(await call("retire",{...input,retirementEpoch:2}));assert.equal(retired.retirement.phase,"retired");
    assert.equal((await call("prepare",input,runtime)).status,503);
    assert.equal(await fixture.data.inspect(prepared.candidateProjectId),null);
    for (const suffix of ["binding?x=1","binding/","unknown","../shadow","binding#invalid"]) {
      if(suffix.includes("#")) continue; // Fragments are not transmitted by HTTP clients.
      assert.equal((await fetch(http.url+canaryHttpPath(suffix),canaryHttpOptions("binding"))).status,404);
    }
    const bad=canaryHttpOptions("inspect",identity);bad.headers["content-encoding"]="gzip";
    assert.equal((await fetch(http.url+canaryHttpPath("inspect"),bad)).status,404);
    assert.equal((await fetch(http.url+canaryHttpPath("inspect"),{...canaryHttpOptions("inspect",identity),body:"{}",headers:{authorization:`Bearer ${canaryHttpToken}`,"content-type":"application/json","content-length":"2","x-clank-canary-input":"{}"}})).status,404);
  } finally {await http?.close();await opened?.service.close();await fixture.close();}
});

test("HTTP held native body rechecks rotated current credentials before candidate effects", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-held-body");let opened,http,held,bodyRead;let snapshots=0,applies=0;
  const entered=new Promise(resolve=>bodyRead=resolve);
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]},data:{...fixture.data,snapshot:async(...args)=>{snapshots++;return fixture.data.snapshot(...args);},apply:async(input,...args)=>{if(input.operation.projectId.startsWith("canary_"))applies++;return fixture.data.apply(input,...args);}}});
    await httpCanaryPrimary(fixture,opened);http=await openCanaryHttp(opened.service,url=>{if(url.endsWith("/prepare"))bodyRead();});
    const primary=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding")))).binding;
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_held",mode:"preserve"}),input=canaryHttpInput(primary,runtime);
    held=heldCanaryHttp(http.url+canaryHttpPath("prepare"),canaryHttpOptions("prepare",input,canaryHttpToken,runtime));await entered;
    const rotated=await fixture.runtime({generation:2,releaseId:"release_http_rotated",mode:"preserve",controlToken:"clankc_rotated-http-token-123456789012345678901234567890"});
    await opened.service.reconcile(providerInput(rotated,2));
    const replacement=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding",null,rotated.manifest.ingress.controlToken)))).binding;
    assert.notEqual(replacement.incarnation,primary.incarnation);
    held.finish();assert.equal((await held.response).status,503);
    assert.equal(snapshots,0);assert.equal(applies,0);assert.equal((await fixture.data.inspect("project_service_01")).releaseId,rotated.manifest.releaseId);
    assert.equal((await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding"))).status,404);
    assert.equal((await fetch(http.url+deploymentProviderSnapshotPath("project_service_01"),{headers:{authorization:`Bearer ${canaryHttpToken}`}})).status,404);
  } finally {held?.request.destroy();await http?.close();await opened?.service.close();await fixture.close();}
});

test("HTTP canary deadline cancels held intake, persists retirement and captures timeout options", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-timeout");let opened,http,held,bodyRead;
  const entered=new Promise(resolve=>bodyRead=resolve),policy={readPaths:["/healthz"],controlTimeoutMs:150};
  try {
    opened=await fixture.open({canaries:policy});policy.controlTimeoutMs=60_000;await httpCanaryPrimary(fixture,opened);
    http=await openCanaryHttp(opened.service,url=>{if(url.endsWith("/prepare"))bodyRead();});
    const primary=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding")))).binding;
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_timeout",mode:"preserve"}),input=canaryHttpInput(primary,runtime);
    held=heldCanaryHttp(http.url+canaryHttpPath("prepare"),canaryHttpOptions("prepare",input,canaryHttpToken,runtime));await entered;
    const response=await held.response;assert.equal(response.status,503);assert.match(response.body,/uncertain/u);assert(!response.body.includes('"phase":"retired"'));
    const retired=await expectCanaryJson(await fetch(http.url+canaryHttpPath("retire"),canaryHttpOptions("retire",{...input,retirementEpoch:3})));
    assert.equal(retired.retirement.phase,"retired");assert.equal((JSON.parse(await readFile(retirementFile(fixture),"utf8"))).epochFloor,3);
    assert.equal(await fixture.data.inspect(retired.retirement.candidateProjectId),null);
    await opened.service.close();opened=await fixture.open();
    await http.close();http=await openCanaryHttp(opened.service);
    assert.equal((await expectCanaryJson(await fetch(http.url+canaryHttpPath("retire"),canaryHttpOptions("retire",{...input,retirementEpoch:3})))).retirement.phase,"retired");
  } finally {held?.request.destroy();await http?.close();await opened?.service.close();await fixture.close();}
});

function holdCanaryReceiptRead(filename) {
  const original=fsPromises.open;let enter,release,held=false;
  const entered=new Promise(resolve=>enter=resolve),pending=new Promise(resolve=>release=resolve);
  fsPromises.open=async function(file,...args) {
    const handle=await original.call(this,file,...args);
    if(file===filename&&!held) {held=true;const read=handle.readFile.bind(handle);handle.readFile=async(...readArgs)=>{const value=await read(...readArgs);enter();await pending;return value;};}
    return handle;
  };
  syncBuiltinESMExports();
  return {entered,release,restore(){fsPromises.open=original;syncBuiltinESMExports();}};
}

test("HTTP native receipt reads cannot resurrect revoked inspect or cleanup authority", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-held-receipt");let opened,http,barrier,pending;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});await httpCanaryPrimary(fixture,opened);http=await openCanaryHttp(opened.service);
    const oldPrimary=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding")))).binding;
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_receipt_old",mode:"preserve"}),input=canaryHttpInput(oldPrimary,runtime);
    await expectCanaryJson(await fetch(http.url+canaryHttpPath("retire"),canaryHttpOptions("retire",{...input,retirementEpoch:1})));
    const file=join(fixture.providerRoot,"service","project_service_01.canary-binding.json");
    barrier=holdCanaryReceiptRead(file);
    pending=fetch(http.url+canaryHttpPath("inspect"),canaryHttpOptions("inspect",{primary:oldPrimary,operationId:input.operationId,controllerEpoch:1}));await barrier.entered;
    const token="clankc_new-current-http-123456789012345678901234567890";
    const next=await fixture.runtime({generation:2,releaseId:"release_http_receipt_new",mode:"preserve",controlToken:token});await opened.service.reconcile(providerInput(next,2));
    assert.equal((await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding"))).status,404);
    assert.equal((await fetch(http.url+canaryHttpPath("prepare"),canaryHttpOptions("prepare",input,canaryHttpToken,runtime))).status,404);
    assert.equal((await expectCanaryJson(await fetch(http.url+canaryHttpPath("retire"),canaryHttpOptions("retire",{...input,retirementEpoch:2})))).retirement.phase,"retired");
    const newPrimary=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding",null,token)))).binding;
    barrier.release();assert.equal((await pending).status,404);barrier.restore();barrier=undefined;
    assert.notEqual(newPrimary.incarnation,oldPrimary.incarnation);
    assert.equal((await fetch(http.url+canaryHttpPath("retire"),canaryHttpOptions("retire",{...input,retirementEpoch:2}))).status,404);
    const candidate=await fixture.runtime({generation:3,releaseId:"release_http_receipt_candidate",mode:"preserve"}),newInput=canaryHttpInput(newPrimary,candidate,"new_http_operation",2);
    const prepared=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("prepare"),canaryHttpOptions("prepare",newInput,token,candidate)))).state;
    assert.equal(prepared.phase,"running");
    const retained=await readFile(file,"utf8");assert(!retained.includes(canaryHttpToken));assert(!retained.includes(token));
    assert.equal((await opened.service.canaries.inspect("project_service_01")).operationId,newInput.operationId);
  } finally {barrier?.release();barrier?.restore();await pending?.catch(()=>{});await http?.close();await opened?.service.close();await fixture.close();}
});

test("HTTP binding issuance refuses ignored, altered and unsynced private receipts", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-receipt-writes");let opened,http;
  const originalRename=fsPromises.rename,originalOpen=fsPromises.open;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});await httpCanaryPrimary(fixture,opened);http=await openCanaryHttp(opened.service);
    const file=join(fixture.providerRoot,"service","project_service_01.canary-binding.json");
    for(const fault of ["ignored","altered","unsynced"]) {
      fsPromises.rename=async function(from,to) {if(to!==file)return originalRename.call(this,from,to);if(fault==="ignored")return;await originalRename.call(this,from,to);if(fault==="altered"){const row=JSON.parse(await readFile(to,"utf8"));row.tokenDigest[0]^=1;await writeFile(to,JSON.stringify(row),{mode:0o600});}};
      fsPromises.open=async function(filename,...args) {const handle=await originalOpen.call(this,filename,...args);if(fault==="unsynced"&&String(filename).startsWith(file+".tmp-"))handle.sync=async()=>{throw new Error("held receipt fsync failure");};return handle;};
      syncBuiltinESMExports();
      const response=await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding"));assert.equal(response.status,503,fault);assert(!JSON.stringify(await response.json()).includes('"binding"'));
      fsPromises.rename=originalRename;fsPromises.open=originalOpen;syncBuiltinESMExports();await rm(file,{force:true});
    }
    await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding")));
    await opened.service.close();opened=undefined;
    const valid=await readFile(file,"utf8");
    for(const invalid of ["{",JSON.stringify({...JSON.parse(valid),protocol:"clank-provider-canary-binding/999"}),JSON.stringify({...JSON.parse(valid),primary:{...JSON.parse(valid).primary,projectId:"other_project"}})]) {
      await writeFile(file,invalid,{mode:0o600});await assert.rejects(fixture.open(),/invalid|scope/u);
    }
    await writeFile(file,valid,{mode:0o600});opened=await fixture.open();
  } finally {fsPromises.rename=originalRename;fsPromises.open=originalOpen;syncBuiltinESMExports();await http?.close();await opened?.service.close();await fixture.close();}
});

async function openHttpChild(root,primaryFile,mode) {
  const child=fork(new URL("./fixtures/provider-canary-http.mjs",import.meta.url),[root,primaryFile,mode],{execArgv:["--disable-warning=ExperimentalWarning"],stdio:["ignore","ignore","pipe","ipc"]});
  let errors="";child.stderr.on("data",chunk=>{errors+=chunk.toString();});
  const ready=await Promise.race([once(child,"message").then(([value])=>value),once(child,"exit").then(([code,signal])=>{throw new Error(`HTTP fixture exited ${code}/${signal}: ${errors}`);})]);
  assert.equal(ready.phase,"ready",JSON.stringify(ready));
  return {child,url:ready.url,async close(){if(child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,"exit");child.send("close");await exit;}};
}

test("HTTP lost prejournal prepare survives native child SIGKILL and disabled restart with exact absence proof", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-process-restart");let first,restarted,held;
  try {
    const primaryRuntime=await fixture.runtime({generation:1,releaseId:"release_http_child_primary",mode:"initialize",snapshot:await sqliteSnapshot(fixture.root,"http-child")});
    const primaryFile=join(fixture.root,"primary.runtime");await writeFile(primaryFile,primaryRuntime.bytes,{mode:0o600});
    first=await openHttpChild(fixture.providerRoot,primaryFile,"first");
    const primary=(await expectCanaryJson(await fetch(first.url+canaryHttpPath("binding"),canaryHttpOptions("binding")))).binding;
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_child_candidate",mode:"preserve"}),input=canaryHttpInput(primary,runtime,"http_child_lost",7);
    const message=once(first.child,"message");held=heldCanaryHttp(first.url+canaryHttpPath("prepare"),canaryHttpOptions("prepare",input,canaryHttpToken,runtime));
    assert.equal((await message)[0].phase,"body-held");
    await assert.rejects(access(join(fixture.providerRoot,"service","project_service_01.canary.json")),{code:"ENOENT"});
    const exit=once(first.child,"exit");first.child.kill("SIGKILL");assert.equal((await exit)[1],"SIGKILL");await assert.rejects(held.response);
    restarted=await openHttpChild(fixture.providerRoot,primaryFile,"disabled");
    for(const operation of ["binding","inspect","prepare","stop"]) {
      const options=canaryHttpOptions(operation,operation==="prepare"?input:{primary,operationId:input.operationId,controllerEpoch:7},canaryHttpToken,operation==="prepare"?runtime:undefined);
      assert.equal((await fetch(restarted.url+canaryHttpPath(operation),options)).status,404,operation);
    }
    assert.equal((await fetch(restarted.url+deploymentProviderSnapshotPath("project_service_01"),{headers:{authorization:`Bearer ${canaryHttpToken}`}})).status,404);
    const wrong={...input,primary:{...primary,incarnation:crypto.randomUUID()},retirementEpoch:9};
    assert.equal((await fetch(restarted.url+canaryHttpPath("retire"),canaryHttpOptions("retire",wrong))).status,404);
    const requested={...input,retirementEpoch:9};
    const retired=(await expectCanaryJson(await fetch(restarted.url+canaryHttpPath("retire"),canaryHttpOptions("retire",requested)))).retirement;
    assert.equal(retired.phase,"retired");assert.equal(retired.controllerEpoch,7);assert.equal(retired.retirementEpoch,9);
    await assert.rejects(access(join(fixture.providerRoot,"projects",retired.candidateProjectId)),{code:"ENOENT"});
    assert.equal((await fixture.data.inspect("project_service_01")).releaseId,primaryRuntime.manifest.releaseId);
    await restarted.close();restarted=await openHttpChild(fixture.providerRoot,primaryFile,"disabled");
    assert.deepEqual((await expectCanaryJson(await fetch(restarted.url+canaryHttpPath("retire"),canaryHttpOptions("retire",requested)))).retirement,retired);
    assert.equal((await fetch(restarted.url+canaryHttpPath("retire"),canaryHttpOptions("retire",{...requested,capsuleSha256:"f".repeat(64)}))).status,503);
  } finally {held?.request.destroy();await restarted?.close();await first?.close();await fixture.close();}
});

test("HTTP native callback timeout remains uncertain and shutdown retains root ownership until cleanup", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-native-timeout");let opened,http,pending,closing,release,enter;
  const entered=new Promise(resolve=>enter=resolve),held=new Promise(resolve=>release=resolve);
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"],controlTimeoutMs:500},data:{...fixture.data,snapshot:async projectId=>{const snapshot=await fixture.data.snapshot(projectId);enter();await held;return snapshot;}}});
    await httpCanaryPrimary(fixture,opened);http=await openCanaryHttp(opened.service);
    const primary=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding")))).binding;
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_native_timeout",mode:"preserve"}),input=canaryHttpInput(primary,runtime);
    pending=fetch(http.url+canaryHttpPath("prepare"),canaryHttpOptions("prepare",input,canaryHttpToken,runtime));await entered;
    const response=await pending;assert.equal(response.status,503);assert.match(await response.text(),/uncertain/u);
    const journalFile=join(fixture.providerRoot,"service","project_service_01.canary.json");assert.equal(JSON.parse(await readFile(journalFile,"utf8")).current.phase,"preparing");
    let closed=false;closing=opened.service.close().then(()=>{closed=true;});
    await assert.rejects(fixture.open(),/already has an active writer/u);assert.equal(closed,false);
    release();await closing;await http.close();http=undefined;
    assert.equal(JSON.parse(await readFile(journalFile,"utf8")).current.phase,"stopped");
    opened=await fixture.open();http=await openCanaryHttp(opened.service);
    const retired=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("retire"),canaryHttpOptions("retire",{...input,retirementEpoch:3})))).retirement;
    assert.equal(retired.phase,"retired");assert.equal(await fixture.data.inspect(retired.candidateProjectId),null);
  } finally {release?.();await pending?.catch(()=>{});await closing?.catch(()=>{});await http?.close();await opened?.service.close();await fixture.close();}
});

test("HTTP malformed and encoded controls never fall through to ordinary application ingress", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-control-envelopes");let opened,http,held,bodyRead;
  const entered=new Promise(resolve=>bodyRead=resolve);let applicationRequests=0;
  try {
    const ingress=fakeIngress([]);ingress.handle=async()=>{applicationRequests++;return new Response("unexpected application response");};
    opened=await fixture.open({ingress,canaries:{readPaths:["/healthz"],controlTimeoutMs:500}});await httpCanaryPrimary(fixture,opened);http=await openCanaryHttp(opened.service,url=>{if(url.endsWith("/prepare"))bodyRead();});
    for(const path of ["/v1/clank/%2563ontrol/project_service_01/canary/binding","/v1/clank/%252563ontrol/project_service_01/canary/binding","/v1/clank/%63ontrol/project_service_01/canary/binding","/v1/clank/control/project_service_01/canary/%62inding","/v1/clank/control/project_service_01/canary/shadow","/v1/clank/control/project_service_01/canary/prepare?redirect=1"]) {
      assert.equal((await fetch(http.url+path,canaryHttpOptions("binding"))).status,404,path);
    }
    const primary=(await expectCanaryJson(await fetch(http.url+canaryHttpPath("binding"),canaryHttpOptions("binding")))).binding;
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_envelope",mode:"preserve"}),input=canaryHttpInput(primary,runtime);
    const options=canaryHttpOptions("prepare",input,canaryHttpToken,runtime);
    for(const patch of [{"content-length":"9999999999"},{"x-clank-canary-input":"x".repeat(4_097)},{"content-encoding":"br"}]) {
      const response=await opened.service.handle(new Request("http://provider.test"+canaryHttpPath("prepare"),{...options,headers:{...options.headers,...patch}}));assert.equal(response.status,404);
    }
    // A held unauthenticated body is rejected without consuming the intake slot.
    const bad=heldCanaryHttp(http.url+canaryHttpPath("prepare"),canaryHttpOptions("prepare",input,"clankc_wrong-authentication-12345678901234567890",runtime));
    assert.equal((await bad.response).status,404);bad.request.destroy();
    held=heldCanaryHttp(http.url+canaryHttpPath("prepare"),options);await entered;
    const busy=await fetch(http.url+canaryHttpPath("prepare"),options);assert.equal(busy.status,503);
    held.finish();assert.equal((await held.response).status,200);
    assert.equal(applicationRequests,0);
  } finally {held?.request.destroy();await http?.close();await opened?.service.close();await fixture.close();}
});

test("HTTP canary envelope captures validated length before asynchronous native receipt reads", {timeout:30_000},async()=>{
  const fixture=await serviceFixture("http-length-capture");let opened,barrier,pending;
  try {
    opened=await fixture.open({canaries:{readPaths:["/healthz"]}});await httpCanaryPrimary(fixture,opened);
    const url="http://provider.test"+canaryHttpPath("binding");
    const primary=(await expectCanaryJson(await opened.service.handle(new Request(url,canaryHttpOptions("binding"))))).binding;
    const runtime=await fixture.runtime({generation:2,releaseId:"release_http_captured_length",mode:"preserve"}),input=canaryHttpInput(primary,runtime);
    const request=new Request("http://provider.test"+canaryHttpPath("prepare"),canaryHttpOptions("prepare",input,canaryHttpToken,runtime));
    barrier=holdCanaryReceiptRead(join(fixture.providerRoot,"service","project_service_01.canary-binding.json"));
    pending=opened.service.handle(request);await barrier.entered;
    request.headers.set("content-length","1");request.headers.set("x-clank-canary-input","{}");request.headers.set("authorization","Bearer changed-credential-123456789012345678901234567890");
    barrier.release();const prepared=(await expectCanaryJson(await pending)).state;
    assert.equal(prepared.capsuleSha256,runtime.sha256);assert.equal(prepared.operationId,input.operationId);
  } finally {barrier?.release();barrier?.restore();await pending?.catch(()=>{});await opened?.service.close();await fixture.close();}
});
