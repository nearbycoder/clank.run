import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
import type { SourceSQLiteTaskRequest } from "./provider-source-worker-wire.ts";
// Tenant-controlled schemas, triggers and SQL must never execute on the shared
// control-plane event loop. Linux workers default to a private filesystem namespace.
import { prepareSQLiteSandbox, assertPinnedSQLiteDirectory, SQLITE_RESOURCE_LIMITS, type PinnedSQLiteDirectory } from "./sqlite-sandbox.ts";
type SQLiteTaskIsolation = "namespace" | "trusted-process";
interface TaskContext {
  run<T>(isolation: SQLiteTaskIsolation, callback: () => T): T;
  getStore(): SQLiteTaskIsolation | undefined;
}
let context: TaskContext | undefined;
let contextReady: Promise<TaskContext> | undefined;

/** Internal, per-platform policy. Standalone helpers always default to namespaces. */
export async function createSQLiteTaskScope(isolation: SQLiteTaskIsolation): Promise<{ run<T>(callback: () => T): T }> {
  if (isolation !== "namespace" && isolation !== "trusted-process") throw new TypeError("Invalid SQLite task isolation.");
  const moduleName = "node:async_hooks";
  contextReady ??= import(moduleName).then(({ AsyncLocalStorage }) => context = new AsyncLocalStorage());
  const storage = await contextReady;
  return { run: callback => storage.run(isolation, callback) };
}
const MAX_ACTIVE_TASKS = 2;
const MAX_WAITING_TASKS = 16;
export const SQLITE_TASK_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = SQLITE_TASK_MAX_MESSAGE_BYTES;
const TASK_TIMEOUT_MS = 10_000;
interface SQLiteTaskWaiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}
function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("SQLite task admission was canceled.");
}
/** Round-robin admission with one active task per tenant and bounded queue wait. */
export class SQLiteTaskScheduler {
  private active = new Set<string>();
  private waiting = new Map<string, SQLiteTaskWaiter[]>();
  private capacity: number;
  private queueLimit: number;
  private tenantQueueLimit: number;
  private queueTimeoutMs: number;
  constructor(capacity = MAX_ACTIVE_TASKS, queueLimit = MAX_WAITING_TASKS,
    tenantQueueLimit = 4, queueTimeoutMs = TASK_TIMEOUT_MS) {
    this.capacity = capacity; this.queueLimit = queueLimit;
    this.tenantQueueLimit = tenantQueueLimit; this.queueTimeoutMs = queueTimeoutMs;
  }
  acquire(tenant: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancellationError(signal));
    if (!this.active.has(tenant) && this.active.size < this.capacity && this.waiting.size === 0) {
      this.active.add(tenant);
      return Promise.resolve(this.release(tenant));
    }
    const queue = this.waiting.get(tenant) ?? [];
    if (queue.length >= this.tenantQueueLimit || [...this.waiting.values()].reduce((sum, entries) => sum + entries.length, 0) >= this.queueLimit) {
      return Promise.reject(new Error("SQLite task capacity is exhausted. Retry after current operations finish."));
    }
    return new Promise((resolve, reject) => {
      const remove = (error: Error) => {
        const entries = this.waiting.get(tenant);
        if (!entries) return;
        const index = entries.indexOf(entry);
        if (index < 0) return;
        entries.splice(index, 1);
        if (!entries.length) this.waiting.delete(tenant);
        this.settle(entry);
        reject(error);
        this.drain();
      };
      const entry: SQLiteTaskWaiter = { resolve, reject, signal,
        timer: setTimeout(() => remove(new Error(`SQLite task exceeded its ${this.queueTimeoutMs}ms queue deadline.`)), this.queueTimeoutMs) };
      queue.push(entry);
      this.waiting.set(tenant, queue);
      if (signal) {
        entry.abort = () => remove(cancellationError(signal));
        signal.addEventListener("abort", entry.abort, { once: true });
        if (signal.aborted) entry.abort();
      }
      this.drain();
    });
  }
  private settle(entry: SQLiteTaskWaiter): void {
    clearTimeout(entry.timer);
    if (entry.abort) entry.signal!.removeEventListener("abort", entry.abort);
  }
  private release(tenant: string): () => void {
    let released = false;
    return () => { if (!released) { released = true; this.active.delete(tenant); this.drain(); } };
  }
  private drain(): void {
    for (const [tenant, entries] of this.waiting) {
      if (this.active.size >= this.capacity) break;
      if (this.active.has(tenant)) continue;
      const next = entries.shift()!;
      this.waiting.delete(tenant);
      if (entries.length) this.waiting.set(tenant, entries);
      this.settle(next);
      this.active.add(tenant);
      next.resolve(this.release(tenant));
    }
  }
}
const scheduler = new SQLiteTaskScheduler();

async function taskTenant(module: string, operation: string, args: readonly any[]): Promise<string> {
  const pathName = "node:path";
  const path = await import(pathName);
  const input = module === "jobs" ? args[0]?.databasePath
    : operation === "applyMigrations" ? args[0]?.path
    : operation === "inspectProjectBucketUsage" ? path.join(args[0], args[1].id, "data", "catalog.sqlite") : args[0];
  if (!input || input === ":memory:") return `memory-${globalThis.crypto.randomUUID()}`;
  const resolved = path.resolve(input);
  const match = /^(.*\/(?:projects|deployments)\/[^/]+)(?:\/|$)/.exec(resolved);
  return match ? match[1]! : path.dirname(resolved);
}

type SQLiteTaskModule = "migrations" | "jobs" | "inspection" | "recovery";
const WORKER_MODULES: Record<SQLiteTaskModule, string> = {
  migrations: "./migrations-worker.js",
  recovery: "./point-in-time-worker.js",
  jobs: "./platform-jobs-worker.js",
  inspection: "./sqlite-inspection-worker.js",
};

/** Private transport projection, not source authority or a worker execution API. */
interface SourceSQLiteTaskProjection {
  readonly request: SourceSQLiteTaskRequest;
  readonly arguments: readonly string[];
  readonly directories: readonly PinnedSQLiteDirectory[];
}

// Source initialization needs only its first backup and the two independent
// checks of that backup. Do not turn its opaque token into a general SQL/file
// capability when those operations move to a provider-side worker channel.
async function projectSourceTask(
  authority: any,
  module: SQLiteTaskModule,
  operation: string,
  values: readonly unknown[],
  directories: readonly PinnedSQLiteDirectory[],
): Promise<SourceSQLiteTaskProjection> {
  const current = authority.current;
  current();
  const opcode = module === "migrations" && operation === "stageSQLiteBackup" ? "backup"
    : module === "inspection" && operation === "inspectSQLite" ? "inspect"
    : module === "inspection" && operation === "verifySQLite" ? "verify" : undefined;
  const count = opcode === "backup" ? 3 : 1;
  if (!opcode || !Array.isArray(values) || values.length !== count
    || Reflect.ownKeys(values).length !== count + 1) {
    throw new Error("Private source tasks require a fixed initialization operation.");
  }
  const args: string[] = [];
  for (let index = 0; index < count; index++) {
    const field = Object.getOwnPropertyDescriptor(values, String(index));
    if (!field || !("value" in field) || typeof field.value !== "string"
      || !field.value || field.value.length > 4096 || field.value.includes("\0")) {
      throw new Error("Private source task arguments require bounded own path data.");
    }
    args.push(field.value);
  }
  if (!Array.isArray(directories) || directories.length !== 4
    || Reflect.ownKeys(directories).length !== 5) {
    throw new Error("Private source tasks require their exact retained directories.");
  }
  const retained: PinnedSQLiteDirectory[] = [];
  for (let index = 0; index < 4; index++) {
    const field = Object.getOwnPropertyDescriptor(directories, String(index));
    if (!field || !("value" in field)) throw new Error("Private source directories require own capability data.");
    assertPinnedSQLiteDirectory(field.value);
    retained.push(field.value);
  }
  const fsName = "node:fs", pathName = "node:path";
  const [fs, path] = await Promise.all([import(fsName), import(pathName)]);
  current();
  const process = (globalThis as any).process;
  if (process.platform !== "linux" || context?.getStore() === "trusted-process" && !authority.remoteWorker) {
    throw new Error("Private source workers require default Linux namespace isolation.");
  }
  const binding = authority.binding;
  const parent = path.dirname(authority.path);
  const root = path.join(parent, ".clank-source-recovery-" + binding.sourceIncarnation);
  const base = path.join(root, "base");
  const filename = path.basename(args[opcode === "backup" ? 1 : 0]!);
  const prefix = opcode === "verify" ? ".verified-" : ".snapshot-";
  if (!filename.startsWith(prefix) || !filename.endsWith(".sqlite")) {
    throw new Error("Private source task file differs from its initialization operation.");
  }
  const backupId = filename.slice(prefix.length, -".sqlite".length);
  const identifier = /^bk_([1-9][0-9]{0,15})_[A-Za-z0-9_-]{24}$/u.exec(backupId);
  if (!identifier || !Number.isSafeInteger(Number(identifier[1]))) {
    throw new Error("Private source task backup identity is invalid.");
  }
  const file = path.join(base, filename);
  let temporaryId: string | null = null;
  if (opcode === "backup") {
    temporaryId = args[2]!.slice((file + ".tmp-").length);
    if (args[0] !== authority.path || args[1] !== file || args[2] !== file + ".tmp-" + temporaryId
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(temporaryId)) {
      throw new Error("Private source backup paths cannot be rebound.");
    }
  } else if (args[0] !== file) {
    throw new Error("Private source inspection path cannot be rebound.");
  }
  const expected = [parent, root, base, path.join(base, ".stage-" + backupId)];
  for (let index = 0; index < expected.length; index++) {
    const directory = retained[index]!;
    if (directory.path !== expected[index]) throw new Error("Private source directory scope differs.");
    const held = fs.fstatSync(directory.fd), visible = fs.lstatSync(directory.path);
    if (!held.isDirectory() || !visible.isDirectory() || held.dev !== visible.dev || held.ino !== visible.ino
      || held.uid !== binding.uid || visible.uid !== binding.uid
      || (held.mode & 0o022) !== 0 || (visible.mode & 0o022) !== 0) {
      throw new Error("Private source retained directory identity changed.");
    }
  }
  current();
  const request: SourceSQLiteTaskRequest = Object.freeze({ protocol: "clank-source-sqlite-task/1", operation: opcode, backupId, temporaryId });
  return Object.freeze({ request, arguments: Object.freeze(args), directories: Object.freeze(retained) });
}

// The bootstrap is fixed framework code. Requests travel through stdin, never
// through shell interpolation or command arguments. Do not inherit NODE_OPTIONS,
// application secrets, inspectors, preload hooks, or parent process arguments.
const BOOTSTRAP = `
const { DatabaseSync } = await import('node:sqlite');
const limit = new DatabaseSync(':memory:');
limit.exec('PRAGMA hard_heap_limit = 67108864');
limit.close();
let request = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  request += chunk;
  if (Buffer.byteLength(request) > ${MAX_MESSAGE_BYTES}) process.exit(1);
}
try {
  const { module, operation, arguments: args } = JSON.parse(request);
  const implementation = await import(module);
  const value = await implementation[operation](...args);
  const response = JSON.stringify({ ok: true, value });
  if (Buffer.byteLength(response) > ${MAX_MESSAGE_BYTES}) throw new Error('SQLite task response exceeds its limit.');
  process.stdout.write(response);
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, name: error?.name, code: error?.code,
    message: String(error?.message ?? 'SQLite task failed.').slice(0, 4096) }));
}
`;

async function sourceContext(token: object): Promise<any> {
  const { retainProviderSourceWorker } = await import("./provider-handoff.ts");
  const retained = (retainProviderSourceWorker as any)[SQLITE_INTERNAL].sourceContext(token);
  if (retained) { retained.current(); return retained; }
  return ((await import("./backend.ts")).openBackend as any)[SQLITE_INTERNAL].sourceContext(token);
}

/** Internal bridge; callers select only fixed framework worker modules. */
export async function runSQLiteTask<T>(
  module: SQLiteTaskModule,
  operation: string,
  args: readonly unknown[],
  directories: readonly PinnedSQLiteDirectory[] = [],
  sourceToken?:object,
): Promise<T> {
  const authority=sourceToken===undefined?undefined:await sourceContext(sourceToken);
  if (!authority) return runSQLiteTaskOwned(module, operation, args, directories, sourceToken, authority);
  if (Object.hasOwn(authority,"provider") && authority.provider === true && context?.getStore() === "trusted-process") {
    const isolated = await createSQLiteTaskScope("namespace"); authority.current();
    return isolated.run(() => runSQLiteTask<T>(module, operation, args, directories, sourceToken));
  }
  // Source authority can disappear while admission or the native worker is
  // waiting. Keep this original context live until owned close/cleanup, and
  // cancel without publishing a result or releasing the scheduler slot early.
  const controller = new AbortController();
  const check = () => { if (controller.signal.aborted) return;try { authority.current(); } catch (error) { controller.abort(error); } };
  check();
  const watch = setInterval(check, 50);
  try { return await runSQLiteTaskOwned<T>(module, operation, args, directories, sourceToken, authority, controller.signal); }
  finally { clearInterval(watch); }
}

async function runSQLiteTaskOwned<T>(module: SQLiteTaskModule, operation: string,
  args: readonly unknown[], directories: readonly PinnedSQLiteDirectory[],
  sourceToken: object | undefined, authority: any, signal?: AbortSignal): Promise<T> {
  const current=()=>{if(signal?.aborted)throw cancellationError(signal);authority?.current();};
  current();
  if (authority) {
    const projection = await projectSourceTask(authority, module, operation, args, directories);
    if (authority.remoteWorker) {
      // Only the genuine captured backend context carries this fixed client.
      // Project/validate original local capabilities first; no path, descriptor,
      // SQL, callback or application execution policy crosses the wire.
      current();const result = await authority.remoteWorker.execute(projection.request);current();return result as T;
    }
    // Retain approved own data across admission/import waits. Caller arrays may
    // change after validation; they must never rebind the eventual worker.
    args = projection.arguments;
    directories = projection.directories;
  }
  current();
  const tenant=await taskTenant(module,operation,args);current();
  const release = await scheduler.acquire(tenant, signal);
  let sandbox: Awaited<ReturnType<typeof prepareSQLiteSandbox>> | undefined;
  try {
    current();
    const moduleName = "node:child_process";
    const { spawn } = await import(moduleName);current();
    const process = (globalThis as any).process;
    if(sourceToken!==undefined&&(process.platform!=="linux"||context?.getStore()==="trusted-process"))throw new Error("Private source workers require default Linux namespace isolation.");
    let executable = process.execPath;
    let trustedArguments: readonly unknown[] | undefined, trustedDescriptors:number[]=[];
    const childArguments = ["--jitless", "--max-old-space-size=128", "--input-type=module", "--eval", BOOTSTRAP];
    if (process.platform === "linux" && context?.getStore() === "trusted-process") {
      // Explicit trusted hosting still keeps native SQLite off the event loop,
      // clears inherited/ambient capabilities and preloads/secrets, and enforces
      // the same kernel limits.
      // This mode makes no filesystem or network isolation claim.
      // Preserve exact retained directory capabilities even without a filesystem namespace.
      // Child descriptor numbers are assigned by spawn, not inferred from parent numbers.
      const pathName="node:path",path=await import(pathName);
      const retained=directories.map((directory,index)=>{assertPinnedSQLiteDirectory(directory);return {directory,descriptor:3+index};}).sort((a,b)=>b.directory.path.length-a.directory.path.length);
      trustedDescriptors=directories.map(directory=>directory.fd);
      const map=(value:any):any=>{
        if(typeof value==="string"){
          const found=retained.find(({directory})=>path.dirname(value)===directory.path);
          return found?`/proc/self/fd/${found.descriptor}/${path.basename(value)}`:value;
        }
        if(Array.isArray(value))return value.map(map);
        if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,map(item)]));
        return value;
      };
      trustedArguments=map(args);
      executable = "/usr/bin/setpriv";
      childArguments.unshift("--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
        "/usr/bin/prlimit", ...SQLITE_RESOURCE_LIMITS, "--", process.execPath);
    } else if (process.platform === "linux") {
      sandbox = await prepareSQLiteSandbox(module, operation, args, childArguments, directories,sourceToken);current();
      executable = sandbox.executable;
      childArguments.splice(0, childArguments.length, ...sandbox.arguments);
    }
    const request = JSON.stringify({
      module: sandbox?.moduleUrl ?? new URL(WORKER_MODULES[module], import.meta.url).href,
      operation,
      arguments: sandbox?.argumentsValue ?? trustedArguments ?? args,
    });
    if (new TextEncoder().encode(request).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error("SQLite task request exceeds its limit.");
    }
    current();const child = spawn(executable, childArguments, {
      stdio: ["pipe", "pipe", "pipe", ...(sandbox?.descriptors ?? trustedDescriptors)],
      windowsHide: true,
      env: {
        NODE_NO_WARNINGS: "1",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        // Node's test runner aggregates subprocess coverage through this path.
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      },
    });
    const result=await new Promise<T>((resolve, reject) => {
      let output = "";
      let outputBytes = 0;
      let diagnostics = "";
      let failure: Error | undefined;
      const terminate = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const timeout = setTimeout(() => {
        terminate(new Error(`SQLite task exceeded its ${TASK_TIMEOUT_MS}ms deadline.`));
      }, TASK_TIMEOUT_MS);
      const abort = () => terminate(cancellationError(signal!));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputBytes += new TextEncoder().encode(chunk).byteLength;
        if (outputBytes > MAX_MESSAGE_BYTES) {
          terminate(new Error("SQLite task response exceeds its limit."));
          return;
        }
        output += chunk;
      });
      // Drain a bounded diagnostic prefix. Never expose worker stderr: it may
      // contain tenant input. Recognize only fixed pre-bootstrap host failures.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { if (diagnostics.length < 4096) diagnostics += chunk.slice(0, 4096 - diagnostics.length); });
      child.on("error", (error: Error) => { failure ??= error; });
      // EPIPE is expected if the worker hits its memory/deadline bound while
      // reading. Rejection waits for close so rollback cannot race a live worker.
      child.stdin.on("error", (error: Error) => { failure ??= error; });
      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (sandbox && code !== 0 && !output && (!failure || (failure as Error & { code?: string }).code === "EPIPE")
          && /^bwrap: (?:Creating new namespace failed: (?:Permission denied|Operation not permitted)|No permissions to create new namespace[^\n]*)$/mu.test(diagnostics)) {
          reject(Object.assign(new Error("SQLite worker isolation is unavailable: host policy denied Linux namespaces. Configure a host with Bubblewrap namespace support."), { code: "SQLITE_ISOLATION_UNAVAILABLE" })); return;
        }
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new Error("SQLite task exited before completing (resource limit or worker failure).")); return; }
        try {
          const response = JSON.parse(output);
          if (!response.ok) {
            const ErrorClass = response.name === "TypeError" ? TypeError : Error;
            const error = new ErrorClass(response.message || "SQLite task failed.");
            if (typeof response.code === "string") Object.assign(error, { code: response.code });
            throw error;
          }
          resolve(response.value as T);
        } catch (error) {
          reject(error);
        }
      });
      try{current();child.stdin.end(request);}catch(error){child.stdin.destroy();terminate(error as Error);}
    });
    current();await sandbox?.close();sandbox=undefined;current();return result;
  } finally {
    try { await sandbox?.close(); } finally { release(); }
  }
}

Object.defineProperty(runSQLiteTask, SQLITE_INTERNAL, { value: Object.freeze({
  sourceContext,
  async sourceRequest(token: object, module: SQLiteTaskModule, operation: string,
    args: readonly unknown[], directories: readonly PinnedSQLiteDirectory[]): Promise<SourceSQLiteTaskRequest> {
    const authority = await sourceContext(token);
    return (await projectSourceTask(authority, module, operation, args, directories)).request;
  },
}) });
