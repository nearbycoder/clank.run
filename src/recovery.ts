import { backupSQLite, restoreSQLiteBackup } from "./migrations.ts";

export interface BackupManifest {
  protocol: "clank-backup/1";
  id: string;
  source: string;
  createdAt: number;
  reason: string;
  databaseBytes: number;
  databaseSha256: string;
  databaseRevision: number | null;
  migrationCount: number;
  latestMigration: string | null;
  encryption: {
    algorithm: "AES-256-GCM";
    keyId: string;
  };
}

export interface BackupVerification {
  id: string;
  ok: true;
  verifiedAt: number;
  durationMs: number;
  databaseBytes: number;
  databaseSha256: string;
}

export interface BackupManager {
  create(options?: { reason?: string }): Promise<BackupManifest>;
  list(): Promise<readonly BackupManifest[]>;
  verify(id: string): Promise<BackupVerification>;
  restore(id: string, options: {
    targetPath?: string;
    confirmation: string;
  }): Promise<BackupVerification>;
  delete(id: string): Promise<boolean>;
  start(intervalMs: number): () => void;
  close(): void;
}

export interface BackupManagerOptions {
  databasePath: string;
  repositoryDirectory: string;
  encryptionKey: string | Uint8Array;
  keyId?: string;
  maxBackups?: number;
  maxAgeMs?: number;
  maxDatabaseBytes?: number;
  verifyAfterCreate?: boolean;
  onEvent?: (event: {
    type: "created" | "verified" | "restored" | "deleted" | "failed";
    backupId?: string;
    durationMs?: number;
    error?: string;
  }) => void;
}

const BACKUP_ID = /^bk_[0-9]{13}_[A-Za-z0-9_-]{12,64}$/u;
const MAGIC = new TextEncoder().encode("CLNKBK1\n");

/** Opens an encrypted local backup repository for one SQLite database. */
export async function openBackupManager(options: BackupManagerOptions): Promise<BackupManager> {
  const fs = await nodeFs();
  const path = await nodePath();
  const source = path.resolve(options.databasePath);
  const repository = path.resolve(options.repositoryDirectory);
  const staging = path.join(repository, ".staging");
  const key = await encryptionKey(options.encryptionKey);
  const keyId = options.keyId
    ? safeIdentifier(options.keyId, "keyId", 100)
    : (await sha256Bytes(key)).slice(0, 16);
  const maxBackups = integerRange(options.maxBackups ?? 30, "maxBackups", 1, 10_000);
  const maxAgeMs = integerRange(options.maxAgeMs ?? 90 * 24 * 60 * 60 * 1_000, "maxAgeMs", 60_000, Number.MAX_SAFE_INTEGER);
  const maxDatabaseBytes = integerRange(
    options.maxDatabaseBytes ?? 10 * 1024 * 1024 * 1024,
    "maxDatabaseBytes",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  await fs.mkdir(repository, { recursive: true, mode: 0o700 });
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  await fs.chmod(repository, 0o700);
  let timer: ReturnType<typeof setInterval> | undefined;
  let creating = false;
  let closed = false;

  const emit = (event: Parameters<NonNullable<BackupManagerOptions["onEvent"]>>[0]) => {
    try { options.onEvent?.(event); }
    catch { /* Recovery observers cannot alter backup state. */ }
  };

  const pathsFor = (id: string, root = repository) => {
    const checked = backupId(id);
    const directory = path.join(root, checked);
    return {
      directory,
      envelope: path.join(directory, "database.enc"),
      manifest: path.join(directory, "manifest.json"),
    };
  };

  const readManifest = async (id: string, root = repository): Promise<BackupManifest> => {
    const locations = pathsFor(id, root);
    let signed: unknown;
    try { signed = JSON.parse(await fs.readFile(locations.manifest, "utf8")); }
    catch (error) {
      if (nodeCode(error) === "ENOENT") throw new Error(`Backup not found: ${id}`);
      throw error;
    }
    if (!signed || typeof signed !== "object" || Array.isArray(signed)) throw new Error(`Backup manifest is invalid: ${id}`);
    const record = signed as { manifest?: unknown; mac?: unknown };
    const manifest = validateManifest(record.manifest, id);
    const encoded = JSON.stringify(manifest);
    if (typeof record.mac !== "string" || !await safeEqual(record.mac, await hmac(encoded, key))) {
      throw new Error(`Backup manifest authentication failed: ${id}`);
    }
    return manifest;
  };

  const decryptAndVerify = async (
    id: string,
    root = repository,
  ): Promise<{ verification: BackupVerification; temporary: string }> => {
    const started = performance.now();
    const manifest = await readManifest(id, root);
    const locations = pathsFor(id, root);
    const temporary = path.join(staging, `${id}-${crypto.randomUUID()}.sqlite`);
    try {
      await decryptFile(
        locations.envelope,
        temporary,
        key,
        new TextEncoder().encode(JSON.stringify(manifest)),
      );
      const file = await fileDigest(temporary, maxDatabaseBytes);
      if (file.bytes !== manifest.databaseBytes || file.sha256 !== manifest.databaseSha256) {
        throw new Error(`Backup plaintext checksum failed: ${id}`);
      }
      await verifySQLite(temporary);
      return {
        temporary,
        verification: {
          id,
          ok: true,
          verifiedAt: Date.now(),
          durationMs: rounded(performance.now() - started),
          databaseBytes: file.bytes,
          databaseSha256: file.sha256,
        },
      };
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  };

  const prune = async (): Promise<void> => {
    const manifests = await manager.list();
    const cutoff = Date.now() - maxAgeMs;
    for (let index = 0; index < manifests.length; index++) {
      const manifest = manifests[index]!;
      if (index < maxBackups && (manifest.createdAt >= cutoff || index === 0)) continue;
      await fs.rm(pathsFor(manifest.id).directory, { recursive: true, force: true });
      emit({ type: "deleted", backupId: manifest.id });
    }
  };

  const manager: BackupManager = {
    async create(createOptions = {}) {
      if (closed) throw new Error("Backup manager is closed.");
      if (creating) throw new Error("A backup is already in progress.");
      creating = true;
      const started = performance.now();
      const id = `bk_${Date.now()}_${randomId(18)}`;
      const temporaryDirectory = pathsFor(id, staging).directory;
      const snapshot = path.join(staging, `${id}.sqlite`);
      try {
        await fs.mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
        await backupSQLite(source, snapshot);
        const digest = await fileDigest(snapshot, maxDatabaseBytes);
        const database = await inspectSQLite(snapshot);
        const manifest: BackupManifest = {
          protocol: "clank-backup/1",
          id,
          source: path.basename(source),
          createdAt: Date.now(),
          reason: bounded(createOptions.reason ?? "scheduled", "backup reason", 1, 200),
          databaseBytes: digest.bytes,
          databaseSha256: digest.sha256,
          databaseRevision: database.revision,
          migrationCount: database.migrationCount,
          latestMigration: database.latestMigration,
          encryption: { algorithm: "AES-256-GCM", keyId },
        };
        const encoded = JSON.stringify(manifest);
        const locations = pathsFor(id, staging);
        await encryptFile(
          snapshot,
          locations.envelope,
          key,
          new TextEncoder().encode(encoded),
        );
        await fs.writeFile(
          locations.manifest,
          `${JSON.stringify({ manifest, mac: await hmac(encoded, key) }, null, 2)}\n`,
          { mode: 0o600, flag: "wx" },
        );
        if (options.verifyAfterCreate !== false) {
          const verified = await decryptAndVerify(id, staging);
          await fs.rm(verified.temporary, { force: true });
        }
        await fs.rename(temporaryDirectory, pathsFor(id).directory);
        await fs.rm(snapshot, { force: true });
        emit({ type: "created", backupId: id, durationMs: rounded(performance.now() - started) });
        await prune();
        return manifest;
      } catch (error) {
        await fs.rm(snapshot, { force: true });
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
        emit({ type: "failed", backupId: id, durationMs: rounded(performance.now() - started), error: safeError(error) });
        throw error;
      } finally {
        creating = false;
      }
    },
    async list() {
      const entries = await fs.readdir(repository, { withFileTypes: true });
      const manifests: BackupManifest[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !BACKUP_ID.test(entry.name)) continue;
        manifests.push(await readManifest(entry.name));
      }
      return manifests.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    },
    async verify(id) {
      if (closed) throw new Error("Backup manager is closed.");
      const result = await decryptAndVerify(backupId(id));
      await fs.rm(result.temporary, { force: true });
      emit({ type: "verified", backupId: id, durationMs: result.verification.durationMs });
      return result.verification;
    },
    async restore(id, restoreOptions) {
      if (closed) throw new Error("Backup manager is closed.");
      const checked = backupId(id);
      if (restoreOptions.confirmation !== `restore ${checked}`) {
        throw new Error(`Restore confirmation must equal "restore ${checked}".`);
      }
      const result = await decryptAndVerify(checked);
      try {
        await restoreSQLiteBackup(result.temporary, path.resolve(restoreOptions.targetPath ?? source));
      } finally {
        await fs.rm(result.temporary, { force: true });
      }
      emit({ type: "restored", backupId: checked, durationMs: result.verification.durationMs });
      return result.verification;
    },
    async delete(id) {
      if (closed) throw new Error("Backup manager is closed.");
      const directory = pathsFor(id).directory;
      try {
        const stats = await fs.lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Backup path is not a regular directory.");
      } catch (error) {
        if (nodeCode(error) === "ENOENT") return false;
        throw error;
      }
      await fs.rm(directory, { recursive: true, force: true });
      emit({ type: "deleted", backupId: id });
      return true;
    },
    start(intervalMs) {
      if (closed) throw new Error("Backup manager is closed.");
      const interval = integerRange(intervalMs, "intervalMs", 60_000, Number.MAX_SAFE_INTEGER);
      if (timer) return () => manager.close();
      timer = setInterval(() => {
        if (!creating && !closed) void manager.create({ reason: "scheduled" }).catch(() => undefined);
      }, interval);
      timer.unref?.();
      return () => {
        if (timer) clearInterval(timer);
        timer = undefined;
      };
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return manager;
}

async function encryptFile(
  source: string,
  destination: string,
  key: Uint8Array,
  additionalData: Uint8Array,
): Promise<void> {
  const fs = await nodeFs();
  const nodeCrypto = await import("node:crypto") as any;
  const streams = await import("node:stream/promises") as any;
  const nativeFs = await import("node:fs") as any;
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  await fs.writeFile(destination, concatenate(MAGIC, iv), { mode: 0o600, flag: "wx" });
  await streams.pipeline(
    nativeFs.createReadStream(source),
    cipher,
    nativeFs.createWriteStream(destination, { flags: "a", mode: 0o600 }),
  );
  await fs.appendFile(destination, cipher.getAuthTag());
}

async function decryptFile(
  source: string,
  destination: string,
  key: Uint8Array,
  additionalData: Uint8Array,
): Promise<void> {
  const fs = await nodeFs();
  const nodeCrypto = await import("node:crypto") as any;
  const streams = await import("node:stream/promises") as any;
  const nativeFs = await import("node:fs") as any;
  const stats = await fs.lstat(source);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= MAGIC.byteLength + 12 + 16) {
    throw new Error("Encrypted backup envelope is invalid.");
  }
  const handle = await fs.open(source, "r");
  let header: Uint8Array;
  let tag: Uint8Array;
  try {
    header = new Uint8Array(MAGIC.byteLength + 12);
    tag = new Uint8Array(16);
    await handle.read(header, 0, header.byteLength, 0);
    await handle.read(tag, 0, tag.byteLength, stats.size - tag.byteLength);
  } finally {
    await handle.close();
  }
  if (!bytesEqual(header.slice(0, MAGIC.byteLength), MAGIC)) throw new Error("Encrypted backup magic is invalid.");
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, header.slice(MAGIC.byteLength));
  decipher.setAAD(additionalData);
  decipher.setAuthTag(tag);
  try {
    await streams.pipeline(
      nativeFs.createReadStream(source, {
        start: header.byteLength,
        end: stats.size - tag.byteLength - 1,
      }),
      decipher,
      nativeFs.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw new Error(`Backup decryption failed: ${safeError(error)}`);
  }
}

async function fileDigest(path: string, maximum: number): Promise<{ bytes: number; sha256: string }> {
  const fs = await nodeFs();
  const nodeCrypto = await import("node:crypto") as any;
  const nativeFs = await import("node:fs") as any;
  const stats = await fs.lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Backup input must be a regular file.");
  if (stats.size > maximum) throw new Error(`Database exceeds backup limit of ${maximum} bytes.`);
  const digest = nodeCrypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of nativeFs.createReadStream(path)) {
    bytes += chunk.byteLength;
    if (bytes > maximum) throw new Error(`Database exceeds backup limit of ${maximum} bytes.`);
    digest.update(chunk);
  }
  return { bytes, sha256: digest.digest("hex") };
}

async function inspectSQLite(path: string): Promise<{
  revision: number | null;
  migrationCount: number;
  latestMigration: string | null;
}> {
  const sqlite = await import("node:sqlite") as any;
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const table = (name: string) => Boolean(database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
    const revision = table("clank_meta")
      ? Number(database.prepare("SELECT _value FROM clank_meta WHERE _key = 'global_version'").get()?._value ?? 0)
      : null;
    const migration = table("clank_migrations")
      ? database.prepare("SELECT count(*) AS count, max(id) AS latest FROM clank_migrations").get()
      : { count: 0, latest: null };
    return {
      revision,
      migrationCount: Number(migration.count),
      latestMigration: migration.latest === null ? null : String(migration.latest),
    };
  } finally {
    database.close();
  }
}

async function verifySQLite(path: string): Promise<void> {
  const sqlite = await import("node:sqlite") as any;
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || String(Object.values(rows[0] ?? {})[0]).toLowerCase() !== "ok") {
      throw new Error("SQLite integrity check failed.");
    }
  } finally {
    database.close();
  }
}

function validateManifest(value: unknown, expectedId: string): BackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup manifest is invalid.");
  const manifest = value as BackupManifest;
  if (
    manifest.protocol !== "clank-backup/1"
    || manifest.id !== expectedId
    || !BACKUP_ID.test(manifest.id)
    || !Number.isSafeInteger(manifest.createdAt)
    || !Number.isSafeInteger(manifest.databaseBytes)
    || !/^[a-f0-9]{64}$/u.test(manifest.databaseSha256)
    || manifest.encryption?.algorithm !== "AES-256-GCM"
  ) throw new Error(`Backup manifest is invalid: ${expectedId}`);
  return manifest;
}

async function encryptionKey(value: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  if (input.byteLength < 32) throw new TypeError("Backup encryption key must contain at least 32 bytes.");
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

async function hmac(value: string, key: Uint8Array): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)));
  return base64Url(bytes);
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function backupId(value: string): string {
  if (!BACKUP_ID.test(value)) throw new TypeError("Invalid backup ID.");
  return value;
}

function safeIdentifier(value: string, name: string, maximum: number): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value.length > maximum) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function bounded(value: string, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} must contain ${minimum} to ${maximum} characters.`);
  }
  return value;
}

function integerRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function randomId(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nodeCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

async function nodePath(): Promise<{
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
  basename(path: string): string;
}> {
  return await import("node:path") as any;
}

async function nodeFs(): Promise<any> {
  return await import("node:fs/promises") as any;
}
