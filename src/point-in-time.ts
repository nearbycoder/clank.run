import { sealPointInTimeState } from "./point-in-time-state.ts";
import { SQLITE_INTERNAL, type SQLiteCaptureConnection } from "./sqlite-internal.ts";
import type { SQLiteDatabase } from "./backend.ts";
import { openBackupManager } from "./recovery.ts";
import { restoreSQLiteBackup } from "./migrations.ts";
import { runSQLiteTask } from "./sqlite-task.ts";

export interface PointInTimeRecoveryOptions {
  /** Dedicated private directory. Copy this entire encrypted repository off the application volume. */
  directory: string;
  encryptionKey: Uint8Array;
  keyId?: string;
  /** Maximum encoded changes in one transaction, defaults to 4 MiB. Larger writes roll back. */
  maxTransactionBytes?: number;
  /** Maximum canonical live state, defaults to 32 MiB. Bounds seal verification costs. */
  maxStateBytes?: number;
  exportIntervalMs?: number | false;
  onError?: (error: unknown) => void;
}
export interface PointInTimeRecoveryStatus {
  epoch: string;
  committedThrough: number;
  exportedThrough: number;
  lastCommittedAt: number;
  baseBackupId: string;
}
export interface PointInTimeRecovery {
  status(): PointInTimeRecoveryStatus;
  /** Durable encrypted changes are retained in SQLite until explicitly rotated into a new epoch. */
  flush(): Promise<PointInTimeRecoveryStatus>;
  close(): Promise<void>;
}
export interface PointInTimeRestoreOptions {
  directory: string;
  encryptionKey: Uint8Array;
  targetPath: string;
  confirmation: "restore point in time";
  /** Exact committed boundary, preferred over wall-clock selection. */
  throughSequence?: number;
  /** Select the latest recorded commit timestamp at or before this time. */
  asOf?: number;
}
export interface PointInTimeRestoreResult { epoch: string; sequence: number; committedAt: number; databasePath: string; }
const bounded = (value: number, name: string, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
};
const keyBytes = (value: Uint8Array) => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("Recovery encryptionKey must contain exactly 32 bytes.");
  return new Uint8Array(value);
};

/** Captures every successful framework transaction, after service schema bootstrap and before serving requests. */
export async function openPointInTimeRecovery(database: SQLiteDatabase<any>, options: PointInTimeRecoveryOptions): Promise<PointInTimeRecovery> {
  const fsName = "node:fs/promises", pathName = "node:path", cryptoName = "node:crypto";
  const [fs, path, crypto] = await Promise.all([import(fsName), import(pathName), import(cryptoName)]);
  const key = keyBytes(options.encryptionKey);
  const maximum = bounded(options.maxTransactionBytes ?? 4 * 1024 * 1024, "maxTransactionBytes", 1024, 8 * 1024 * 1024);
  const stateMaximum = bounded(options.maxStateBytes ?? 32 * 1024 * 1024, "maxStateBytes", 1024, 128 * 1024 * 1024);
  const interval = options.exportIntervalMs === false ? false : bounded(options.exportIntervalMs ?? 1000, "exportIntervalMs", 100, 3_600_000);
  const keyId = options.keyId ?? crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(keyId)) throw new TypeError("Invalid recovery keyId.");
  const directory = path.resolve(options.directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Recovery directory cannot be a symbolic link.");
  await fs.chmod(directory, 0o700);
  const internal = database[SQLITE_INTERNAL];
  if (!internal.captureTransactions) throw new Error("Database does not support transactional recovery capture.");
  let connection!: SQLiteCaptureConnection;
  let fatal: unknown;
  const hash = (value: string | Uint8Array) => crypto.createHash("sha256").update(value).digest("hex");
  let schema = "";
  const shape = () => JSON.stringify(connection.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'clank_pitr_*' ORDER BY type,name").all());
  const stateDigest = () => sealPointInTimeState(connection, crypto.createHash, stateMaximum);
  internal.captureTransactions((value) => {
    connection = value;
    connection.exec("BEGIN IMMEDIATE");
    try {
    if (connection.path === ":memory:") throw new Error("Recovery requires a file-backed SQLite database.");
    connection.exec(`CREATE TABLE IF NOT EXISTS clank_pitr_state(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,key_id TEXT NOT NULL,key_hash TEXT NOT NULL,schema_hash TEXT NOT NULL,state_hash TEXT NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,committed_at INTEGER NOT NULL,base_id TEXT NOT NULL DEFAULT '',exported INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS clank_pitr_journal(sequence INTEGER PRIMARY KEY, envelope TEXT NOT NULL);`);
    schema = shape();
    const current = stateDigest();
    const existing = connection.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get();
    if (existing) {
      if (existing.key_id !== keyId || existing.key_hash !== hash(key) || existing.schema_hash !== hash(schema) || existing.state_hash !== current) throw new Error("Recovery seal mismatch: unjournaled writers, schema changes or a different key require a new verified recovery epoch.");
    } else connection.prepare("INSERT INTO clank_pitr_state(id,epoch,key_id,key_hash,schema_hash,state_hash,sequence,digest,committed_at) VALUES(1,?,?,?,?,?,0,?,?)")
      .run(crypto.randomUUID(), keyId, hash(key), hash(schema), current, "0".repeat(64), Date.now());
    const dataVersion = Number(connection.prepare("PRAGMA data_version").get()?.data_version);
    let sessions: Array<{ table: string; session: ReturnType<SQLiteCaptureConnection["createSession"]> }> = [];
    const ensureSealed = () => {
      if (fatal) throw fatal;
      if (Number(connection.prepare("PRAGMA data_version").get()?.data_version) !== dataVersion || shape() !== schema) {
        fatal = new Error("Recovery detected another SQLite writer or a schema change; writes are fenced until operator recovery."); throw fatal;
      }
    };
    // Keep SQLite's preupdate hook installed between transactions. Otherwise
    // DELETE without WHERE can compile to the truncate optimization before the
    // per-transaction session exists and silently bypass capture.
    const sentinel = connection.createSession({ table: "clank_pitr_state" });
    connection.exec("COMMIT");
    return {
      before() { ensureSealed(); sessions = [{ table: "*", session: connection.createSession({}) }]; },
      commit() {
        ensureSealed();
        const changes = sessions.map(({ table, session }) => ({ table, bytes: (globalThis as any).Buffer.from(session.changeset()).toString("base64") })).filter((entry) => entry.bytes);
        const prior = connection.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get()!;
        const state = stateDigest();
        if (!changes.length && state === prior.state_hash) return;
        const sequences = connection.prepare("SELECT 1 AS found FROM sqlite_schema WHERE name='sqlite_sequence'").get()
          ? connection.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all() : [];
        const plaintext = JSON.stringify({ changes, sequences, stateHash: state });
        if ((globalThis as any).Buffer.byteLength(plaintext) > maximum) throw new Error("Recovery transaction exceeds maxTransactionBytes; the transaction was rolled back.");
        const header = { protocol: "clank-pitr/1", epoch: prior.epoch, sequence: Number(prior.sequence) + 1, committedAt: Math.max(Date.now(), Number(prior.committed_at) + 1), previousDigest: prior.digest, schemaHash: prior.schema_hash, keyId };
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD((globalThis as any).Buffer.from(JSON.stringify(header)));
        const body = (globalThis as any).Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const content = { ...header, iv: iv.toString("base64"), body: body.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
        const envelope = JSON.stringify({ ...content, digest: hash(JSON.stringify(content)) });
        connection.prepare("INSERT INTO clank_pitr_journal(sequence,envelope) VALUES(?,?)").run(header.sequence, envelope);
        connection.prepare("UPDATE clank_pitr_state SET state_hash=?,sequence=?,digest=?,committed_at=? WHERE id=1").run(state, header.sequence, hash(JSON.stringify(content)), header.committedAt);
      },
      after() { for (const { session } of sessions) session.close(); sessions = []; },
      close() { for (const { session } of sessions) session.close(); sentinel.close(); key.fill(0); },
    };
    } catch (error) { connection.exec("ROLLBACK"); throw error; }
  });
  const manager = await openBackupManager({ databasePath: connection.path, repositoryDirectory: path.join(directory, "base"), encryptionKey: key, keyId, maxBackups: 2, maxDatabaseBytes: stateMaximum * 4 });
  let timer: ReturnType<typeof setInterval> | undefined, flight: Promise<PointInTimeRecoveryStatus> | undefined, closed = false;
  const state = () => connection.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get()!;
  const status = (): PointInTimeRecoveryStatus => { const row = state(); return { epoch: String(row.epoch), committedThrough: Number(row.sequence), exportedThrough: Number(row.exported), lastCommittedAt: Number(row.committed_at), baseBackupId: String(row.base_id) }; };
  const syncWrite = async (file: string, contents: string, replace = false) => {
    const temporary = `${file}.tmp-${crypto.randomUUID()}`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    try { if (replace) await fs.rename(temporary, file); else await fs.link(temporary, file); } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST" || await fs.readFile(file, "utf8") !== contents) throw error;
    } finally { await fs.rm(temporary, { force: true }); }
    const parent = await fs.open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
  };
  try {
    if (!state().base_id) {
      const backup = await manager.create({ reason: "point-in-time recovery epoch" });
      connection.prepare("UPDATE clank_pitr_state SET base_id=? WHERE id=1").run(backup.id);
    }
    const manifest = { protocol: "clank-pitr-repository/1", epoch: state().epoch, keyId, baseBackupId: state().base_id };
    const encoded = JSON.stringify(manifest);
    await syncWrite(path.join(directory, "epoch.json"), JSON.stringify({ manifest, mac: crypto.createHmac("sha256", key).update(encoded).digest("hex") }));
  } catch (error) { manager.close(); throw error; }
  const flush = async () => {
    if (closed) throw new Error("Recovery exporter is closed.");
    if (flight) return flight;
    flight = (async () => {
      const through = Number(state().sequence);
      for (let cursor = Number(state().exported) + 1; cursor <= through; cursor++) {
        const row = connection.prepare("SELECT envelope FROM clank_pitr_journal WHERE sequence=?").get(cursor);
        if (!row) throw new Error("Recovery journal has a missing committed transaction.");
        await syncWrite(path.join(directory, `${String(cursor).padStart(16, "0")}.json`), String(row.envelope));
        connection.prepare("UPDATE clank_pitr_state SET exported=? WHERE id=1").run(cursor);
      }
      const headRow = state();
      const checkpoint = { epoch: headRow.epoch, sequence: through, digest: through ? JSON.parse(String(connection.prepare("SELECT envelope FROM clank_pitr_journal WHERE sequence=?").get(through)!.envelope)).digest : "0".repeat(64), committedAt: through ? JSON.parse(String(connection.prepare("SELECT envelope FROM clank_pitr_journal WHERE sequence=?").get(through)!.envelope)).committedAt : Number(headRow.committed_at) };
      const encoded = JSON.stringify(checkpoint);
      await syncWrite(path.join(directory, "head.json"), JSON.stringify({ checkpoint, mac: crypto.createHmac("sha256", key).update(encoded).digest("hex") }), true);
      return status();
    })().finally(() => { flight = undefined; });
    return flight;
  };
  await flush();
  if (interval !== false) { timer = setInterval(() => { void flush().catch((error) => { try { options.onError?.(error); } catch {} }); }, interval); (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.(); }
  return { status, flush, async close() { if (closed) return; if (timer) clearInterval(timer); await (flight ?? flush()); closed = true; manager.close(); } };
}

/** Replays an authenticated encrypted base and an unbroken journal into a stopped destination. */
export async function restorePointInTime(options: PointInTimeRestoreOptions): Promise<PointInTimeRestoreResult> {
  if (options.confirmation !== "restore point in time") throw new TypeError("Point-in-time restore confirmation is required.");
  if ((options.throughSequence === undefined) === (options.asOf === undefined)) throw new TypeError("Choose exactly one committed sequence or asOf timestamp.");
  if (options.throughSequence !== undefined) bounded(options.throughSequence, "throughSequence", 0, Number.MAX_SAFE_INTEGER);
  if (options.asOf !== undefined) bounded(options.asOf, "asOf", 0, Number.MAX_SAFE_INTEGER);
  const fsName = "node:fs/promises", pathName = "node:path", cryptoName = "node:crypto", osName = "node:os", constantsName = "node:fs";
  const [fs, path, crypto, os, { constants }] = await Promise.all([import(fsName), import(pathName), import(cryptoName), import(osName), import(constantsName)]);
  const readBounded = async (filename: string, maximum: number): Promise<string> => {
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maximum) throw new Error("Recovery archive entry is not a bounded regular file.");
      const bytes = new Uint8Array(maximum + 1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > maximum) throw new Error("Recovery archive entry exceeds its size bound.");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
  };
  const key = keyBytes(options.encryptionKey), directory = path.resolve(options.directory);
  const encoded = JSON.parse(await readBounded(path.join(directory, "epoch.json"), 64 * 1024));
  const expected = crypto.createHmac("sha256", key).update(JSON.stringify(encoded.manifest)).digest("hex");
  if (encoded.mac !== expected || encoded.manifest?.protocol !== "clank-pitr-repository/1") throw new Error("Recovery repository authentication failed.");
  const head = JSON.parse(await readBounded(path.join(directory, "head.json"), 64 * 1024));
  if (head.mac !== crypto.createHmac("sha256", key).update(JSON.stringify(head.checkpoint)).digest("hex") || head.checkpoint.epoch !== encoded.manifest.epoch
    || !Number.isSafeInteger(head.checkpoint.sequence) || head.checkpoint.sequence < 0) throw new Error("Recovery export checkpoint authentication failed.");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-pitr-"));
  const temporary = path.join(root, "replay.sqlite");
  const manager = await openBackupManager({ repositoryDirectory: path.join(directory, "base"), encryptionKey: key, keyId: encoded.manifest.keyId, maxDatabaseBytes: 512 * 1024 * 1024 });
  try {
    await manager.restore(encoded.manifest.baseBackupId, { targetPath: temporary, confirmation: `restore ${encoded.manifest.baseBackupId}` });
    const entries = (await fs.readdir(directory)).filter((name: string) => /^[0-9]{16}\.json$/u.test(name)).sort();
    let result = await runSQLiteTask<PointInTimeRestoreResult>("recovery", "replayJournal", [temporary, [], Array.from(key), encoded.manifest.epoch, options.throughSequence, options.asOf]);
    let verifiedSequence = 0, verifiedDigest = "0".repeat(64);
    for (const entry of entries) {
      const envelope = await readBounded(path.join(directory, entry), 12 * 1024 * 1024);
      if ((globalThis as any).Buffer.byteLength(envelope) > 12 * 1024 * 1024) throw new Error("Recovery entry exceeds size limit.");
      const parsed = JSON.parse(envelope);
      if (Number(parsed.sequence) > head.checkpoint.sequence) continue;
      const { digest, ...content } = parsed;
      if (parsed.epoch !== encoded.manifest.epoch || parsed.protocol !== "clank-pitr/1" || parsed.sequence !== verifiedSequence + 1 || parsed.previousDigest !== verifiedDigest
        || crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex") !== digest) throw new Error("Recovery journal has missing, reordered or invalid recovery entries.");
      const { iv, body, tag, ...header } = content;
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, (globalThis as any).Buffer.from(iv, "base64"));
      decipher.setAAD((globalThis as any).Buffer.from(JSON.stringify(header))); decipher.setAuthTag((globalThis as any).Buffer.from(tag, "base64"));
      decipher.update((globalThis as any).Buffer.from(body, "base64")); decipher.final();
      verifiedSequence = parsed.sequence; verifiedDigest = digest;
      if (options.throughSequence !== undefined && Number(parsed.sequence) > options.throughSequence) continue;
      if (options.asOf !== undefined && Number(parsed.committedAt) > options.asOf) continue;
      result = await runSQLiteTask<PointInTimeRestoreResult>("recovery", "replayJournal", [temporary, [envelope], Array.from(key), encoded.manifest.epoch, options.throughSequence, options.asOf]);
    }
    if (verifiedSequence !== head.checkpoint.sequence || verifiedDigest !== head.checkpoint.digest) throw new Error("Recovery journal is missing its authenticated exported tail.");
    if (options.throughSequence !== undefined && result.sequence !== options.throughSequence) throw new Error("Requested recovery sequence is not available in the exported repository.");
    if (options.asOf !== undefined && result.committedAt > options.asOf) throw new Error("Requested recovery time predates the base backup.");
    // A restored database begins a new epoch. Its old journal is not resumed accidentally.
    await runSQLiteTask("recovery", "finishReplay", [temporary]);
    await restoreSQLiteBackup(temporary, options.targetPath);
    return { ...result, databasePath: path.resolve(options.targetPath) };
  } finally { manager.close(); key.fill(0); await fs.rm(root, { recursive: true, force: true }); }
}
