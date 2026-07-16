import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createManagedIngress,
  defineDatabase,
  openBackupManager,
  openDeploymentOrchestrator,
  openSQLite,
} from "../dist/index.js";

test("a crashed deployment worker is reclaimed and its stale completion is fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-chaos-operation-"));
  const database = await openSQLite(defineDatabase({}), {
    path: join(root, "control.sqlite"),
    wal: false,
  });
  const orchestrator = openDeploymentOrchestrator(database, { operationLeaseMs: 100 });
  try {
    const node = await orchestrator.registerNode({ id: "chaos-node", region: "test", capacity: 1 });
    await orchestrator.enqueue({
      projectId: "chaos_project",
      action: "deploy",
      idempotencyKey: "chaos-deploy-operation-0001",
      nodeId: node.node.id,
    });
    const [abandoned] = await orchestrator.claim(node.node.id, node.token, 1);
    assert.equal(abandoned.fence, 1);

    await new Promise((resolve) => setTimeout(resolve, 175));
    const [reclaimed] = await orchestrator.claim(node.node.id, node.token, 1);
    assert.equal(reclaimed.id, abandoned.id);
    assert.equal(reclaimed.fence, 2);
    assert.equal(await orchestrator.complete(abandoned, { stale: true }), false);
    assert.equal(await orchestrator.complete(reclaimed, { recovered: true }), true);
    assert.deepEqual(orchestrator.operation(reclaimed.id).result, { recovered: true });
  } finally {
    orchestrator.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt encrypted backup fails closed without changing the live database", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-chaos-backup-"));
  const databasePath = join(root, "app.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE state (value TEXT NOT NULL)");
  database.prepare("INSERT INTO state (value) VALUES (?)").run("live-data");
  database.close();
  const manager = await openBackupManager({
    databasePath,
    repositoryDirectory: join(root, "backups"),
    encryptionKey: "a sufficiently long chaos backup encryption key",
  });
  try {
    const backup = await manager.create({ reason: "chaos corruption drill" });
    const envelopePath = join(root, "backups", backup.id, "database.enc");
    const envelope = await readFile(envelopePath);
    envelope[envelope.byteLength - 1] ^= 0xff;
    await writeFile(envelopePath, envelope);
    await assert.rejects(
      manager.restore(backup.id, { confirmation: `restore ${backup.id}` }),
      /decryption failed|authenticate/i,
    );
    const current = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(current.prepare("SELECT value FROM state").get().value, "live-data");
    current.close();
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an ingress circuit opens during failure and automatically probes recovery", async () => {
  let available = false;
  let calls = 0;
  const ingress = createManagedIngress({
    routes: () => [{
      id: "chaos_route",
      projectId: "chaos_project",
      hosts: ["chaos.example.test"],
      upstream: "http://127.0.0.1:4999",
      active: true,
    }],
    retries: 0,
    circuitFailures: 1,
    circuitResetMs: 100,
    fetch: async () => {
      calls++;
      if (!available) throw new Error("simulated upstream outage");
      return new Response("healthy");
    },
  });
  const request = () => new Request("https://chaos.example.test/");
  assert.equal((await ingress.handle(request())).status, 502);
  assert.equal((await ingress.handle(request())).status, 503);
  assert.equal(calls, 1);
  available = true;
  await new Promise((resolve) => setTimeout(resolve, 140));
  const recovered = await ingress.handle(request());
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), "healthy");
  assert.equal(calls, 2);
});
