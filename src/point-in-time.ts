import { sealPointInTimeState } from "./point-in-time-state.ts";
import { SQLITE_INTERNAL, type SQLiteCaptureConnection } from "./sqlite-internal.ts";
import type { SQLiteDatabase } from "./backend.ts";
import { openBackupManager } from "./recovery.ts";
import { restoreSQLiteBackup } from "./migrations.ts";
import { pinSQLiteDirectory, createPinnedSQLiteChildDirectory, assertPinnedSQLiteDirectory, type PinnedSQLiteDirectory } from "./sqlite-sandbox.ts";
import { runSQLiteTask } from "./sqlite-task.ts";
import { publishSQLiteReplacement } from "./migrations-worker.ts";

export interface PointInTimeRecoveryOptions {
  /** Dedicated private directory. Copy this entire encrypted repository off the application volume. */
  directory: string;
  encryptionKey: Uint8Array;
  keyId?: string;
  /** Maximum encoded changes in one transaction, defaults to 4 MiB. Larger writes roll back. */
  maxTransactionBytes?: number;
  /** Maximum canonical live state, defaults to 32 MiB. Bounds seal verification costs. */
  maxStateBytes?: number;
  /** Opt-in retained entry ceiling. A full journal rolls back the next write; rotate a quiesced verified epoch. */
  maxJournalEntries?: number;
  /** Opt-in retained encrypted envelope ceiling; preserves all existing journal entries at capacity. */
  maxJournalBytes?: number;
  /** Stable remote export receipts are never evicted implicitly; defaults to 32. */
  maxRemoteExports?: number;
  /** Total encoded stable export receipts, defaults to 128 MiB. */
  maxRemoteExportBytes?: number;
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
  /** Overall monotonic replay budget; defaults to 30 seconds, at most 60 seconds. */
  maxDurationMs?: number;
  /** Trusted synchronous ownership check; destination must remain stopped and exclusively owned. */
  assertCurrent?: () => void;
}
export interface PointInTimeRestoreResult { epoch: string; sequence: number; committedAt: number; databasePath: string; }
export interface PointInTimeArchive {
  readonly protocol: "clank-pitr-archive/1";
  readonly epoch: string;
  readonly keyId: string;
  readonly sequence: number;
  readonly digest: string;
  readonly committedAt: number;
  readonly operationId: string | null;
  readonly binding: PointInTimeProviderBinding | null;
  readonly files: readonly { readonly name: string; readonly contents: string; readonly bytes: number; readonly sha256: string }[];
  /** HMAC binds the complete encrypted repository and its exact horizon. */
  readonly authentication: string;
}
export interface PointInTimeArchiveBounds {
  /** Complete encoded JSON archive, defaults to 32 MiB; maximum 256 MiB. */
  maxArchiveBytes?: number;
  /** Exported committed entries, defaults to 10,000; maximum 100,000. */
  maxEntries?: number;
  /** Persist this exact encrypted checkpoint for retries, including after process restart. */
  operationId?: string;
  /** Server-configured provider identity, authenticated with the checkpoint. */
  binding?: PointInTimeProviderBinding;
}
export interface PointInTimeProviderBinding {
  readonly projectId: string;
  readonly nodeId: string;
  readonly releaseId: string;
  readonly generation: number;
}
export interface PointInTimeRecoveryProviderOptions extends PointInTimeArchiveBounds {
  binding: PointInTimeProviderBinding;
  /** Private high-entropy control credential; never use a human cookie/session. */
  token: string;
  /** Synchronously consult the provider's current persisted generation/ownership. */
  assertCurrent(): void;
  onError?: (error: unknown) => void;
}
export interface PointInTimeArchiveRestoreOptions extends PointInTimeArchiveBounds {
  encryptionKey: Uint8Array;
  targetPath: string;
  confirmation: "restore point in time";
  throughSequence: number;
  /** Independently retained horizon; all three values are required to reject a replayed archive. */
  expectedEpoch: string;
  expectedSequence: number;
  expectedDigest: string;
  expectedBinding?: PointInTimeProviderBinding;
  maxDurationMs?: number;
  assertCurrent?: () => void;
}
const archiveSources = new WeakMap<PointInTimeRecovery, (bounds: PointInTimeArchiveBounds) => Promise<PointInTimeArchive>>();
const transferSources = new WeakMap<PointInTimeRecovery, (options: PointInTimeTransferExportOptions) => PointInTimeTransferBatch>();
const bounded = (value: number, name: string, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
};
const keyBytes = (value: Uint8Array) => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("Recovery encryptionKey must contain exactly 32 bytes.");
  return new Uint8Array(value);
};
const restoreGuard=(duration:number|undefined,assertCurrent:(()=>void)|undefined)=>{
  const deadline=performance.now()+bounded(duration??30000,"maxDurationMs",1,60000);
  if(assertCurrent!==undefined&&typeof assertCurrent!=="function")throw new TypeError("Recovery current authority must be a synchronous assertion.");
  return ()=>{
    if(performance.now()>deadline)throw new Error("Recovery restore deadline exceeded.");
    const result:unknown=assertCurrent?.();if(result!==undefined){
      if(result&&(typeof result==="object"||typeof result==="function")&&typeof Reflect.get(result,"then")==="function")void Promise.resolve(result).catch(()=>undefined);
      throw new TypeError("Recovery current authority assertions must complete synchronously.");
    }
    if(performance.now()>deadline)throw new Error("Recovery restore deadline exceeded.");
  };
};

/** Captures every successful framework transaction, after service schema bootstrap and before serving requests. */
export async function openPointInTimeRecovery(database: SQLiteDatabase<any>, options: PointInTimeRecoveryOptions): Promise<PointInTimeRecovery> {
  // Capture operator configuration before the first asynchronous boundary.
  const key = keyBytes(options.encryptionKey), configuredKeyId = options.keyId;
  const configuredDirectory = options.directory, onError = options.onError;
  const maximum = bounded(options.maxTransactionBytes ?? 4 * 1024 * 1024, "maxTransactionBytes", 1024, 8 * 1024 * 1024);
  const stateMaximum = bounded(options.maxStateBytes ?? 32 * 1024 * 1024, "maxStateBytes", 1024, 128 * 1024 * 1024);
  const interval = options.exportIntervalMs === false ? false : bounded(options.exportIntervalMs ?? 1000, "exportIntervalMs", 100, 3_600_000);
  const journalEntries=options.maxJournalEntries===undefined?null:bounded(options.maxJournalEntries,"maxJournalEntries",1,100_000);
  const journalBytes=options.maxJournalBytes===undefined?null:bounded(options.maxJournalBytes,"maxJournalBytes",1024,1024*1024*1024);
  const maxRemoteExports=bounded(options.maxRemoteExports??32,"maxRemoteExports",1,1000);
  const maxRemoteExportBytes=bounded(options.maxRemoteExportBytes??128*1024*1024,"maxRemoteExportBytes",4096,1024*1024*1024);
  const fsName = "node:fs/promises", pathName = "node:path", cryptoName = "node:crypto";
  const [fs, path, crypto] = await Promise.all([import(fsName), import(pathName), import(cryptoName)]);
  const keyId = configuredKeyId ?? crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(keyId)) throw new TypeError("Invalid recovery keyId.");
  const directory = path.resolve(configuredDirectory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Recovery directory cannot be a symbolic link.");
  await fs.chmod(directory, 0o700);
  const retainedRepositoryFiles = await fs.readdir(directory);
  const internal = database[SQLITE_INTERNAL];
  if (!internal.captureTransactions) throw new Error("Database does not support transactional recovery capture.");
  let connection!: SQLiteCaptureConnection;
  let fatal: unknown;
  let assertSealed!: () => void;
  const hash = (value: string | Uint8Array) => crypto.createHash("sha256").update(value).digest("hex");
  let schema = "";
  const shape = () => JSON.stringify(connection.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'clank_pitr_*' ORDER BY type,name").all());
  const stateDigest = () => sealPointInTimeState(connection, crypto.createHash, stateMaximum);
  internal.captureTransactions((value) => {
    connection = value;
    connection.exec("BEGIN IMMEDIATE");
    try {
    if (connection.path === ":memory:") throw new Error("Recovery requires a file-backed SQLite database.");
    const retainedTables=connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('clank_pitr_state','clank_pitr_journal')").all();
    if(retainedTables.length===0&&retainedRepositoryFiles.length!==0 || retainedTables.length!==0&&retainedTables.length!==2 || retainedTables.length===2
      && (connection.prepare("SELECT count(*) AS n FROM clank_pitr_state").get()!.n!==1 || !connection.prepare("SELECT 1 FROM clank_pitr_state WHERE id=1").get()))throw new Error("Recovery retained epoch is missing or partial; preserve it for verified operator recovery.");
    const remoteExports=connection.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='clank_pitr_remote_exports'").get();
    const retainedState=retainedTables.length===2?connection.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get():undefined;
    if(retainedState?.remote_exports_protocol!==undefined&&(retainedState.remote_exports_protocol!==1||!remoteExports)||remoteExports&&retainedState?.remote_exports_protocol===undefined)throw new Error("Retained remote export protocol is missing or unsupported; preserve its evidence.");
    if(retainedRepositoryFiles.includes("remote-exports"))throw new Error("Legacy remote export files require verified operator import; preserve their evidence.");
    connection.exec(`CREATE TABLE IF NOT EXISTS clank_pitr_state(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,key_id TEXT NOT NULL,key_hash TEXT NOT NULL,schema_hash TEXT NOT NULL,state_hash TEXT NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,committed_at INTEGER NOT NULL,base_id TEXT NOT NULL DEFAULT '',exported INTEGER NOT NULL DEFAULT 0,remote_exports_protocol INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS clank_pitr_journal(sequence INTEGER PRIMARY KEY, envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clank_pitr_remote_exports(operation TEXT PRIMARY KEY,max_bytes INTEGER NOT NULL,max_entries INTEGER NOT NULL,archive TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0)) STRICT;`);
    if(!connection.prepare("PRAGMA table_info(clank_pitr_state)").all().some(column=>column.name==="remote_exports_protocol"))connection.exec("ALTER TABLE clank_pitr_state ADD COLUMN remote_exports_protocol INTEGER NOT NULL DEFAULT 1");
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
    assertSealed = ensureSealed;
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
        if(journalEntries!==null||journalBytes!==null){
          const retained=connection.prepare("SELECT count(*) AS entries,coalesce(sum(length(CAST(envelope AS BLOB))),0) AS bytes FROM clank_pitr_journal").get()!;
          if(journalEntries!==null&&Number(retained.entries)>=journalEntries
            ||journalBytes!==null&&Number(retained.bytes)+(globalThis as any).Buffer.byteLength(envelope)>journalBytes){
            throw new Error("Recovery journal capacity is exhausted; the write was rolled back and the retained epoch requires verified rotation.");
          }
        }
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
  if (interval !== false) { timer = setInterval(() => { void flush().catch((error) => { try { onError?.(error); } catch {} }); }, interval); (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.(); }
  const recovery: PointInTimeRecovery = Object.freeze({ status, flush, async close() { if (closed) return; if (timer) clearInterval(timer); await (flight ?? flush()); closed = true; archiveSources.delete(recovery); transferSources.delete(recovery); manager.close(); } });
  transferSources.set(recovery, input => {
    const identity = transferIdentity(input.identity), after = transferCursor(input.after), limits = transferBounds(input);
    const through = bounded(input.throughSequence,"throughSequence",after.sequence+1,Number.MAX_SAFE_INTEGER);
    assertSealed();if(closed)throw new Error("Recovery transfer source is closed.");
    const retained=state();
    const digestAt=(sequence:number)=>sequence===0?"0".repeat(64):JSON.parse(String(connection.prepare("SELECT envelope FROM clank_pitr_journal WHERE sequence=?").get(sequence)?.envelope??"null"))?.digest;
    if(after.epoch!==retained.epoch||through>Number(retained.sequence)||through-after.sequence>limits.entries||digestAt(after.sequence)!==after.digest)throw new Error("Transfer prefix is unavailable or does not match the captured journal.");
    const envelopes:string[]=[];let bytes=1024;
    for(let sequence=after.sequence+1;sequence<=through;sequence++){
      const encoded=connection.prepare("SELECT envelope FROM clank_pitr_journal WHERE sequence=?").get(sequence)?.envelope;
      if(typeof encoded!=="string")throw new Error("Transfer journal has a missing committed entry.");
      bytes+=(globalThis as any).Buffer.byteLength(JSON.stringify(encoded))+1;
      if(bytes>limits.bytes)throw new Error("Transfer batch exceeds its byte bound.");
      envelopes.push(encoded);
    }
    const content={protocol:"clank-pitr-transfer/1" as const,identity,keyId,baseBackupId:String(retained.base_id),after,
      through:{epoch:after.epoch,sequence:through,digest:digestAt(through)},envelopes};
    const batch={...content,authentication:crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest("hex")};
    if((globalThis as any).Buffer.byteLength(JSON.stringify(batch))>limits.bytes)throw new Error("Transfer batch exceeds its byte bound.");
    assertSealed();return Object.freeze(batch);
  });
  let exporting = false;
  archiveSources.set(recovery, async bounds => {
    const limits = archiveBounds(bounds);
    if (closed || exporting) throw new Error("Recovery archive exporter is closed or busy.");
    exporting = true;
    try {
      if(bounds.operationId!==undefined){
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(bounds.operationId)) throw new TypeError("Invalid recovery export operationId.");
        if(state().remote_exports_protocol!==1)throw new Error("Retained remote export protocol is unsupported.");
        assertSealed();
        const retained=connection.prepare("SELECT max_bytes,max_entries,archive,bytes FROM clank_pitr_remote_exports WHERE operation=?").get(bounds.operationId);
        if(retained){
            if(typeof retained.archive!=="string"||!Number.isSafeInteger(retained.bytes)||Number(retained.bytes)<1||Number(retained.bytes)>limits.bytes||(globalThis as any).Buffer.byteLength(retained.archive)!==retained.bytes)throw new Error("Invalid bounded recovery receipt.");
            const archive=JSON.parse(retained.archive),{authentication,...content}=archive??{};
            if(retained.max_bytes!==limits.bytes||retained.max_entries!==limits.entries||content.operationId!==bounds.operationId||content.epoch!==status().epoch
              || JSON.stringify(content.binding)!==JSON.stringify(bounds.binding??null)
              || authentication!==crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest("hex"))throw new Error("Recovery receipt retry conflict or authentication failure.");
            assertSealed();if(closed)throw new Error("Recovery source closed during receipt read.");
            return Object.freeze(archive) as PointInTimeArchive;
        }
      }
      assertSealed(); await flush(); assertSealed();
      // Read one authenticated head. Immutable journal entries remain valid if
      // later application transactions or periodic exports advance the head.
      const files: Array<{name: string; contents: string; bytes: number; sha256: string}> = [];
      let encodedBytes = 1024;
      const deadline = performance.now() + 30_000;
      const timely = () => { if(performance.now()>deadline) throw new Error("Recovery archive export exceeded its deadline."); };
      const read = async (name: string, maximumBytes = limits.bytes) => {
        timely();
        const {constants} = await import("node:fs");
        const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.nlink !== 1 || stats.size > maximumBytes || encodedBytes + Math.ceil(stats.size / 3) * 4 + name.length + 200 > limits.bytes) throw new Error("Recovery archive exceeds its regular-file or encoded byte bound.");
          const bytes = new Uint8Array(stats.size + 1); let length = 0;
          while (length < bytes.byteLength) { const next = await handle.read(bytes,length,bytes.byteLength-length,length); if (!next.bytesRead) break; length += next.bytesRead; }
          if (length !== stats.size) throw new Error("Recovery archive file changed while reading.");
          const contents = (globalThis as any).Buffer.from(bytes.subarray(0,length)).toString("base64");
          const file = {name,contents,bytes:length,sha256:hash(bytes.subarray(0,length))}; files.push(Object.freeze(file));
          encodedBytes += (globalThis as any).Buffer.byteLength(JSON.stringify(file)) + 1;
          if (encodedBytes > limits.bytes) throw new Error("Recovery archive exceeds its encoded byte bound.");
          timely(); return bytes.subarray(0,length);
        } finally { await handle.close(); }
      };
      const text = (bytes: Uint8Array) => new TextDecoder("utf-8",{fatal:true}).decode(bytes);
      const epoch = JSON.parse(text(await read("epoch.json",65536)));
      const head = JSON.parse(text(await read("head.json",65536)));
      const checkpoint = head.checkpoint;
      if (epoch.mac !== crypto.createHmac("sha256",key).update(JSON.stringify(epoch.manifest)).digest("hex")
        || head.mac !== crypto.createHmac("sha256",key).update(JSON.stringify(checkpoint)).digest("hex")
        || checkpoint.epoch !== status().epoch || checkpoint.epoch !== epoch.manifest.epoch || epoch.manifest.keyId !== keyId
        || epoch.manifest.baseBackupId !== state().base_id
        || !/^bk_[0-9]{13}_[A-Za-z0-9_-]{12,64}$/u.test(epoch.manifest.baseBackupId)) throw new Error("Recovery archive checkpoint authentication failed.");
      bounded(checkpoint.sequence,"archive sequence",0,limits.entries);
      const signed = JSON.parse(text(await read(`base/${epoch.manifest.baseBackupId}/manifest.json`,65536)));
      // BackupManager normalizes supplied keys with SHA-256 and encodes its
      // manifest MAC as base64url; the PITR head uses the original key/hex.
      const backupKey = crypto.createHash("sha256").update(key).digest();
      if(signed.mac !== crypto.createHmac("sha256",backupKey).update(JSON.stringify(signed.manifest)).digest("base64url") || signed.manifest.id !== epoch.manifest.baseBackupId) throw new Error("Recovery archive base authentication failed.");
      const base = await read(`base/${epoch.manifest.baseBackupId}/database.enc`);
      if(base.byteLength < 36 || text(base.subarray(0,8))!=="CLNKBK1\n") throw new Error("Recovery archive encrypted base is invalid.");
      const baseDecipher = crypto.createDecipheriv("aes-256-gcm",backupKey,base.subarray(8,20));
      baseDecipher.setAAD((globalThis as any).Buffer.from(JSON.stringify(signed.manifest)));baseDecipher.setAuthTag(base.subarray(-16));
      const plaintext = (globalThis as any).Buffer.concat([baseDecipher.update(base.subarray(20,-16)),baseDecipher.final()]);
      if(plaintext.byteLength!==signed.manifest.databaseBytes || hash(plaintext)!==signed.manifest.databaseSha256) throw new Error("Recovery archive base checksum failed.");
      plaintext.fill(0);
      backupKey.fill(0);
      let previous = "0".repeat(64);
      for(let sequence=1;sequence<=checkpoint.sequence;sequence++) {
        const envelope = JSON.parse(text(await read(`${String(sequence).padStart(16,"0")}.json`,12*1024*1024)));
        const {digest,...content} = envelope;
        if(content.epoch!==checkpoint.epoch || content.protocol!=="clank-pitr/1" || content.sequence!==sequence || content.previousDigest!==previous || hash(JSON.stringify(content))!==digest) throw new Error("Recovery archive journal gap or digest mismatch.");
        const {iv,body,tag,...header} = content, decipher = crypto.createDecipheriv("aes-256-gcm",key,(globalThis as any).Buffer.from(iv,"base64"));
        decipher.setAAD((globalThis as any).Buffer.from(JSON.stringify(header)));decipher.setAuthTag((globalThis as any).Buffer.from(tag,"base64"));
        const decoded = decipher.update((globalThis as any).Buffer.from(body,"base64"));decipher.final();decoded.fill(0);previous=digest;
      }
      if(previous!==checkpoint.digest) throw new Error("Recovery archive checkpoint digest mismatch.");
      timely();
      assertSealed(); if(closed) throw new Error("Recovery archive source closed during export.");
      const content = {protocol:"clank-pitr-archive/1" as const,epoch:String(checkpoint.epoch),keyId,sequence:Number(checkpoint.sequence),digest:String(checkpoint.digest),committedAt:Number(checkpoint.committedAt),operationId:bounds.operationId??null,binding:bounds.binding??null,files:Object.freeze(files)};
      const archive = Object.freeze({...content,authentication:crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest("hex")});
      if((globalThis as any).Buffer.byteLength(JSON.stringify(archive))>limits.bytes) throw new Error("Recovery archive exceeds its encoded byte bound.");
      if(bounds.operationId!==undefined){
        const encoded=JSON.stringify(archive),bytes=(globalThis as any).Buffer.byteLength(encoded);
        connection.exec("BEGIN IMMEDIATE");
        try{
          assertSealed();if(closed)throw new Error("Recovery source closed during export.");
          const retained=connection.prepare("SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM clank_pitr_remote_exports").get()!;
          if(Number(retained.count)>=maxRemoteExports)throw new Error("Recovery export receipt capacity is exhausted; retained receipts are preserved.");
          if(!Number.isSafeInteger(retained.bytes)||Number(retained.bytes)<0||Number(retained.bytes)+bytes>maxRemoteExportBytes)throw new Error("Recovery export receipt byte capacity is exhausted; retained receipts are preserved.");
          connection.prepare("INSERT INTO clank_pitr_remote_exports VALUES(?,?,?,?,?)").run(bounds.operationId,limits.bytes,limits.entries,encoded,bytes);
          assertSealed();connection.exec("COMMIT");
        }catch(error){connection.exec("ROLLBACK");throw error;}
        assertSealed();if(closed)throw new Error("Recovery source closed after export receipt publication.");
      }
      return archive;
    } finally { exporting = false; }
  });
  return recovery;
}

function archiveBounds(options: PointInTimeArchiveBounds) {
  return {bytes:bounded(options.maxArchiveBytes??32*1024*1024,"maxArchiveBytes",4096,256*1024*1024),entries:bounded(options.maxEntries??10000,"maxEntries",1,100000)};
}

/** Exports only an actual live capture handle; copied status objects confer no authority. */
export function exportPointInTimeRecovery(recovery: PointInTimeRecovery, bounds: PointInTimeArchiveBounds = {}): Promise<PointInTimeArchive> {
  const exportSource = archiveSources.get(recovery);
  if (!exportSource) return Promise.reject(new Error("A current native point-in-time capture handle is required."));
  return exportSource({maxArchiveBytes:bounds.maxArchiveBytes,maxEntries:bounds.maxEntries,operationId:bounds.operationId,binding:bounds.binding===undefined?undefined:providerBinding(bounds.binding)});
}

function providerBinding(binding: PointInTimeProviderBinding): PointInTimeProviderBinding {
  const {projectId,nodeId,releaseId,generation}=binding;
  if([projectId,nodeId,releaseId].some(value=>typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/u.test(value)))throw new TypeError("Invalid recovery provider binding.");
  bounded(generation,"provider generation",1,Number.MAX_SAFE_INTEGER);
  return Object.freeze({projectId,nodeId,releaseId,generation});
}

/** Private checkpoint endpoint for an explicitly captured single-connection application. */
export function createPointInTimeRecoveryProvider(recovery: PointInTimeRecovery, options: PointInTimeRecoveryProviderOptions): {handle(request:Request):Promise<Response>} {
  if(!archiveSources.has(recovery))throw new TypeError("A current native point-in-time capture handle is required.");
  const binding=providerBinding(options.binding), token=options.token, assertCurrent=options.assertCurrent, onError=options.onError;
  const limits=archiveBounds(options);
  if(typeof token!=="string"||!/^[A-Za-z0-9_-]{32,512}$/u.test(token)||typeof assertCurrent!=="function")throw new TypeError("A private recovery credential and current provider assertion are required.");
  const current=()=>{const result:unknown=assertCurrent();if(result!==undefined){
    if(result&&typeof result==="object"&&typeof Reflect.get(result,"then")==="function")void Promise.resolve(result).catch(()=>undefined);
    throw new Error("Provider ownership assertions must complete synchronously.");
  }};
  return Object.freeze({async handle(request:Request){
    const problem=(status:number,code:string)=>Response.json({error:{code}},{status,headers:{"cache-control":"no-store"}});
    const url=new URL(request.url);
    if(url.pathname!=="/__clank/pitr/checkpoint"||url.search||request.method!=="GET"||request.body!==null)return problem(404,"RECOVERY_NOT_FOUND");
    const credential=request.headers.get("authorization"), operationId=request.headers.get("x-clank-recovery-operation-id");
    if(!operationId||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(operationId)
      ||request.headers.get("x-clank-project-id")!==binding.projectId||request.headers.get("x-clank-node-id")!==binding.nodeId
      ||request.headers.get("x-clank-release-id")!==binding.releaseId||request.headers.get("x-clank-runtime-generation")!==String(binding.generation))return problem(404,"RECOVERY_NOT_FOUND");
    const cryptoName="node:crypto",crypto=await import(cryptoName);
    if(!credential||!crypto.timingSafeEqual(crypto.createHash("sha256").update(credential).digest(),crypto.createHash("sha256").update("Bearer "+token).digest()))return problem(401,"RECOVERY_UNAUTHENTICATED");
    try{
      current();if(request.signal.aborted)throw new Error("Recovery request aborted.");
      const archive=await exportPointInTimeRecovery(recovery,{maxArchiveBytes:limits.bytes,maxEntries:limits.entries,operationId,binding});
      current();if(request.signal.aborted)throw new Error("Recovery request aborted.");
      return Response.json(archive,{headers:{"cache-control":"no-store","x-clank-recovery-protocol":"clank-pitr-archive/1"}});
    }catch(error){try{onError?.(error);}catch{}return problem(503,"RECOVERY_UNAVAILABLE");}
  }});
}

/** Validates the complete encrypted archive against an independently retained horizon. */
export async function restorePointInTimeArchive(archive: PointInTimeArchive, options: PointInTimeArchiveRestoreOptions): Promise<PointInTimeRestoreResult> {
  return restoreArchive(archive,options);
}
async function restoreArchive(archive: PointInTimeArchive, options: PointInTimeArchiveRestoreOptions, consume?: (files:Map<string,Uint8Array>,manifest:any)=>Promise<PointInTimeRestoreResult>): Promise<PointInTimeRestoreResult> {
  const current=restoreGuard(options.maxDurationMs,options.assertCurrent);current();
  const limits = archiveBounds(options), key = keyBytes(options.encryptionKey), targetPath = options.targetPath;
  const confirmation = options.confirmation, through = bounded(options.throughSequence,"throughSequence",0,Number.MAX_SAFE_INTEGER);
  const expected = {epoch:options.expectedEpoch,sequence:bounded(options.expectedSequence,"expectedSequence",0,limits.entries),digest:options.expectedDigest};
  const expectedBinding=options.expectedBinding===undefined?undefined:providerBinding(options.expectedBinding);
  const expectedOperation=options.operationId;
  if(confirmation!=="restore point in time" || through>expected.sequence || !/^[0-9a-f-]{36}$/u.test(expected.epoch) || !/^[0-9a-f]{64}$/u.test(expected.digest)) throw new TypeError("An exact independently retained recovery horizon and confirmation are required.");
  // The serialized request is captured before the first await; callers cannot
  // replace files or the expected horizon while verification is in progress.
  const encoded = JSON.stringify(archive);
  if((globalThis as any).Buffer.byteLength(encoded)>limits.bytes) throw new Error("Recovery archive exceeds its encoded byte bound.");
  const captured = JSON.parse(encoded) as PointInTimeArchive;
  const fsName="node:fs/promises", pathName="node:path", cryptoName="node:crypto";
  const [fs,path,crypto] = await Promise.all([import(fsName),import(pathName),import(cryptoName)]);
  let temporary: string | undefined;
  try {
    current();
    const {authentication,...content} = captured;
    const actualMac = crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest();
    if(typeof authentication!=="string" || !/^[0-9a-f]{64}$/u.test(authentication)
      || !crypto.timingSafeEqual(actualMac,(globalThis as any).Buffer.from(authentication,"hex"))) throw new Error("Recovery archive authentication failed.");
    if(captured.protocol!=="clank-pitr-archive/1" || captured.epoch!==expected.epoch || captured.sequence!==expected.sequence || captured.digest!==expected.digest
      || expectedOperation!==undefined&&captured.operationId!==expectedOperation
      || expectedBinding!==undefined&&JSON.stringify(captured.binding)!==JSON.stringify(expectedBinding)
      || !Array.isArray(captured.files) || captured.files.length!==captured.sequence+4 || !Number.isSafeInteger(captured.committedAt) || captured.committedAt<0) throw new Error("Recovery archive does not match its retained horizon.");
    const names = new Set<string>(), decoded = new Map<string,Uint8Array>();
    for(const file of captured.files) {
      current();
      if(!file || typeof file.name!=="string" || typeof file.contents!=="string" || !Number.isSafeInteger(file.bytes) || file.bytes<0
        || !/^[0-9a-f]{64}$/u.test(file.sha256) || names.has(file.name)
        || !(file.name==="epoch.json" || file.name==="head.json" || /^[0-9]{16}\.json$/u.test(file.name)
          || /^base\/bk_[0-9]{13}_[A-Za-z0-9_-]{12,64}\/(?:manifest\.json|database\.enc)$/u.test(file.name))
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contents)) throw new Error("Recovery archive has an invalid or duplicate file.");
      const bytes = (globalThis as any).Buffer.from(file.contents,"base64");
      if(bytes.byteLength!==file.bytes || bytes.toString("base64")!==file.contents || crypto.createHash("sha256").update(bytes).digest("hex")!==file.sha256) throw new Error("Recovery archive file checksum failed.");
      names.add(file.name); decoded.set(file.name,bytes);
    }
    const text = (name:string) => {
      const bytes=decoded.get(name);if(!bytes || bytes.byteLength>65536)throw new Error("Recovery archive metadata is missing or oversized.");
      return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    };
    const epoch=text("epoch.json"),head=text("head.json");
    if(epoch.manifest?.epoch!==captured.epoch || epoch.manifest?.keyId!==captured.keyId
      || !/^bk_[0-9]{13}_[A-Za-z0-9_-]{12,64}$/u.test(epoch.manifest?.baseBackupId)
      || head.checkpoint?.sequence!==captured.sequence || head.checkpoint?.epoch!==captured.epoch || head.checkpoint?.digest!==captured.digest || head.checkpoint?.committedAt!==captured.committedAt) throw new Error("Recovery archive checkpoint metadata mismatch.");
    const required=new Set(["epoch.json","head.json",`base/${epoch.manifest.baseBackupId}/manifest.json`,`base/${epoch.manifest.baseBackupId}/database.enc`]);
    for(let sequence=1;sequence<=captured.sequence;sequence++)required.add(`${String(sequence).padStart(16,"0")}.json`);
    if(required.size!==names.size || [...required].some(name=>!names.has(name)))throw new Error("Recovery archive has a missing or foreign file.");
    if(consume)return await consume(decoded,epoch.manifest);
    const destination=path.resolve(targetPath),parent=path.dirname(destination);
    await fs.mkdir(parent,{recursive:true,mode:0o700});current();
    const repository: string=path.join(parent,".clank-pitr-"+crypto.createHash("sha256").update(destination).digest("hex")+"-archive");
    // EEXIST preserves a possible live or interrupted worker and bounds exact retries.
    await fs.mkdir(repository,{mode:0o700});temporary=repository;
    current();
    await fs.mkdir(path.join(repository,"base",epoch.manifest.baseBackupId),{recursive:true,mode:0o700});
    for(const [name,bytes] of decoded) {
      current();
      const file=await fs.open(path.join(repository,name),"wx",0o600);
      try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    }
    current();return await restorePointInTime({directory:repository,encryptionKey:key,targetPath,confirmation,throughSequence:through,assertCurrent:current});
  } finally {key.fill(0);if(temporary)await fs.rm(temporary,{recursive:true,force:true});}
}

/** Replays an authenticated encrypted base and an unbroken journal into a stopped destination. */
export async function restorePointInTime(options: PointInTimeRestoreOptions): Promise<PointInTimeRestoreResult> {
  const current=restoreGuard(options.maxDurationMs,options.assertCurrent);current();
  // Capture the whole request before the first asynchronous boundary.
  options={directory:options.directory,targetPath:options.targetPath,confirmation:options.confirmation,throughSequence:options.throughSequence,asOf:options.asOf,encryptionKey:keyBytes(options.encryptionKey)};
  const key=options.encryptionKey;let cleanup=async()=>{};
  try{
  if (options.confirmation !== "restore point in time") throw new TypeError("Point-in-time restore confirmation is required.");
  if ((options.throughSequence === undefined) === (options.asOf === undefined)) throw new TypeError("Choose exactly one committed sequence or asOf timestamp.");
  if (options.throughSequence !== undefined) bounded(options.throughSequence, "throughSequence", 0, Number.MAX_SAFE_INTEGER);
  if (options.asOf !== undefined) bounded(options.asOf, "asOf", 0, Number.MAX_SAFE_INTEGER);
  const fsName = "node:fs/promises", pathName = "node:path", cryptoName = "node:crypto", constantsName = "node:fs";
  const [fs, path, crypto, { constants }] = await Promise.all([import(fsName), import(pathName), import(cryptoName), import(constantsName)]);
  current();
  const readBounded = async (filename: string, maximum: number): Promise<string> => {
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      current();
      if (!stats.isFile() || stats.size > maximum) throw new Error("Recovery archive entry is not a bounded regular file.");
      const bytes = new Uint8Array(maximum + 1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length);current();if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > maximum) throw new Error("Recovery archive entry exceeds its size bound.");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
  };
  const directory = path.resolve(options.directory);
  const encoded = JSON.parse(await readBounded(path.join(directory, "epoch.json"), 64 * 1024));
  const expected = crypto.createHmac("sha256", key).update(JSON.stringify(encoded.manifest)).digest("hex");
  if (encoded.mac !== expected || encoded.manifest?.protocol !== "clank-pitr-repository/1") throw new Error("Recovery repository authentication failed.");
  const head = JSON.parse(await readBounded(path.join(directory, "head.json"), 64 * 1024));
  if (head.mac !== crypto.createHmac("sha256", key).update(JSON.stringify(head.checkpoint)).digest("hex") || head.checkpoint.epoch !== encoded.manifest.epoch
    || !Number.isSafeInteger(head.checkpoint.sequence) || head.checkpoint.sequence < 0) throw new Error("Recovery export checkpoint authentication failed.");
  const destination=path.resolve(options.targetPath),parent=path.dirname(destination);
  await fs.mkdir(parent,{recursive:true,mode:0o700});current();
  const root=path.join(parent,".clank-pitr-"+crypto.createHash("sha256").update(destination).digest("hex")+"-replay");
  await fs.mkdir(root,{mode:0o700});cleanup=async()=>{await fs.rm(root,{recursive:true,force:true});};current();
  const temporary = path.join(root, "replay.sqlite");
  const manager = await openBackupManager({ repositoryDirectory: path.join(directory, "base"), encryptionKey: key, keyId: encoded.manifest.keyId, maxDatabaseBytes: 512 * 1024 * 1024 });
  try {
    current();
    await manager.restore(encoded.manifest.baseBackupId, { targetPath: temporary, confirmation: `restore ${encoded.manifest.baseBackupId}` });
    current();
    const entries = (await fs.readdir(directory)).filter((name: string) => /^[0-9]{16}\.json$/u.test(name)).sort();
    let result = await runSQLiteTask<PointInTimeRestoreResult>("recovery", "replayJournal", [temporary, [], Array.from(key), encoded.manifest.epoch, options.throughSequence, options.asOf]);
    current();
    let verifiedSequence = 0, verifiedDigest = "0".repeat(64);
    for (const entry of entries) {
      current();
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
      current();
    }
    if (verifiedSequence !== head.checkpoint.sequence || verifiedDigest !== head.checkpoint.digest) throw new Error("Recovery journal is missing its authenticated exported tail.");
    if (options.throughSequence !== undefined && result.sequence !== options.throughSequence) throw new Error("Requested recovery sequence is not available in the exported repository.");
    if (options.asOf !== undefined && result.committedAt > options.asOf) throw new Error("Requested recovery time predates the base backup.");
    // A restored database begins a new epoch. Its old journal is not resumed accidentally.
    await runSQLiteTask("recovery", "finishReplay", [temporary]);
    current();await restoreSQLiteBackup(temporary, options.targetPath,current);current();
    return { ...result, databasePath: path.resolve(options.targetPath) };
  } finally { manager.close(); }
  }finally{key.fill(0);await cleanup();}
}

/** A stopped same-release transfer. This identity does not grant runtime or writer authority. */
export interface PointInTimeTransferIdentity {
  readonly handoffId: string;
  readonly source: PointInTimeProviderBinding;
  readonly targetNodeId: string;
  readonly targetGeneration: number;
  readonly artifactSha256: string;
}
export interface PointInTimeTransferCursor { readonly epoch: string; readonly sequence: number; readonly digest: string; }
export interface PointInTimeTransferBounds { maxBatchBytes?: number; maxEntries?: number; }
export interface PointInTimeTransferExportOptions extends PointInTimeTransferBounds {
  identity: PointInTimeTransferIdentity;
  after: PointInTimeTransferCursor;
  throughSequence: number;
}
export interface PointInTimeTransferBatch {
  readonly protocol: "clank-pitr-transfer/1";
  readonly identity: PointInTimeTransferIdentity;
  readonly keyId: string;
  readonly baseBackupId: string;
  readonly after: PointInTimeTransferCursor;
  readonly through: PointInTimeTransferCursor;
  readonly envelopes: readonly string[];
  readonly authentication: string;
}
export interface PointInTimeTransferAuthority {
  /** Consult actual current native source ownership; an epoch number is not authority. */
  assertSourceCurrent(): void;
  /** The exact destination must remain stopped and exclusively owned through publication. */
  assertTargetCurrent(): void;
  maxDurationMs?: number;
}
export interface PointInTimeTransferStageOptions extends PointInTimeTransferAuthority {
  identity: PointInTimeTransferIdentity;
  encryptionKey: Uint8Array;
  targetPath: string;
  expectedEpoch: string;
  expectedSequence: number;
  expectedDigest: string;
  operationId?: string;
  maxArchiveBytes?: number;
  maxEntries?: number;
}
export interface PointInTimeTransferApplyOptions extends PointInTimeTransferAuthority, PointInTimeTransferBounds {
  identity: PointInTimeTransferIdentity;
  encryptionKey: Uint8Array;
  targetPath: string;
  /** Independently retained predecessor. It cannot be derived from an untrusted batch. */
  expectedCursor: PointInTimeTransferCursor;
}
export interface PointInTimeTransferResult {
  readonly cursor: PointInTimeTransferCursor;
  readonly baseBackupId: string;
  readonly appliedEntries: number;
  readonly replayed: boolean;
}
const transferHashPattern=/^[0-9a-f]{64}$/u;
function transferIdentity(input:PointInTimeTransferIdentity):PointInTimeTransferIdentity {
  if(!input||Object.keys(input).sort().join(",")!=="artifactSha256,handoffId,source,targetGeneration,targetNodeId"
    ||typeof input.handoffId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/u.test(input.handoffId)
    ||typeof input.targetNodeId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/u.test(input.targetNodeId)
    ||typeof input.artifactSha256!=="string"||!transferHashPattern.test(input.artifactSha256))throw new TypeError("An exact transfer identity is required.");
  const source=providerBinding(input.source),targetGeneration=bounded(input.targetGeneration,"targetGeneration",source.generation+1,Number.MAX_SAFE_INTEGER);
  if(source.nodeId===input.targetNodeId)throw new TypeError("A transfer requires a different target node.");
  return Object.freeze({handoffId:input.handoffId,source,targetNodeId:input.targetNodeId,targetGeneration,artifactSha256:input.artifactSha256});
}
function transferCursor(input:PointInTimeTransferCursor):PointInTimeTransferCursor {
  if(!input||Object.keys(input).sort().join(",")!=="digest,epoch,sequence"||typeof input.epoch!=="string"||!/^[0-9a-f-]{36}$/u.test(input.epoch)
    ||typeof input.digest!=="string"||!transferHashPattern.test(input.digest))throw new TypeError("An exact transfer cursor is required.");
  return Object.freeze({epoch:input.epoch,sequence:bounded(input.sequence,"transfer sequence",0,Number.MAX_SAFE_INTEGER),digest:input.digest});
}
function transferBounds(options:PointInTimeTransferBounds){return {bytes:bounded(options.maxBatchBytes??4*1024*1024,"maxBatchBytes",4096,8*1024*1024),entries:bounded(options.maxEntries??256,"maxEntries",1,1000)};}
function transferAuthority(options:PointInTimeTransferAuthority):()=>void {
  const source=options.assertSourceCurrent,target=options.assertTargetCurrent;
  if(typeof source!=="function"||typeof target!=="function")throw new TypeError("Current native source and stopped-destination ownership assertions are required.");
  return restoreGuard(options.maxDurationMs,()=>{
    for(const check of [source,target]){const result:unknown=check();if(result!==undefined){
      if(result&&(typeof result==="object"||typeof result==="function")&&typeof Reflect.get(result,"then")==="function")void Promise.resolve(result).catch(()=>undefined);
      throw new TypeError("Transfer authority assertions must complete synchronously.");
    }}
  });
}
/** Reads only the requested immutable encrypted native journal entries; never copies the base again. */
export function exportPointInTimeTransfer(recovery:PointInTimeRecovery,options:PointInTimeTransferExportOptions):Promise<PointInTimeTransferBatch> {
  const source=transferSources.get(recovery);
  try{if(!source)throw new Error("A current native point-in-time capture handle is required.");return Promise.resolve(source(options));}catch(error){return Promise.reject(error);}
}
interface TransferWorkspace {fs:any;path:any;crypto:any;target:string;root:string;anchoredTarget:string;anchoredRoot:string;directories:readonly PinnedSQLiteDirectory[];current:()=>void;}
async function transferWorkspace<T>(targetPath:string,authority:()=>void,work:(context:TransferWorkspace)=>Promise<T>):Promise<T>{
  authority();const fsName="node:fs/promises",nativeName="node:fs",pathName="node:path",cryptoName="node:crypto";
  const [fs,native,path,crypto]=await Promise.all([import(fsName),import(nativeName),import(pathName),import(cryptoName)]);authority();
  if((globalThis as any).process.platform!=="linux")throw new Error("Pinned transfer publication requires Linux directory capabilities.");
  if(typeof targetPath!=="string"||!targetPath||targetPath.includes("\0"))throw new TypeError("A private stopped transfer destination is required.");
  const target=path.resolve(targetPath),parent=path.dirname(target),pinned=await pinSQLiteDirectory(parent,true);
  let workspace:PinnedSQLiteDirectory|undefined;
  const name=".clank-transfer-"+crypto.createHash("sha256").update(target).digest("hex"),root=path.join(parent,name),anchoredRoot=`${pinned.anchor}/${name}`,anchoredTarget=`${pinned.anchor}/${path.basename(target)}`;
  try{
    const identity=native.fstatSync(pinned.fd);
    if(identity.uid!==(globalThis as any).process.geteuid()||(identity.mode&0o022)!==0)throw new Error("Transfer destination directory must be privately owned and not writable by other users.");
    const current=()=>{
      authority();const actual=native.lstatSync(parent);
      if(!actual.isDirectory()||actual.dev!==identity.dev||actual.ino!==identity.ino)throw new Error("Transfer destination directory changed while pinned.");
      if(workspace){const retained=native.fstatSync(workspace.fd),visible=native.lstatSync(anchoredRoot);if(visible.dev!==retained.dev||visible.ino!==retained.ino)throw new Error("Transfer private workspace changed while pinned.");}
    };
    current();workspace=await createPinnedSQLiteChildDirectory(pinned,name,current);current();
    const result=await work({fs,path,crypto,target,root,anchoredTarget,anchoredRoot:workspace.anchor,directories:[pinned,workspace],current});current();
    // Exact retries also complete a directory sync that a lost response may have interrupted.
    const durable=await fs.open(pinned.anchor,"r");try{await durable.sync();current();}finally{await durable.close();}current();return result;
  }finally{try{
    if(workspace){
      // Clean through the owned descriptor even if its visible name was replaced.
      for(const entry of await fs.readdir(workspace.anchor))await fs.rm(`${workspace.anchor}/${entry}`,{recursive:true,force:true});
      const expected=native.fstatSync(workspace.fd);let actual;try{actual=native.lstatSync(anchoredRoot);}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;}
      if(actual?.dev===expected.dev&&actual?.ino===expected.ino)native.rmdirSync(anchoredRoot);
    }
  }finally{try{await workspace?.close();}finally{await pinned.close();}}}
}
/** Stages a base once. It retains native capture metadata and never admits an application writer. */
export async function stagePointInTimeTransfer(archive:PointInTimeArchive,options:PointInTimeTransferStageOptions):Promise<PointInTimeTransferResult>{
  const current=transferAuthority(options);current();
  const identity=transferIdentity(options.identity),key=keyBytes(options.encryptionKey),targetPath=options.targetPath;
  const expected=transferCursor({epoch:options.expectedEpoch,sequence:options.expectedSequence,digest:options.expectedDigest});
  const maxArchiveBytes=archiveBounds(options).bytes,encoded=JSON.stringify(archive);
  if(new TextEncoder().encode(encoded).byteLength>maxArchiveBytes)throw new Error("Transfer base exceeds its byte bound.");
  const captured=JSON.parse(encoded) as PointInTimeArchive,operationId=options.operationId,maxEntries=options.maxEntries;
  try{return await transferWorkspace(targetPath,current,async({fs,path,crypto,target,root,anchoredTarget,anchoredRoot,directories,current})=>{
    const {authentication,...content}=captured;
    if(authentication!==crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest("hex")||captured.protocol!=="clank-pitr-archive/1"
      ||captured.epoch!==expected.epoch||captured.sequence!==expected.sequence||captured.digest!==expected.digest||captured.sequence>archiveBounds({maxEntries}).entries
      ||JSON.stringify(captured.binding)!==JSON.stringify(identity.source)||operationId!==undefined&&captured.operationId!==operationId)throw new Error("Transfer base authentication, identity or retained horizon mismatch.");
    const archiveSha256=crypto.createHash("sha256").update(encoded).digest("hex"),binding={identity,archiveSha256,initialCursor:expected};
    let exists=false;
    try{const stat=await fs.lstat(anchoredTarget);current();if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error("Transfer destination must be a private regular file.");exists=true;}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;}
    if(exists){const result=await runSQLiteTask<PointInTimeTransferResult>("recovery","inspectTransfer",[target,binding],directories);current();return {...result,replayed:true};}
    const staged=path.join(root,"stage.sqlite");
    await restoreArchive(captured,{encryptionKey:key,targetPath:staged,confirmation:"restore point in time",throughSequence:expected.sequence,
      expectedEpoch:expected.epoch,expectedSequence:expected.sequence,expectedDigest:expected.digest,expectedBinding:identity.source,operationId,maxArchiveBytes,maxEntries,assertCurrent:current},async(files,manifest)=>{
      const baseId=manifest.baseBackupId,envelope=files.get(`base/${baseId}/database.enc`)!,signed=JSON.parse(new TextDecoder().decode(files.get(`base/${baseId}/manifest.json`)!));
      await fs.writeFile(`${anchoredRoot}/database.enc`,envelope,{flag:"wx",mode:0o600});current();
      await runSQLiteTask("recovery","prepareTransferBase",[staged,path.join(root,"database.enc"),signed,Array.from(key),baseId],directories);current();
      let replay=await runSQLiteTask<PointInTimeRestoreResult>("recovery","replayJournal",[staged,[],Array.from(key),expected.epoch,expected.sequence],directories);current();
      for(let sequence=1;sequence<=expected.sequence;sequence++){
        replay=await runSQLiteTask<PointInTimeRestoreResult>("recovery","replayJournal",[staged,[new TextDecoder().decode(files.get(`${String(sequence).padStart(16,"0")}.json`))],Array.from(key),expected.epoch,expected.sequence],directories);current();
      }
      const initialized=await runSQLiteTask<PointInTimeTransferResult>("recovery","initializeTransfer",[staged,identity,baseId,archiveSha256],directories);current();
      if(JSON.stringify(initialized.cursor)!==JSON.stringify(expected))throw new Error("Transfer base differs from its authenticated horizon.");
      return replay;
    });
    current();
    // A link creates the destination exclusively; an existing live file cannot be replaced.
    const source=await fs.open(`${anchoredRoot}/stage.sqlite`,"r");try{await source.sync();current();}finally{await source.close();}current();
    await fs.link(`${anchoredRoot}/stage.sqlite`,anchoredTarget);current();await fs.unlink(`${anchoredRoot}/stage.sqlite`);current();
    const parent=await fs.open(directories[0]!.anchor,"r");try{await parent.sync();}finally{await parent.close();}current();
    const result=await runSQLiteTask<PointInTimeTransferResult>("recovery","inspectTransfer",[target,binding],directories);current();return result;
  });}finally{key.fill(0);}
}
/** Applies to an owned stopped stage; publication is separately guarded after bounded native replay. */
export async function applyPointInTimeTransfer(batch:PointInTimeTransferBatch,options:PointInTimeTransferApplyOptions):Promise<PointInTimeTransferResult>{
  const current=transferAuthority(options);current();
  const identity=transferIdentity(options.identity),expectedCursor=transferCursor(options.expectedCursor),limits=transferBounds(options),key=keyBytes(options.encryptionKey),targetPath=options.targetPath;
  const encoded=JSON.stringify(batch);
  if(new TextEncoder().encode(encoded).byteLength>limits.bytes)throw new Error("Transfer batch exceeds its byte bound.");
  const captured=JSON.parse(encoded) as PointInTimeTransferBatch;
  try{return await transferWorkspace(targetPath,current,async({path,crypto,target,root,directories,current})=>{
    const {authentication,...content}=captured;
    const mac=crypto.createHmac("sha256",key).update(JSON.stringify(content)).digest("hex");
    if(typeof authentication!=="string"||!transferHashPattern.test(authentication)||authentication!==mac||captured.protocol!=="clank-pitr-transfer/1"
      ||JSON.stringify(transferIdentity(captured.identity))!==JSON.stringify(identity)||!Array.isArray(captured.envelopes)||captured.envelopes.length<1||captured.envelopes.length>limits.entries
      ||JSON.stringify(transferCursor(captured.after))!==JSON.stringify(expectedCursor)||captured.through.epoch!==expectedCursor.epoch
      ||transferCursor(captured.through).sequence-expectedCursor.sequence!==captured.envelopes.length)throw new Error("Transfer batch authentication, identity or prefix mismatch.");
    const request={identity,expectedCursor,batch:captured,batchSha256:crypto.createHash("sha256").update(encoded).digest("hex")};
    const before=await runSQLiteTask<PointInTimeTransferResult>("recovery","inspectTransfer",[target,{identity},request],directories);current();
    if(before.replayed)return before;
    const staged=path.join(root,"apply.sqlite");
    await restorePinnedSQLiteBackup(target,staged,current,directories);current();
    const result=await runSQLiteTask<PointInTimeTransferResult>("recovery","applyTransfer",[staged,request,Array.from(key)],directories);current();
    // Recheck the owned original before replacing it; a receipt is never inferred from rename success.
    const original=await runSQLiteTask<PointInTimeTransferResult>("recovery","inspectTransfer",[target,{identity},request],directories);current();
    if(original.replayed)return original;
    await restorePinnedSQLiteBackup(staged,target,current,directories);current();
    const acknowledged=await runSQLiteTask<PointInTimeTransferResult>("recovery","inspectTransfer",[target,{identity},request],directories);current();
    if(!acknowledged.replayed||JSON.stringify(acknowledged.cursor)!==JSON.stringify(result.cursor))throw new Error("Transfer publication was not durably acknowledged; retry the exact batch.");
    return {...acknowledged,replayed:false,appliedEntries:result.appliedEntries};
  });}finally{key.fill(0);}
}

/** Internal transfer publication: both file paths remain bound to retained directories. */
async function restorePinnedSQLiteBackup(sourcePath:string,destinationPath:string,current:()=>void,directories:readonly PinnedSQLiteDirectory[]):Promise<void>{
  current();const pathName="node:path",fsName="node:fs/promises",constantsName="node:fs";
  const [path,fs,{constants}]=await Promise.all([import(pathName),import(fsName),import(constantsName)]);current();
  for(const directory of directories)assertPinnedSQLiteDirectory(directory);
  const source=directories.find(directory=>directory.path===path.dirname(sourcePath)),destination=directories.find(directory=>directory.path===path.dirname(destinationPath));
  if(!source||!destination)throw new Error("Transfer replacement requires retained source and destination directories.");
  const temporary=`${destinationPath}.tmp-${globalThis.crypto.randomUUID()}`,anchoredTemporary=`${destination.anchor}/${path.basename(temporary)}`,anchoredDestination=`${destination.anchor}/${path.basename(destinationPath)}`;
  try{
    await runSQLiteTask("migrations","stageSQLiteRestore",[sourcePath,destinationPath,temporary],directories);current();
    const file=await fs.open(anchoredTemporary,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{await file.sync();current();}finally{await file.close();}current();
    await publishSQLiteReplacement(anchoredTemporary,anchoredDestination,current);current();
    const parent=await fs.open(destination.anchor,"r");try{await parent.sync();current();}finally{await parent.close();}current();
  }finally{
    for(const suffix of ["","-journal","-wal","-shm"])await fs.rm(anchoredTemporary+suffix,{force:true});
  }
}
