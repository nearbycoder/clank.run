import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlatform } from "../dist/platform.js";
import {
  resolveBackupStorage,
  resolvePlatformHosting,
  resolveProviderPlacement,
  resolveRunnerArtifactStorage,
} from "../scripts/platform-hosting.mjs";

test("development remains zero-setup while production defaults to isolated Docker hosting", () => {
  assert.deepEqual(
    resolvePlatformHosting({}, undefined),
    { hostingProfile: "trusted", runnerKind: "process" },
  );
  assert.deepEqual(
    resolvePlatformHosting({ NODE_ENV: "production" }, "bootstrap"),
    { hostingProfile: "isolated", runnerKind: "docker" },
  );
  assert.deepEqual(
    resolvePlatformHosting({ CLANK_RUNNER: "docker" }, "bootstrap"),
    { hostingProfile: "isolated", runnerKind: "docker" },
  );
});

test("trusted process hosting requires an explicit production profile", () => {
  assert.throws(
    () => resolvePlatformHosting({
      NODE_ENV: "production",
      CLANK_RUNNER: "process",
    }, "bootstrap"),
    /isolated hosting profile requires CLANK_RUNNER=docker/u,
  );
  assert.deepEqual(
    resolvePlatformHosting({
      NODE_ENV: "production",
      CLANK_HOSTING_PROFILE: "trusted",
      CLANK_RUNNER: "process",
    }, "bootstrap"),
    { hostingProfile: "trusted", runnerKind: "process" },
  );
});

test("public signup cannot use the shared process trust boundary", () => {
  assert.throws(
    () => resolvePlatformHosting({
      CLANK_HOSTING_PROFILE: "trusted",
      CLANK_RUNNER: "process",
    }, "public"),
    /CLANK_SIGNUP=public requires CLANK_HOSTING_PROFILE=isolated/u,
  );
  assert.deepEqual(
    resolvePlatformHosting({
      CLANK_HOSTING_PROFILE: "isolated",
      CLANK_RUNNER: "docker",
    }, "public"),
    { hostingProfile: "isolated", runnerKind: "docker" },
  );
});

test("hosting configuration rejects unknown values rather than falling back to process execution", () => {
  assert.throws(
    () => resolvePlatformHosting({ CLANK_HOSTING_PROFILE: "public" }, "bootstrap"),
    /CLANK_HOSTING_PROFILE must be trusted or isolated/u,
  );
  assert.throws(
    () => resolvePlatformHosting({ CLANK_RUNNER: "dockre" }, "bootstrap"),
    /CLANK_RUNNER must be process or docker/u,
  );
});

test("runner artifact storage resolves explicit S3-compatible configuration without hidden defaults", () => {
  assert.equal(resolveRunnerArtifactStorage({}), null);
  const resolved = resolveRunnerArtifactStorage({
    CLANK_RUNNER_ARTIFACT_STORE: "s3",
    CLANK_RUNNER_ARTIFACT_NAMESPACE: "production-v1",
    AWS_ENDPOINT_URL: "https://objects.example.test",
    AWS_DEFAULT_REGION: "auto",
    AWS_S3_BUCKET_NAME: "clank-artifacts",
    AWS_ACCESS_KEY_ID: "ACCESSKEY",
    AWS_SECRET_ACCESS_KEY: "secret-access-key",
    AWS_SESSION_TOKEN: "temporary-session-token",
    CLANK_OBJECT_PREFIX: "installation-01",
    CLANK_OBJECT_PATH_STYLE: "1",
    CLANK_RUNNER_MAX_ARTIFACT_BYTES: "4096",
  });
  assert.deepEqual(resolved, {
    namespace: "production-v1",
    options: {
      endpoint: "https://objects.example.test",
      region: "auto",
      bucket: "clank-artifacts",
      accessKeyId: "ACCESSKEY",
      secretAccessKey: "secret-access-key",
      sessionToken: "temporary-session-token",
      prefix: "installation-01",
      pathStyle: true,
      maxObjectBytes: 4096,
    },
  });
  assert.throws(
    () => resolveRunnerArtifactStorage({ CLANK_RUNNER_ARTIFACT_STORE: "filesystem" }),
    /must be local or s3/u,
  );
  assert.throws(
    () => resolveRunnerArtifactStorage({
      CLANK_RUNNER_ARTIFACT_STORE: "s3",
      CLANK_RUNNER_ARTIFACT_NAMESPACE: "production-v1",
    }),
    /CLANK_OBJECT_ENDPOINT is required/u,
  );
  assert.throws(
    () => resolveRunnerArtifactStorage({
      CLANK_RUNNER_ARTIFACT_STORE: "s3",
      CLANK_RUNNER_ARTIFACT_NAMESPACE: "production-v1",
      CLANK_OBJECT_ENDPOINT: "https://objects.example.test",
      CLANK_OBJECT_REGION: "auto",
      CLANK_OBJECT_BUCKET: "clank-artifacts",
      CLANK_OBJECT_ACCESS_KEY_ID: "ACCESSKEY",
      CLANK_OBJECT_SECRET_ACCESS_KEY: "secret-access-key",
      CLANK_OBJECT_PATH_STYLE: "yes",
    }),
    /CLANK_OBJECT_PATH_STYLE must be 0 or 1/u,
  );
});

test("provider placement is explicit, bounded, and local-by-choice", () => {
  assert.equal(resolveProviderPlacement({}), null);
  assert.deepEqual(
    resolveProviderPlacement({
      CLANK_PROVIDER_DEFAULT_PLACEMENT: "local",
      CLANK_PROVIDER_REGION: "us-central",
      CLANK_PROVIDER_LABELS: "tier=stateful,disk=encrypted",
      CLANK_PROVIDER_ALLOWED_HOSTS: "provider.internal, provider.internal",
      CLANK_PROVIDER_ACTIVATION_TIMEOUT_MS: "45000",
      CLANK_RUNNER_MAX_RUNTIME_BYTES: "1048576",
      CLANK_PROVIDER_MAX_DATABASE_BYTES: "524288",
    }),
    {
      default: "local",
      region: "us-central",
      labels: {
        tier: "stateful",
        disk: "encrypted",
      },
      allowedProviderHosts: ["provider.internal"],
      activationTimeoutMs: 45_000,
      maxRuntimeBytes: 1_048_576,
      maxDatabaseBytes: 524_288,
    },
  );
  assert.throws(
    () => resolveProviderPlacement({
      CLANK_PROVIDER_DEFAULT_PLACEMENT: "automatic",
    }),
    /must be local or provider/u,
  );
  assert.throws(
    () => resolveProviderPlacement({
      CLANK_PROVIDER_DEFAULT_PLACEMENT: "local",
      CLANK_PROVIDER_LABELS: "tier=one,tier=two",
    }),
    /Duplicate CLANK_PROVIDER_LABELS/u,
  );
});

test("provider placement reserves capsule capacity for code, database, and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-provider-capacity-"));
  try {
    await assert.rejects(
      openPlatform({
        dataDirectory: root,
        publicUrl: "http://127.0.0.1:4200",
        signup: true,
        deploymentAgents: {
          registrationToken: `registration-${"r".repeat(32)}`,
          maxArtifactBytes: 256 * 1024,
          placement: {
            maxDatabaseBytes: 512 * 1024,
            maxRuntimeBytes: 1024 * 1024,
          },
        },
        ingress: { baseDomain: "apps.example.test" },
      }),
      /must contain the artifact, database, and manifest limits/u,
    );
    await assert.rejects(
      openPlatform({
        dataDirectory: root,
        publicUrl: "http://127.0.0.1:4200",
        signup: true,
        deploymentAgents: {
          registrationToken: `registration-${"r".repeat(32)}`,
          maxArtifactBytes: "262144",
          placement: {},
        },
        ingress: { baseDomain: "apps.example.test" },
      }),
      /deploymentAgents.maxArtifactBytes must be an integer/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup storage resolves bounded chunking over the shared S3 configuration", () => {
  assert.equal(resolveBackupStorage({}), null);
  const resolved = resolveBackupStorage({
    CLANK_BACKUP_STORE: "s3",
    CLANK_BACKUP_NAMESPACE: "recovery-production-v1",
    CLANK_BACKUP_PREFIX: "recovery",
    CLANK_BACKUP_CHUNK_BYTES: "1048576",
    CLANK_OBJECT_ENDPOINT: "https://objects.example.test",
    CLANK_OBJECT_REGION: "auto",
    CLANK_OBJECT_BUCKET: "clank-private",
    CLANK_OBJECT_ACCESS_KEY_ID: "ACCESSKEY",
    CLANK_OBJECT_SECRET_ACCESS_KEY: "secret-access-key",
  });
  assert.deepEqual(resolved, {
    namespace: "recovery-production-v1",
    prefix: "recovery",
    chunkBytes: 1_048_576,
    options: {
      endpoint: "https://objects.example.test",
      region: "auto",
      bucket: "clank-private",
      accessKeyId: "ACCESSKEY",
      secretAccessKey: "secret-access-key",
      pathStyle: false,
      maxObjectBytes: 32 * 1024 * 1024,
    },
  });
  assert.throws(
    () => resolveBackupStorage({ CLANK_BACKUP_STORE: "filesystem" }),
    /CLANK_BACKUP_STORE must be local or s3/u,
  );
  assert.throws(
    () => resolveBackupStorage({
      CLANK_BACKUP_STORE: "s3",
      CLANK_BACKUP_NAMESPACE: "recovery-production-v1",
      CLANK_BACKUP_CHUNK_BYTES: "1024",
    }),
    /CLANK_BACKUP_CHUNK_BYTES/u,
  );
});

test("programmatic isolated hosting requires an isolated runner and reports its posture", async () => {
  await assert.rejects(
    openPlatform({
      dataDirectory: join(tmpdir(), "clank-hosting-mismatch-must-not-open"),
      publicUrl: "http://127.0.0.1:4200",
      hostingProfile: "isolated",
      runner: { kind: "process" },
    }),
    /hostingProfile "isolated" requires a Docker runner/u,
  );
  await assert.rejects(
    openPlatform({
      dataDirectory: join(tmpdir(), "clank-object-namespace-must-not-open"),
      publicUrl: "http://127.0.0.1:4200",
      deploymentAgents: {
        registrationToken: "clank_runner_registration_validation_1234567890",
        artifacts: {
          namespace: "local",
          store: {
            kind: "test",
            async put() { throw new Error("unused"); },
            async get() { return null; },
            async stat() { return null; },
            async delete() { return false; },
          },
        },
      },
    }),
    /portable non-local identifier/u,
  );

  const root = await mkdtemp(join(tmpdir(), "clank-hosting-profile-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    hostingProfile: "isolated",
    runner: { kind: "docker", executable: "unused-test-docker" },
    signup: false,
    backups: { intervalMs: false },
  });
  try {
    assert.equal(platform.hostingProfile, "isolated");
    assert.equal(platform.runnerKind, "docker");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});
