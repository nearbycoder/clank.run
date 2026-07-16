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
