import { backupSQLite, restoreSQLiteBackup } from "./migrations.ts";
import type { ObjectStore } from "./object-storage.ts";

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

export interface BackupSnapshotInput {
  /** Consistent SQLite snapshot bytes obtained from a trusted source. */
  bytes: Uint8Array;
  /** Optional precomputed checksum, verified before encryption. */
  sha256?: string;
  /** Basename recorded in the manifest. */
  source: string;
  reason?: string;
  databaseRevision?: number | null;
  migrationCount?: number;
  latestMigration?: string | null;
  protectedBackupIds?: readonly string[];
}

export interface BackupReadResult {
  bytes: Uint8Array;
  verification: BackupVerification;
}

export interface BackupManager {
  create(options?: {
    reason?: string;
    /** Backup IDs that this create/prune cycle must preserve temporarily. */
    protectedBackupIds?: readonly string[];
  }): Promise<BackupManifest>;
  /** Encrypts an already-consistent snapshot without writing plaintext staging data. */
  createFromSnapshot(options: BackupSnapshotInput): Promise<BackupManifest>;
  list(): Promise<readonly BackupManifest[]>;
  verify(id: string): Promise<BackupVerification>;
  /** Authenticates and decrypts a backup into bounded memory without a plaintext staging file. */
  read(id: string): Promise<BackupReadResult>;
  restore(id: string, options: {
    targetPath?: string;
    confirmation: string;
  }): Promise<BackupVerification>;
  delete(id: string): Promise<boolean>;
  /** Permanently removes every local and object-backed recovery point. */
  purge(options: { confirmation: "delete all backups" }): Promise<number>;
  start(intervalMs: number): () => void;
  close(): void;
}

export interface BackupManagerOptions {
  /** Local live database. Optional for snapshot-import-only repositories. */
  databasePath?: string;
  repositoryDirectory: string;
  encryptionKey: string | Uint8Array;
  keyId?: string;
  maxBackups?: number;
  maxAgeMs?: number;
  maxDatabaseBytes?: number;
  verifyAfterCreate?: boolean;
  /**
   * Stores encrypted backup envelopes outside the application volume.
   *
   * The local repository remains as a private staging area and compatibility
   * source. Existing local backups are promoted on the next create. A stable
   * namespace and repositoryId prevent a configuration change from silently
   * pointing at a different backup history.
   */
  objects?: BackupObjectRepositoryOptions;
  onEvent?: (event: {
    type: "created" | "verified" | "restored" | "deleted" | "failed";
    backupId?: string;
    durationMs?: number;
    error?: string;
  }) => void;
}

export interface BackupObjectRepositoryOptions {
  store: ObjectStore;
  /** Stable operator-selected identity for the physical repository. */
  namespace: string;
  /** Stable identity for this database within the shared object repository. */
  repositoryId: string;
  /** Logical key prefix. Defaults to "backups". */
  prefix?: string;
  /** Encrypted bytes uploaded per immutable object. Defaults to 8 MiB. */
  chunkBytes?: number;
}

const BACKUP_ID = /^bk_[0-9]{13}_[A-Za-z0-9_-]{12,64}$/u;
const MAGIC = new TextEncoder().encode("CLNKBK1\n");
const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\0");
const OBJECT_CATALOG_PROTOCOL = "clank-backup-catalog/1" as const;
const OBJECT_CONTENT_TYPE = "application/vnd.clank.backup-chunk";
const CATALOG_CONTENT_TYPE = "application/vnd.clank.backup-catalog+json";
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;

/** Opens an encrypted local or object-backed backup repository for one SQLite database. */
export async function openBackupManager(options: BackupManagerOptions): Promise<BackupManager> {
  if (!options.objects) return openLocalBackupManager(options);
  return openObjectBackupManager(options);
}

async function openLocalBackupManager(options: BackupManagerOptions): Promise<BackupManager> {
  const fs = await nodeFs();
  const path = await nodePath();
  const source = options.databasePath ? path.resolve(options.databasePath) : null;
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

  const prune = async (protectedIds: ReadonlySet<string> = new Set()): Promise<void> => {
    const manifests = await manager.list();
    const cutoff = Date.now() - maxAgeMs;
    for (let index = 0; index < manifests.length; index++) {
      const manifest = manifests[index]!;
      if (protectedIds.has(manifest.id)) continue;
      if (index < maxBackups && (manifest.createdAt >= cutoff || index === 0)) continue;
      await fs.rm(pathsFor(manifest.id).directory, { recursive: true, force: true });
      emit({ type: "deleted", backupId: manifest.id });
    }
  };

  const manager: BackupManager = {
    async create(createOptions = {}) {
      if (closed) throw new Error("Backup manager is closed.");
      if (creating) throw new Error("A backup is already in progress.");
      if (!source) throw new Error("A local database path is required for live backup creation.");
      const protectedIds = protectedBackupIds(createOptions.protectedBackupIds);
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
        await prune(protectedIds);
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
    async createFromSnapshot(snapshotOptions) {
      if (closed) throw new Error("Backup manager is closed.");
      if (creating) throw new Error("A backup is already in progress.");
      const snapshot = backupSnapshotInput(snapshotOptions, maxDatabaseBytes);
      const protectedIds = protectedBackupIds(snapshot.protectedBackupIds);
      creating = true;
      const started = performance.now();
      const id = `bk_${Date.now()}_${randomId(18)}`;
      const temporaryDirectory = pathsFor(id, staging).directory;
      try {
        await fs.mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
        const sha256 = await sha256Bytes(snapshot.bytes);
        if (snapshot.sha256 !== undefined && snapshot.sha256 !== sha256) {
          throw new Error("Imported backup snapshot checksum failed.");
        }
        const manifest: BackupManifest = {
          protocol: "clank-backup/1",
          id,
          source: snapshot.source,
          createdAt: Date.now(),
          reason: snapshot.reason,
          databaseBytes: snapshot.bytes.byteLength,
          databaseSha256: sha256,
          databaseRevision: snapshot.databaseRevision,
          migrationCount: snapshot.migrationCount,
          latestMigration: snapshot.latestMigration,
          encryption: { algorithm: "AES-256-GCM", keyId },
        };
        const encoded = JSON.stringify(manifest);
        const locations = pathsFor(id, staging);
        await encryptBytes(
          snapshot.bytes,
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
          const verified = await decryptBytes(
            locations.envelope,
            key,
            new TextEncoder().encode(encoded),
            maxDatabaseBytes,
          );
          if (
            verified.byteLength !== manifest.databaseBytes
            || await sha256Bytes(verified) !== manifest.databaseSha256
          ) {
            throw new Error(`Backup plaintext checksum failed: ${id}`);
          }
          assertSQLiteBytes(verified);
        }
        await fs.rename(temporaryDirectory, pathsFor(id).directory);
        emit({
          type: "created",
          backupId: id,
          durationMs: rounded(performance.now() - started),
        });
        await prune(protectedIds);
        return manifest;
      } catch (error) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
        emit({
          type: "failed",
          backupId: id,
          durationMs: rounded(performance.now() - started),
          error: safeError(error),
        });
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
    async read(idInput) {
      if (closed) throw new Error("Backup manager is closed.");
      const id = backupId(idInput);
      const started = performance.now();
      const manifest = await readManifest(id);
      const bytes = await decryptBytes(
        pathsFor(id).envelope,
        key,
        new TextEncoder().encode(JSON.stringify(manifest)),
        maxDatabaseBytes,
      );
      const sha256 = await sha256Bytes(bytes);
      if (
        bytes.byteLength !== manifest.databaseBytes
        || sha256 !== manifest.databaseSha256
      ) {
        throw new Error(`Backup plaintext checksum failed: ${id}`);
      }
      assertSQLiteBytes(bytes);
      return {
        bytes,
        verification: {
          id,
          ok: true,
          verifiedAt: Date.now(),
          durationMs: rounded(performance.now() - started),
          databaseBytes: bytes.byteLength,
          databaseSha256: sha256,
        },
      };
    },
    async restore(id, restoreOptions) {
      if (closed) throw new Error("Backup manager is closed.");
      const checked = backupId(id);
      if (restoreOptions.confirmation !== `restore ${checked}`) {
        throw new Error(`Restore confirmation must equal "restore ${checked}".`);
      }
      const result = await decryptAndVerify(checked);
      try {
        const target = restoreOptions.targetPath
          ? path.resolve(restoreOptions.targetPath)
          : source;
        if (!target) {
          throw new Error("A restore target path is required for this backup repository.");
        }
        await restoreSQLiteBackup(result.temporary, target);
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
    async purge(purgeOptions) {
      if (closed) throw new Error("Backup manager is closed.");
      if (purgeOptions?.confirmation !== "delete all backups") {
        throw new Error('Backup purge confirmation must equal "delete all backups".');
      }
      const manifests = await manager.list();
      for (const manifest of manifests) await manager.delete(manifest.id);
      return manifests.length;
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

type ObjectBackupState = "uploading" | "active" | "deleting";

interface ObjectBackupChunk {
  key: string;
  size: number;
  sha256: string | null;
}

interface ObjectBackupEntry {
  id: string;
  state: ObjectBackupState;
  manifest: BackupManifest;
  manifestMac: string;
  envelopeBytes: number;
  chunks: readonly ObjectBackupChunk[];
  updatedAt: number;
}

interface ObjectBackupCatalog {
  protocol: typeof OBJECT_CATALOG_PROTOCOL;
  namespace: string;
  repositoryId: string;
  revision: number;
  entries: readonly ObjectBackupEntry[];
}

async function openObjectBackupManager(options: BackupManagerOptions): Promise<BackupManager> {
  const fs = await nodeFs();
  const path = await nodePath();
  const source = options.databasePath ? path.resolve(options.databasePath) : null;
  const repository = path.resolve(options.repositoryDirectory);
  const objectStaging = path.join(repository, ".object-staging");
  const configured = normalizeBackupObjects(options.objects);
  const key = await encryptionKey(options.encryptionKey);
  const maxBackups = integerRange(options.maxBackups ?? 30, "maxBackups", 1, 10_000);
  const maxAgeMs = integerRange(
    options.maxAgeMs ?? 90 * 24 * 60 * 60 * 1_000,
    "maxAgeMs",
    60_000,
    Number.MAX_SAFE_INTEGER,
  );
  const maxDatabaseBytes = integerRange(
    options.maxDatabaseBytes ?? 10 * 1024 * 1024 * 1024,
    "maxDatabaseBytes",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  await fs.mkdir(objectStaging, { recursive: true, mode: 0o700 });
  await fs.chmod(objectStaging, 0o700);

  // The local engine remains the source of truth for encryption, SQLite
  // consistency, and compatibility with backups created before object storage
  // was enabled. Retention is coordinated across both repositories below.
  const local = await openLocalBackupManager({
    ...options,
    objects: undefined,
    maxBackups: 10_000,
    maxAgeMs: Number.MAX_SAFE_INTEGER,
    onEvent: undefined,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let creating = false;
  let closed = false;
  let mutationTail: Promise<void> = Promise.resolve();

  const emit = (event: Parameters<NonNullable<BackupManagerOptions["onEvent"]>>[0]) => {
    try { options.onEvent?.(event); }
    catch { /* Recovery observers cannot alter backup state. */ }
  };

  const mutate = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const previous = mutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mutationTail = previous.then(() => gate, () => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const catalogKey = `${configured.root}/catalog.json`;
  const emptyCatalog = (): ObjectBackupCatalog => ({
    protocol: OBJECT_CATALOG_PROTOCOL,
    namespace: configured.namespace,
    repositoryId: configured.repositoryId,
    revision: 0,
    entries: [],
  });

  const readCatalog = async (): Promise<ObjectBackupCatalog> => {
    const stored = await configured.store.get(catalogKey);
    if (!stored) return emptyCatalog();
    await assertStoredObject(stored, catalogKey, MAX_CATALOG_BYTES, CATALOG_CONTENT_TYPE);
    let signed: unknown;
    try {
      signed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes));
    } catch {
      throw new Error("Object backup catalog is invalid.");
    }
    if (!signed || typeof signed !== "object" || Array.isArray(signed)) {
      throw new Error("Object backup catalog is invalid.");
    }
    const record = signed as { catalog?: unknown; mac?: unknown };
    const catalog = validateObjectCatalog(
      record.catalog,
      configured.namespace,
      configured.repositoryId,
      configured.root,
    );
    const encoded = JSON.stringify(catalog);
    if (typeof record.mac !== "string" || !await safeEqual(record.mac, await hmac(encoded, key))) {
      throw new Error("Object backup catalog authentication failed.");
    }
    for (const entry of catalog.entries) {
      if (!await safeEqual(entry.manifestMac, await hmac(JSON.stringify(entry.manifest), key))) {
        throw new Error(`Backup manifest authentication failed: ${entry.id}`);
      }
    }
    return catalog;
  };

  const writeCatalog = async (
    previous: ObjectBackupCatalog,
    entries: readonly ObjectBackupEntry[],
  ): Promise<ObjectBackupCatalog> => {
    const catalog: ObjectBackupCatalog = {
      protocol: OBJECT_CATALOG_PROTOCOL,
      namespace: configured.namespace,
      repositoryId: configured.repositoryId,
      revision: previous.revision + 1,
      entries: [...entries].sort((left, right) =>
        right.manifest.createdAt - left.manifest.createdAt || right.id.localeCompare(left.id)),
    };
    const encoded = JSON.stringify(catalog);
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ catalog, mac: await hmac(encoded, key) }, null, 2)}\n`,
    );
    if (bytes.byteLength > MAX_CATALOG_BYTES) {
      throw new Error(`Object backup catalog exceeds ${MAX_CATALOG_BYTES} bytes.`);
    }
    const metadata = await configured.store.put(catalogKey, bytes, {
      contentType: CATALOG_CONTENT_TYPE,
    });
    await assertWrittenObject(metadata, catalogKey, bytes, CATALOG_CONTENT_TYPE);
    return catalog;
  };

  const replaceEntry = async (
    catalog: ObjectBackupCatalog,
    entry: ObjectBackupEntry,
  ): Promise<ObjectBackupCatalog> => {
    const entries = catalog.entries.filter((candidate) => candidate.id !== entry.id);
    entries.push(entry);
    return writeCatalog(catalog, entries);
  };

  const removeEntry = async (
    catalog: ObjectBackupCatalog,
    id: string,
  ): Promise<ObjectBackupCatalog> => {
    return writeCatalog(catalog, catalog.entries.filter((entry) => entry.id !== id));
  };

  const localLocations = (id: string) => {
    const checked = backupId(id);
    const directory = path.join(repository, checked);
    return {
      directory,
      envelope: path.join(directory, "database.enc"),
      manifest: path.join(directory, "manifest.json"),
    };
  };

  const readSignedLocalManifest = async (
    manifest: BackupManifest,
  ): Promise<{ manifest: BackupManifest; mac: string }> => {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(localLocations(manifest.id).manifest, "utf8"));
    } catch {
      throw new Error(`Backup manifest is invalid: ${manifest.id}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Backup manifest is invalid: ${manifest.id}`);
    }
    const signed = value as { manifest?: unknown; mac?: unknown };
    const checked = validateManifest(signed.manifest, manifest.id);
    if (
      JSON.stringify(checked) !== JSON.stringify(manifest)
      || typeof signed.mac !== "string"
      || !await safeEqual(signed.mac, await hmac(JSON.stringify(checked), key))
    ) {
      throw new Error(`Backup manifest authentication failed: ${manifest.id}`);
    }
    return { manifest: checked, mac: signed.mac };
  };

  const plannedChunks = (id: string, envelopeBytes: number): ObjectBackupChunk[] => {
    if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes <= 0) {
      throw new Error(`Encrypted backup envelope is invalid: ${id}`);
    }
    const count = Math.ceil(envelopeBytes / configured.chunkBytes);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
      throw new Error("Encrypted backup requires too many object chunks.");
    }
    return Array.from({ length: count }, (_, index) => ({
      key: objectChunkKey(configured.root, id, index),
      size: Math.min(configured.chunkBytes, envelopeBytes - index * configured.chunkBytes),
      sha256: null,
    }));
  };

  const uploadEnvelope = async (
    envelope: string,
    chunks: readonly ObjectBackupChunk[],
  ): Promise<ObjectBackupChunk[]> => {
    const handle = await fs.open(envelope, "r");
    const uploaded: ObjectBackupChunk[] = [];
    try {
      for (let index = 0; index < chunks.length; index++) {
        const planned = chunks[index]!;
        const bytes = new Uint8Array(planned.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await handle.read(bytes, offset, bytes.byteLength - offset, index * configured.chunkBytes + offset);
          if (result.bytesRead <= 0) throw new Error("Encrypted backup ended before its declared size.");
          offset += result.bytesRead;
        }
        const metadata = await configured.store.put(planned.key, bytes, {
          contentType: OBJECT_CONTENT_TYPE,
        });
        await assertWrittenObject(metadata, planned.key, bytes, OBJECT_CONTENT_TYPE);
        uploaded.push({
          key: planned.key,
          size: bytes.byteLength,
          sha256: metadata.sha256,
        });
      }
    } finally {
      await handle.close();
    }
    return uploaded;
  };

  const materializeRemote = async (
    entry: ObjectBackupEntry,
  ): Promise<{ root: string; manager: BackupManager }> => {
    if (entry.state !== "active" || entry.chunks.some((chunk) => chunk.sha256 === null)) {
      throw new Error(`Backup is not available: ${entry.id}`);
    }
    const root = await fs.mkdtemp(path.join(objectStaging, "read-"));
    const directory = path.join(root, entry.id);
    const envelope = path.join(directory, "database.enc");
    try {
      await fs.mkdir(directory, { recursive: false, mode: 0o700 });
      await fs.writeFile(
        path.join(directory, "manifest.json"),
        `${JSON.stringify({ manifest: entry.manifest, mac: entry.manifestMac }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      const handle = await fs.open(envelope, "wx", 0o600);
      let position = 0;
      try {
        for (const chunk of entry.chunks) {
          const stored = await configured.store.get(chunk.key);
          if (!stored) throw new Error(`Backup object is missing: ${entry.id}`);
          await assertStoredObject(stored, chunk.key, configured.chunkBytes, OBJECT_CONTENT_TYPE);
          if (
            stored.metadata.size !== chunk.size
            || stored.metadata.sha256 !== chunk.sha256
            || stored.metadata.contentType !== OBJECT_CONTENT_TYPE
          ) {
            throw new Error(`Backup object integrity failed: ${entry.id}`);
          }
          let offset = 0;
          while (offset < stored.bytes.byteLength) {
            const result = await handle.write(
              stored.bytes,
              offset,
              stored.bytes.byteLength - offset,
              position + offset,
            );
            if (result.bytesWritten <= 0) throw new Error("Backup object could not be materialized.");
            offset += result.bytesWritten;
          }
          position += stored.bytes.byteLength;
        }
      } finally {
        await handle.close();
      }
      if (position !== entry.envelopeBytes) {
        throw new Error(`Backup object size failed: ${entry.id}`);
      }
      const manager = await openLocalBackupManager({
        ...options,
        objects: undefined,
        repositoryDirectory: root,
        onEvent: undefined,
      });
      return { root, manager };
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  };

  const deleteRemoteEntry = async (
    startingCatalog: ObjectBackupCatalog,
    startingEntry: ObjectBackupEntry,
  ): Promise<ObjectBackupCatalog> => {
    let catalog = startingCatalog;
    let entry = startingEntry;
    if (entry.state !== "deleting") {
      entry = { ...entry, state: "deleting", updatedAt: Date.now() };
      catalog = await replaceEntry(catalog, entry);
    }
    for (const chunk of entry.chunks) await configured.store.delete(chunk.key);
    try {
      return await removeEntry(catalog, entry.id);
    } catch (error) {
      const observed = await readCatalog().catch(() => null);
      if (observed && !observed.entries.some((candidate) => candidate.id === entry.id)) return observed;
      throw error;
    }
  };

  const publishLocal = async (manifest: BackupManifest): Promise<void> => {
    const signed = await readSignedLocalManifest(manifest);
    const envelope = localLocations(manifest.id).envelope;
    const stats = await fs.lstat(envelope);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Encrypted backup envelope is invalid: ${manifest.id}`);
    }
    const plan = plannedChunks(manifest.id, stats.size);
    let catalog = await readCatalog();
    let existing = catalog.entries.find((entry) => entry.id === manifest.id);
    if (existing?.state === "active") {
      if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) {
        throw new Error(`Object backup ID conflicts with a different manifest: ${manifest.id}`);
      }
      await local.delete(manifest.id);
      return;
    }
    if (existing?.state === "deleting") {
      catalog = await deleteRemoteEntry(catalog, existing);
      existing = undefined;
    }
    if (existing && JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) {
      throw new Error(`Object backup ID conflicts with a different manifest: ${manifest.id}`);
    }
    const uploading: ObjectBackupEntry = {
      id: manifest.id,
      state: "uploading",
      manifest,
      manifestMac: signed.mac,
      envelopeBytes: stats.size,
      chunks: plan,
      updatedAt: Date.now(),
    };
    if (!existing) {
      try {
        catalog = await replaceEntry(catalog, uploading);
      } catch (error) {
        const observed = await readCatalog().catch(() => null);
        const pending = observed?.entries.find((entry) => entry.id === manifest.id);
        if (!observed || pending?.state !== "uploading") throw error;
        catalog = observed;
      }
    } else {
      catalog = await replaceEntry(catalog, uploading);
    }
    const chunks = await uploadEnvelope(envelope, plan);
    const active: ObjectBackupEntry = {
      ...uploading,
      state: "active",
      chunks,
      updatedAt: Date.now(),
    };
    if (options.verifyAfterCreate !== false) {
      const materialized = await materializeRemote(active);
      try {
        await materialized.manager.verify(active.id);
      } finally {
        materialized.manager.close();
        await fs.rm(materialized.root, { recursive: true, force: true });
      }
    }
    try {
      await replaceEntry(await readCatalog(), active);
    } catch (error) {
      const observed = await readCatalog().catch(() => null);
      const committed = observed?.entries.find((entry) =>
        entry.id === manifest.id
        && entry.state === "active"
        && JSON.stringify(entry.chunks) === JSON.stringify(active.chunks));
      if (!committed) throw error;
    }
    await local.delete(manifest.id);
  };

  const synchronizeLocal = async (): Promise<void> => {
    let catalog = await readCatalog();
    for (const entry of [...catalog.entries]) {
      if (entry.state !== "deleting") continue;
      catalog = await deleteRemoteEntry(catalog, entry);
    }
    const localBackups = await local.list();
    const localIds = new Set(localBackups.map((manifest) => manifest.id));
    const staleBefore = Date.now() - 60 * 60_000;
    for (const entry of [...catalog.entries]) {
      if (
        entry.state !== "uploading"
        || localIds.has(entry.id)
        || entry.updatedAt >= staleBefore
      ) continue;
      for (const chunk of entry.chunks) await configured.store.delete(chunk.key);
      catalog = await removeEntry(catalog, entry.id);
    }
    for (const manifest of localBackups) await publishLocal(manifest);
  };

  const combinedList = async (): Promise<BackupManifest[]> => {
    const [catalog, localBackups] = await Promise.all([readCatalog(), local.list()]);
    const manifests = new Map<string, BackupManifest>();
    for (const entry of catalog.entries) {
      if (entry.state === "active") manifests.set(entry.id, entry.manifest);
    }
    for (const manifest of localBackups) {
      const existing = manifests.get(manifest.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(manifest)) {
        throw new Error(`Backup ID conflicts across repositories: ${manifest.id}`);
      }
      if (!existing) manifests.set(manifest.id, manifest);
    }
    return [...manifests.values()].sort((left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  };

  const deleteInternal = async (idInput: string): Promise<boolean> => {
    const id = backupId(idInput);
    let removed = false;
    let catalog = await readCatalog();
    const remote = catalog.entries.find((entry) => entry.id === id);
    if (remote) {
      catalog = await deleteRemoteEntry(catalog, remote);
      removed = true;
    }
    if (await local.delete(id)) removed = true;
    return removed;
  };

  const prune = async (protectedIds: ReadonlySet<string> = new Set()): Promise<void> => {
    const manifests = await combinedList();
    const cutoff = Date.now() - maxAgeMs;
    for (let index = 0; index < manifests.length; index++) {
      const manifest = manifests[index]!;
      if (protectedIds.has(manifest.id)) continue;
      if (index < maxBackups && (manifest.createdAt >= cutoff || index === 0)) continue;
      if (await deleteInternal(manifest.id)) {
        emit({ type: "deleted", backupId: manifest.id });
      }
    }
  };

  const manager: BackupManager = {
    async create(createOptions = {}) {
      if (closed) throw new Error("Backup manager is closed.");
      if (creating) throw new Error("A backup is already in progress.");
      const protectedIds = protectedBackupIds(createOptions.protectedBackupIds);
      creating = true;
      const started = performance.now();
      let backup: BackupManifest | undefined;
      try {
        return await mutate(async () => {
          await synchronizeLocal();
          backup = await local.create(createOptions);
          await publishLocal(backup);
          await prune(protectedIds);
          emit({ type: "created", backupId: backup.id, durationMs: rounded(performance.now() - started) });
          return backup;
        });
      } catch (error) {
        emit({
          type: "failed",
          backupId: backup?.id,
          durationMs: rounded(performance.now() - started),
          error: safeError(error),
        });
        throw error;
      } finally {
        creating = false;
      }
    },
    async createFromSnapshot(snapshotOptions) {
      if (closed) throw new Error("Backup manager is closed.");
      if (creating) throw new Error("A backup is already in progress.");
      const protectedIds = protectedBackupIds(snapshotOptions.protectedBackupIds);
      creating = true;
      const started = performance.now();
      let backup: BackupManifest | undefined;
      try {
        return await mutate(async () => {
          await synchronizeLocal();
          backup = await local.createFromSnapshot(snapshotOptions);
          await publishLocal(backup);
          await prune(protectedIds);
          emit({
            type: "created",
            backupId: backup.id,
            durationMs: rounded(performance.now() - started),
          });
          return backup;
        });
      } catch (error) {
        emit({
          type: "failed",
          backupId: backup?.id,
          durationMs: rounded(performance.now() - started),
          error: safeError(error),
        });
        throw error;
      } finally {
        creating = false;
      }
    },
    async list() {
      if (closed) throw new Error("Backup manager is closed.");
      return combinedList();
    },
    async verify(idInput) {
      if (closed) throw new Error("Backup manager is closed.");
      const id = backupId(idInput);
      const catalog = await readCatalog();
      const remote = catalog.entries.find((entry) => entry.id === id && entry.state === "active");
      let verification: BackupVerification;
      if (remote) {
        const materialized = await materializeRemote(remote);
        try {
          verification = await materialized.manager.verify(id);
        } finally {
          materialized.manager.close();
          await fs.rm(materialized.root, { recursive: true, force: true });
        }
      } else {
        verification = await local.verify(id);
      }
      emit({ type: "verified", backupId: id, durationMs: verification.durationMs });
      return verification;
    },
    async read(idInput) {
      if (closed) throw new Error("Backup manager is closed.");
      const id = backupId(idInput);
      const catalog = await readCatalog();
      const remote = catalog.entries.find((entry) =>
        entry.id === id && entry.state === "active");
      if (remote) {
        const materialized = await materializeRemote(remote);
        try {
          return await materialized.manager.read(id);
        } finally {
          materialized.manager.close();
          await fs.rm(materialized.root, { recursive: true, force: true });
        }
      }
      return local.read(id);
    },
    async restore(idInput, restoreOptions) {
      if (closed) throw new Error("Backup manager is closed.");
      const id = backupId(idInput);
      if (restoreOptions.confirmation !== `restore ${id}`) {
        throw new Error(`Restore confirmation must equal "restore ${id}".`);
      }
      const catalog = await readCatalog();
      const remote = catalog.entries.find((entry) => entry.id === id && entry.state === "active");
      let verification: BackupVerification;
      if (remote) {
        const materialized = await materializeRemote(remote);
        try {
          verification = await materialized.manager.restore(id, {
            confirmation: restoreOptions.confirmation,
            ...(restoreOptions.targetPath
              ? { targetPath: path.resolve(restoreOptions.targetPath) }
              : source
                ? { targetPath: source }
                : {}),
          });
        } finally {
          materialized.manager.close();
          await fs.rm(materialized.root, { recursive: true, force: true });
        }
      } else {
        verification = await local.restore(id, restoreOptions);
      }
      emit({ type: "restored", backupId: id, durationMs: verification.durationMs });
      return verification;
    },
    async delete(id) {
      if (closed) throw new Error("Backup manager is closed.");
      return mutate(async () => {
        const removed = await deleteInternal(id);
        if (removed) emit({ type: "deleted", backupId: id });
        return removed;
      });
    },
    async purge(purgeOptions) {
      if (closed) throw new Error("Backup manager is closed.");
      if (purgeOptions?.confirmation !== "delete all backups") {
        throw new Error('Backup purge confirmation must equal "delete all backups".');
      }
      return mutate(async () => {
        const catalog = await readCatalog();
        const localBackups = await local.list();
        const ids = new Set([
          ...catalog.entries.map((entry) => entry.id),
          ...localBackups.map((manifest) => manifest.id),
        ]);
        for (const entry of catalog.entries) {
          for (const chunk of entry.chunks) await configured.store.delete(chunk.key);
        }
        for (const manifest of localBackups) await local.delete(manifest.id);
        await configured.store.delete(catalogKey);
        for (const id of ids) emit({ type: "deleted", backupId: id });
        return ids.size;
      });
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
      local.close();
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return manager;
}

function normalizeBackupObjects(
  configured: BackupObjectRepositoryOptions | undefined,
): {
  store: ObjectStore;
  namespace: string;
  repositoryId: string;
  root: string;
  chunkBytes: number;
} {
  if (!configured || typeof configured !== "object") {
    throw new TypeError("objects must configure an object backup repository.");
  }
  const namespace = portableIdentifier(configured.namespace, "objects.namespace", 128);
  if (namespace === "local") throw new TypeError("objects.namespace cannot be local.");
  const repositoryId = portableIdentifier(configured.repositoryId, "objects.repositoryId", 128);
  const prefix = objectPrefix(configured.prefix ?? "backups");
  const store = configured.store;
  if (
    !store
    || typeof store !== "object"
    || typeof store.put !== "function"
    || typeof store.get !== "function"
    || typeof store.stat !== "function"
    || typeof store.delete !== "function"
  ) {
    throw new TypeError("objects.store must implement ObjectStore.");
  }
  return Object.freeze({
    store,
    namespace,
    repositoryId,
    root: `${prefix}/${repositoryId}`,
    chunkBytes: integerRange(
      configured.chunkBytes ?? 8 * 1024 * 1024,
      "objects.chunkBytes",
      64 * 1024,
      64 * 1024 * 1024,
    ),
  });
}

function validateObjectCatalog(
  value: unknown,
  namespace: string,
  repositoryId: string,
  root: string,
): ObjectBackupCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Object backup catalog is invalid.");
  }
  const catalog = value as ObjectBackupCatalog;
  if (
    catalog.protocol !== OBJECT_CATALOG_PROTOCOL
    || catalog.namespace !== namespace
    || catalog.repositoryId !== repositoryId
    || !Number.isSafeInteger(catalog.revision)
    || catalog.revision < 0
    || !Array.isArray(catalog.entries)
    || catalog.entries.length > 10_001
  ) {
    throw new Error("Object backup catalog does not match the configured repository.");
  }
  const ids = new Set<string>();
  const entries = catalog.entries.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Object backup catalog entry is invalid.");
    }
    const entry = input as ObjectBackupEntry;
    const id = backupId(entry.id);
    if (
      ids.has(id)
      || !["uploading", "active", "deleting"].includes(entry.state)
      || typeof entry.manifestMac !== "string"
      || !/^[A-Za-z0-9_-]{43}$/u.test(entry.manifestMac)
      || !Number.isSafeInteger(entry.envelopeBytes)
      || entry.envelopeBytes <= 0
      || !Number.isSafeInteger(entry.updatedAt)
      || entry.updatedAt <= 0
      || !Array.isArray(entry.chunks)
      || entry.chunks.length < 1
      || entry.chunks.length > 1_000_000
    ) {
      throw new Error("Object backup catalog entry is invalid.");
    }
    ids.add(id);
    const manifest = validateManifest(entry.manifest, id);
    let total = 0;
    const chunks = entry.chunks.map((inputChunk, index) => {
      if (!inputChunk || typeof inputChunk !== "object" || Array.isArray(inputChunk)) {
        throw new Error("Object backup catalog chunk is invalid.");
      }
      const chunk = inputChunk as ObjectBackupChunk;
      if (
        chunk.key !== objectChunkKey(root, id, index)
        || !Number.isSafeInteger(chunk.size)
        || chunk.size <= 0
        || (chunk.sha256 !== null && !/^[a-f0-9]{64}$/u.test(chunk.sha256))
        || (entry.state === "active" && chunk.sha256 === null)
      ) {
        throw new Error("Object backup catalog chunk is invalid.");
      }
      total += chunk.size;
      if (!Number.isSafeInteger(total)) throw new Error("Object backup size is invalid.");
      return Object.freeze({ key: chunk.key, size: chunk.size, sha256: chunk.sha256 });
    });
    if (total !== entry.envelopeBytes) throw new Error("Object backup envelope size is invalid.");
    return Object.freeze({
      id,
      state: entry.state,
      manifest,
      manifestMac: entry.manifestMac,
      envelopeBytes: entry.envelopeBytes,
      chunks,
      updatedAt: entry.updatedAt,
    });
  });
  return Object.freeze({
    protocol: OBJECT_CATALOG_PROTOCOL,
    namespace,
    repositoryId,
    revision: catalog.revision,
    entries: Object.freeze(entries),
  });
}

function objectChunkKey(root: string, idInput: string, index: number): string {
  const id = backupId(idInput);
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) {
    throw new Error("Object backup chunk index is invalid.");
  }
  return `${root}/${id}/chunks/${String(index).padStart(6, "0")}.enc`;
}

function objectPrefix(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 384) {
    throw new TypeError("objects.prefix must contain 1 to 384 characters.");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length < 1
      || segment.length > 100
      || segment === "."
      || segment === ".."
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))
  ) {
    throw new TypeError("objects.prefix must contain portable path segments.");
  }
  return segments.join("/");
}

function portableIdentifier(value: string, name: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new TypeError(`${name} must be a portable identifier.`);
  }
  return value;
}

async function assertStoredObject(
  stored: {
    metadata: { key: string; size: number; sha256: string; contentType: string };
    bytes: Uint8Array;
  },
  key: string,
  maximum: number,
  contentType: string,
): Promise<void> {
  if (
    stored.metadata.key !== key
    || stored.metadata.size !== stored.bytes.byteLength
    || stored.bytes.byteLength > maximum
    || !/^[a-f0-9]{64}$/u.test(stored.metadata.sha256)
    || stored.metadata.sha256 !== await sha256Bytes(stored.bytes)
    || stored.metadata.contentType !== contentType
  ) {
    throw new Error("Object backup repository returned inconsistent metadata.");
  }
}

async function assertWrittenObject(
  metadata: { key: string; size: number; sha256: string; contentType: string },
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  if (
    metadata.key !== key
    || metadata.size !== bytes.byteLength
    || metadata.sha256 !== await sha256Bytes(bytes)
    || metadata.contentType !== contentType
  ) {
    throw new Error("Object backup repository returned inconsistent write metadata.");
  }
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

async function encryptBytes(
  source: Uint8Array,
  destination: string,
  key: Uint8Array,
  additionalData: Uint8Array,
): Promise<void> {
  const fs = await nodeFs();
  const nodeCrypto = await import("node:crypto") as any;
  const streams = await import("node:stream/promises") as any;
  const nativeFs = await import("node:fs") as any;
  const nativeStream = await import("node:stream") as any;
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  await fs.writeFile(destination, concatenate(MAGIC, iv), {
    mode: 0o600,
    flag: "wx",
  });
  await streams.pipeline(
    nativeStream.Readable.from([source]),
    cipher,
    nativeFs.createWriteStream(destination, { flags: "a", mode: 0o600 }),
  );
  await fs.appendFile(destination, cipher.getAuthTag());
}

async function decryptBytes(
  source: string,
  key: Uint8Array,
  additionalData: Uint8Array,
  maximum: number,
): Promise<Uint8Array> {
  const fs = await nodeFs();
  const nodeCrypto = await import("node:crypto") as any;
  const stats = await fs.lstat(source);
  const overhead = MAGIC.byteLength + 12 + 16;
  const plaintextBytes = stats.size - overhead;
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size <= overhead
    || plaintextBytes > maximum
  ) {
    throw new Error("Encrypted backup envelope is invalid.");
  }
  const header = new Uint8Array(MAGIC.byteLength + 12);
  const tag = new Uint8Array(16);
  const handle = await fs.open(source, "r");
  try {
    await readExactly(handle, header, 0);
    await readExactly(handle, tag, stats.size - tag.byteLength);
    if (!bytesEqual(header.subarray(0, MAGIC.byteLength), MAGIC)) {
      throw new Error("Encrypted backup magic is invalid.");
    }
    const decipher = nodeCrypto.createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(MAGIC.byteLength),
    );
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    const output = new Uint8Array(plaintextBytes);
    const input = new Uint8Array(Math.min(64 * 1024, plaintextBytes));
    let inputPosition = header.byteLength;
    let outputPosition = 0;
    while (inputPosition < stats.size - tag.byteLength) {
      const requested = Math.min(
        input.byteLength,
        stats.size - tag.byteLength - inputPosition,
      );
      const result = await handle.read(input, 0, requested, inputPosition);
      if (result.bytesRead <= 0) {
        throw new Error("Encrypted backup envelope ended unexpectedly.");
      }
      const decrypted = new Uint8Array(
        decipher.update(input.subarray(0, result.bytesRead)),
      );
      if (outputPosition + decrypted.byteLength > output.byteLength) {
        throw new Error("Encrypted backup envelope is invalid.");
      }
      output.set(decrypted, outputPosition);
      outputPosition += decrypted.byteLength;
      inputPosition += result.bytesRead;
    }
    const final = new Uint8Array(decipher.final());
    if (outputPosition + final.byteLength !== output.byteLength) {
      throw new Error("Encrypted backup envelope is invalid.");
    }
    output.set(final, outputPosition);
    return output;
  } catch (error) {
    if (error instanceof Error && error.message === "Encrypted backup magic is invalid.") {
      throw error;
    }
    throw new Error(`Backup decryption failed: ${safeError(error)}`);
  } finally {
    await handle.close();
  }
}

async function readExactly(
  handle: { read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> },
  output: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < output.byteLength) {
    const result = await handle.read(
      output,
      offset,
      output.byteLength - offset,
      position + offset,
    );
    if (result.bytesRead <= 0) {
      throw new Error("Encrypted backup envelope ended unexpectedly.");
    }
    offset += result.bytesRead;
  }
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

function backupSnapshotInput(
  value: BackupSnapshotInput,
  maximum: number,
): Required<Omit<BackupSnapshotInput, "sha256">> & { sha256?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Backup snapshot input is required.");
  }
  const allowed = new Set([
    "bytes",
    "sha256",
    "source",
    "reason",
    "databaseRevision",
    "migrationCount",
    "latestMigration",
    "protectedBackupIds",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Backup snapshot input contains an unknown field.");
  }
  if (!(value.bytes instanceof Uint8Array)
    || value.bytes.byteLength < SQLITE_HEADER.byteLength
    || value.bytes.byteLength > maximum) {
    throw new TypeError(`Backup snapshot must contain at most ${maximum} SQLite bytes.`);
  }
  const bytes = new Uint8Array(value.bytes);
  assertSQLiteBytes(bytes);
  const source = bounded(value.source, "backup source", 1, 255);
  if (source.includes("/") || source.includes("\\")) {
    throw new TypeError("Backup source must be a basename.");
  }
  if (value.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new TypeError("Backup snapshot checksum is invalid.");
  }
  const databaseRevision = value.databaseRevision ?? null;
  if (
    databaseRevision !== null
    && (
      !Number.isSafeInteger(databaseRevision)
      || Number(databaseRevision) < 0
    )
  ) {
    throw new TypeError("Backup database revision is invalid.");
  }
  const migrationCount = value.migrationCount ?? 0;
  if (!Number.isSafeInteger(migrationCount) || migrationCount < 0) {
    throw new TypeError("Backup migration count is invalid.");
  }
  const latestMigration = value.latestMigration ?? null;
  if (
    latestMigration !== null
    && (
      typeof latestMigration !== "string"
      || latestMigration.length < 1
      || latestMigration.length > 200
      || latestMigration.includes("\0")
    )
  ) {
    throw new TypeError("Backup latest migration is invalid.");
  }
  return {
    bytes,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
    source,
    reason: bounded(value.reason ?? "remote snapshot", "backup reason", 1, 200),
    databaseRevision,
    migrationCount,
    latestMigration,
    protectedBackupIds: [...protectedBackupIds(value.protectedBackupIds)],
  };
}

function assertSQLiteBytes(value: Uint8Array): void {
  if (
    value.byteLength < SQLITE_HEADER.byteLength
    || SQLITE_HEADER.some((byte, index) => value[index] !== byte)
  ) {
    throw new TypeError("Backup snapshot is not a SQLite database.");
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
    || manifest.createdAt <= 0
    || !Number.isSafeInteger(manifest.databaseBytes)
    || manifest.databaseBytes <= 0
    || !/^[a-f0-9]{64}$/u.test(manifest.databaseSha256)
    || (
      manifest.databaseRevision !== null
      && (!Number.isSafeInteger(manifest.databaseRevision) || manifest.databaseRevision < 0)
    )
    || !Number.isSafeInteger(manifest.migrationCount)
    || manifest.migrationCount < 0
    || (
      manifest.latestMigration !== null
      && (
        typeof manifest.latestMigration !== "string"
        || manifest.latestMigration.length < 1
        || manifest.latestMigration.length > 200
        || manifest.latestMigration.includes("\0")
      )
    )
    || typeof manifest.source !== "string"
    || manifest.source.length < 1
    || manifest.source.length > 255
    || manifest.source.includes("/")
    || manifest.source.includes("\\")
    || manifest.source.includes("\0")
    || typeof manifest.reason !== "string"
    || manifest.reason.length < 1
    || manifest.reason.length > 200
    || manifest.reason.includes("\0")
    || manifest.encryption?.algorithm !== "AES-256-GCM"
    || typeof manifest.encryption.keyId !== "string"
    || !/^[A-Za-z0-9_.-]+$/u.test(manifest.encryption.keyId)
    || manifest.encryption.keyId.length > 100
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

function protectedBackupIds(value: readonly string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError("protectedBackupIds must contain at most 100 backup IDs.");
  }
  const ids = new Set<string>();
  for (const id of value) ids.add(backupId(id));
  return ids;
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
