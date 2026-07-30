import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defineDatabase,
  defineTable,
  openBackupManager,
  openSQLite,
  s,
} from "../dist/index.js";

async function fixture(maxBackups = 3) {
  const root = await mkdtemp(join(tmpdir(), "clank-recovery-"));
  const databasePath = join(root, "app.sqlite");
  const database = await openSQLite(defineDatabase({
    tasks: defineTable({
      title: s.string({ min: 1, max: 200 }),
      done: s.boolean(),
    }),
  }), { path: databasePath, wal: false });
  database.transaction((db) => {
    db.table("tasks").insert({ title: "preserve me", done: false });
  });
  database.close();
  const events = [];
  const manager = await openBackupManager({
    databasePath,
    repositoryDirectory: join(root, "backups"),
    encryptionKey: "a sufficiently long backup encryption key for the recovery tests",
    maxBackups,
    verifyAfterCreate: true,
    onEvent: (event) => events.push(event),
  });
  return {
    root,
    databasePath,
    manager,
    events,
    async close() {
      manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function memoryObjectStore() {
  const values = new Map();
  const controls = { failChunks: false };
  const store = Object.freeze({
    kind: "memory",
    async put(key, input, options = {}) {
      if (controls.failChunks && key.includes("/chunks/")) {
        throw new Error("simulated object chunk failure");
      }
      const bytes = new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input));
      const now = Date.now();
      const existing = values.get(key);
      const metadata = Object.freeze({
        key,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: options.contentType ?? "application/octet-stream",
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
      });
      values.set(key, { metadata, bytes });
      return metadata;
    },
    async get(key) {
      const value = values.get(key);
      return value
        ? { metadata: value.metadata, bytes: new Uint8Array(value.bytes) }
        : null;
    },
    async stat(key) {
      return values.get(key)?.metadata ?? null;
    },
    async delete(key) {
      return values.delete(key);
    },
  });
  return { store, values, controls };
}

test("encrypted backups are consistent, authenticated, restorable, and require confirmation", async () => {
  const test = await fixture();
  try {
    const backup = await test.manager.create({ reason: "before destructive import" });
    assert.equal(backup.protocol, "clank-backup/1");
    assert.equal(backup.databaseRevision, 1);
    assert.equal(backup.reason, "before destructive import");
    assert.equal((await test.manager.list())[0].id, backup.id);
    const verification = await test.manager.verify(backup.id);
    assert.equal(verification.ok, true);
    assert.equal(verification.databaseSha256, backup.databaseSha256);

    const encrypted = await readFile(join(test.root, "backups", backup.id, "database.enc"));
    assert.equal(encrypted.includes(Buffer.from("preserve me")), false);
    assert.match(encrypted.subarray(0, 8).toString(), /^CLNKBK1/);

    let database = new DatabaseSync(test.databasePath);
    database.prepare("DELETE FROM clank_tasks").run();
    database.close();
    await assert.rejects(
      test.manager.restore(backup.id, { confirmation: "yes" }),
      /confirmation/,
    );
    await test.manager.restore(backup.id, { confirmation: `restore ${backup.id}` });
    database = new DatabaseSync(test.databasePath, { readOnly: true });
    const row = database.prepare("SELECT _data FROM clank_tasks").get();
    database.close();
    assert.equal(JSON.parse(row._data).title, "preserve me");
    assert.ok(test.events.some((event) => event.type === "created" && event.backupId === backup.id));
    assert.ok(test.events.some((event) => event.type === "restored" && event.backupId === backup.id));
  } finally {
    await test.close();
  }
});

test("backup authentication detects ciphertext and manifest tampering", async () => {
  const test = await fixture();
  try {
    const ciphertextBackup = await test.manager.create({ reason: "ciphertext tamper test" });
    const envelopePath = join(test.root, "backups", ciphertextBackup.id, "database.enc");
    const envelope = await readFile(envelopePath);
    envelope[Math.floor(envelope.length / 2)] ^= 0xff;
    await writeFile(envelopePath, envelope);
    await assert.rejects(test.manager.verify(ciphertextBackup.id), /decryption failed|authenticate/i);

    const manifestBackup = await test.manager.create({ reason: "manifest tamper test" });
    const manifestPath = join(test.root, "backups", manifestBackup.id, "manifest.json");
    const signed = JSON.parse(await readFile(manifestPath, "utf8"));
    signed.manifest.reason = "attacker changed this";
    await writeFile(manifestPath, `${JSON.stringify(signed)}\n`);
    await assert.rejects(test.manager.verify(manifestBackup.id), /manifest authentication/i);
  } finally {
    await test.close();
  }
});

test("retention preserves the newest verified backups", async () => {
  const test = await fixture(2);
  try {
    await test.manager.create({ reason: "one" });
    await test.manager.create({ reason: "two" });
    await test.manager.create({ reason: "three" });
    const backups = await test.manager.list();
    assert.equal(backups.length, 2);
    assert.deepEqual(new Set(backups.map((backup) => backup.reason)), new Set(["two", "three"]));
    assert.ok(test.events.some((event) => event.type === "deleted"));
  } finally {
    await test.close();
  }
});

test("a create-time protection keeps the selected restore target past a full retention window", async () => {
  const test = await fixture(1);
  try {
    const target = await test.manager.create({ reason: "selected restore target" });
    const safety = await test.manager.create({
      reason: "pre-restore safety",
      protectedBackupIds: [target.id],
    });
    assert.deepEqual(
      new Set((await test.manager.list()).map((backup) => backup.id)),
      new Set([target.id, safety.id]),
    );
    await test.manager.create({ reason: "normal retention resumes" });
    const retained = await test.manager.list();
    assert.equal(retained.length, 1);
    assert.equal(retained[0].reason, "normal retention resumes");
  } finally {
    await test.close();
  }
});

test("consistent snapshot imports stay encrypted on disk and support bounded authenticated reads", async () => {
  const test = await fixture();
  const sourceBytes = new Uint8Array(await readFile(test.databasePath));
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  test.manager.close();
  await rm(join(test.root, "backups"), { recursive: true, force: true });
  const manager = await openBackupManager({
    repositoryDirectory: join(test.root, "backups"),
    encryptionKey: "a sufficiently long backup encryption key for the recovery tests",
    maxBackups: 3,
    maxDatabaseBytes: sourceBytes.byteLength,
    verifyAfterCreate: true,
  });
  try {
    const backup = await manager.createFromSnapshot({
      bytes: sourceBytes,
      sha256: sourceSha256,
      source: "remote.sqlite",
      reason: "provider snapshot",
      databaseRevision: 1,
      migrationCount: 0,
    });
    assert.equal(backup.databaseSha256, sourceSha256);
    assert.equal(backup.source, "remote.sqlite");
    assert.equal(backup.reason, "provider snapshot");
    assert.equal(
      Buffer.from(await readFile(
        join(test.root, "backups", backup.id, "database.enc"),
      )).includes(Buffer.from("preserve me")),
      false,
    );
    assert.deepEqual(
      await readdir(join(test.root, "backups", ".staging")),
      [],
      "snapshot import and authenticated read must not stage plaintext files",
    );

    const read = await manager.read(backup.id);
    assert.deepEqual(read.bytes, sourceBytes);
    assert.equal(read.verification.databaseSha256, sourceSha256);
    assert.deepEqual(await readdir(join(test.root, "backups", ".staging")), []);

    await assert.rejects(
      manager.restore(backup.id, { confirmation: `restore ${backup.id}` }),
      /restore target path is required/u,
    );
    const target = join(test.root, "restored.sqlite");
    await manager.restore(backup.id, {
      targetPath: target,
      confirmation: `restore ${backup.id}`,
    });
    const restored = new DatabaseSync(target, { readOnly: true });
    assert.equal(
      JSON.parse(restored.prepare("SELECT _data FROM clank_tasks").get()._data).title,
      "preserve me",
    );
    restored.close();
  } finally {
    manager.close();
    await test.close();
  }
});

test("snapshot imports reject invalid SQLite input and checksum drift without committing a backup", async () => {
  const test = await fixture();
  const sourceBytes = new Uint8Array(await readFile(test.databasePath));
  test.manager.close();
  await rm(join(test.root, "backups"), { recursive: true, force: true });
  const manager = await openBackupManager({
    repositoryDirectory: join(test.root, "backups"),
    encryptionKey: "a sufficiently long backup encryption key for the recovery tests",
    maxDatabaseBytes: sourceBytes.byteLength,
  });
  try {
    await assert.rejects(
      manager.create(),
      /local database path is required/u,
    );
    await assert.rejects(
      manager.createFromSnapshot({
        bytes: sourceBytes,
        sha256: "0".repeat(64),
        source: "remote.sqlite",
      }),
      /checksum failed/u,
    );
    const invalid = new Uint8Array(sourceBytes);
    invalid[0] ^= 0xff;
    await assert.rejects(
      manager.createFromSnapshot({
        bytes: invalid,
        source: "remote.sqlite",
      }),
      /not a SQLite database/u,
    );
    assert.deepEqual(await manager.list(), []);
    assert.deepEqual(await readdir(join(test.root, "backups", ".staging")), []);
  } finally {
    manager.close();
    await test.close();
  }
});

test("object-backed backups are chunked, authenticated, restorable, and remotely deleted", async () => {
  const test = await fixture();
  const objects = memoryObjectStore();
  test.manager.close();
  const filler = new DatabaseSync(test.databasePath);
  filler.exec("CREATE TABLE backup_chunk_filler (payload BLOB NOT NULL)");
  const insertFiller = filler.prepare(
    "INSERT INTO backup_chunk_filler (payload) VALUES (randomblob(4096))",
  );
  for (let index = 0; index < 40; index++) insertFiller.run();
  filler.close();
  const manager = await openBackupManager({
    databasePath: test.databasePath,
    repositoryDirectory: join(test.root, "backups"),
    encryptionKey: "a sufficiently long backup encryption key for the recovery tests",
    maxBackups: 3,
    verifyAfterCreate: true,
    objects: {
      store: objects.store,
      namespace: "test-recovery-v1",
      repositoryId: "database-01",
      prefix: "recovery",
      chunkBytes: 64 * 1024,
    },
  });
  try {
    const backup = await manager.create({ reason: "off-host recovery" });
    assert.equal((await manager.list())[0].id, backup.id);
    const objectKeys = [...objects.values.keys()];
    const catalogKey = "recovery/database-01/catalog.json";
    const chunkKeys = objectKeys.filter((key) => key.includes("/chunks/"));
    assert.ok(chunkKeys.length >= 2, "the encrypted envelope crosses multiple bounded objects");
    assert.equal(objectKeys.includes(catalogKey), true);
    assert.equal(
      new TextDecoder().decode(objects.values.get(catalogKey).bytes).includes("preserve me"),
      false,
    );
    assert.equal(
      chunkKeys.some((key) => Buffer.from(objects.values.get(key).bytes).includes("preserve me")),
      false,
    );
    assert.equal(
      (await readdir(join(test.root, "backups"))).some((entry) => entry === backup.id),
      false,
      "a committed object backup must not remain coupled to the local volume",
    );

    const verified = await manager.verify(backup.id);
    assert.equal(verified.databaseSha256, backup.databaseSha256);
    let database = new DatabaseSync(test.databasePath);
    database.prepare("DELETE FROM clank_tasks").run();
    database.close();
    await manager.restore(backup.id, { confirmation: `restore ${backup.id}` });
    database = new DatabaseSync(test.databasePath, { readOnly: true });
    assert.equal(
      JSON.parse(database.prepare("SELECT _data FROM clank_tasks").get()._data).title,
      "preserve me",
    );
    database.close();

    const chunk = objects.values.get(chunkKeys[0]);
    chunk.bytes[Math.floor(chunk.bytes.length / 2)] ^= 0xff;
    await assert.rejects(manager.verify(backup.id), /inconsistent metadata|integrity/u);
    chunk.bytes[Math.floor(chunk.bytes.length / 2)] ^= 0xff;

    assert.equal(await manager.delete(backup.id), true);
    assert.equal((await manager.list()).length, 0);
    assert.equal([...objects.values.keys()].some((key) => key.includes(`/${backup.id}/`)), false);
  } finally {
    manager.close();
    await test.close();
  }
});

test("object-backed repositories import and read provider snapshots without a live database path", async () => {
  const test = await fixture();
  const sourceBytes = new Uint8Array(await readFile(test.databasePath));
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const objects = memoryObjectStore();
  test.manager.close();
  await rm(join(test.root, "backups"), { recursive: true, force: true });
  const manager = await openBackupManager({
    repositoryDirectory: join(test.root, "backups"),
    encryptionKey: "a sufficiently long backup encryption key for the recovery tests",
    maxBackups: 3,
    maxDatabaseBytes: sourceBytes.byteLength,
    verifyAfterCreate: true,
    objects: {
      store: objects.store,
      namespace: "test-provider-recovery-v1",
      repositoryId: "provider-database-01",
      prefix: "provider-recovery",
      chunkBytes: 64 * 1024,
    },
  });
  try {
    const backup = await manager.createFromSnapshot({
      bytes: sourceBytes,
      sha256: sourceSha256,
      source: "provider.sqlite",
      reason: "remote provider snapshot",
    });
    assert.equal((await manager.list())[0].id, backup.id);
    assert.equal(
      (await readdir(join(test.root, "backups"))).some((entry) => entry === backup.id),
      false,
    );
    const read = await manager.read(backup.id);
    assert.deepEqual(read.bytes, sourceBytes);
    assert.equal(read.verification.databaseSha256, sourceSha256);
    assert.equal(
      [...objects.values.values()].some((value) =>
        Buffer.from(value.bytes).includes(Buffer.from("preserve me"))),
      false,
    );
  } finally {
    manager.close();
    await test.close();
  }
});

test("object backup upload failures retain a local recovery copy and resume safely", async () => {
  const test = await fixture(2);
  const objects = memoryObjectStore();
  test.manager.close();
  const manager = await openBackupManager({
    databasePath: test.databasePath,
    repositoryDirectory: join(test.root, "backups"),
    encryptionKey: "a sufficiently long backup encryption key for the recovery tests",
    maxBackups: 2,
    verifyAfterCreate: true,
    objects: {
      store: objects.store,
      namespace: "test-recovery-v1",
      repositoryId: "database-02",
      chunkBytes: 64 * 1024,
    },
  });
  try {
    objects.controls.failChunks = true;
    await assert.rejects(
      manager.create({ reason: "survive failed upload" }),
      /simulated object chunk failure/u,
    );
    const retained = await manager.list();
    assert.equal(retained.length, 1);
    assert.equal(retained[0].reason, "survive failed upload");
    assert.ok(await readFile(
      join(test.root, "backups", retained[0].id, "database.enc"),
    ));

    objects.controls.failChunks = false;
    await manager.create({ reason: "retry and continue" });
    const recovered = await manager.list();
    assert.equal(recovered.length, 2);
    assert.deepEqual(
      new Set(recovered.map((backup) => backup.reason)),
      new Set(["survive failed upload", "retry and continue"]),
    );
    assert.equal(
      (await readdir(join(test.root, "backups"))).some((entry) => entry.startsWith("bk_")),
      false,
    );
    await Promise.all(recovered.map((backup) => manager.verify(backup.id)));

    objects.controls.failChunks = true;
    await assert.rejects(
      manager.create({ reason: "incomplete promotion before purge" }),
      /simulated object chunk failure/u,
    );
    objects.controls.failChunks = false;
    await assert.rejects(
      manager.purge({ confirmation: "yes" }),
      /purge confirmation/u,
    );
    assert.equal(
      await manager.purge({ confirmation: "delete all backups" }),
      3,
    );
    assert.equal((await manager.list()).length, 0);
    assert.equal(objects.values.size, 0);
  } finally {
    manager.close();
    await test.close();
  }
});

test("object backup catalogs reject repository identity drift", async () => {
  const test = await fixture();
  const objects = memoryObjectStore();
  const legacy = await test.manager.create({ reason: "legacy local recovery point" });
  test.manager.close();
  const options = {
    databasePath: test.databasePath,
    repositoryDirectory: join(test.root, "backups"),
    encryptionKey: "a sufficiently long backup encryption key for the recovery tests",
    objects: {
      store: objects.store,
      namespace: "test-recovery-v1",
      repositoryId: "database-03",
    },
  };
  const manager = await openBackupManager(options);
  try {
    const current = await manager.create({ reason: "identity binding" });
    assert.deepEqual(
      new Set((await manager.list()).map((backup) => backup.id)),
      new Set([legacy.id, current.id]),
    );
    assert.equal(
      (await readdir(join(test.root, "backups"))).some((entry) => entry.startsWith("bk_")),
      false,
      "legacy local recovery points are promoted before the next backup",
    );
  } finally {
    manager.close();
  }
  const changed = await openBackupManager({
    ...options,
    objects: { ...options.objects, namespace: "different-repository" },
  });
  try {
    await assert.rejects(
      changed.list(),
      /does not match the configured repository/u,
    );
  } finally {
    changed.close();
    await test.close();
  }
});
