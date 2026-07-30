import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDeploymentBundle } from "../dist/deploy.js";
import {
  createDeploymentRuntimeCapsule,
  decodeDeploymentRuntimeCapsule,
  deploymentRuntimeDigest,
  DEPLOYMENT_RUNTIME_MEDIA_TYPE,
  DEPLOYMENT_RUNTIME_PROTOCOL,
} from "../dist/runtime-placement.js";

test("runtime capsules bind code, final environment, SQLite data, and ingress identity", async () => {
  const fixture = await runtimeFixture();
  try {
    const input = {
      projectId: "project_runtime_01",
      releaseId: "release_runtime_01",
      generation: 7,
      environment: {
        Z_LAST: "last",
        DATABASE_API_SECRET: "private-runtime-secret-value",
        CLANK_MANAGED_INGRESS: "1",
      },
      database: {
        path: "app.sqlite",
        mode: "initialize",
        snapshot: fixture.database,
      },
      ingress: {
        route: "/v1/clank/apps/project_runtime_01",
        token: "clanki_runtime-ingress-token-12345678901234567890",
        controlToken: "clankc_runtime-control-token-12345678901234567890",
      },
      artifact: fixture.artifact,
    };
    const first = await createDeploymentRuntimeCapsule(input);
    const second = await createDeploymentRuntimeCapsule(input);
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.sha256, await deploymentRuntimeDigest(first.bytes));
    assert.equal(first.manifest.protocol, DEPLOYMENT_RUNTIME_PROTOCOL);
    assert.equal(DEPLOYMENT_RUNTIME_MEDIA_TYPE, "application/vnd.clank.runtime");
    assert.deepEqual(Object.keys(first.manifest.environment), [
      "CLANK_MANAGED_INGRESS",
      "DATABASE_API_SECRET",
      "Z_LAST",
    ]);
    assert.equal(Object.isFrozen(first.manifest.environment), true);
    assert.equal(first.manifest.database.snapshot.bytes, fixture.database.byteLength);
    assert.equal(first.artifact.bundle.config.health.path, "/healthz");
    assert.deepEqual(first.databaseSnapshot, fixture.database);

    const decoded = await decodeDeploymentRuntimeCapsule(first.bytes);
    assert.equal(decoded.sha256, first.sha256);
    assert.equal(decoded.manifest.projectId, "project_runtime_01");
    assert.equal(decoded.manifest.releaseId, "release_runtime_01");
    assert.equal(decoded.manifest.generation, 7);
    assert.equal(
      decoded.manifest.environment.DATABASE_API_SECRET,
      "private-runtime-secret-value",
    );
    assert.equal(decoded.manifest.ingress.route, "/v1/clank/apps/project_runtime_01");
    assert.equal(
      decoded.manifest.ingress.controlToken,
      "clankc_runtime-control-token-12345678901234567890",
    );
    assert.equal(decoded.artifact.bundle.config.database.path, "app.sqlite");
    assert.deepEqual(decoded.databaseSnapshot, fixture.database);

    const preserve = await createDeploymentRuntimeCapsule({
      ...input,
      generation: 8,
      database: { path: "app.sqlite", mode: "preserve" },
    });
    const preserved = await decodeDeploymentRuntimeCapsule(preserve.bytes);
    assert.equal(preserved.manifest.database.mode, "preserve");
    assert.equal(preserved.manifest.database.snapshot, null);
    assert.equal(preserved.databaseSnapshot, null);
  } finally {
    await fixture.close();
  }
});

test("runtime capsules fail closed on mismatched paths, modes, lengths, and bytes", async () => {
  const fixture = await runtimeFixture();
  const secret = "must-not-appear-in-runtime-errors";
  const base = {
    projectId: "project_runtime_02",
    releaseId: "release_runtime_02",
    generation: 1,
    environment: { PRIVATE_SECRET: secret },
    database: {
      path: "app.sqlite",
      mode: "initialize",
      snapshot: fixture.database,
    },
    ingress: {
      route: "/v1/clank/apps/project_runtime_02",
      token: "clanki_runtime-ingress-token-abcdefghijklmnopqrstuvwxyz",
    },
    artifact: fixture.artifact,
  };
  try {
    await assert.rejects(
      createDeploymentRuntimeCapsule({
        ...base,
        database: { ...base.database, path: "other.sqlite" },
      }),
      /database path does not match/u,
    );
    await assert.rejects(
      createDeploymentRuntimeCapsule({
        ...base,
        database: { path: "app.sqlite", mode: "preserve", snapshot: fixture.database },
      }),
      /cannot include a replacement snapshot/u,
    );
    await assert.rejects(
      createDeploymentRuntimeCapsule({
        ...base,
        database: { path: "app.sqlite", mode: "replace" },
      }),
      /requires a database snapshot/u,
    );
    await assert.rejects(
      createDeploymentRuntimeCapsule({
        ...base,
        database: {
          path: "app.sqlite",
          mode: "initialize",
          snapshot: new Uint8Array(32),
        },
      }),
      /not a SQLite database/u,
    );
    await assert.rejects(
      createDeploymentRuntimeCapsule({
        ...base,
        environment: { BAD_VALUE: "contains\0nul", PRIVATE_SECRET: secret },
      }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(secret, "u"));
        return /BAD_VALUE/u.test(error.message);
      },
    );
    await assert.rejects(
      createDeploymentRuntimeCapsule({
        ...base,
        ingress: { ...base.ingress, route: "/v1/%2e%2e/project_runtime_02" },
      }),
      /ingress route is invalid/u,
    );

    const capsule = await createDeploymentRuntimeCapsule(base);
    const view = new DataView(
      capsule.bytes.buffer,
      capsule.bytes.byteOffset,
      capsule.bytes.byteLength,
    );
    const manifestLength = view.getUint32(8);
    const artifactLength = Number(view.getBigUint64(16));
    const artifactStart = 32 + manifestLength;
    const databaseStart = artifactStart + artifactLength;

    const artifactTampered = new Uint8Array(capsule.bytes);
    artifactTampered[artifactStart + Math.floor(artifactLength / 2)] ^= 1;
    await assert.rejects(
      decodeDeploymentRuntimeCapsule(artifactTampered),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(secret, "u"));
        return /artifact failed integrity/u.test(error.message);
      },
    );

    const databaseTampered = new Uint8Array(capsule.bytes);
    databaseTampered[databaseStart + fixture.database.byteLength - 1] ^= 1;
    await assert.rejects(
      decodeDeploymentRuntimeCapsule(databaseTampered),
      /snapshot failed integrity/u,
    );

    const lengthTampered = new Uint8Array(capsule.bytes);
    new DataView(lengthTampered.buffer).setBigUint64(24, BigInt(fixture.database.byteLength + 1));
    await assert.rejects(
      decodeDeploymentRuntimeCapsule(lengthTampered),
      /length is inconsistent/u,
    );
    await assert.rejects(
      decodeDeploymentRuntimeCapsule(capsule.bytes, {
        maxManifestBytes: 1_024,
        maxArtifactBytes: 1_024,
        maxDatabaseBytes: 1_024,
        maxCapsuleBytes: 4_096,
      }),
      /section exceeds|capsule size/u,
    );
  } finally {
    await fixture.close();
  }
});

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "clank-runtime-capsule-"));
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(join(root, "dist", "server.js"), "export default {};\n");
  await writeFile(
    join(root, "migrations", "001-init.sql"),
    "CREATE TABLE task (id TEXT PRIMARY KEY);\n",
  );
  const artifact = await createDeploymentBundle(root, {
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
  }, {
    frameworkVersion: "0.9.4-test",
    nodeVersion: "22.16.0",
  });
  const databasePath = join(root, "app.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  database.prepare("INSERT INTO task (id, title) VALUES (?, ?)").run("task-1", "private");
  database.close();
  const databaseBytes = await readFile(databasePath);
  return {
    artifact,
    database: new Uint8Array(databaseBytes),
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
