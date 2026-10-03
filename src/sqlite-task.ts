// Tenant-controlled schemas, triggers and SQL must never execute on the shared
// control-plane event loop. This is resource isolation, not a filesystem sandbox.
const MAX_ACTIVE_TASKS = 2;
const MAX_WAITING_TASKS = 16;
export const SQLITE_TASK_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = SQLITE_TASK_MAX_MESSAGE_BYTES;
const TASK_TIMEOUT_MS = 10_000;
let activeTasks = 0;
const waitingTasks: Array<() => void> = [];

type SQLiteTaskModule = "migrations" | "jobs" | "inspection";
const WORKER_MODULES: Record<SQLiteTaskModule, string> = {
  migrations: "./migrations-worker.js",
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
): Promise<T> {
  if (activeTasks >= MAX_ACTIVE_TASKS) {
    if (waitingTasks.length >= MAX_WAITING_TASKS) {
      throw new Error("SQLite task capacity is exhausted. Retry after current operations finish.");
    }
    await new Promise<void>((resolve) => waitingTasks.push(resolve));
  } else {
    activeTasks++;
  }
  try {
    const request = JSON.stringify({
      module: new URL(WORKER_MODULES[module], import.meta.url).href,
      operation,
      arguments: args,
    });
    if (new TextEncoder().encode(request).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error("SQLite task request exceeds its limit.");
    }
    const moduleName = "node:child_process";
    const { spawn } = await import(moduleName);
    const process = (globalThis as any).process;
    let executable = process.execPath;
    const childArguments = ["--jitless", "--max-old-space-size=128", "--input-type=module", "--eval", BOOTSTRAP];
    if (process.platform === "linux") {
      // Official Node builds disable SQLite memory accounting, so its heap
      // pragma cannot be the native-allocation security boundary. Linux limits
      // must be imposed before loading any tenant data. Jitless mode avoids V8's
      // large executable code reservation under the address-space/data limits.
      const fsName = "node:fs/promises";
      const fs = await import(fsName);
      executable = "";
      for (const candidate of ["/usr/bin/prlimit", "/bin/prlimit"]) {
        try { await fs.access(candidate, 1); executable = candidate; break; } catch { /* Try the next trusted system path. */ }
      }
      if (!executable) throw new Error("Bounded SQLite tasks on Linux require the util-linux prlimit executable.");
      childArguments.unshift("--data=268435456:268435456", "--as=1073741824:1073741824",
        "--cpu=10:10", "--core=0:0", "--", process.execPath);
    }
    const child = spawn(executable, childArguments, {
      stdio: ["pipe", "pipe", "ignore"],
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
    const next = waitingTasks.shift();
    if (next) next();
    else activeTasks--;
  }
}
