// Tenant-controlled schemas, triggers and SQL must never execute on the shared
// control-plane event loop. Linux workers additionally have a private filesystem namespace.
import { prepareSQLiteSandbox, type PinnedSQLiteDirectory } from "./sqlite-sandbox.ts";
const MAX_ACTIVE_TASKS = 2;
const MAX_WAITING_TASKS = 16;
export const SQLITE_TASK_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = SQLITE_TASK_MAX_MESSAGE_BYTES;
const TASK_TIMEOUT_MS = 10_000;
/** Round-robin admission with one active task per tenant and bounded queue wait. */
export class SQLiteTaskScheduler {
  private active = new Set<string>();
  private waiting = new Map<string, Array<{ resolve(release: () => void): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>>();
  private capacity: number;
  private queueLimit: number;
  private tenantQueueLimit: number;
  private queueTimeoutMs: number;
  constructor(capacity = MAX_ACTIVE_TASKS, queueLimit = MAX_WAITING_TASKS,
    tenantQueueLimit = 4, queueTimeoutMs = TASK_TIMEOUT_MS) {
    this.capacity = capacity; this.queueLimit = queueLimit;
    this.tenantQueueLimit = tenantQueueLimit; this.queueTimeoutMs = queueTimeoutMs;
  }
  acquire(tenant: string): Promise<() => void> {
    if (!this.active.has(tenant) && this.active.size < this.capacity && this.waiting.size === 0) {
      this.active.add(tenant);
      return Promise.resolve(this.release(tenant));
    }
    const queue = this.waiting.get(tenant) ?? [];
    if (queue.length >= this.tenantQueueLimit || [...this.waiting.values()].reduce((sum, entries) => sum + entries.length, 0) >= this.queueLimit) {
      return Promise.reject(new Error("SQLite task capacity is exhausted. Retry after current operations finish."));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: setTimeout(() => {
        const entries = this.waiting.get(tenant);
        if (!entries) return;
        const index = entries.indexOf(entry);
        if (index < 0) return;
        entries.splice(index, 1);
        if (!entries.length) this.waiting.delete(tenant);
        reject(new Error(`SQLite task exceeded its ${this.queueTimeoutMs}ms queue deadline.`));
        this.drain();
      }, this.queueTimeoutMs) };
      queue.push(entry);
      this.waiting.set(tenant, queue);
      this.drain();
    });
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
      clearTimeout(next.timer);
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

/** Internal bridge; callers select only fixed framework worker modules. */
export async function runSQLiteTask<T>(
  module: SQLiteTaskModule,
  operation: string,
  args: readonly unknown[],
  directories: readonly PinnedSQLiteDirectory[] = [],
): Promise<T> {
  const release = await scheduler.acquire(await taskTenant(module, operation, args));
  let sandbox: Awaited<ReturnType<typeof prepareSQLiteSandbox>> | undefined;
  try {
    const moduleName = "node:child_process";
    const { spawn } = await import(moduleName);
    const process = (globalThis as any).process;
    let executable = process.execPath;
    const childArguments = ["--jitless", "--max-old-space-size=128", "--input-type=module", "--eval", BOOTSTRAP];
    if (process.platform === "linux") {
      sandbox = await prepareSQLiteSandbox(module, operation, args, childArguments, directories);
      executable = sandbox.executable;
      childArguments.splice(0, childArguments.length, ...sandbox.arguments);
    }
    const request = JSON.stringify({
      module: sandbox?.moduleUrl ?? new URL(WORKER_MODULES[module], import.meta.url).href,
      operation,
      arguments: sandbox?.argumentsValue ?? args,
    });
    if (new TextEncoder().encode(request).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error("SQLite task request exceeds its limit.");
    }
    const child = spawn(executable, childArguments, {
      stdio: ["pipe", "pipe", "ignore", ...(sandbox?.descriptors ?? [])],
      windowsHide: true,
      env: {
        NODE_NO_WARNINGS: "1",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        // Node's test runner aggregates subprocess coverage through this path.
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      },
    });
    return await new Promise<T>((resolve, reject) => {
      let output = "";
      let outputBytes = 0;
      let failure: Error | undefined;
      const terminate = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const timeout = setTimeout(() => {
        terminate(new Error(`SQLite task exceeded its ${TASK_TIMEOUT_MS}ms deadline.`));
      }, TASK_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputBytes += new TextEncoder().encode(chunk).byteLength;
        if (outputBytes > MAX_MESSAGE_BYTES) {
          terminate(new Error("SQLite task response exceeds its limit."));
          return;
        }
        output += chunk;
      });
      child.on("error", (error: Error) => { failure ??= error; });
      // EPIPE is expected if the worker hits its memory/deadline bound while
      // reading. Rejection waits for close so rollback cannot race a live worker.
      child.stdin.on("error", (error: Error) => { failure ??= error; });
      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
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
      child.stdin.end(request);
    });
  } finally {
    try { await sandbox?.close(); } finally { release(); }
  }
}
