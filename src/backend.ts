import { batch, signal, type Cleanup, type ReactiveSignal } from "./core.ts";
import {
  ValidationError,
  s,
  type InferSchema,
  type InferSchemaShape,
  type DocumentId,
  type Schema,
  type SchemaShape,
} from "./ai.ts";
import {
  AuthError,
  createAuthClient,
  openAuth,
  type AuthClient,
  type AuthDefinition,
  type AuthRequest,
  type AuthRuntime,
  type AuthState,
  type AuthUser,
  type AuthUserId,
  type DefaultAuthProfile,
} from "./auth.ts";
import {
  RequestInputError,
  publicValidationIssues,
  readJsonRequest,
  requestOriginAllowed,
} from "./security.ts";
import {
  SQLITE_INTERNAL,
  type SQLiteInternal,
} from "./sqlite-internal.ts";

/** A nominal document ID. At runtime this is a compact random string. */
export type Id<Table extends string> = DocumentId<Table>;

export type DocumentFor<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> =
  TableValue<Schema["tables"][Name]> & {
    _id: Id<Name>;
    _creationTime: number;
    _version: number;
  } & (TableOwned<Schema["tables"][Name]> extends true ? { _ownerId: string } : {});

type IndexMap<Value extends object> = Record<string, readonly (keyof Value & string)[]>;
const FINALIZE_TABLE = Symbol("clank.finalize-table");

export interface TableDefinition<
  Value extends object,
  Indexes extends IndexMap<Value> = {},
  Owned extends boolean = false,
> {
  readonly fields: SchemaShape;
  readonly schema: Schema<Value>;
  readonly indexes: Readonly<Record<string, readonly string[]>>;
  readonly ownership: Owned extends true ? "user" : "public";
  index<
    const Name extends string,
    const Fields extends readonly (keyof Value & string)[],
  >(name: Name, fields: Fields): TableDefinition<Value, Indexes & Record<Name, Fields>, Owned>;
  owned(): TableDefinition<Value, Indexes, true>;
}

export function defineTable<const Fields extends SchemaShape>(fields: Fields): TableDefinition<InferSchemaShape<Fields>> {
  validateFieldNames(fields);
  const safeFields = Object.freeze({ ...fields }) as Fields;
  const indexes: Record<string, readonly string[]> = {};
  let owned = false;
  let finalized = false;
  const definition = {
    fields: safeFields,
    schema: s.object(safeFields),
    indexes,
    get ownership() { return owned ? "user" : "public"; },
    index(name, indexFields) {
      if (finalized) throw new TypeError("Table definitions cannot change after defineDatabase().");
      assertIdentifier(name, "index");
      if (name in indexes) throw new TypeError(`Duplicate index: ${name}`);
      if (indexFields.length === 0) throw new TypeError(`Index ${name} must contain at least one field.`);
      for (const field of indexFields) {
        if (!(field in safeFields)) throw new TypeError(`Unknown field ${String(field)} in index ${name}.`);
      }
      indexes[name] = Object.freeze([...indexFields]);
      return definition as any;
    },
    owned() {
      if (finalized) throw new TypeError("Table definitions cannot change after defineDatabase().");
      owned = true;
      return definition as any;
    },
    [FINALIZE_TABLE]() {
      if (finalized) return;
      finalized = true;
      Object.freeze(indexes);
      Object.freeze(definition);
    },
  } as TableDefinition<InferSchemaShape<Fields>> & { [FINALIZE_TABLE](): void };
  return definition;
}

export interface DatabaseSchema<Tables extends Record<string, TableDefinition<any, any, any>>> {
  readonly tables: Tables;
}

export function defineDatabase<const Tables extends Record<string, TableDefinition<any, any, any>>>(tables: Tables): DatabaseSchema<Tables> {
  const safeTables = { ...tables };
  for (const [name, table] of Object.entries(safeTables)) {
    assertIdentifier(name, "table");
    if (RESERVED_TABLE_NAMES.has(name) || name.startsWith("platform_")) {
      throw new TypeError(`Table name ${name} is reserved for Clank internals.`);
    }
    const finalize = (table as TableDefinition<any, any, any> & { [FINALIZE_TABLE]?: () => void })[FINALIZE_TABLE];
    if (!finalize) throw new TypeError(`Invalid table definition: ${name}`);
    finalize.call(table);
  }
  return Object.freeze({ tables: Object.freeze(safeTables) }) as DatabaseSchema<Tables>;
}

const RESERVED_TABLE_NAMES = new Set([
  "meta",
  "changes",
  "migrations",
  "auth_users",
  "auth_sessions",
]);

export type TableName<Schema extends DatabaseSchema<any>> = keyof Schema["tables"] & string;
export type TableValue<Table> = Table extends TableDefinition<infer Value, any, any> ? Value : never;
export type TableIndexes<Table> = Table extends TableDefinition<any, infer Indexes, any> ? Indexes : never;
export type TableOwned<Table> = Table extends TableDefinition<any, any, infer Owned> ? Owned : false;

export type Comparison = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
type QueryField<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> = keyof DocumentFor<Schema, Name> & string;

export interface QueryBuilder<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> {
  where<Field extends QueryField<Schema, Name>>(field: Field, value: DocumentFor<Schema, Name>[Field]): QueryBuilder<Schema, Name>;
  where<Field extends QueryField<Schema, Name>>(field: Field, comparison: Comparison, value: DocumentFor<Schema, Name>[Field]): QueryBuilder<Schema, Name>;
  orderBy<Field extends QueryField<Schema, Name>>(field: Field, direction?: "asc" | "desc"): QueryBuilder<Schema, Name>;
  limit(count: number): QueryBuilder<Schema, Name>;
  collect(): Array<DocumentFor<Schema, Name>>;
  first(): DocumentFor<Schema, Name> | null;
}

export interface ReadTable<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> {
  get(id: Id<Name>): DocumentFor<Schema, Name> | null;
  query(): QueryBuilder<Schema, Name>;
  collect(): Array<DocumentFor<Schema, Name>>;
}

export interface WriteTable<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>> extends ReadTable<Schema, Name> {
  insert(value: TableValue<Schema["tables"][Name]>): Id<Name>;
  patch(
    id: Id<Name>,
    value: Partial<TableValue<Schema["tables"][Name]>>,
    options?: DocumentWriteOptions,
  ): DocumentFor<Schema, Name> | null;
  replace(
    id: Id<Name>,
    value: TableValue<Schema["tables"][Name]>,
    options?: DocumentWriteOptions,
  ): DocumentFor<Schema, Name> | null;
  delete(id: Id<Name>, options?: DocumentWriteOptions): boolean;
}

export interface DocumentWriteOptions {
  /** Reject the write unless the stored document has this exact version. */
  ifVersion?: number;
}

export class DatabaseConflictError extends Error {
  readonly name = "DatabaseConflictError";
  readonly code = "VERSION_CONFLICT";
  readonly status = 409;

  constructor(
    readonly table: string,
    readonly id: string,
    readonly expectedVersion: number | null,
    readonly actualVersion: number | null,
  ) {
    super(expectedVersion === null
      ? `${table}/${id} was created by another writer.`
      : actualVersion === null
        ? `${table}/${id} no longer exists.`
        : `${table}/${id} changed from version ${expectedVersion} to ${actualVersion}.`);
  }
}

export interface ReadDatabase<Schema extends DatabaseSchema<any>> {
  table<Name extends TableName<Schema>>(name: Name): ReadTable<Schema, Name>;
}

export interface WriteDatabase<Schema extends DatabaseSchema<any>> extends ReadDatabase<Schema> {
  table<Name extends TableName<Schema>>(name: Name): WriteTable<Schema, Name>;
}

export interface DatabaseChangeRecord {
  readonly table: string;
  readonly id: string;
  readonly ownerId?: string | null;
}

export interface DatabaseChange {
  readonly version: number;
  readonly records: readonly DatabaseChangeRecord[];
  readonly tables: ReadonlySet<string>;
  readonly ids: ReadonlyMap<string, ReadonlySet<string>>;
  readonly all?: boolean;
}

interface ReadDependency {
  table: string;
  id?: string;
  ownerId?: string | null;
}

export interface TrackedResult<Value> {
  value: Value;
  dependencies: readonly ReadDependency[];
  version: number;
}

interface StatementLike {
  all(...parameters: any[]): Array<Record<string, unknown>>;
  get(...parameters: any[]): Record<string, unknown> | undefined;
  run(...parameters: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
  enableLoadExtension?(allow: boolean): void;
}

interface DatabaseSyncConstructor {
  new(path: string): DatabaseSyncLike;
}

export interface SQLiteOptions {
  path?: string;
  wal?: boolean;
  busyTimeout?: number;
  durability?: "full" | "normal";
  integrityCheck?: "quick" | "full" | false;
  changePollIntervalMs?: number;
  changeRetentionRevisions?: number;
  onError?: (error: unknown) => void;
}

export interface SQLiteDatabase<Schema extends DatabaseSchema<any>> {
  readonly schema: Schema;
  readonly version: number;
  read<Value>(handler: (db: ReadDatabase<Schema>) => Value, scope?: DatabaseScope): Value;
  tracked<Value>(handler: (db: ReadDatabase<Schema>) => Value, scope?: DatabaseScope): TrackedResult<Value>;
  transaction<Value>(handler: (db: WriteDatabase<Schema>) => Value, scope?: DatabaseScope): Value;
  subscribe(listener: (change: DatabaseChange) => void): Cleanup;
  close(): void;
  /** @internal Used by Clank's own zero-dependency services. */
  readonly [SQLITE_INTERNAL]: SQLiteInternal;
}

export interface DatabaseScope {
  /** `undefined` is trusted/unscoped server access; `null` is anonymous access. */
  userId?: string | null;
}

export async function openSQLite<Schema extends DatabaseSchema<any>>(
  schema: Schema,
  options: SQLiteOptions = {},
): Promise<SQLiteDatabase<Schema>> {
  const moduleName = "node:sqlite";
  const sqlite = await import(moduleName) as unknown as { DatabaseSync: DatabaseSyncConstructor };
  const path = await prepareSQLitePath(options.path ?? ":memory:");
  const native = new sqlite.DatabaseSync(path);
  let database: SQLiteDatabase<Schema> | undefined;
  try {
    database = createSQLiteDatabase(schema, native, { ...options, path });
    if (path !== ":memory:") await hardenSQLiteFiles(path);
    return database;
  } catch (error) {
    if (database) database.close();
    else native.close();
    throw error;
  }
}

/** Accepts a compatible SQLite connection; useful for alternate runtimes and deterministic tests. */
export function createSQLiteDatabase<Schema extends DatabaseSchema<any>>(
  schema: Schema,
  native: DatabaseSyncLike,
  options: SQLiteOptions = {},
): SQLiteDatabase<Schema> {
  const path = options.path ?? ":memory:";
  const busyTimeout = nonNegativeInteger(options.busyTimeout ?? 5_000, "busyTimeout");
  const pollInterval = path === ":memory:"
    ? 0
    : nonNegativeInteger(options.changePollIntervalMs ?? 100, "changePollIntervalMs");
  const retention = positiveIntegerOption(
    options.changeRetentionRevisions ?? 10_000,
    "changeRetentionRevisions",
  );
  const reportError = (error: unknown) => {
    try { options.onError?.(error); } catch { /* Error reporting must never change database behavior. */ }
  };

  native.enableLoadExtension?.(false);
  native.exec("PRAGMA foreign_keys = ON");
  native.exec("PRAGMA trusted_schema = OFF");
  native.exec("PRAGMA recursive_triggers = OFF");
  native.exec("PRAGMA secure_delete = FAST");
  native.exec("PRAGMA temp_store = MEMORY");
  native.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  if (options.wal !== false && path !== ":memory:") {
    native.exec("PRAGMA journal_mode = WAL");
    native.exec(`PRAGMA synchronous = ${(options.durability ?? "full") === "full" ? "FULL" : "NORMAL"}`);
    native.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  migrateLegacyTable(native, "proact_meta", "clank_meta");
  native.exec(`CREATE TABLE IF NOT EXISTS clank_meta (
    _key TEXT PRIMARY KEY,
    _value INTEGER NOT NULL
  )`);
  native.prepare("INSERT OR IGNORE INTO clank_meta (_key, _value) VALUES ('global_version', 0)").run();
  native.exec(`CREATE TABLE IF NOT EXISTS clank_changes (
    revision INTEGER NOT NULL CHECK (revision > 0),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    table_name TEXT NOT NULL CHECK (length(table_name) > 0),
    document_id TEXT NOT NULL CHECK (length(document_id) > 0),
    owner_id TEXT CHECK (owner_id IS NULL OR length(owner_id) > 0),
    PRIMARY KEY (revision, sequence)
  ) WITHOUT ROWID`);

  const statements = new Map<string, StatementLike>();
  const prepared = (sql: string): StatementLike => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = native.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  for (const [name, table] of Object.entries(schema.tables) as Array<[string, TableDefinition<any, any, any>]>) {
    const sqlTable = tableIdentifier(name);
    migrateLegacyTable(native, `proact_${name}`, `clank_${name}`);
    native.exec(`CREATE TABLE IF NOT EXISTS ${sqlTable} (
      _id TEXT PRIMARY KEY,
      _owner_id TEXT,
      _creation_time INTEGER NOT NULL,
      _version INTEGER NOT NULL,
      _data TEXT NOT NULL CHECK (json_valid(_data))
    )`);
    const columns = native.prepare(`PRAGMA table_info(${sqlTable})`).all();
    if (!columns.some((column) => column.name === "_owner_id")) {
      native.exec(`ALTER TABLE ${sqlTable} ADD COLUMN _owner_id TEXT`);
    }
    if (table.ownership === "user") {
      native.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(`proact_${name}_owner`)}`);
      native.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`clank_${name}_owner`)} ON ${sqlTable} (_owner_id)`);
    }
    for (const [indexName, fields] of Object.entries(table.indexes)) {
      const expressions = fields.map((field) => jsonExpression(field)).join(", ");
      native.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(`proact_${name}_${indexName}`)}`);
      native.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`clank_${name}_${indexName}`)} ON ${sqlTable} (${expressions})`);
    }
    const rows = prepared(`SELECT _id, _owner_id, _creation_time, _version, _data FROM ${sqlTable}`).all();
    for (const row of rows) {
      table.schema.parse(parseStoredData(row._data));
      if (table.ownership === "user" && typeof row._owner_id !== "string") {
        throw new Error(`Owned table ${name} contains an unowned document (${String(row._id)}). Assign an owner before enabling .owned().`);
      }
    }
  }

  assertDatabaseIntegrity(native, options.integrityCheck ?? "quick");

  let version = readGlobalRevision(prepared);
  assertChangeJournalIntegrity(prepared, version);
  let closed = false;
  let transactionActive = false;
  let readActive = false;
  let synchronizing = false;
  const listeners = new Set<(change: DatabaseChange) => void>();
  let poller: ReturnType<typeof setInterval> | undefined;

  const ensureOpen = () => {
    if (closed) throw new Error("SQLite database is closed.");
  };

  const publish = (change: DatabaseChange) => {
    version = change.version;
    for (const listener of [...listeners]) {
      try { listener(change); } catch (error) { reportError(error); }
    }
  };

  const synchronizeChanges = (through?: number, strict = true) => {
    if (closed || transactionActive || readActive || synchronizing) return;
    synchronizing = true;
    try {
      const target = through ?? readGlobalRevision(prepared);
      if (target < version) {
        throw new Error(`SQLite global revision moved backwards from ${version} to ${target}.`);
      }
      if (target === version) return;
      const rows = prepared(`SELECT revision, sequence, table_name, document_id, owner_id
        FROM clank_changes
        WHERE revision > ? AND revision <= ?
        ORDER BY revision, sequence`).all(version, target);
      const records: DatabaseChangeRecord[] = [];
      let expectedRevision = version + 1;
      let observedRevision = version;
      let fullInvalidation = false;
      for (const row of rows) {
        const revision = safeRevision(row.revision, "change revision");
        if (revision < observedRevision) throw new Error("SQLite change journal is not ordered.");
        if (revision > observedRevision) {
          if (revision !== expectedRevision) fullInvalidation = true;
          observedRevision = revision;
          expectedRevision = revision + 1;
        }
        records.push(Object.freeze({
          table: String(row.table_name),
          id: String(row.document_id),
          ...(row.owner_id === null || row.owner_id === undefined
            ? {}
            : { ownerId: String(row.owner_id) }),
        }));
      }
      if (observedRevision !== target) fullInvalidation = true;
      publish(databaseChange(target, records, fullInvalidation));
    } catch (error) {
      if (strict) throw error;
      reportError(error);
      try {
        const target = through ?? readGlobalRevision(prepared);
        if (target > version) publish(databaseChange(target, [], true));
      } catch (fallbackError) {
        reportError(fallbackError);
      }
    } finally {
      synchronizing = false;
    }
  };

  const executeQuery = <Name extends TableName<Schema>>(
    name: Name,
    conditions: QueryCondition[],
    order: QueryOrder | undefined,
    count: number | undefined,
    ownerId?: string | null,
  ): Array<DocumentFor<Schema, Name>> => {
    ensureOpen();
    const parameters: unknown[] = [];
    const clauses: string[] = [];
    const definition = tableDefinition(schema, name);
    if (definition.ownership === "user") {
      if (ownerId === null) throw new Error(`Owned table ${name} requires an authenticated user.`);
      if (ownerId !== undefined) {
        clauses.push("_owner_id = ?");
        parameters.push(ownerId);
      }
    }
    clauses.push(...conditions.map((condition) => {
      const expression = fieldExpression(condition.field);
      const operator = comparisonOperator(condition.comparison);
      if (condition.value === null && (condition.comparison === "eq" || condition.comparison === "neq")) {
        return `${expression} IS ${condition.comparison === "neq" ? "NOT " : ""}NULL`;
      }
      parameters.push(toSQLiteValue(condition.value));
      return `${expression} ${operator} ?`;
    }));
    const orderSql = order
      ? ` ORDER BY ${fieldExpression(order.field)} ${order.direction.toUpperCase()}`
      : " ORDER BY _creation_time ASC, _id ASC";
    const limitSql = count === undefined ? "" : ` LIMIT ${validateLimit(count)}`;
    const sql = `SELECT _id, _owner_id, _creation_time, _version, _data FROM ${tableIdentifier(name)}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}${orderSql}${limitSql}`;
    return prepared(sql).all(...parameters).map((row) => decodeDocument<Schema, Name>(schema, name, row));
  };

  const getDocument = <Name extends TableName<Schema>>(name: Name, id: Id<Name>, ownerId?: string | null): DocumentFor<Schema, Name> | null => {
    ensureOpen();
    const definition = tableDefinition(schema, name);
    if (definition.ownership === "user" && ownerId === null) throw new Error(`Owned table ${name} requires an authenticated user.`);
    const scoped = definition.ownership === "user" && ownerId !== undefined;
    const row = prepared(`SELECT _id, _owner_id, _creation_time, _version, _data FROM ${tableIdentifier(name)} WHERE _id = ?${scoped ? " AND _owner_id = ?" : ""}`)
      .get(...(scoped ? [id, ownerId] : [id]));
    return row ? decodeDocument(schema, name, row) : null;
  };

  const makeReader = (dependencies?: Map<string, ReadDependency>, ownerId?: string | null): ReadDatabase<Schema> => ({
    table<Name extends TableName<Schema>>(name: Name): ReadTable<Schema, Name> {
      const definition = tableDefinition(schema, name);
      const dependencyOwner = definition.ownership === "user" ? ownerId : undefined;
      const trackTable = () => dependencies?.set(
        `${name}:*:${dependencyOwner ?? "*"}`,
        { table: name, ...(dependencyOwner === undefined ? {} : { ownerId: dependencyOwner }) },
      );
      return {
        get(id) {
          dependencies?.set(
            `${name}:${id}:${dependencyOwner ?? "*"}`,
            { table: name, id, ...(dependencyOwner === undefined ? {} : { ownerId: dependencyOwner }) },
          );
          return getDocument(name, id, ownerId);
        },
        query() {
          trackTable();
          return makeQueryBuilder(schema, name, (table, conditions, order, count) => executeQuery(table, conditions, order, count, ownerId));
        },
        collect() {
          trackTable();
          return executeQuery(name, [], undefined, undefined, ownerId);
        },
      };
    },
  });

  const changesForTransaction = () => ({
    records: new Map<string, DatabaseChangeRecord>(),
  });

  const recordChange = (
    changes: ReturnType<typeof changesForTransaction>,
    table: string,
    id: string,
    ownerId?: string | null,
  ) => {
    if (!table || !id) throw new TypeError("Database changes require a table and document ID.");
    if (ownerId !== undefined && ownerId !== null && !ownerId) {
      throw new TypeError("Database change owner IDs cannot be empty.");
    }
    const record = Object.freeze({
      table,
      id,
      ...(ownerId === undefined || ownerId === null ? {} : { ownerId }),
    });
    changes.records.set(`${table}\n${id}`, record);
  };

  const makeWriter = (changes: ReturnType<typeof changesForTransaction>, ownerId?: string | null): WriteDatabase<Schema> => ({
    table<Name extends TableName<Schema>>(name: Name): WriteTable<Schema, Name> {
      const definition = tableDefinition(schema, name);
      const reader = makeReader(undefined, ownerId).table(name);
      return {
        ...reader,
        insert(raw) {
          const value = definition.schema.parse(raw) as TableValue<Schema["tables"][Name]>;
          if (definition.ownership === "user" && (ownerId === null || ownerId === undefined)) {
            throw new Error(`Owned table ${name} requires an authenticated user for inserts.`);
          }
          let id: Id<Name> | undefined;
          const now = Date.now();
          const storedOwner = definition.ownership === "user" ? ownerId : undefined;
          const insert = prepared(`INSERT OR IGNORE INTO ${tableIdentifier(name)}
            (_id, _owner_id, _creation_time, _version, _data) VALUES (?, ?, ?, 1, ?)`);
          for (let attempt = 0; attempt < 4 && !id; attempt++) {
            const candidate = createId<Name>();
            const result = insert.run(candidate, storedOwner ?? null, now, stringifyStoredData(value));
            if (Number(result.changes) === 1) id = candidate;
          }
          if (!id) throw new Error(`Could not allocate a unique ID for ${name}.`);
          recordChange(changes, name, id, storedOwner);
          return id;
        },
        patch(id, patch, writeOptions = {}) {
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("patch() expects an object.");
          for (const key of Object.keys(patch)) if (!(key in definition.fields)) throw new TypeError(`Unknown field in patch: ${key}`);
          const previous = getDocument(name, id, ownerId);
          const expected = validatedExpectedVersion(writeOptions.ifVersion);
          if (expected !== undefined && previous?._version !== expected) {
            throw new DatabaseConflictError(name, id, expected, previous?._version ?? null);
          }
          if (!previous) return null;
          const value = definition.schema.parse({ ...documentValue(previous), ...patch });
          if (stringifyStoredData(value) === stringifyStoredData(documentValue(previous))) return previous;
          const nextVersion = nextDocumentVersion(previous._version);
          const storedOwner = definition.ownership === "user"
            ? (previous as DocumentFor<Schema, Name> & { _ownerId: string })._ownerId
            : undefined;
          const result = prepared(`UPDATE ${tableIdentifier(name)}
            SET _version = ?, _data = ?
            WHERE _id = ? AND _version = ?${storedOwner === undefined ? "" : " AND _owner_id = ?"}`)
            .run(nextVersion, stringifyStoredData(value), id, previous._version, ...(storedOwner === undefined ? [] : [storedOwner]));
          if (Number(result.changes) !== 1) {
            const actual = getDocument(name, id, ownerId);
            throw new DatabaseConflictError(name, id, previous._version, actual?._version ?? null);
          }
          recordChange(changes, name, id, storedOwner);
          return documentWithMetadata(schema, name, value, id, previous._creationTime, nextVersion, storedOwner);
        },
        replace(id, raw, writeOptions = {}) {
          const previous = getDocument(name, id, ownerId);
          const expected = validatedExpectedVersion(writeOptions.ifVersion);
          if (expected !== undefined && previous?._version !== expected) {
            throw new DatabaseConflictError(name, id, expected, previous?._version ?? null);
          }
          if (!previous) return null;
          const value = definition.schema.parse(raw);
          if (stringifyStoredData(value) === stringifyStoredData(documentValue(previous))) return previous;
          const nextVersion = nextDocumentVersion(previous._version);
          const storedOwner = definition.ownership === "user"
            ? (previous as DocumentFor<Schema, Name> & { _ownerId: string })._ownerId
            : undefined;
          const result = prepared(`UPDATE ${tableIdentifier(name)}
            SET _version = ?, _data = ?
            WHERE _id = ? AND _version = ?${storedOwner === undefined ? "" : " AND _owner_id = ?"}`)
            .run(nextVersion, stringifyStoredData(value), id, previous._version, ...(storedOwner === undefined ? [] : [storedOwner]));
          if (Number(result.changes) !== 1) {
            const actual = getDocument(name, id, ownerId);
            throw new DatabaseConflictError(name, id, previous._version, actual?._version ?? null);
          }
          recordChange(changes, name, id, storedOwner);
          return documentWithMetadata(schema, name, value, id, previous._creationTime, nextVersion, storedOwner);
        },
        delete(id, writeOptions = {}) {
          const previous = getDocument(name, id, ownerId);
          const expected = validatedExpectedVersion(writeOptions.ifVersion);
          if (expected !== undefined && previous?._version !== expected) {
            throw new DatabaseConflictError(name, id, expected, previous?._version ?? null);
          }
          if (!previous) return false;
          const storedOwner = definition.ownership === "user"
            ? (previous as DocumentFor<Schema, Name> & { _ownerId: string })._ownerId
            : undefined;
          const result = prepared(`DELETE FROM ${tableIdentifier(name)}
            WHERE _id = ? AND _version = ?${storedOwner === undefined ? "" : " AND _owner_id = ?"}`)
            .run(id, previous._version, ...(storedOwner === undefined ? [] : [storedOwner]));
          const changed = Number(result.changes) > 0;
          if (!changed) {
            const actual = getDocument(name, id, ownerId);
            throw new DatabaseConflictError(name, id, previous._version, actual?._version ?? null);
          }
          recordChange(changes, name, id, storedOwner);
          return changed;
        },
      };
    },
  });

  const runTransaction = <Value>(
    handler: (changes: ReturnType<typeof changesForTransaction>) => Value,
  ): Value => {
    ensureOpen();
    if (transactionActive || readActive) {
      throw new Error("Nested database transactions are not supported; call helpers with the current database context.");
    }
    synchronizeChanges(undefined, true);
    transactionActive = true;
    const changes = changesForTransaction();
    let value!: Value;
    let committedVersion: number | undefined;
    native.exec("BEGIN IMMEDIATE");
    try {
      value = handler(changes);
      assertSynchronous(value, "mutation");
      if (changes.records.size > 0) {
        prepared("UPDATE clank_meta SET _value = _value + 1 WHERE _key = 'global_version'").run();
        committedVersion = readGlobalRevision(prepared);
        const insertChange = prepared(`INSERT INTO clank_changes
          (revision, sequence, table_name, document_id, owner_id)
          VALUES (?, ?, ?, ?, ?)`);
        let sequence = 0;
        for (const record of changes.records.values()) {
          insertChange.run(
            committedVersion,
            sequence++,
            record.table,
            record.id,
            record.ownerId ?? null,
          );
        }
        prepared("DELETE FROM clank_changes WHERE revision < ?")
          .run(Math.max(1, committedVersion - retention + 1));
      }
      native.exec("COMMIT");
    } catch (error) {
      try { native.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    } finally {
      transactionActive = false;
    }
    if (committedVersion !== undefined) synchronizeChanges(committedVersion, false);
    return value;
  };

  const runReadSnapshot = <Value>(handler: () => Value): { value: Value; version: number } => {
    ensureOpen();
    if (transactionActive || readActive) {
      throw new Error("Nested database reads are not supported; call helpers with the current database context.");
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      synchronizeChanges(undefined, true);
      readActive = true;
      native.exec("BEGIN DEFERRED");
      try {
        const snapshotVersion = readGlobalRevision(prepared);
        if (snapshotVersion !== version) {
          native.exec("ROLLBACK");
          readActive = false;
          synchronizeChanges(snapshotVersion, true);
          continue;
        }
        const value = handler();
        assertSynchronous(value, "query");
        native.exec("COMMIT");
        return { value, version: snapshotVersion };
      } catch (error) {
        try { native.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
        throw error;
      } finally {
        readActive = false;
      }
    }
    throw new Error("Could not establish a stable SQLite read snapshot.");
  };

  const database: SQLiteDatabase<Schema> = {
    schema,
    get version() {
      synchronizeChanges(undefined, true);
      return version;
    },
    read(handler, scope) {
      return runReadSnapshot(() => handler(makeReader(undefined, scope?.userId))).value;
    },
    tracked(handler, scope) {
      const dependencies = new Map<string, ReadDependency>();
      const result = runReadSnapshot(() => handler(makeReader(dependencies, scope?.userId)));
      return { value: result.value, dependencies: [...dependencies.values()], version: result.version };
    },
    transaction(handler, scope) {
      return runTransaction((changes) => handler(makeWriter(changes, scope?.userId)));
    },
    subscribe(listener) {
      ensureOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      if (poller) clearInterval(poller);
      listeners.clear();
      statements.clear();
      native.close();
    },
    [SQLITE_INTERNAL]: {
      exec(sql) {
        ensureOpen();
        native.exec(sql);
      },
      prepare: prepared,
      transaction(handler) {
        return runTransaction((changes) => handler({
          record(table, id, ownerId) { recordChange(changes, table, id, ownerId); },
        }));
      },
    },
  };
  if (pollInterval > 0) {
    poller = setInterval(() => synchronizeChanges(undefined, false), pollInterval);
    (poller as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  }
  return database;
}

interface QueryCondition {
  field: string;
  comparison: Comparison;
  value: unknown;
}

interface QueryOrder {
  field: string;
  direction: "asc" | "desc";
}

function makeQueryBuilder<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>>(
  schema: Schema,
  name: Name,
  execute: (name: Name, conditions: QueryCondition[], order: QueryOrder | undefined, count: number | undefined) => Array<DocumentFor<Schema, Name>>,
  conditions: QueryCondition[] = [],
  order?: QueryOrder,
  count?: number,
): QueryBuilder<Schema, Name> {
  const next = (nextConditions = conditions, nextOrder = order, nextCount = count) =>
    makeQueryBuilder(schema, name, execute, nextConditions, nextOrder, nextCount);
  return {
    where(field: string, comparisonOrValue: unknown, maybeValue?: unknown) {
      validateQueryField(schema, name, field);
      const comparison = arguments.length === 2 ? "eq" : comparisonOrValue as Comparison;
      if (!["eq", "neq", "lt", "lte", "gt", "gte"].includes(comparison)) throw new TypeError(`Unknown comparison: ${comparison}`);
      const value = arguments.length === 2 ? comparisonOrValue : maybeValue;
      return next([...conditions, { field, comparison, value }]);
    },
    orderBy(field: string, direction: "asc" | "desc" = "asc") {
      validateQueryField(schema, name, field);
      if (direction !== "asc" && direction !== "desc") throw new TypeError(`Unknown order direction: ${direction}`);
      return next(conditions, { field, direction });
    },
    limit(limit: number) { return next(conditions, order, validateLimit(limit)); },
    collect() { return execute(name, conditions, order, count); },
    first() { return execute(name, conditions, order, 1)[0] ?? null; },
  } as QueryBuilder<Schema, Name>;
}

export type FunctionArgs = Schema<any> | SchemaShape;
export type InferFunctionArgs<Args extends FunctionArgs> = Args extends Schema<any>
  ? InferSchema<Args>
  : Args extends SchemaShape
    ? InferSchemaShape<Args>
    : never;

export interface QueryContext<DB extends DatabaseSchema<any>> {
  db: ReadDatabase<DB>;
}

export interface MutationContext<DB extends DatabaseSchema<any>> {
  db: WriteDatabase<DB>;
}

export type BackendAccess = "public" | "required";
type AuthProfileOf<Auth> = Auth extends AuthDefinition<infer Profile> ? Profile : DefaultAuthProfile;
type DefaultAccessOf<Auth> = Auth extends AuthDefinition<any> ? "required" : "public";

export type BackendContext<
  Kind extends "query" | "mutation",
  DB extends DatabaseSchema<any>,
  Auth extends AuthDefinition<any> | undefined,
  Access extends BackendAccess,
> = (Kind extends "query" ? QueryContext<DB> : MutationContext<DB>)
  & (Auth extends AuthDefinition<any>
    ? {
        auth: AuthRequest<AuthProfileOf<Auth>>;
        user: Access extends "required"
          ? AuthUser<AuthProfileOf<Auth>>
          : AuthUser<AuthProfileOf<Auth>> | null;
      }
    : {});

export interface BackendFunction<
  Kind extends "query" | "mutation",
  Input,
  Output,
  DB extends DatabaseSchema<any>,
  Access extends BackendAccess = "public",
  Auth extends AuthDefinition<any> | undefined = undefined,
> {
  readonly kind: Kind;
  readonly access: Access;
  readonly args: Schema<Input>;
  readonly returns?: Schema<Output>;
  readonly handler: (context: BackendContext<Kind, DB, Auth, Access>, args: Input) => Output;
}

export type AnyBackendFunction = BackendFunction<"query" | "mutation", any, any, any, any, any>;
export type FunctionTree = { readonly [key: string]: AnyBackendFunction | FunctionTree };

export interface FunctionBuilders<
  DB extends DatabaseSchema<any>,
  Auth extends AuthDefinition<any> | undefined = undefined,
> {
  query<const Args extends FunctionArgs, Output>(definition: {
    args: Args;
    returns?: Schema<Output>;
    handler: (context: BackendContext<"query", DB, Auth, DefaultAccessOf<Auth>>, args: InferFunctionArgs<Args>) => Output;
  }): BackendFunction<"query", InferFunctionArgs<Args>, Output, DB, DefaultAccessOf<Auth>, Auth>;
  mutation<const Args extends FunctionArgs, Output>(definition: {
    args: Args;
    returns?: Schema<Output>;
    handler: (context: BackendContext<"mutation", DB, Auth, DefaultAccessOf<Auth>>, args: InferFunctionArgs<Args>) => Output;
  }): BackendFunction<"mutation", InferFunctionArgs<Args>, Output, DB, DefaultAccessOf<Auth>, Auth>;
  publicQuery<const Args extends FunctionArgs, Output>(definition: {
    args: Args;
    returns?: Schema<Output>;
    handler: (context: BackendContext<"query", DB, Auth, "public">, args: InferFunctionArgs<Args>) => Output;
  }): BackendFunction<"query", InferFunctionArgs<Args>, Output, DB, "public", Auth>;
  publicMutation<const Args extends FunctionArgs, Output>(definition: {
    args: Args;
    returns?: Schema<Output>;
    handler: (context: BackendContext<"mutation", DB, Auth, "public">, args: InferFunctionArgs<Args>) => Output;
  }): BackendFunction<"mutation", InferFunctionArgs<Args>, Output, DB, "public", Auth>;
}

export interface BackendDefinition<
  Schema extends DatabaseSchema<any>,
  Functions extends FunctionTree,
  Auth extends AuthDefinition<any> | undefined = undefined,
> {
  readonly schema: Schema;
  readonly functions: Functions;
  readonly auth: Auth;
}

export interface BackendBuilder<
  Schema extends DatabaseSchema<any>,
  Auth extends AuthDefinition<any> | undefined = undefined,
> {
  functions<const Functions extends FunctionTree>(
    define: (builders: FunctionBuilders<Schema, Auth>) => Functions,
  ): BackendDefinition<Schema, Functions, Auth>;
}

export function defineBackend<
  Schema extends DatabaseSchema<any>,
  Auth extends AuthDefinition<any> | undefined = undefined,
>(options: { schema: Schema; auth?: Auth }): BackendBuilder<Schema, Auth> {
  const defaultAccess = options.auth ? "required" : "public";
  const builders: FunctionBuilders<Schema, Auth> = {
    query: (definition) => createBackendFunction("query", defaultAccess, definition) as any,
    mutation: (definition) => createBackendFunction("mutation", defaultAccess, definition) as any,
    publicQuery: (definition) => createBackendFunction("query", "public", definition) as any,
    publicMutation: (definition) => createBackendFunction("mutation", "public", definition) as any,
  };
  return {
    functions(define) {
      const functions = define(builders);
      validateFunctionTree(functions);
      return Object.freeze({
        schema: options.schema,
        functions: freezeFunctionTree(functions) as typeof functions,
        auth: options.auth as Auth,
      });
    },
  };
}

function createBackendFunction(kind: "query" | "mutation", access: BackendAccess, definition: {
  args: FunctionArgs;
  returns?: Schema<any>;
  handler: (context: any, args: any) => any;
}): AnyBackendFunction {
  if (typeof definition.handler !== "function") throw new TypeError(`${kind} requires a handler.`);
  return Object.freeze({
    kind,
    access,
    args: toSchema(definition.args),
    returns: definition.returns,
    handler: definition.handler,
  }) as AnyBackendFunction;
}

export interface FunctionReference<Kind extends "query" | "mutation", Input, Output> {
  readonly kind: Kind;
  readonly path: string;
  readonly __input?: Input;
  readonly __output?: Output;
}

export type ApiOf<Tree> = {
  readonly [Key in keyof Tree]: Tree[Key] extends BackendFunction<infer Kind, infer Input, infer Output, any, any, any>
    ? FunctionReference<Kind, Input, Output>
    : Tree[Key] extends object
      ? ApiOf<Tree[Key]>
      : never;
};

const REFERENCE = Symbol.for("clank.function-reference");

export function functionPath(reference: FunctionReference<any, any, any>): string {
  const path = (reference as unknown as Record<PropertyKey, unknown>)[REFERENCE] ?? reference.path;
  if (!path || typeof path !== "string") throw new TypeError("Expected a Clank function reference.");
  return path;
}

/** Creates a zero-codegen typed API proxy. Pass a server function tree as its type argument. */
type FunctionsFrom<Source> = Source extends { readonly functions: infer Functions extends FunctionTree } ? Functions : Source;

export function createApi<Source extends FunctionTree | BackendDefinition<any, any, any>>(): ApiOf<FunctionsFrom<Source>> {
  const reference = (segments: string[]): unknown => new Proxy({}, {
    get(_target, key) {
      if (key === REFERENCE) return segments.join(".");
      if (key === "path") return segments.join(".");
      if (key === "then") return undefined;
      return reference([...segments, String(key)]);
    },
  });
  return reference([]) as ApiOf<FunctionsFrom<Source>>;
}

type InputOf<Reference> = Reference extends FunctionReference<any, infer Input, any> ? Input : never;
type OutputOf<Reference> = Reference extends FunctionReference<any, any, infer Output> ? Output : never;
type InputTuple<Input> = {} extends Input ? [args?: Input] : [args: Input];

export interface LiveQuery<Value> {
  readonly data: ReactiveSignal<Value | undefined>;
  readonly error: ReactiveSignal<unknown>;
  readonly loading: ReactiveSignal<boolean>;
  readonly version: ReactiveSignal<number>;
  dispose(): void;
}

export interface SyncClient {
  query<Reference extends FunctionReference<"query", any, any>>(
    reference: Reference,
    ...args: InputTuple<InputOf<Reference>>
  ): Promise<OutputOf<Reference>>;
  mutate<Reference extends FunctionReference<"mutation", any, any>>(
    reference: Reference,
    ...args: InputTuple<InputOf<Reference>>
  ): Promise<OutputOf<Reference>>;
  live<Reference extends FunctionReference<"query", any, any>>(
    reference: Reference,
    ...args: InputTuple<InputOf<Reference>>
  ): LiveQuery<OutputOf<Reference>>;
  seed<Reference extends FunctionReference<"query", any, any>>(
    reference: Reference,
    args: InputOf<Reference>,
    value: OutputOf<Reference>,
    version?: number,
  ): void;
}

interface EventSourceLike {
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface SyncClientOptions {
  url?: string;
  fetch?: typeof fetch;
  eventSource?: new(url: string, options?: { withCredentials?: boolean }) => EventSourceLike;
  auth?: Pick<AuthClient<any>, "csrfHeader">;
}

export class BackendClientError extends Error {
  readonly name = "BackendClientError";
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

export function createSyncClient(options: SyncClientOptions = {}): SyncClient {
  const base = (options.url ?? "").replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const EventSourceConstructor = options.eventSource ?? (globalThis as unknown as { EventSource?: new(url: string) => EventSourceLike }).EventSource;
  const seeds = new Map<string, { value: unknown; version: number }>();

  const call = async (kind: "query" | "mutation", reference: FunctionReference<any, any, any>, args: unknown) => {
    if (!fetcher) throw new Error("fetch is not available in this runtime.");
    const response = await fetcher(`${base}/__clank/${kind}/${encodeURIComponent(functionPath(reference))}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(kind === "mutation" ? options.auth?.csrfHeader() ?? {} : {}),
      },
      body: JSON.stringify(args ?? {}),
    });
    const payload = await response.json().catch(() => ({ ok: false })) as {
      ok: boolean;
      value?: unknown;
      error?: { code?: string; message?: string };
    };
    if (!response.ok || !payload.ok) {
      throw new BackendClientError(
        payload.error?.code ?? "BACKEND_FAILED",
        payload.error?.message ?? `Clank ${kind} failed with ${response.status}.`,
        response.status,
      );
    }
    return payload.value;
  };

  return {
    query(reference, ...args) { return call("query", reference, args[0] ?? {}) as Promise<any>; },
    mutate(reference, ...args) { return call("mutation", reference, args[0] ?? {}) as Promise<any>; },
    live(reference, ...args) {
      if (!EventSourceConstructor) throw new Error("EventSource is not available in this runtime.");
      const input = args[0] ?? {};
      const key = functionKey(functionPath(reference), input);
      const seeded = seeds.get(key);
      const data = signal<any>(seeded?.value);
      const error = signal<unknown>(undefined);
      const loading = signal(seeded === undefined);
      const version = signal(seeded?.version ?? 0);
      const url = `${base}/__clank/live/${encodeURIComponent(functionPath(reference))}?args=${encodeURIComponent(stableStringify(input))}`;
      const source = new EventSourceConstructor(url, { withCredentials: false });
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { value: unknown; version: number };
          if (!Number.isSafeInteger(payload.version) || payload.version < 0) {
            throw new TypeError("Live query returned an invalid revision.");
          }
          if (payload.version < version.peek()) return;
          batch(() => {
            data.value = payload.value;
            version.value = payload.version;
            error.value = undefined;
            loading.value = false;
          });
        } catch (reason) {
          batch(() => { error.value = reason; loading.value = false; });
        }
      };
      source.onerror = (reason) => { error.value = reason; };
      return { data, error, loading, version, dispose: () => source.close() };
    },
    seed(reference, args, value, seedVersion = 0) {
      seeds.set(functionKey(functionPath(reference), args), { value, version: seedVersion });
    },
  };
}

type AuthDefinitionOf<Source> = Source extends BackendDefinition<any, any, infer Auth> ? Auth : undefined;

export interface ClankClientOptions<Profile extends object = DefaultAuthProfile>
  extends Omit<SyncClientOptions, "auth"> {
  initialAuth?: AuthState<Profile>;
  authPrefix?: string;
  loadAuth?: boolean;
}

export type ClankClient<Source extends BackendDefinition<any, any, AuthDefinition<any>>> = SyncClient & {
  readonly api: ApiOf<FunctionsFrom<Source>>;
  readonly auth: AuthClient<AuthProfileOf<AuthDefinitionOf<Source>>>;
};

/**
 * Creates the complete browser client for a backend definition: typed API
 * references, auth state, CSRF-aware mutations, cache seeding, and live queries.
 */
export function createClient<Source extends BackendDefinition<any, any, AuthDefinition<any>>>(
  options: ClankClientOptions<AuthProfileOf<AuthDefinitionOf<Source>>> = {},
): ClankClient<Source> {
  const auth = createAuthClient({
    url: options.url,
    prefix: options.authPrefix,
    fetch: options.fetch,
    initial: options.initialAuth,
    immediate: options.loadAuth,
  });
  const sync = createSyncClient({
    url: options.url,
    fetch: options.fetch,
    eventSource: options.eventSource,
    auth,
  });
  return Object.assign(sync, {
    api: createApi<Source>(),
    auth,
  }) as ClankClient<Source>;
}

interface CacheEntry {
  path: string;
  args: unknown;
  auth: AuthRequest<any> | null;
  value: unknown;
  dependencies: readonly ReadDependency[];
  version: number;
  dirty: boolean;
}

interface SubscriberEntry {
  path: string;
  args: unknown;
  auth: AuthRequest<any> | null;
  listeners: Set<(value: unknown, version: number) => void>;
}

export interface BackendCaller<Profile extends object = DefaultAuthProfile> {
  readonly auth: AuthRequest<Profile> | null;
  query<Reference extends FunctionReference<"query", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): { value: OutputOf<Reference>; version: number };
  query(path: string, input: unknown): { value: unknown; version: number };
  mutation<Reference extends FunctionReference<"mutation", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): { value: OutputOf<Reference>; version: number };
  mutation(path: string, input: unknown): { value: unknown; version: number };
  subscribe<Reference extends FunctionReference<"query", any, any>>(reference: Reference, args: InputOf<Reference>, listener: (value: OutputOf<Reference>, version: number) => void): Cleanup;
  subscribe(path: string, input: unknown, listener: (value: unknown, version: number) => void): Cleanup;
}

export interface BackendRuntime<
  Schema extends DatabaseSchema<any>,
  Functions extends FunctionTree,
  Auth extends AuthDefinition<any> | undefined = undefined,
> {
  readonly definition: BackendDefinition<Schema, Functions, Auth>;
  readonly database: SQLiteDatabase<Schema>;
  readonly auth: Auth extends AuthDefinition<infer Profile> ? AuthRuntime<Profile> : undefined;
  readonly version: number;
  query<Reference extends FunctionReference<"query", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): { value: OutputOf<Reference>; version: number };
  query(path: string, input: unknown): { value: unknown; version: number };
  mutation<Reference extends FunctionReference<"mutation", any, any>>(reference: Reference, ...args: InputTuple<InputOf<Reference>>): { value: OutputOf<Reference>; version: number };
  mutation(path: string, input: unknown): { value: unknown; version: number };
  subscribe<Reference extends FunctionReference<"query", any, any>>(reference: Reference, args: InputOf<Reference>, listener: (value: OutputOf<Reference>, version: number) => void): Cleanup;
  subscribe(path: string, input: unknown, listener: (value: unknown, version: number) => void): Cleanup;
  caller(request: Request): Promise<BackendCaller<AuthProfileOf<Auth>>>;
  handle(request: Request): Promise<Response>;
  close(): void;
}

export interface OpenBackendOptions extends SQLiteOptions {
  database?: SQLiteDatabase<any>;
  prefix?: string;
  verifyOrigin?: boolean;
  allowedOrigins?: readonly string[];
  heartbeat?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxLiveArgumentBytes?: number;
  maxLivePayloadBytes?: number;
  maxLiveConnections?: number;
  maxCacheEntries?: number;
  exposeErrors?: boolean;
  onError?: (error: unknown) => void;
}

export async function openBackend<
  Schema extends DatabaseSchema<any>,
  Functions extends FunctionTree,
  Auth extends AuthDefinition<any> | undefined = undefined,
>(
  definition: BackendDefinition<Schema, Functions, Auth>,
  options: OpenBackendOptions = {},
): Promise<BackendRuntime<Schema, Functions, Auth>> {
  const heartbeatMs = positiveIntegerOption(options.heartbeat ?? 20_000, "heartbeat");
  const maxRequestBytes = positiveIntegerOption(options.maxRequestBytes ?? 64 * 1024, "maxRequestBytes");
  const maxResponseBytes = positiveIntegerOption(options.maxResponseBytes ?? 4 * 1024 * 1024, "maxResponseBytes");
  const maxLiveArgumentBytes = positiveIntegerOption(options.maxLiveArgumentBytes ?? 8 * 1024, "maxLiveArgumentBytes");
  const maxLivePayloadBytes = positiveIntegerOption(options.maxLivePayloadBytes ?? 4 * 1024 * 1024, "maxLivePayloadBytes");
  const maxLiveConnections = positiveIntegerOption(options.maxLiveConnections ?? 1_000, "maxLiveConnections");
  const maxCacheEntries = positiveIntegerOption(options.maxCacheEntries ?? 1_000, "maxCacheEntries");
  const database = options.database as SQLiteDatabase<Schema> | undefined
    ?? await openSQLite(definition.schema, options);
  let authRuntime: AuthRuntime<AuthProfileOf<Auth>> | undefined;
  try {
    authRuntime = definition.auth
      ? await openAuth(definition.auth, database, { onError: options.onError }) as AuthRuntime<AuthProfileOf<Auth>>
      : undefined;
  } catch (error) {
    if (!options.database) database.close();
    throw error;
  }
  const registry = flattenFunctions(definition.functions);
  const cache = new Map<string, CacheEntry>();
  const subscribers = new Map<string, SubscriberEntry>();
  const liveDisconnects = new Set<Cleanup>();
  const prefix = `/${(options.prefix ?? "__clank").replace(/^\/+|\/+$/g, "")}`;
  let closed = false;
  let liveConnections = 0;
  const reportError = (error: unknown) => {
    try { options.onError?.(error); } catch { /* Observability hooks cannot affect request or commit behavior. */ }
  };

  const ensureOpen = () => {
    if (closed) throw new Error("Backend runtime is closed.");
  };

  const anonymous = definition.auth ? anonymousBackendAuth<AuthProfileOf<Auth>>() : null;
  const partition = (auth: AuthRequest<any> | null) => auth?.session?.id ?? (definition.auth ? "anonymous" : "server");
  const cacheKey = (path: string, args: unknown, auth: AuthRequest<any> | null) =>
    `${partition(auth)}\n${functionKey(path, args)}`;
  const scopeFor = (auth: AuthRequest<any> | null): DatabaseScope | undefined =>
    definition.auth ? { userId: auth?.user?.id ?? null } : undefined;
  const handlerContext = (db: ReadDatabase<Schema> | WriteDatabase<Schema>, auth: AuthRequest<any> | null) =>
    definition.auth ? { db, auth, user: auth?.user ?? null } : { db };

  const authorize = (fn: AnyBackendFunction, auth: AuthRequest<any> | null) => {
    if (fn.access === "required" && !auth?.user) throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401);
  };

  const setCache = (key: string, entry: CacheEntry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value!);
  };

  const invokeQuery = (path: string, input: unknown, auth: AuthRequest<any> | null): { value: unknown; version: number } => {
    ensureOpen();
    const fn = functionAt(registry, path, "query");
    authorize(fn, auth);
    const args = fn.args.parse(input ?? {});
    const key = cacheKey(path, args, auth);
    // Synchronize the persisted change cursor before trusting an in-memory cache.
    // This makes one-shot reads current even when another process committed before
    // the background poll interval elapsed.
    database.version;
    const cached = cache.get(key);
    if (cached && !cached.dirty) {
      cache.delete(key);
      cache.set(key, cached);
      return { value: cached.value, version: cached.version };
    }
    const tracked = database.tracked((db) => fn.handler(handlerContext(db, auth) as any, args), scopeFor(auth));
    assertSynchronous(tracked.value, "query");
    const value = finalizeBackendOutput(fn, tracked.value, maxResponseBytes);
    const dependencies = auth?.user
      ? [...tracked.dependencies, { table: "__auth", id: auth.user.id, ownerId: auth.user.id }]
      : tracked.dependencies;
    setCache(key, { path, args, auth, value, dependencies, version: tracked.version, dirty: false });
    return { value, version: tracked.version };
  };

  const invokeMutation = (path: string, input: unknown, auth: AuthRequest<any> | null): { value: unknown; version: number } => {
    ensureOpen();
    const fn = functionAt(registry, path, "mutation");
    authorize(fn, auth);
    const args = fn.args.parse(input ?? {});
    const value = database.transaction(
      (db) => {
        const output = fn.handler(handlerContext(db, auth) as any, args);
        assertSynchronous(output, "mutation");
        return finalizeBackendOutput(fn, output, maxResponseBytes);
      },
      scopeFor(auth),
    );
    return { value, version: database.version };
  };

  const notify = (key: string) => {
    const subscription = subscribers.get(key);
    if (!subscription) return;
    try {
      const result = invokeQuery(subscription.path, subscription.args, subscription.auth);
      for (const listener of [...subscription.listeners]) {
        try { listener(result.value, result.version); } catch (error) { reportError(error); }
      }
    } catch (error) {
      reportError(error);
    }
  };

  const stopChanges = database.subscribe((change) => {
    if (authRuntime) {
      if (change.all) {
        authRuntime.notifyAllUserChanges();
      } else {
        const affectedUsers = new Set(change.records
          .filter((record) => record.table === "__auth")
          .map((record) => record.ownerId ?? record.id));
        for (const userId of affectedUsers) authRuntime.notifyUserChange(userId as AuthUserId);
      }
    }
    const invalidated = new Set<string>();
    for (const [key, entry] of cache) {
      if (entry.dependencies.some((dependency) => changeAffects(dependency, change))) {
        entry.dirty = true;
        invalidated.add(key);
      }
    }
    for (const key of invalidated) {
      const subscription = subscribers.get(key);
      if (subscription?.auth?.session && (
        change.all
        || change.records.some((record) =>
          record.table === "__auth"
          && (record.ownerId ?? record.id) === subscription.auth?.user?.id
        )
      )) {
        const refreshed = authRuntime?.refreshSession(subscription.auth.session.id);
        if (!refreshed) continue;
        subscription.auth = refreshed;
      }
      notify(key);
    }
  });

  const callerFor = (initialAuth: AuthRequest<any> | null): BackendCaller<any> => {
    let currentAuth = initialAuth;
    const refreshAuth = () => {
      if (authRuntime && currentAuth?.session) {
        currentAuth = authRuntime.refreshSession(currentAuth.session.id) ?? anonymous;
      }
      return currentAuth;
    };
    return {
      get auth() { return refreshAuth(); },
      query(pathOrReference: string | FunctionReference<"query", any, any>, input: unknown = {}) {
        const auth = refreshAuth();
        return invokeQuery(typeof pathOrReference === "string" ? pathOrReference : functionPath(pathOrReference), input, auth);
      },
      mutation(pathOrReference: string | FunctionReference<"mutation", any, any>, input: unknown = {}) {
        const auth = refreshAuth();
        return invokeMutation(typeof pathOrReference === "string" ? pathOrReference : functionPath(pathOrReference), input, auth);
      },
      subscribe(pathOrReference: string | FunctionReference<"query", any, any>, input: unknown, listener: (value: unknown, version: number) => void) {
        const auth = refreshAuth();
      const path = typeof pathOrReference === "string" ? pathOrReference : functionPath(pathOrReference);
      const fn = functionAt(registry, path, "query");
      authorize(fn, auth);
      const args = fn.args.parse(input ?? {});
      const key = cacheKey(path, args, auth);
      let entry = subscribers.get(key);
      if (!entry) {
        entry = { path, args, auth, listeners: new Set() };
        subscribers.set(key, entry);
      }
      entry.listeners.add(listener);
      try {
        const initial = invokeQuery(path, args, auth);
        listener(initial.value, initial.version);
      } catch (error) {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) subscribers.delete(key);
        throw error;
      }
      return () => {
        entry?.listeners.delete(listener);
        if (entry?.listeners.size === 0) subscribers.delete(key);
      };
      },
    } as BackendCaller<any>;
  };

  const runtime: BackendRuntime<Schema, Functions, Auth> = {
    definition,
    database,
    auth: authRuntime as BackendRuntime<Schema, Functions, Auth>["auth"],
    get version() { return database.version; },
    query(pathOrReference: string | FunctionReference<"query", any, any>, input: unknown = {}) {
      return callerFor(anonymous).query(pathOrReference as any, input);
    },
    mutation(pathOrReference: string | FunctionReference<"mutation", any, any>, input: unknown = {}) {
      return callerFor(anonymous).mutation(pathOrReference as any, input);
    },
    subscribe(pathOrReference: string | FunctionReference<"query", any, any>, input: unknown, listener: (value: unknown, version: number) => void) {
      return callerFor(anonymous).subscribe(pathOrReference as any, input, listener);
    },
    async caller(request) {
      ensureOpen();
      const auth = authRuntime ? await authRuntime.resolve(request) : null;
      return callerFor(auth) as BackendCaller<AuthProfileOf<Auth>>;
    },
    async handle(request) {
      ensureOpen();
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) return problem(404, "NOT_FOUND", "Backend endpoint not found.");
      if (authRuntime && (url.pathname === `${prefix}/auth` || url.pathname.startsWith(`${prefix}/auth/`))) {
        return authRuntime.handle(request, `${prefix}/auth`);
      }
      try {
        if (options.verifyOrigin !== false && !requestOriginAllowed(request, { allowedOrigins: options.allowedOrigins })) {
          return problem(403, "ORIGIN_MISMATCH", "Cross-origin backend request rejected.");
        }
        const relative = url.pathname.slice(prefix.length + 1);
        const slash = relative.indexOf("/");
        const operation = slash === -1 ? relative : relative.slice(0, slash);
        let path = "";
        if (slash !== -1) {
          try {
            path = decodeURIComponent(relative.slice(slash + 1));
          } catch {
            throw new RequestInputError(400, "INVALID_PATH", "The backend function path is not valid URL encoding.");
          }
        }
        if (request.method === "GET" && operation === "manifest") {
          return Response.json({
            protocol: "clank-live/1",
            auth: Boolean(authRuntime),
            functions: [...registry].map(([name, fn]) => ({
              name,
              kind: fn.kind,
              access: fn.access,
              args: fn.args.toJSONSchema(),
              ...(fn.returns ? { returns: fn.returns.toJSONSchema() } : {}),
            })),
          });
        }
        const auth = authRuntime ? await authRuntime.resolve(request) : null;
        if (request.method === "POST" && operation === "query") {
          const result = invokeQuery(path, await readJsonRequest(request, maxRequestBytes), auth);
          return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
        }
        if (request.method === "POST" && operation === "mutation") {
          if (authRuntime && auth?.session) await authRuntime.verifyCsrf(request, auth);
          const result = invokeMutation(path, await readJsonRequest(request, maxRequestBytes), auth);
          return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
        }
        if (request.method === "GET" && operation === "live") {
          const encoded = url.searchParams.get("args") ?? "{}";
          if (new TextEncoder().encode(encoded).byteLength > maxLiveArgumentBytes) {
            return problem(414, "ARGUMENTS_TOO_LARGE", "Live query arguments are too large.");
          }
          if (liveConnections >= maxLiveConnections) {
            return problem(503, "LIVE_CAPACITY", "The live-query connection limit has been reached.");
          }
          let input: unknown;
          try {
            input = JSON.parse(encoded);
          } catch {
            throw new RequestInputError(400, "INVALID_ARGUMENTS", "Live query arguments must be valid JSON.");
          }
          const caller = callerFor(auth);
          const fn = functionAt(registry, path, "query");
          authorize(fn, auth);
          invokeQuery(path, input, auth);
          liveConnections++;
          let closeLive: Cleanup | undefined;
          const live = liveResponse(
            caller,
            path,
            input,
            request.signal,
            heartbeatMs,
            maxLivePayloadBytes,
            authRuntime,
            auth,
            reportError,
            () => {
              liveConnections--;
              if (closeLive) liveDisconnects.delete(closeLive);
            },
          );
          closeLive = live.close;
          if (!live.closed()) liveDisconnects.add(closeLive);
          return live.response;
        }
        return problem(404, "NOT_FOUND", "Backend operation not found.");
      } catch (error) {
        if (error instanceof RequestInputError) return problem(error.status, error.code, error.message);
        if (error instanceof ValidationError) return problem(422, "INVALID_INPUT", error.message, publicValidationIssues(error.issues));
        if (error instanceof AuthError) return problem(error.status, error.code, error.message);
        if (error instanceof DatabaseConflictError) {
          return problem(error.status, error.code, error.message, {
            table: error.table,
            id: error.id,
            expectedVersion: error.expectedVersion,
            actualVersion: error.actualVersion,
          });
        }
        if (error instanceof BackendInvocationError) return problem(error.status, error.code, error.message);
        if (error instanceof BackendOutputError) {
          reportError(error.cause);
          return problem(500, "BACKEND_ERROR", "The backend operation failed.");
        }
        reportError(error);
        return problem(500, "BACKEND_ERROR", options.exposeErrors
          ? error instanceof Error ? error.message : String(error)
          : "The backend operation failed.");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const disconnect of [...liveDisconnects]) disconnect();
      liveDisconnects.clear();
      stopChanges();
      subscribers.clear();
      cache.clear();
      authRuntime?.close();
      database.close();
    },
  };
  return runtime;
}

function liveResponse(
  caller: BackendCaller<any>,
  path: string,
  input: unknown,
  requestSignal: AbortSignal,
  heartbeatMs: number,
  maxPayloadBytes: number,
  authRuntime: AuthRuntime<any> | undefined,
  auth: AuthRequest<any> | null,
  reportError: (error: unknown) => void,
  onClose: () => void,
): { response: Response; close: Cleanup; closed(): boolean } {
  const encoder = new TextEncoder();
  let dispose: Cleanup = () => {};
  let disposeSession: Cleanup = () => {};
  let disposeUser: Cleanup = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let active = true;
  let closed = false;
  let disconnect: Cleanup = () => {};
  const finished = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (!active) return;
        active = false;
        dispose();
        disposeSession();
        disposeUser();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
        finished();
      };
      disconnect = close;
      try {
        const subscribed = caller.subscribe(path, input, (value, version) => {
          if (!active) return;
          try {
            const chunk = encoder.encode(`id: ${version}\ndata: ${JSON.stringify({ value, version })}\n\n`);
            if (chunk.byteLength > maxPayloadBytes) {
              throw new RangeError(`Live query payload exceeds ${maxPayloadBytes} bytes.`);
            }
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              close();
              return;
            }
            controller.enqueue(chunk);
          }
          catch (error) {
            reportError(error);
            close();
          }
        });
        dispose = subscribed;
        if (!active) dispose();
        if (authRuntime && auth?.session) {
          disposeSession = authRuntime.subscribeSession(auth.session.id, close);
        }
        if (authRuntime && auth?.user) {
          disposeUser = authRuntime.subscribeUser(auth.user.id, close);
        }
      } catch (error) {
        active = false;
        try { controller.error(error); } finally { finished(); }
        return;
      }
      heartbeat = setInterval(() => {
        try {
          if (!active) return;
          if (authRuntime && auth?.session && !authRuntime.isSessionActive(auth.session.id)) {
            close();
            return;
          }
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            close();
            return;
          }
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch (error) {
          reportError(error);
          close();
        }
      }, Math.max(1000, heartbeatMs));
      requestSignal.addEventListener("abort", close, { once: true });
      if (requestSignal.aborted) close();
    },
    cancel() {
      active = false;
      dispose();
      disposeSession();
      disposeUser();
      if (heartbeat) clearInterval(heartbeat);
      finished();
    },
  });
  return {
    response: new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    }),
    close() { disconnect(); },
    closed() { return closed; },
  };
}

function flattenFunctions(
  tree: FunctionTree,
  prefix: string[] = [],
  output = new Map<string, AnyBackendFunction>(),
  stack = new Set<object>(),
): Map<string, AnyBackendFunction> {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new TypeError(`Backend function namespace ${prefix.join(".") || "<root>"} must be an object.`);
  }
  if (stack.has(tree)) throw new TypeError("Backend function trees cannot contain cycles.");
  stack.add(tree);
  try {
    for (const [key, value] of Object.entries(tree)) {
      assertIdentifier(key, "function segment");
      const path = [...prefix, key];
      if (isBackendFunction(value)) output.set(path.join("."), value);
      else flattenFunctions(value, path, output, stack);
    }
  } finally {
    stack.delete(tree);
  }
  return output;
}

function validateFunctionTree(tree: FunctionTree): void {
  if (!tree || typeof tree !== "object") throw new TypeError("Backend functions must be an object tree.");
  flattenFunctions(tree);
}

function freezeFunctionTree(tree: FunctionTree): FunctionTree {
  return Object.freeze(Object.fromEntries(
    Object.entries(tree).map(([key, value]) => [
      key,
      isBackendFunction(value) ? value : freezeFunctionTree(value),
    ]),
  ));
}

function isBackendFunction(value: AnyBackendFunction | FunctionTree): value is AnyBackendFunction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as AnyBackendFunction;
  return (candidate.kind === "query" || candidate.kind === "mutation")
    && (candidate.access === "public" || candidate.access === "required")
    && typeof candidate.handler === "function"
    && typeof candidate.args?.parse === "function"
    && (candidate.returns === undefined || typeof candidate.returns.parse === "function");
}

function functionAt(registry: Map<string, AnyBackendFunction>, path: string, expected: "query" | "mutation"): AnyBackendFunction {
  const fn = registry.get(path);
  if (!fn) throw new BackendInvocationError("FUNCTION_NOT_FOUND", "Backend function not found.", 404);
  if (fn.kind !== expected) {
    throw new BackendInvocationError("FUNCTION_KIND_MISMATCH", "Backend function does not support this operation.", 405);
  }
  return fn;
}

class BackendInvocationError extends Error {
  readonly name = "BackendInvocationError";
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

class BackendOutputError extends Error {
  readonly name = "BackendOutputError";
  constructor(readonly cause: unknown) {
    super("The backend function returned an invalid result.");
  }
}

function parseBackendOutput(fn: AnyBackendFunction, value: unknown): unknown {
  if (!fn.returns) return value;
  try {
    return fn.returns.parse(value);
  } catch (error) {
    throw new BackendOutputError(error);
  }
}

function finalizeBackendOutput(fn: AnyBackendFunction, value: unknown, maxBytes: number): unknown {
  const parsed = parseBackendOutput(fn, value);
  try {
    assertJsonOutput(parsed, true, new WeakSet());
    const encoded = new TextEncoder().encode(parsed === undefined ? "" : JSON.stringify(parsed));
    if (encoded.byteLength > maxBytes) {
      throw new RangeError(`Backend output exceeds ${maxBytes} bytes.`);
    }
    return immutableSnapshot(parsed);
  } catch (error) {
    if (error instanceof BackendOutputError) throw error;
    throw new BackendOutputError(error);
  }
}

function assertJsonOutput(value: unknown, topLevel: boolean, seen: WeakSet<object>): void {
  if (value === undefined) {
    if (topLevel) return;
    throw new TypeError("Backend output contains undefined.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Backend output numbers must be finite.");
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Backend output contains unsupported ${typeof value} data.`);
  }
  if (seen.has(value)) throw new TypeError("Backend output contains a cycle.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) throw new TypeError("Backend output arrays cannot be sparse.");
        assertJsonOutput(value[index], false, seen);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Backend output objects must be plain JSON objects.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Backend output cannot contain symbol properties.");
    }
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonOutput(entry, false, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function anonymousBackendAuth<Profile extends object>(): AuthRequest<Profile> {
  return {
    user: null,
    session: null,
    requireUser() {
      throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401);
    },
    requireRole() {
      throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401);
    },
  };
}

function toSchema(input: FunctionArgs): Schema<any> {
  return typeof (input as Schema<any>).parse === "function" ? input as Schema<any> : s.object(input as SchemaShape);
}

function changeAffects(dependency: ReadDependency, change: DatabaseChange): boolean {
  if (change.all) return true;
  return change.records.some((record) => {
    if (record.table !== dependency.table) return false;
    if (dependency.ownerId !== undefined && record.ownerId !== dependency.ownerId) return false;
    return dependency.id === undefined || record.id === dependency.id;
  });
}

export function functionKey(path: string, args: unknown): string {
  return `${path}\n${stableStringify(args ?? {})}`;
}

export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") return entry;
    if (seen.has(entry as object)) throw new TypeError("Cannot serialize circular backend arguments.");
    seen.add(entry as object);
    const output = Array.isArray(entry)
      ? entry.map(normalize)
      : Object.fromEntries(Object.keys(entry as Record<string, unknown>).sort().map((key) => [key, normalize((entry as Record<string, unknown>)[key])]));
    seen.delete(entry as object);
    return output;
  };
  return JSON.stringify(normalize(value));
}

function decodeDocument<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>>(
  schema: Schema,
  name: Name,
  row: Record<string, unknown>,
): DocumentFor<Schema, Name> {
  const value = tableDefinition(schema, name).schema.parse(parseStoredData(row._data));
  const id = String(row._id) as Id<Name>;
  const creationTime = safeNonNegativeInteger(row._creation_time, `${name}/${id} creation time`);
  const version = positiveIntegerOption(Number(row._version), `${name}/${id} version`);
  const definition = tableDefinition(schema, name);
  const ownerId = definition.ownership === "user" ? String(row._owner_id ?? "") : undefined;
  if (definition.ownership === "user" && !ownerId) {
    throw new Error(`Owned table ${name} contains an unowned document (${id}).`);
  }
  return documentWithMetadata(schema, name, value, id, creationTime, version, ownerId);
}

function documentWithMetadata<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>>(
  schema: Schema,
  name: Name,
  value: TableValue<Schema["tables"][Name]>,
  id: Id<Name>,
  creationTime: number,
  version: number,
  ownerId?: string,
): DocumentFor<Schema, Name> {
  return immutableSnapshot({
    ...value,
    _id: id,
    _creationTime: creationTime,
    _version: version,
    ...(tableDefinition(schema, name).ownership === "user" ? { _ownerId: ownerId! } : {}),
  }) as DocumentFor<Schema, Name>;
}

function documentValue(document: Record<string, unknown>): Record<string, unknown> {
  const {
    _id: _ignoredId,
    _creationTime: _ignoredCreation,
    _version: _ignoredVersion,
    _ownerId: _ignoredOwner,
    ...value
  } = document;
  return value;
}

function stringifyStoredData(value: unknown): string {
  const output = stableStringify(value);
  if (output === undefined) throw new TypeError("Database values must be JSON serializable.");
  return output;
}

function parseStoredData(value: unknown): unknown {
  if (typeof value !== "string") throw new TypeError("Invalid SQLite document payload.");
  return JSON.parse(value);
}

function databaseChange(
  version: number,
  records: readonly DatabaseChangeRecord[],
  all = false,
): DatabaseChange {
  const tableValues = new Set<string>();
  const idValues = new Map<string, Set<string>>();
  for (const record of records) {
    tableValues.add(record.table);
    let tableIds = idValues.get(record.table);
    if (!tableIds) idValues.set(record.table, tableIds = new Set());
    tableIds.add(record.id);
  }
  const tables = readonlySet(tableValues);
  const ids = readonlyMap([...idValues].map(([table, tableIds]) => [table, readonlySet(tableIds)]));
  return Object.freeze({
    version: safeRevision(version, "database change revision"),
    records: Object.freeze([...records]),
    tables,
    ids,
    ...(all ? { all: true } : {}),
  });
}

function immutableSnapshot<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object) || Object.isFrozen(object)) return value;
  seen.add(object);
  if (Array.isArray(value)) {
    for (const entry of value) immutableSnapshot(entry, seen);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) immutableSnapshot(entry, seen);
  }
  return Object.freeze(value);
}

function readonlySet<Value>(input: Iterable<Value>): ReadonlySet<Value> {
  const values = new Set(input);
  let output: ReadonlySet<Value>;
  output = Object.freeze({
    get size() { return values.size; },
    has(value: Value) { return values.has(value); },
    entries() { return values.entries(); },
    keys() { return values.keys(); },
    values() { return values.values(); },
    forEach(callback: (value: Value, value2: Value, set: ReadonlySet<Value>) => void, thisArg?: unknown) {
      values.forEach((value) => callback.call(thisArg, value, value, output));
    },
    [Symbol.iterator]() { return values[Symbol.iterator](); },
    get [Symbol.toStringTag]() { return "Set"; },
  });
  return output;
}

function readonlyMap<Key, Value>(input: Iterable<readonly [Key, Value]>): ReadonlyMap<Key, Value> {
  const values = new Map(input);
  let output: ReadonlyMap<Key, Value>;
  output = Object.freeze({
    get size() { return values.size; },
    get(key: Key) { return values.get(key); },
    has(key: Key) { return values.has(key); },
    entries() { return values.entries(); },
    keys() { return values.keys(); },
    values() { return values.values(); },
    forEach(callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) {
      values.forEach((value, key) => callback.call(thisArg, value, key, output));
    },
    [Symbol.iterator]() { return values[Symbol.iterator](); },
    get [Symbol.toStringTag]() { return "Map"; },
  });
  return output;
}

function readGlobalRevision(prepared: (sql: string) => StatementLike): number {
  return safeRevision(
    prepared("SELECT _value FROM clank_meta WHERE _key = 'global_version'").get()?._value ?? 0,
    "global database revision",
  );
}

function assertChangeJournalIntegrity(
  prepared: (sql: string) => StatementLike,
  globalRevision: number,
): void {
  const row = prepared(`SELECT
      max(revision) AS max_revision,
      sum(CASE WHEN table_name = '' OR document_id = '' OR owner_id = '' THEN 1 ELSE 0 END) AS invalid_rows
    FROM clank_changes`).get();
  const maxRevision = row?.max_revision === null || row?.max_revision === undefined
    ? 0
    : safeRevision(row.max_revision, "maximum change revision");
  if (maxRevision > globalRevision) {
    throw new Error(`SQLite change journal revision ${maxRevision} exceeds global revision ${globalRevision}.`);
  }
  if (Number(row?.invalid_rows ?? 0) > 0) {
    throw new Error("SQLite change journal contains empty table, document, or owner identifiers.");
  }
}

function safeRevision(value: unknown, name: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return revision;
}

function safeNonNegativeInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return number;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer.`);
  return value;
}

function positiveIntegerOption(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function validatedExpectedVersion(value: number | undefined): number | undefined {
  return value === undefined ? undefined : positiveIntegerOption(value, "ifVersion");
}

function nextDocumentVersion(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Document version limit reached; the document cannot be updated safely.");
  }
  return value + 1;
}

function assertDatabaseIntegrity(
  native: DatabaseSyncLike,
  mode: SQLiteOptions["integrityCheck"],
): void {
  if (mode) {
    const pragma = mode === "full" ? "integrity_check" : "quick_check";
    const rows = native.prepare(`PRAGMA ${pragma}`).all();
    const failures = rows.flatMap((row) => Object.values(row).map(String)).filter((value) => value !== "ok");
    if (failures.length > 0) throw new Error(`SQLite ${pragma} failed: ${failures.slice(0, 5).join("; ")}`);
  }
  const foreignKeys = native.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(`SQLite foreign-key check failed for ${foreignKeys.length} row(s).`);
  }
}

async function prepareSQLitePath(input: string): Promise<string> {
  if (input === ":memory:") return input;
  if (!input || input.includes("\0")) throw new TypeError("SQLite path is invalid.");
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
    lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
    open(path: string, flags: string, mode: number): Promise<{
      chmod(mode: number): Promise<void>;
      close(): Promise<void>;
    }>;
  };
  const path = await import(pathName) as unknown as {
    resolve(path: string): string;
    dirname(path: string): string;
  };
  const resolved = path.resolve(input);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    const stats = await fs.lstat(resolved);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("SQLite path must be a regular file and cannot be a symbolic link.");
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const handle = await fs.open(resolved, "a", 0o600);
  try { await handle.chmod(0o600); } finally { await handle.close(); }
  return resolved;
}

async function hardenSQLiteFiles(path: string): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    chmod(path: string, mode: number): Promise<void>;
  };
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async (file) => {
    try { await fs.chmod(file, 0o600); }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  }));
}

function createId<Table extends string>(): Id<Table> {
  return globalThis.crypto.randomUUID().replaceAll("-", "") as Id<Table>;
}

function tableDefinition<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>>(
  schema: Schema,
  name: Name,
): Schema["tables"][Name] {
  const table = schema.tables[name];
  if (!table) throw new TypeError(`Unknown table: ${name}`);
  return table;
}

function validateQueryField<Schema extends DatabaseSchema<any>, Name extends TableName<Schema>>(
  schema: Schema,
  name: Name,
  field: string,
): void {
  if (!["_id", "_creationTime", "_version"].includes(field) && !(field in tableDefinition(schema, name).fields)) {
    throw new TypeError(`Unknown field ${field} on table ${name}.`);
  }
}

function validateFieldNames(fields: SchemaShape): void {
  for (const name of Object.keys(fields)) {
    assertIdentifier(name, "field");
    if (name.startsWith("_")) throw new TypeError(`Field names beginning with _ are reserved: ${name}`);
  }
}

function assertIdentifier(name: string, kind: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`Invalid ${kind} name: ${name}`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function migrateLegacyTable(native: DatabaseSyncLike, legacy: string, current: string): void {
  const exists = (name: string) => Boolean(native.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
  if (!exists(legacy)) return;
  if (exists(current)) {
    throw new Error(`Cannot migrate legacy SQLite table ${legacy}: ${current} already exists.`);
  }
  native.exec(`ALTER TABLE ${quoteIdentifier(legacy)} RENAME TO ${quoteIdentifier(current)}`);
}

function tableIdentifier(name: string): string {
  return quoteIdentifier(`clank_${name}`);
}

function jsonExpression(field: string): string {
  assertIdentifier(field, "field");
  return `json_extract(_data, '$.${field}')`;
}

function fieldExpression(field: string): string {
  if (field === "_id") return "_id";
  if (field === "_ownerId") return "_owner_id";
  if (field === "_creationTime") return "_creation_time";
  if (field === "_version") return "_version";
  return jsonExpression(field);
}

function comparisonOperator(comparison: Comparison): string {
  return ({ eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const)[comparison];
}

function toSQLiteValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value === null) return value;
  throw new TypeError("Indexed query values must be strings, numbers, bigints, booleans, or null.");
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new RangeError("Query limit must be an integer between 0 and 10,000.");
  return value;
}

function assertSynchronous(value: unknown, kind: string): void {
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    throw new TypeError(`Backend ${kind} handlers must be synchronous and deterministic. Use an action for external asynchronous work.`);
  }
}

function problem(status: number, code: string, message: string, details?: unknown): Response {
  return Response.json(
    { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}
