import type { Cleanup } from "./core.ts";
import type { DatabaseQueryDiagnostic } from "./query-advisor.ts";
import {
  DatabaseConflictError,
  stableStringify,
  type ApplicationDatabase, type DatabaseSchema, type DatabaseScope,
  type DatabaseChange, type DatabaseChangeRecord, type DocumentFor, type Id,
  type ReadDatabase, type WriteDatabase, type ReadTable, type WriteTable,
  type QueryBuilder, type TableName, type TrackedResult,
} from "./backend.ts";

export interface PostgresOptions {
  host: string;
  port?: number;
  database: string;
  user: string;
  /** Printable ASCII SCRAM password; Unicode SASLprep is not supported. */
  password: string;
  /** Verified TLS is the default. Plaintext requires the literal 127.0.0.1 or ::1. */
  tls?: { ca?: string; serverName?: string } | "loopback";
  /** Separate application data from other applications. Never a SQL identifier. */
  namespace?: string;
  /** Per-operation deadline, 100–30000 ms. Default 5000. */
  timeoutMs?: number;
  /** 1–10000 returned rows, default 1000. */
  maxRows?: number;
  /** 64 KiB–16 MiB, default 4 MiB. Includes the worker response. */
  maxResponseBytes?: number;
  /** 1–1000 changed documents per transaction, default 100. */
  maxWrites?: number;
  /** Retained global change revisions, 1–100000. Default 10000. */
  changeRetentionRevisions?: number;
  /** External revision polling, 0 disables; otherwise 100–60000 ms. */
  changePollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export class PostgresError extends Error {
  readonly name = "PostgresError";
  declare readonly code: string;
  declare readonly sqlState?: string;
  constructor(code: string, sqlState?: string) {
    super(code === "PG_COMMIT_UNKNOWN"
      ? "The PostgreSQL commit outcome is unknown. Reconnect and inspect native state before deciding whether to write again."
      : `PostgreSQL operation failed (${code}${sqlState ? `; SQLSTATE ${sqlState}` : ""}).`);
    this.code = code; this.sqlState = sqlState;
  }
}

export interface PostgresDatabase<Schema extends DatabaseSchema<any>> extends ApplicationDatabase<Schema> {
  readonly dialect: "postgres";
  /** History, aggregates and SQLite-native services are explicitly unsupported. */
  readonly unsupported: readonly ["history", "aggregate", "sqlite-services"];
  /** Reopen a poisoned session without replaying an earlier transaction. */
  reconnect(): Promise<void>;
}

type Result = { rows: Array<Record<string,string|null>>; command: string; transactionStatus: string };
type Transport = { query(sql: string, values?: Array<string|null>, commit?: boolean): Result; close(): void; readonly poisoned: boolean };
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[A-Za-z0-9_-]{8,128}$/u;

function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError(`Invalid PostgreSQL ${name}.`);
  return Number(value);
}
function nativeInteger(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new PostgresError("PG_CATALOG_INVALID");
  return integer(Number(value), 0, Number.MAX_SAFE_INTEGER, "native revision");
}
function ascii(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !/^[\x20-\x7e]+$/u.test(value)) throw new TypeError(`PostgreSQL ${name} requires bounded printable ASCII.`);
  return value;
}
function scalar(value: unknown): string {
  if (value !== null && typeof value !== "string" && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) throw new TypeError("PostgreSQL query comparisons require finite JSON scalars.");
  const encoded = JSON.stringify(value); if (encoder.encode(encoded).length > 65536) throw new RangeError("PostgreSQL scalar byte limit exceeded."); return encoded;
}
function synchronous(value: unknown) {
  if (value && (typeof value === "object" || typeof value === "function") && typeof (value as any).then === "function") {
    // Prevent a rejected async callback from becoming an unhandled rejection.
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError("PostgreSQL database callbacks must be synchronous.");
  }
}

function canonicalSchema(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === "required" && Array.isArray(child) && child.every(entry => typeof entry === "string")
      ? [...child].sort() : canonicalSchema(child)]));
}

async function connect(options: Required<Pick<PostgresOptions,"host"|"port"|"database"|"user"|"password"|"timeoutMs"|"maxRows"|"maxResponseBytes">> & { tls: NonNullable<PostgresOptions["tls"]> }): Promise<Transport> {
  const { Worker } = await import("node:worker_threads");
  // --input-type belongs to the caller's eval/stdin entry point. A worker has
  // a file entry point, which Node rejects if it inherits that option.
  const inlineEntry = process.execArgv.some(argument => argument === "--input-type" || argument.startsWith("--input-type="));
  const worker = new Worker(new URL("./postgres-worker.js", import.meta.url), inlineEntry ? {
    execArgv: process.execArgv.filter((argument, index, arguments_) =>
      argument !== "--input-type" && !argument.startsWith("--input-type=") && arguments_[index - 1] !== "--input-type"),
  } : undefined);
  // Atomics.wait cannot observe main-thread worker events. Its fixed deadline
  // remains the failure boundary even if a worker fails before posting back.
  worker.on("error", () => { /* No credential-bearing native error is forwarded. */ });
  let poisoned = false, closed = false;
  const exchange = (request: object, commit = false): any => {
    if (closed || poisoned) throw new PostgresError("PG_RECONNECT_REQUIRED");
    const memory = new SharedArrayBuffer(options.maxResponseBytes + 16), header = new Int32Array(memory,0,4);
    worker.postMessage({ ...request, memory });
    if (Atomics.wait(header,0,0,options.timeoutMs + 1000) === "timed-out" || Atomics.load(header,0) !== 1) {
      Atomics.store(header,0,-1); poisoned = true; void worker.terminate();
      throw new PostgresError(commit ? "PG_COMMIT_UNKNOWN" : "PG_TIMEOUT");
    }
    const length = Atomics.load(header,1);
    if (length < 1 || length > options.maxResponseBytes) { poisoned = true; void worker.terminate(); throw new PostgresError(commit ? "PG_COMMIT_UNKNOWN" : "PG_PROTOCOL_INVALID"); }
    let value: any;
    try { value = JSON.parse(decoder.decode(new Uint8Array(memory,16,length))); }
    catch { poisoned = true; void worker.terminate(); throw new PostgresError(commit ? "PG_COMMIT_UNKNOWN" : "PG_PROTOCOL_INVALID"); }
    if (value.error) {
      const statement = value.error === "PG_STATEMENT_REJECTED" && /^[A-Z0-9]{5}$/u.test(value.sqlState ?? "");
      if (!statement) { poisoned = true; void worker.terminate(); }
      throw new PostgresError(commit && !statement ? "PG_COMMIT_UNKNOWN" : value.error, statement ? value.sqlState : undefined);
    }
    return value;
  };
  try { exchange({ kind:"connect", options }); } catch(error) { void worker.terminate(); throw error; }
  worker.unref();
  return {
    get poisoned() { return poisoned; },
    query(sql, values = [], commit = false) { return exchange({ kind:"query", sql, parameters:values },commit); },
    close() { if (closed) return; closed = true; void worker.terminate(); },
  };
}

/** Open the proposed PostgreSQL application subset; SQLite services stay separate. */
export async function openPostgres<Schema extends DatabaseSchema<any>>(schema: Schema, options: PostgresOptions): Promise<PostgresDatabase<Schema>> {
  if (!schema?.tables || Object.keys(schema.tables).length < 1 || Object.keys(schema.tables).length > 128) throw new TypeError("PostgreSQL requires 1–128 defined tables.");
  const host = ascii(options.host,"host",253), port = integer(options.port ?? 5432,1,65535,"port");
  if (!/^[A-Za-z0-9.:-]+$/u.test(host)) throw new TypeError("Invalid PostgreSQL host.");
  const tls = options.tls ?? {};
  if (tls === "loopback" && host !== "127.0.0.1" && host !== "::1") throw new TypeError("Plaintext PostgreSQL requires a literal loopback host.");
  if (tls !== "loopback") {
    if (!tls || typeof tls !== "object" || Object.keys(tls).some(key => !["ca","serverName"].includes(key))) throw new TypeError("Invalid PostgreSQL TLS options.");
    if (tls.ca !== undefined && (typeof tls.ca !== "string" || encoder.encode(tls.ca).length > 65536)) throw new TypeError("Invalid PostgreSQL TLS CA.");
    if (tls.serverName !== undefined && !/^[A-Za-z0-9.:-]{1,253}$/u.test(tls.serverName)) throw new TypeError("Invalid PostgreSQL TLS identity.");
  }
  const namespace = options.namespace ?? "default";
  if (typeof namespace !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(namespace)) throw new TypeError("Invalid PostgreSQL application namespace.");
  const timeoutMs = integer(options.timeoutMs ?? 5000,100,30000,"timeout"), maxRows = integer(options.maxRows ?? 1000,1,10000,"row limit");
  const maxResponseBytes = integer(options.maxResponseBytes ?? 4*1024*1024,65536,16*1024*1024,"response limit");
  const maxWrites = integer(options.maxWrites ?? 100,1,1000,"write limit"), retention = integer(options.changeRetentionRevisions ?? 10000,1,100000,"retention");
  const pollMs = options.changePollIntervalMs ?? 100;
  if (pollMs !== 0) integer(pollMs,100,60000,"poll interval");
  const settings = { host, port, database:ascii(options.database,"database"), user:ascii(options.user,"user"), password:ascii(options.password,"password"), tls, timeoutMs, maxRows:maxRows + 1, maxResponseBytes };
  const { createHash, randomBytes } = await import("node:crypto");
  const description = Object.keys(schema.tables).sort().map(name => {
    const table = schema.tables[name];
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || !Object.isFrozen(table) || !["public","user"].includes(table.ownership)) throw new TypeError("PostgreSQL requires a finalized defineDatabase schema.");
    return { name, ownership:table.ownership, fields:canonicalSchema(table.schema.toJSONSchema()), indexes:table.indexes };
  });
  const fingerprint = createHash("sha256").update(stableStringify(description)).digest("hex");
  let transport = await connect(settings), closed = false, busy = false, version = 0, generation = 0;
  const listeners = new Set<(change: DatabaseChange)=>void>();
  const sql = (statement: string, parameters: Array<string|null> = [], commit = false) => transport.query(statement,parameters,commit);
  const report = (error: unknown) => { try { void Promise.resolve(options.onError?.(error)).catch(() => undefined); } catch { /* Observers cannot affect native state. */ } };
  const ensureOpen = () => { if (closed) throw new PostgresError("PG_CLOSED"); if (transport.poisoned) throw new PostgresError("PG_RECONNECT_REQUIRED"); };
  const revision = () => {
    const row = sql("SELECT revision, protocol, schema_hash FROM public.clank_pg_applications WHERE namespace=$1",[namespace]).rows[0];
    if (!row || row.protocol !== "clank-postgres/1" || row.schema_hash !== fingerprint) throw new PostgresError("PG_SCHEMA_MISMATCH");
    return nativeInteger(row.revision);
  };
  const initialize = () => {
    sql("SELECT set_config('search_path','pg_catalog,public',false) AS configured");
    sql("BEGIN");
    try {
      // One fixed advisory lock serializes initial DDL across native sessions.
      sql("SELECT pg_advisory_xact_lock(1129070923, 1) AS locked");
      sql("CREATE TABLE IF NOT EXISTS public.clank_pg_applications (namespace text PRIMARY KEY, protocol text NOT NULL, schema_hash text NOT NULL, revision bigint NOT NULL CHECK (revision>=0 AND revision<=9007199254740991))");
      sql("CREATE TABLE IF NOT EXISTS public.clank_pg_documents (namespace text NOT NULL REFERENCES public.clank_pg_applications(namespace), table_name text NOT NULL, id text NOT NULL, owner_id text, creation_time bigint NOT NULL, document_version bigint NOT NULL CHECK (document_version>0 AND document_version<=9007199254740991), data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'), PRIMARY KEY(namespace,table_name,id))");
      sql("CREATE INDEX IF NOT EXISTS clank_pg_owner_documents ON public.clank_pg_documents(namespace,table_name,owner_id,id)");
      sql("CREATE TABLE IF NOT EXISTS public.clank_pg_changes (namespace text NOT NULL REFERENCES public.clank_pg_applications(namespace), revision bigint NOT NULL, sequence integer NOT NULL, table_name text NOT NULL, id text NOT NULL, owner_id text, PRIMARY KEY(namespace,revision,sequence))");
      sql("INSERT INTO public.clank_pg_applications(namespace,protocol,schema_hash,revision) VALUES($1,'clank-postgres/1',$2,0) ON CONFLICT(namespace) DO NOTHING",[namespace,fingerprint]);
      version = revision(); sql("COMMIT",[],true);
      sql("SELECT set_config('statement_timeout',$1,false) AS configured",[String(timeoutMs)]);
      sql("SELECT set_config('lock_timeout',$1,false) AS configured",[String(timeoutMs)]);
      sql("SELECT set_config('idle_in_transaction_session_timeout',$1,false) AS configured",[String(timeoutMs)]);
    } catch (error) { if (!transport.poisoned) { try { sql("ROLLBACK"); } catch { /* Preserve the original failure. */ } } throw error; }
  };
  try { initialize(); } catch(error) { transport.close(); throw error; }

  const change = (next: number, records: readonly DatabaseChangeRecord[], all = false): DatabaseChange => {
    const tables = new Set<string>(), ids = new Map<string,Set<string>>();
    for (const record of records) { tables.add(record.table); if (!ids.has(record.table)) ids.set(record.table,new Set()); ids.get(record.table)!.add(record.id); }
    return Object.freeze({ version:next, records:Object.freeze(records.map(r=>Object.freeze({...r}))), tables, ids, ...(all ? { all:true } : {}) });
  };
  const notify = (entry: DatabaseChange) => { for (const listener of [...listeners]) try { listener(entry); } catch(error) { report(error); } };
  const synchronize = () => {
    ensureOpen(); if (busy) throw new PostgresError("PG_NESTED_OPERATION");
    busy = true; let next = version, entry: DatabaseChange | undefined;
    try {
      // Revision, retention boundary and records must share one native snapshot.
      // A concurrent pruning transaction cannot hide changes already observed.
      sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); next = revision();
      if (next < version) { transport.close(); throw new PostgresError("PG_REVISION_REGRESSED"); }
      if (next !== version) {
        const retained = sql("SELECT min(revision) AS oldest FROM public.clank_pg_changes WHERE namespace=$1",[namespace]).rows[0]?.oldest;
        const rows = sql("SELECT revision,table_name,id,owner_id FROM public.clank_pg_changes WHERE namespace=$1 AND revision>$2 AND revision<=$3 ORDER BY revision,sequence LIMIT $4",[namespace,String(version),String(next),String(maxRows + 1)]).rows;
        const all = retained === null || retained === undefined || nativeInteger(retained) > version + 1 || rows.length > maxRows;
        entry = change(next,all ? [] : rows.map(row=>({table:row.table_name!,id:row.id!,...(row.owner_id === null ? {} : {ownerId:row.owner_id!})})),all);
      }
      sql("COMMIT");
    } catch(error) { if (!transport.poisoned) try { sql("ROLLBACK"); } catch { /* Preserve the native failure. */ } throw error; }
    finally { busy = false; }
    if (entry) { version = next; notify(entry); }
  };
  const unsupported = () => { throw new PostgresError("PG_OPERATION_UNSUPPORTED"); };
  const run = <Value>(handler: (db: any)=>Value, scope: DatabaseScope | undefined, write: boolean, tracked: boolean): TrackedResult<Value> => {
    ensureOpen(); if (busy) throw new PostgresError("PG_NESTED_OPERATION");
    synchronize();
    const owner = scope?.userId;
    if (owner !== undefined && owner !== null && (typeof owner !== "string" || owner.length < 1 || owner.length > 256 || owner.includes("\0"))) throw new TypeError("Invalid trusted PostgreSQL owner scope.");
    busy = true; const token = ++generation;
    const dependencies = new Map<string,{table:string;id?:string;ownerId?:string|null}>(), records = new Map<string,DatabaseChangeRecord>();
    const observed = version, started = Date.now();
    let mutations = 0, began = false, result!: Value, snapshot = version, base = version, committed = false;
    const alive = () => { ensureOpen(); if (!busy || token !== generation) throw new PostgresError("PG_CONTEXT_EXPIRED"); if (Date.now() - started > timeoutMs) throw new PostgresError("PG_TIMEOUT"); };
    const track = (name: string, id?: string) => { if (tracked) { const own = schema.tables[name].ownership === "user" ? owner : undefined; dependencies.set(`${name}:${id ?? "*"}`,{table:name,...(id ? {id} : {}),...(own === undefined ? {} : {ownerId:own})}); } };
    const admitWrite = () => { alive(); if (!write) throw new PostgresError("PG_READ_ONLY"); if (++mutations > maxWrites) throw new PostgresError("PG_WRITE_LIMIT"); };
    const table = (name: string): any => {
      alive(); const definition = schema.tables[name]; if (!Object.hasOwn(schema.tables,name)) throw new TypeError("Unknown PostgreSQL table.");
      const owned = definition.ownership === "user";
      if (owned && owner === null) throw new PostgresError("PG_OWNER_REQUIRED");
      const scopeSQL = (parameters: Array<string|null>) => { parameters.push(namespace,name); let where = "namespace=$1 AND table_name=$2"; if (owned && owner !== undefined) { parameters.push(owner); where += " AND owner_id=$3"; } return where; };
      const document = (row: Record<string,string|null>): any => {
        if (!ID.test(row.id ?? "") || (owned && !row.owner_id) || nativeInteger(row.document_version) < 1) throw new PostgresError("PG_CATALOG_INVALID");
        const data = definition.schema.parse(JSON.parse(row.data!));
        const freeze = (value: any): any => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
        return freeze({ ...data, _id:row.id, _creationTime:nativeInteger(row.creation_time), _version:nativeInteger(row.document_version), ...(owned ? {_ownerId:row.owner_id} : {}) });
      };
      const get = (id: string): any => { alive(); if (typeof id !== "string" || !ID.test(id)) throw new TypeError("Invalid PostgreSQL document ID."); track(name,id); const p: Array<string|null> = []; const where = scopeSQL(p); p.push(id); const row = sql(`SELECT id,owner_id,creation_time,document_version,data FROM public.clank_pg_documents WHERE ${where} AND id=$${p.length}`,p).rows[0]; return row ? document(row) : null; };
      const encoded = (raw: unknown): string => { const data = stableStringify(definition.schema.parse(raw)); if (encoder.encode(data).length > 65536) throw new PostgresError("PG_DOCUMENT_LIMIT"); return data; };
      const mark = (id: string, own?: string|null) => { records.set(name+":"+id,{table:name,id,...(own === undefined || own === null ? {} : {ownerId:own})}); };
      const field = (value: unknown, parameters: Array<string|null>): string => {
        if (typeof value !== "string") throw new TypeError("Invalid PostgreSQL query field.");
        const metadata: Record<string,string> = { _id:"id", _creationTime:"creation_time", _version:"document_version", ...(owned ? {_ownerId:"owner_id"} : {}) };
        if (Object.hasOwn(metadata,value)) return `to_jsonb(${metadata[value]})`;
        if (!Object.hasOwn(definition.fields,value)) throw new TypeError("Unknown PostgreSQL query field.");
        const shape = definition.fields[value].toJSONSchema();
        const types = Array.isArray(shape.type) ? shape.type : [shape.type];
        if (!types.length || types.some((type: unknown)=>!["string","integer","number","boolean","null"].includes(String(type)))) throw new PostgresError("PG_QUERY_SHAPE_UNSUPPORTED");
        parameters.push(value); return `COALESCE(data -> $${parameters.length}::text,'null'::jsonb)`;
      };
      const builder = (conditions: Array<[string,string,unknown]> = [], order?: [string,"asc"|"desc"], count?: number): any => {
        const collect = () => {
          alive(); track(name); const p: Array<string|null> = [], filters = [scopeSQL(p)];
          for (const [key,comparison,value] of conditions) { const expression = field(key,p); p.push(scalar(value)); filters.push(`${expression} ${comparison} $${p.length}::jsonb`); }
          const orderSQL = order ? `${field(order[0],p)} ${order[1]},id COLLATE "C"` : 'id COLLATE "C"';
          p.push(String(count ?? maxRows + 1));
          const rows = sql(`SELECT id,owner_id,creation_time,document_version,data FROM public.clank_pg_documents WHERE ${filters.join(" AND ")} ORDER BY ${orderSQL} LIMIT $${p.length}`,p).rows;
          if (rows.length > maxRows) throw new PostgresError("PG_ROW_LIMIT"); return rows.map(document);
        };
        return Object.freeze({
          where(key: string, comparison: unknown, value?: unknown) { alive(); if (conditions.length >= 20) throw new PostgresError("PG_QUERY_LIMIT"); const op = arguments.length === 2 ? "eq" : comparison; const operators: Record<string,string> = {eq:"=",neq:"<>",lt:"<",lte:"<=",gt:">",gte:">="}; if (!Object.hasOwn(operators,String(op))) throw new TypeError("Invalid PostgreSQL comparison."); scalar(arguments.length === 2 ? comparison : value); return builder([...conditions,[key,operators[String(op)]!,arguments.length === 2 ? comparison : value]],order,count); },
          orderBy(key: string, direction: "asc"|"desc" = "asc") { alive(); if (!["asc","desc"].includes(direction)) throw new TypeError("Invalid PostgreSQL ordering."); return builder(conditions,[key,direction],count); },
          limit(limit: number) { alive(); return builder(conditions,order,integer(limit,1,maxRows,"query limit")); },
          collect, first() { return builder(conditions,order,1).collect()[0] ?? null; }, aggregate:unsupported,
        });
      };
      const modify = (id: string, raw: unknown, replace: boolean, expected?: number): any => {
        alive(); if (expected !== undefined) integer(expected,1,Number.MAX_SAFE_INTEGER,"expected version");
        const previous = get(id); if (expected !== undefined && previous?._version !== expected) throw new DatabaseConflictError(name,id,expected,previous?._version ?? null);
        if (!previous) return null;
        const data = Object.fromEntries(Object.keys(definition.fields).filter(key=>Object.hasOwn(previous,key)).map(key=>[key,previous[key]]));
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key=>!Object.hasOwn(definition.fields,key))) throw new TypeError("Invalid PostgreSQL document fields.");
        const value = encoded(replace ? raw : {...data,...raw}); if (value === stableStringify(data)) return previous;
        admitWrite(); const next = integer(previous._version + 1,1,Number.MAX_SAFE_INTEGER,"document version");
        const p: Array<string|null> = [], where = scopeSQL(p); p.push(id,value,String(next),String(previous._version));
        const rows = sql(`UPDATE public.clank_pg_documents SET data=$${p.length-2}::jsonb,document_version=$${p.length-1} WHERE ${where} AND id=$${p.length-3} AND document_version=$${p.length} RETURNING id,owner_id,creation_time,document_version,data`,p).rows;
        if (rows.length !== 1) throw new DatabaseConflictError(name,id,previous._version,get(id)?._version ?? null);
        mark(id,previous._ownerId); return document(rows[0]!);
      };
      const reader = { get, query:()=>{alive();return builder();}, collect:()=>builder().collect(), history:unsupported };
      if (!write) return Object.freeze(reader);
      return Object.freeze({ ...reader,
        insert(raw: unknown) { admitWrite(); if (owned && owner === undefined) throw new PostgresError("PG_OWNER_REQUIRED"); const id = randomBytes(18).toString("base64url"), data = encoded(raw), now = String(Date.now()); sql("INSERT INTO public.clank_pg_documents(namespace,table_name,id,owner_id,creation_time,document_version,data) VALUES($1,$2,$3,$4,$5,1,$6::jsonb)",[namespace,name,id,owned ? owner! : null,now,data]); mark(id,owned ? owner : undefined); return id; },
        patch(id: string, raw: unknown, o: {ifVersion?:number} = {}) { return modify(id,raw,false,o.ifVersion); },
        replace(id: string, raw: unknown, o: {ifVersion?:number} = {}) { return modify(id,raw,true,o.ifVersion); },
        delete(id: string, o: {ifVersion?:number} = {}) { alive(); if (o.ifVersion !== undefined) integer(o.ifVersion,1,Number.MAX_SAFE_INTEGER,"expected version"); const previous = get(id); if (o.ifVersion !== undefined && previous?._version !== o.ifVersion) throw new DatabaseConflictError(name,id,o.ifVersion,previous?._version ?? null); if (!previous) return false; admitWrite(); const p: Array<string|null> = [], where = scopeSQL(p); p.push(id,String(previous._version)); const row = sql(`DELETE FROM public.clank_pg_documents WHERE ${where} AND id=$${p.length-1} AND document_version=$${p.length} RETURNING id`,p).rows; if (row.length !== 1) throw new DatabaseConflictError(name,id,previous._version,get(id)?._version ?? null); mark(id,previous._ownerId); return true; },
        restore:unsupported, purgeDeleted:unsupported,
      });
    };
    try {
      sql(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); began = true;
      if (write) sql("SELECT revision FROM public.clank_pg_applications WHERE namespace=$1 FOR UPDATE",[namespace]);
      snapshot = revision(); base = snapshot; result = handler(Object.freeze({table})); synchronous(result);
      if (Date.now() - started > timeoutMs) throw new PostgresError("PG_TIMEOUT");
      if (records.size) {
        snapshot = integer(snapshot+1,1,Number.MAX_SAFE_INTEGER,"global revision");
        alive(); sql("UPDATE public.clank_pg_applications SET revision=$2 WHERE namespace=$1",[namespace,String(snapshot)]);
        let sequence = 0; for (const record of records.values()) { alive(); sql("INSERT INTO public.clank_pg_changes(namespace,revision,sequence,table_name,id,owner_id) VALUES($1,$2,$3,$4,$5,$6)",[namespace,String(snapshot),String(sequence++),record.table,record.id,record.ownerId ?? null]); }
        alive();
        sql("DELETE FROM public.clank_pg_changes WHERE namespace=$1 AND revision<$2",[namespace,String(Math.max(1,snapshot-retention+1))]);
        // Drop entire older revisions at the fixed row ceiling. A reader that
        // misses them receives a conservative invalidation, never a partial one.
        alive(); sql("DELETE FROM public.clank_pg_changes WHERE namespace=$1 AND revision <= (SELECT revision FROM public.clank_pg_changes WHERE namespace=$1 ORDER BY revision DESC,sequence DESC OFFSET 100000 LIMIT 1)",[namespace]);
      }
      alive(); sql("COMMIT",[],true); committed = true;
    } catch(error) { if (began && !transport.poisoned) try { sql("ROLLBACK"); } catch { /* Preserve the operation's error. */ } throw error; }
    finally { busy = false; ++generation; }
    if (committed && snapshot !== version) { version = snapshot; notify(change(version,[...records.values()],base !== observed)); }
    return {value:result, dependencies:Object.freeze([...dependencies.values()].map(d=>Object.freeze(d))), version:snapshot};
  };
  const timer = pollMs ? setInterval(()=>{if (closed || busy || !listeners.size || transport.poisoned) return; try { synchronize(); } catch(error) { report(error); }},pollMs) : undefined;
  timer?.unref();
  return {
    schema, dialect:"postgres", unsupported:Object.freeze(["history","aggregate","sqlite-services"]),
    get version() { ensureOpen(); if (!busy) synchronize(); return version; },
    inspectDatabaseQueries(): readonly DatabaseQueryDiagnostic[] { ensureOpen(); return Object.freeze([]); },
    read(handler,scope) { return run(handler,scope,false,false).value; },
    tracked(handler,scope) { return run(handler,scope,false,true); },
    transaction(handler,scope) { return run(handler,scope,true,false).value; },
    subscribe(listener) { ensureOpen(); if (typeof listener !== "function") throw new TypeError("Invalid PostgreSQL change observer."); if (listeners.size >= 1000) throw new PostgresError("PG_LISTENER_LIMIT"); listeners.add(listener); return ()=>{listeners.delete(listener);}; },
    async reconnect() { if (closed) throw new PostgresError("PG_CLOSED"); if (busy) throw new PostgresError("PG_NESTED_OPERATION"); busy = true; transport.close(); try { transport = await connect(settings); const previous = version; initialize(); if (version < previous) throw new PostgresError("PG_REVISION_REGRESSED"); busy = false; notify(change(version,[],true)); } catch(error) { transport.close(); throw error; } finally { busy = false; } },
    close() { if (busy) throw new PostgresError("PG_NESTED_OPERATION"); if (closed) return; closed = true; if (timer) clearInterval(timer); listeners.clear(); transport.close(); },
  };
}
