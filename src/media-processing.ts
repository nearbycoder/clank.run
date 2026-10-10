import { s } from "./ai.ts";
import { authRuntimeDatabase, type AuthRequest, type AuthRuntime } from "./auth.ts";
import type { SQLiteDatabase } from "./backend.ts";
import { bucketProcessingBinding, type BucketManager, type BucketObject, type BucketProcessingSource, type BucketStoredObject } from "./buckets.ts";
import { assertJobAttemptCurrent, defineJobs, openJobs, type JobHandlerContext, type JobProcessHandle, type JobWorkerOptions } from "./jobs.ts";
import { SQLITE_INTERNAL, type SQLiteStatement } from "./sqlite-internal.ts";

export interface MediaTransform {
  readonly name: string;
  /** Change whenever the adapter, configuration or provider behavior changes. */
  readonly revision: string;
  readonly sourceBucket: string;
  readonly destinationBucket: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly handler: (input: { readonly source: BucketStoredObject; readonly signal: AbortSignal;
    /** Providers must deduplicate this exact key across attempts and process death. */
    readonly operationKey: string; readonly progress: (percent: number) => void }) =>
      { readonly bytes: Uint8Array | ArrayBuffer; readonly contentType: string } | Promise<{ readonly bytes: Uint8Array | ArrayBuffer; readonly contentType: string }>;
}
export interface MediaProcessingInput {
  readonly operationId: string;
  readonly transform: string;
  readonly sourceKey: string;
  readonly destinationKey: string;
}
export interface MediaProcessingStatus {
  readonly id: string;
  readonly jobId: string;
  readonly transform: string;
  readonly state: "queued" | "running" | "retry" | "succeeded" | "dead" | "cancelled" | "published";
  readonly progress: number;
  readonly attempt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** False after either the source or accepted destination is replaced. */
  readonly outputCurrent: boolean;
  readonly object: BucketObject | null;
}
export interface OpenMediaProcessingOptions {
  /** A persistent native catalog shared by this AuthRuntime and bucket manager. */
  readonly database: SQLiteDatabase<any>;
  readonly buckets: BucketManager;
  readonly auth: AuthRuntime<any>;
  readonly transforms: readonly MediaTransform[];
  /** Increasing revision shared by every compatible controller and worker. */
  readonly policyRevision: number;
  /** Synchronous current ownership/role/policy check; success returns undefined. */
  readonly authorize: (auth: AuthRequest<any>, transform: MediaTransform, operation: "enqueue" | "read" | "cancel" | "process") => undefined;
  readonly maxOperations?: number;
  readonly receiptLifetimeMs?: number;
  readonly maxProgressUpdates?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}
export interface MediaProcessing {
  enqueue(auth: AuthRequest<any>, input: MediaProcessingInput): MediaProcessingStatus;
  get(auth: AuthRequest<any>, id: string): MediaProcessingStatus | null;
  cancel(auth: AuthRequest<any>, id: string): boolean;
  workOnce(options?: Omit<JobWorkerOptions, "queues" | "concurrency" | "pollIntervalMs">): Promise<boolean>;
  startWorker(options?: Omit<JobWorkerOptions, "queues">): JobProcessHandle;
  /** Stops this controller's workers; does not close shared auth, buckets or database. */
  close(): void;
}
export class MediaProcessingError extends Error {
  readonly name = "MediaProcessingError";
  declare readonly code: string;
  declare readonly status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.code = code; this.status = status; }
}
type Connection = { prepare(sql: string): SQLiteStatement };
function fail(code: string, message: string, status = 409): never { throw new MediaProcessingError(code, message, status); }
function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`Invalid ${label}.`);
  return Number(value);
}
function synchronous(value: unknown): void {
  if (value !== undefined) {
    if (value && typeof Reflect.get(Object(value), "then") === "function") void Promise.resolve(value).catch(() => undefined);
    throw new TypeError("Media authorization must synchronously return undefined.");
  }
}
function implementation(value: Function): string {
  const source=Function.prototype.toString.call(value);
  if(new TextEncoder().encode(source).byteLength>65536) throw new TypeError("Media implementation exceeds its bound.");
  return source;
}

/** Durable native jobs with generation-fenced, receipt-backed bucket publication. */
export async function openMediaProcessing(input: OpenMediaProcessingOptions): Promise<MediaProcessing> {
  const options: OpenMediaProcessingOptions = Object.freeze({ ...input,
    transforms: Array.isArray(input.transforms) ? Object.freeze(input.transforms.map(value => Object.freeze({ ...value }))) : input.transforms,
  });
  const database = options.database, auth = options.auth, buckets = options.buckets, sql = database?.[SQLITE_INTERNAL];
  if (!sql || authRuntimeDatabase(auth) !== database) throw new TypeError("Media processing requires native auth on its actual SQLite database.");
  if (typeof options.authorize !== "function") throw new TypeError("Current media authorization is required.");
  const binding = bucketProcessingBinding(buckets);
  const fsName = "node:fs/promises", pathName = "node:path", cryptoName = "node:crypto";
  const [fs, path, nodeCrypto] = await Promise.all([import(fsName), import(pathName), import(cryptoName)]);
  const catalog = sql.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  if (typeof catalog !== "string" || !catalog || path.resolve(catalog) !== binding.databasePath
    || await fs.realpath(catalog) !== binding.databasePath || (await fs.lstat(catalog)).nlink !== 1) {
    throw new TypeError("Media jobs, auth, receipts and buckets must use the same persistent native catalog path.");
  }
  const maxOperations = integer(options.maxOperations ?? 1_000, "maxOperations", 1, 100_000);
  const lifetime = integer(options.receiptLifetimeMs ?? 24 * 60 * 60_000, "receiptLifetimeMs", 1_000, 7 * 24 * 60 * 60_000);
  const maxProgress = integer(options.maxProgressUpdates ?? 100, "maxProgressUpdates", 1, 1_000);
  const attempts = integer(options.maxAttempts ?? 3, "maxAttempts", 1, 10);
  const timeout = integer(options.timeoutMs ?? 30_000, "timeoutMs", 100, 60 * 60_000);
  const revision = integer(options.policyRevision, "policyRevision", 1, Number.MAX_SAFE_INTEGER);
  const clock = options.now ?? Date.now;
  const now = () => integer(clock(), "clock", 0, Number.MAX_SAFE_INTEGER - lifetime);
  now();
  if (!Array.isArray(options.transforms) || options.transforms.length < 1 || options.transforms.length > 100) throw new TypeError("Declare between 1 and 100 media transforms.");
  const transforms = new Map<string, MediaTransform>();
  for (const input of options.transforms) {
    const name = text(input.name, "transform name", 64);
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(name) || transforms.has(name) || typeof input.handler !== "function") throw new TypeError("Invalid or duplicate media transform.");
    const sourceBucket = text(input.sourceBucket, "source bucket", 64), destinationBucket = text(input.destinationBucket, "destination bucket", 64);
    const source = buckets.bucket(sourceBucket).definition, destination = buckets.bucket(destinationBucket).definition;
    if (source.ownership !== destination.ownership || source.visibility === "private" && destination.visibility === "public") {
      throw new TypeError("Media transforms cannot change ownership or publish private sources publicly.");
    }
    transforms.set(name, Object.freeze({ name, revision: text(input.revision, "transform revision"), sourceBucket, destinationBucket,
      maxInputBytes: integer(input.maxInputBytes, "maxInputBytes", 1, Math.min(source.maxObjectBytes, 100 * 1024 * 1024)),
      maxOutputBytes: integer(input.maxOutputBytes, "maxOutputBytes", 1, Math.min(destination.maxObjectBytes, 100 * 1024 * 1024)), handler: input.handler }));
  }
  const fingerprint = nodeCrypto.createHash("sha256").update(JSON.stringify([maxOperations, lifetime, maxProgress, attempts, timeout,
    implementation(options.authorize),
    [...transforms.values()].sort((a,b) => a.name.localeCompare(b.name)).map(({handler, ...value}) => [value,
      implementation(handler), buckets.bucket(value.sourceBucket).definition, buckets.bucket(value.destinationBucket).definition])])).digest("hex");
  const current = (connection: Connection = sql) => {
    const state = connection.prepare("SELECT protocol,revision,fingerprint FROM clank_media_state WHERE singleton=1").get();
    if (state?.protocol !== 1 || state.revision !== revision || state.fingerprint !== fingerprint) fail("MEDIA_POLICY_CHANGED", "Current media protocol and processing policy are required.");
  };
  if (sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_media_state' AND type='table'").get()
    && sql.prepare("SELECT protocol FROM clank_media_state WHERE singleton=1").get()?.protocol !== 1) fail("MEDIA_PROTOCOL", "Unsupported media processing protocol.");
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_media_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS clank_media_operations (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,session_id TEXT NOT NULL,
      transform_name TEXT NOT NULL,transform_revision TEXT NOT NULL,policy_revision INTEGER NOT NULL,policy_fingerprint TEXT NOT NULL,
      input TEXT NOT NULL CHECK(length(CAST(input AS BLOB))<=32768 AND json_valid(input)),fingerprint TEXT NOT NULL,
      job_id TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,progress INTEGER NOT NULL DEFAULT 0,
      progress_updates INTEGER NOT NULL DEFAULT 0,output_generation TEXT,result TEXT CHECK(result IS NULL OR length(CAST(result AS BLOB))<=8192 AND json_valid(result)),
      UNIQUE(owner_id,operation_id)) STRICT;`);
  sql.transaction(() => {
    const state = sql.prepare("SELECT * FROM clank_media_state WHERE singleton=1").get();
    if (state && (state.protocol !== 1 || Number(state.revision) > revision || state.revision === revision && state.fingerprint !== fingerprint)) fail("MEDIA_POLICY_CHANGED", "Increase the media policy revision for changed configuration.");
    sql.prepare("INSERT INTO clank_media_state VALUES(1,1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint").run(revision,fingerprint);
  });
  let closed = false;
  const ensureOpen = () => { if (closed) fail("MEDIA_CLOSED", "Media processing is closed.", 503); current(); };
  const transformFor = (name: string): MediaTransform => transforms.get(name) ?? fail("MEDIA_TRANSFORM_NOT_FOUND", "Declared media transform not found.", 404);
  const freshCaller = (caller: AuthRequest<any>) => {
    ensureOpen();
    if (!caller?.session || !caller.user || typeof caller.requireUser !== "function" || typeof caller.requireVerified !== "function" || typeof caller.requireRole !== "function") fail("MEDIA_AUTH_REQUIRED", "A current native authenticated request is required.", 401);
    const fresh = auth.refreshSession(caller.session.id);
    if (!fresh?.user || fresh.user.id !== caller.user.id) fail("MEDIA_AUTH_REQUIRED", "Media authorization is no longer current.", 401);
    fresh.requireUser(); return fresh;
  };
  const authorize = (caller: AuthRequest<any>, transform: MediaTransform, operation: "enqueue" | "read" | "cancel" | "process") => {
    const fresh=freshCaller(caller);synchronous(options.authorize(fresh, transform, operation));return fresh;
  };
  const rowById = (id: string, connection: Connection = sql) => connection.prepare("SELECT * FROM clank_media_operations WHERE id=?").get(id);
  const inputFor = (row: Record<string, unknown>): { source: BucketProcessingSource; destinationKey: string; destinationGeneration: string | null } => {
    try {
      const input=JSON.parse(String(row.input)),transform=transformFor(String(row.transform_name));
      if(!input || typeof input!=="object" || Array.isArray(input)
        || Object.keys(input).sort().join(",")!=="destinationGeneration,destinationKey,source"
        || !input.source || typeof input.source!=="object" || Array.isArray(input.source)
        || input.source.bucket!==transform.sourceBucket) throw new Error("Invalid persisted media input.");
      const sourceKey=text(input.source.key,"persisted source key",512),destinationKey=text(input.destinationKey,"persisted destination key",512);
      text(input.source.generation,"persisted source generation",200);
      if(input.destinationGeneration!==null) text(input.destinationGeneration,"persisted destination generation",200);
      if(row.fingerprint!==JSON.stringify([transform.name,sourceKey,destinationKey])
        || transform.sourceBucket===transform.destinationBucket && sourceKey===destinationKey) throw new Error("Changed persisted media input.");
      return input;
    } catch { fail("MEDIA_INPUT_INVALID","Persisted media input no longer matches its declared operation."); }
  };
  const guard = (row: Record<string, unknown>, context?: JobHandlerContext<any,any>, connection: Connection = sql) => {
    current(connection); if (context) assertJobAttemptCurrent(context);
    if (Number(row.expires_at) <= now()) fail("MEDIA_EXPIRED", "This media operation and its retry authority expired.", 410);
    const transform = transformFor(String(row.transform_name));
    if (row.policy_revision !== revision || row.policy_fingerprint !== fingerprint || row.transform_revision !== transform.revision) fail("MEDIA_POLICY_CHANGED", "This media operation belongs to a retired processing policy.");
    const caller = auth.refreshSession(String(row.session_id));
    if (!caller || caller.user?.id !== row.owner_id) fail("MEDIA_AUTH_REQUIRED", "The originating media session is no longer current.", 401);
    authorize(caller, transform, "process");
    const input = inputFor(row), source = binding.snapshot(input.source.bucket,input.source.key,String(row.owner_id));
    if (source?.generation !== input.source.generation) fail("MEDIA_SOURCE_CHANGED", "The media source generation changed.");
    return { transform, input };
  };
  const status = (row: Record<string,unknown>): MediaProcessingStatus => {
    const job = jobs.get(String(row.job_id)); const input = inputFor(row), transform = transformFor(String(row.transform_name));
    const destination=binding.snapshot(transform.destinationBucket,input.destinationKey,String(row.owner_id));
    const outputCurrent = row.result !== null && row.policy_revision === revision && row.policy_fingerprint === fingerprint
      && binding.snapshot(input.source.bucket,input.source.key,String(row.owner_id))?.generation === input.source.generation
      && destination?.generation === row.output_generation;
    return Object.freeze({ id:String(row.id),jobId:String(row.job_id),transform:transform.name,state:row.result !== null ? "published" : job?.state ?? "dead",
      progress:Number(row.progress),attempt:job?.attempt ?? 0,createdAt:Number(row.created_at),expiresAt:Number(row.expires_at),outputCurrent,
      object:outputCurrent ? destination!.metadata : null });
  };
  const definition = defineJobs({schema:database.schema}).jobs(({job}) => ({ media: { run: job({
    args: { operation: s.string({min:1,max:128}) }, queue:"clank-media", timeoutMs:timeout,
    retry:{maxAttempts:attempts,initialDelayMs:1_000,maxDelayMs:30_000},
    async handler(context, {operation}) {
      const row = rowById(operation); if (!row || row.job_id !== context.job.id || row.owner_id !== context.job.ownerId) fail("MEDIA_OPERATION_MISMATCH", "Native job and media operation do not match.");
      try {
        let {transform,input} = guard(row,context);
        if (row.result !== null) {
          if (binding.snapshot(transform.destinationBucket,input.destinationKey,String(row.owner_id))?.generation !== row.output_generation) fail("MEDIA_DESTINATION_CHANGED", "Accepted media output was replaced.");
          return {operation,published:true};
        }
        const source = await binding.read(input.source,String(row.owner_id)); guard(row,context);
        if (source.bytes.byteLength > transform.maxInputBytes) fail("MEDIA_INPUT_TOO_LARGE", "Source exceeds the declared transform input limit.",413);
        const output = await transform.handler({source,signal:context.signal,operationKey:`clank-media:${operation}`,
          progress(percent) { integer(percent,"progress",0,100); sql.transaction(() => {
            const latest=rowById(operation)!; guard(latest,context);
            if (latest.result !== null || Number(latest.progress_updates) >= maxProgress || percent < Number(latest.progress)) fail("MEDIA_PROGRESS_LIMIT", "Media progress update limit or monotonicity was exceeded.");
            sql.prepare("UPDATE clank_media_operations SET progress=?,progress_updates=progress_updates+1 WHERE id=?").run(percent,operation);
          }); },
        });
        guard(row,context);
        if (!(output?.bytes instanceof Uint8Array) && !(output?.bytes instanceof ArrayBuffer)) throw new TypeError("Media transforms must return bounded bytes.");
        if (output.bytes.byteLength > transform.maxOutputBytes) fail("MEDIA_OUTPUT_TOO_LARGE", "Output exceeds the declared transform limit.",413);
        const bytes = output.bytes instanceof Uint8Array ? new Uint8Array(output.bytes) : new Uint8Array(output.bytes.slice(0));
        await binding.publish({source:input.source,userId:String(row.owner_id),bucket:transform.destinationBucket,key:input.destinationKey,
          expectedGeneration:input.destinationGeneration,bytes,contentType:text(output.contentType,"output content type",200),signal:context.signal}, {
          check() { guard(rowById(operation)!,context); },
          accept(connection,object,generation) {
            const latest=rowById(operation,connection)!; guard(latest,context,connection);
            if (latest.result !== null) fail("MEDIA_ALREADY_PUBLISHED", "This operation already has an accepted publication.");
            const result=JSON.stringify(object);if(new TextEncoder().encode(result).byteLength>8192) fail("MEDIA_RESULT_TOO_LARGE", "Media result metadata exceeds its bound.");
            connection.prepare("UPDATE clank_media_operations SET result=?,output_generation=?,progress=100 WHERE id=? AND result IS NULL").run(result,generation,operation);
          },
        });
        return {operation,published:true};
      } catch(error) {
        try { void Promise.resolve(options.onError?.(error)).catch(()=>undefined); } catch { /* Diagnostics cannot alter attempts or reveal adapter details. */ }
        if (error instanceof MediaProcessingError) throw error;
        throw new MediaProcessingError("MEDIA_PROCESSING_FAILED","Media processing failed; inspect trusted adapter diagnostics.",500);
      }
    },
  }) } }));
  const jobs=openJobs(definition,{database,now,maxPayloadBytes:1024,maxResultBytes:1024,maxErrorBytes:512});
  return Object.freeze<MediaProcessing>({
    enqueue(caller,input) {
      const operationId=text(input.operationId,"operation ID"),name=text(input.transform,"transform name",64),sourceKey=text(input.sourceKey,"source key",512),destinationKey=text(input.destinationKey,"destination key",512);
      const transform=transformFor(name);if(transform.sourceBucket===transform.destinationBucket&&sourceKey===destinationKey) throw new TypeError("Media output cannot replace its original source.");
      const logical=JSON.stringify([name,sourceKey,destinationKey]);
      return sql.transaction(() => {
        const fresh=authorize(caller,transform,"enqueue"),owner=String(fresh.user!.id);
        const previous=sql.prepare("SELECT * FROM clank_media_operations WHERE owner_id=? AND operation_id=?").get(owner,operationId);
        if(previous) {
          if(previous.fingerprint!==logical) fail("MEDIA_RETRY_CONFLICT","This operation ID was used for different media input.");
          guard(previous); const accepted=status(previous);
          if(previous.result!==null&&!accepted.outputCurrent) fail("MEDIA_DESTINATION_CHANGED","Accepted media output was replaced."); return accepted;
        }
        if(Number(sql.prepare("SELECT count(*) AS count FROM clank_media_operations").get()!.count)>=maxOperations) fail("MEDIA_CAPACITY","Retained media operation capacity is exhausted.",429);
        const source=binding.snapshot(transform.sourceBucket,sourceKey,owner);if(!source) fail("MEDIA_SOURCE_NOT_FOUND","Media source not found.",404);
        if(source.metadata.size>transform.maxInputBytes) fail("MEDIA_INPUT_TOO_LARGE","Source exceeds the declared transform input limit.",413);
        const destination=binding.snapshot(transform.destinationBucket,destinationKey,owner),id=crypto.randomUUID(),createdAt=now();
        const frozen=JSON.stringify({source,destinationKey,destinationGeneration:destination?.generation??null});
        if(new TextEncoder().encode(frozen).byteLength>32768) fail("MEDIA_INPUT_TOO_LARGE","Media operation metadata exceeds its bound.",413);
        sql.prepare(`INSERT INTO clank_media_operations(id,owner_id,operation_id,session_id,transform_name,transform_revision,policy_revision,policy_fingerprint,input,fingerprint,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,owner,operationId,fresh.session!.id,name,transform.revision,revision,fingerprint,frozen,logical,createdAt,createdAt+lifetime);
        const queued=jobs.publisher({userId:owner}).enqueue(definition.jobs.media.run,{operation:id},{idempotencyKey:id});
        sql.prepare("UPDATE clank_media_operations SET job_id=? WHERE id=?").run(queued.id,id);return status(rowById(id)!);
      });
    },
    get(caller,id) { return sql.transaction(() => {
      freshCaller(caller);
      const row=rowById(text(id,"media operation ID"));if(!row){ensureOpen();return null;}
      const fresh=authorize(caller,transformFor(String(row.transform_name)),"read");if(fresh.user!.id!==row.owner_id)return null;return status(row);
    }); },
    cancel(caller,id) { return sql.transaction(() => {
      freshCaller(caller);
      const row=rowById(text(id,"media operation ID"));if(!row){ensureOpen();return false;}
      const fresh=authorize(caller,transformFor(String(row.transform_name)),"cancel");if(fresh.user!.id!==row.owner_id)return false;
      return row.result===null&&jobs.cancel(String(row.job_id));
    }); },
    workOnce(workerOptions={}) {ensureOpen();return jobs.workOnce({...workerOptions,queues:["clank-media"]});},
    startWorker(workerOptions={}) {ensureOpen();return jobs.startWorker({...workerOptions,queues:["clank-media"]});},
    close() {if(closed)return;closed=true;jobs.close();},
  });
}
