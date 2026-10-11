import { sealPointInTimeState } from "./point-in-time-state.ts";
/** Called only inside the bounded SQLite namespace. Never publishes its working database. */
export async function replayJournal(databasePath: string, envelopes: string[], keyBytes: number[], epoch: string, through?: number, asOf?: number) {
  const sqliteName = "node:sqlite", cryptoName = "node:crypto";
  const [{ DatabaseSync }, crypto] = await Promise.all([import(sqliteName), import(cryptoName)]);
  const database = new DatabaseSync(databasePath);
  const buffer = (globalThis as any).Buffer;
  try {
    database.enableLoadExtension(false);
    database.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=1000");
    let state = database.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get();
    if (!state || state.epoch !== epoch) throw new Error("Recovery base epoch does not match the repository.");
    if (sealPointInTimeState(database, crypto.createHash, 128 * 1024 * 1024) !== state.state_hash) throw new Error("Recovery base seal does not match its committed state.");
    if ((through != null && Number(state.sequence) > through) || (asOf != null && Number(state.committed_at) > asOf)) throw new Error("Requested recovery boundary predates the base snapshot.");
    for (const encoded of envelopes) {
      const entry = JSON.parse(encoded);
      const { digest, ...content } = entry;
      if (entry.protocol !== "clank-pitr/1" || entry.epoch !== epoch || entry.keyId !== state.key_id || entry.schemaHash !== state.schema_hash
        || !Number.isSafeInteger(entry.sequence) || !Number.isSafeInteger(entry.committedAt)
        || crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex") !== digest) throw new Error("Invalid recovery journal envelope.");
      const { iv, body, tag, ...header } = content;
      const decipher = crypto.createDecipheriv("aes-256-gcm", new Uint8Array(keyBytes), buffer.from(iv, "base64"));
      decipher.setAAD(buffer.from(JSON.stringify(header))); decipher.setAuthTag(buffer.from(tag, "base64"));
      const plaintext = JSON.parse(buffer.concat([decipher.update(buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
      // Envelopes already represented by the base are still authenticated before skipping.
      if (entry.sequence <= Number(state.sequence)) continue;
      if (entry.sequence !== Number(state.sequence) + 1 || entry.previousDigest !== state.digest || entry.committedAt <= Number(state.committed_at)) throw new Error("Recovery journal is missing or reorders a committed transaction.");
      database.exec("BEGIN IMMEDIATE");
      try {
        // Changesets already contain trigger/cascade effects. Re-running either
        // would duplicate writes or incorrectly conflict with captured deletes.
        const triggers = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
        for (const trigger of triggers) database.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
        for (const change of plaintext.changes) {
          if (typeof change.table !== "string" || change.table.startsWith("clank_pitr_") || (change.table !== "*" && !database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(change.table))) throw new Error("Recovery changeset names an unsupported table.");
          if (!database.applyChangeset(buffer.from(change.bytes, "base64"), { filter: (table: string) => (change.table === "*" ? !table.startsWith("clank_pitr_") : table === change.table) })) throw new Error("Recovery changeset conflicts with its base.");
        }
        if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
          database.exec("DELETE FROM sqlite_sequence");
          for (const sequence of plaintext.sequences) database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(sequence.name, sequence.seq);
        }
        for (const trigger of triggers) database.exec(String(trigger.sql));
        if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Recovery changeset violates foreign keys.");
        if (sealPointInTimeState(database, crypto.createHash, 128 * 1024 * 1024) !== plaintext.stateHash) throw new Error("Recovered state does not match its committed recovery seal.");
        database.prepare("UPDATE clank_pitr_state SET sequence=?,digest=?,committed_at=?,state_hash=? WHERE id=1")
          .run(entry.sequence, digest, entry.committedAt, plaintext.stateHash);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      state = database.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get();
    }
    return { epoch, sequence: Number(state.sequence), committedAt: Number(state.committed_at), databasePath };
  } finally { database.close(); }
}
export async function finishReplay(databasePath: string): Promise<void> {
  const sqliteName = "node:sqlite";
  const { DatabaseSync } = await import(sqliteName);
  const database = new DatabaseSync(databasePath);
  try {
    database.enableLoadExtension(false); database.exec("PRAGMA trusted_schema=OFF");
    if (String(database.prepare("PRAGMA integrity_check").get()?.integrity_check) !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Recovered SQLite database failed integrity checks.");
    database.exec("BEGIN IMMEDIATE");
    try {
      // Source export receipts belong to the old epoch. Retaining their table
      // would make enrolling the restored database fail as a partial protocol.
      database.exec("DROP TABLE IF EXISTS clank_pitr_remote_exports; DROP TABLE clank_pitr_journal; DROP TABLE clank_pitr_state; COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { database.close(); }
}
