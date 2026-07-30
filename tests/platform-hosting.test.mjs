import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlatform } from "../dist/platform.js";
import { resolvePlatformHosting } from "../scripts/platform-hosting.mjs";

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
