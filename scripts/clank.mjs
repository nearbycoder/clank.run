#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compile } from "./compiler.mjs";

const args = process.argv.slice(2);
const command = args.shift();
let temporaryFile = 0;

if (!command) {
  const { run, runInteractive } = await import("./cli-deploy.mjs");
  if (process.stdin.isTTY && process.stdout.isTTY) await runInteractive();
  else await run("help", []);
  process.exit(process.exitCode ?? 0);
}

if (command === "--help" || command === "-h" || command === "help") {
  const { run } = await import("./cli-deploy.mjs");
  await run("help", args);
  process.exit(process.exitCode ?? 0);
}

if (command === "--version" || command === "-v" || command === "version") {
  const { run } = await import("./cli-deploy.mjs");
  await run("version", args);
  process.exit(process.exitCode ?? 0);
}

if (command === "editor") {
  if (args.includes("--help") || args.includes("-h")) console.log("clank editor [directory] — Clank Language Server Protocol over stdio (full document synchronization)");
  else {
    if (args.length > 1 || args[0]?.startsWith("--")) throw new Error("Usage: clank editor [directory]");
    const { runEditor } = await import("./editor.mjs");
    await runEditor({ root: resolve(args[0] ?? ".") });
  }
  process.exit(process.exitCode ?? 0);
}

if (command === "dev") {
  if (args.includes("--help") || args.includes("-h")) {
    const { run } = await import("./cli-deploy.mjs");
    await run("help", ["dev", ...(args.includes("--json") ? ["--json"] : [])]);
    process.exit(process.exitCode ?? 0);
  }
  try {
    const { runDev } = await import("./clank-dev.mjs");
    await runDev(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        protocol: "clank-dev-event/1",
        type: "fatal",
        message,
      }));
    } else {
      console.error(`clank: ${message}`);
    }
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

if (command === "workbench" && !args.includes("--help") && !args.includes("-h")) {
  try {
    const { runWorkbench } = await import("./cli-workbench.mjs");
    await runWorkbench(args);
  } catch (error) {
    console.error(`clank: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

if (command !== "build" && command !== "watch") {
  const { run } = await import("./cli-deploy.mjs");
  const end = args.indexOf("--"), options = end === -1 ? args : args.slice(0, end);
  if (options.includes("--help") || options.includes("-h")) {
    await run("help", [command, ...(options.includes("--json") ? ["--json"] : [])]);
    process.exit(process.exitCode ?? 0);
  }
  await run(command, args);
  process.exit(process.exitCode ?? 0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Clank compiler

Usage:
  clank build [input=src] [output=dist] [--jsx-import-source=@clank.run/framework] [--tailwind=src/styles.css]
  clank watch [input=src] [output=dist] [--jsx-import-source=@clank.run/framework] [--tailwind=src/styles.css]

Compiles .ts and .tsx modules, copies static files, and optionally invokes the local Tailwind CLI without a shell.`);
  process.exit(process.exitCode ?? 0);
}

for (const argument of args) {
  if (
    argument.startsWith("--")
    && !argument.startsWith("--jsx-import-source=")
    && !argument.startsWith("--tailwind=")
  ) {
    console.error(`clank: Unknown option ${argument} for clank ${command}.`);
    process.exit(1);
  }
  if (argument === "--jsx-import-source=") {
    console.error("clank: --jsx-import-source requires a value.");
    process.exit(1);
  }
  if (argument === "--tailwind=") {
    console.error("clank: --tailwind requires a stylesheet path.");
    process.exit(1);
  }
}
const positionals = args.filter((argument) => !argument.startsWith("--"));
if (positionals.length > 2) {
  console.error(`clank: Too many arguments for clank ${command}. Run clank ${command} --help.`);
  process.exit(1);
}
const option = (name, fallback) => args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const input = resolve(positionals[0] ?? "src");
const output = resolve(positionals[1] ?? "dist");
const jsxImportSource = option("jsx-import-source", "@clank.run/framework");
const tailwindInput = option("tailwind", null);

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
if (inside(input, output) || inside(output, input)) {
  console.error("Input and output directories must not overlap.");
  process.exit(1);
}
const resolvedTailwindInput = tailwindInput === null ? null : resolve(tailwindInput);
if (resolvedTailwindInput && !inside(input, resolvedTailwindInput)) {
  console.error("Tailwind input must be inside the compiler input directory.");
  process.exit(1);
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not compiled: ${path}`);
    else files.push(path);
  }
  return files;
}

async function writeTargetAtomically(target, writer) {
  await mkdir(dirname(target), { recursive: true });
  const temporaryPath = `${target}.clank-build-${process.pid}-${temporaryFile++}`;
  try {
    await writer(temporaryPath);
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function outputFor(path) {
  const target = join(output, relative(input, path));
  return /\.tsx?$/.test(path) && !path.endsWith(".d.ts")
    ? target.replace(/\.tsx?$/, ".js")
    : target;
}

async function compileFile(path) {
  const target = outputFor(path);
  if (/\.tsx?$/.test(path) && !path.endsWith(".d.ts")) {
    const source = await readFile(path, "utf8");
    await writeTargetAtomically(target, (temporaryPath) =>
      writeFile(temporaryPath, compile(source, { filename: path, jsxImportSource })));
  } else {
    await writeTargetAtomically(target, (temporaryPath) => cp(path, temporaryPath));
  }
}

async function compileTailwind() {
  if (!resolvedTailwindInput) return;
  const configured = process.env.CLANK_TAILWIND_EXECUTABLE;
  const executable = configured
    ? (isAbsolute(configured) ? configured : resolve(configured))
    : process.execPath;
  const executableArguments = configured
    ? []
    : [resolve("node_modules", "@tailwindcss", "cli", "dist", "index.mjs")];
  if (!configured) {
    try { await access(executableArguments[0]); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new Error("Tailwind CLI is unavailable. Run npm install or set CLANK_TAILWIND_EXECUTABLE to the standalone binary.");
    }
  }
  const target = join(output, "styles.css");
  await writeTargetAtomically(target, (temporaryPath) => new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [
      ...executableArguments,
      "-i",
      resolvedTailwindInput,
      "-o",
      temporaryPath,
      "--minify",
    ], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (error) => {
      if (error?.code === "ENOENT") {
        reject(new Error(
          "Tailwind CLI is unavailable. Run npm install or set CLANK_TAILWIND_EXECUTABLE to the standalone binary.",
        ));
      } else {
        reject(error);
      }
    });
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`Tailwind build exited with ${code ?? signal}.`)));
  }));
}

let compiledSources = "";
async function build() {
  const started = performance.now();
  const files = await filesUnder(input);
  const sourcesByOutput = new Map();
  for (const path of files) {
    const target = outputFor(path);
    const previous = sourcesByOutput.get(target);
    if (previous) {
      throw new Error(`Output collision: ${relative(input, previous)} and ${relative(input, path)} both produce ${relative(output, target)}.`);
    }
    sourcesByOutput.set(target, path);
  }
  const expectedOutputs = new Set(sourcesByOutput.keys());
  if (resolvedTailwindInput) expectedOutputs.add(join(output, "styles.css"));
  await mkdir(output, { recursive: true });
  // Limit open files and temporary writes, and settle every worker before the
  // build reports failure so a subsequent watch build cannot overlap it.
  let nextFile = 0;
  let failed = false;
  let failure;
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
    while (!failed && nextFile < files.length) {
      const path = files[nextFile++];
      try { await compileFile(path); }
      catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  }));
  if (failed) throw failure;
  await compileTailwind();
  for (const path of await filesUnder(output)) {
    if (!path.includes(".clank-build-") && !expectedOutputs.has(path)) await rm(path, { force: true });
  }
  compiledSources = JSON.stringify(files.sort());
  console.log(`Compiled ${files.length} files in ${(performance.now() - started).toFixed(1)}ms.`);
}

try {
  await build();
} catch (error) {
  console.error(`clank: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (command === "watch") {
  let queued;
  let rebuilding = false;
  let dirty = false;
  let stopped = false;
  const rebuild = async () => {
    if (rebuilding) { dirty = true; return; }
    rebuilding = true;
    do {
      dirty = false;
      try { await build(); }
      catch (error) { console.error(`clank: ${error instanceof Error ? error.message : String(error)}`); }
    } while (dirty && !stopped);
    rebuilding = false;
  };
  // Recursive native watchers can lose a directory deletion during a rename,
  // including on minimum Node. Reconcile names periodically, without polling
  // file contents or creating a second writer. A failed unchanged inventory
  // waits for another change rather than retrying a bad build indefinitely.
  let observedSources = compiledSources;
  let reconciliation;
  const reconcile = async () => {
    try {
      const inventory = JSON.stringify((await filesUnder(input)).sort());
      if (!stopped && inventory !== observedSources) {
        observedSources = inventory;
        if (inventory !== compiledSources) await rebuild();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`clank: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!stopped) reconciliation = setTimeout(() => void reconcile(), 1000);
    }
  };
  reconciliation = setTimeout(() => void reconcile(), 1000);
  // Every source entry is copied or compiled. Directory events and arbitrary
  // static extensions must trigger the same rebuild as TypeScript changes.
  const schedule = () => {
    if (stopped) return;
    clearTimeout(queued);
    queued = setTimeout(() => void rebuild(), 40);
  };
  // Minimum Node's recursive async iterator omits an error listener. Keep a
  // permanent listener for transient scandir ENOENT during directory moves.
  const events = watch(input, {recursive: true}, schedule);
  events.on("error", error => {
    if (error?.code === "ENOENT") schedule();
    else { console.error(`clank: ${error.message}`); process.exitCode = 1; events.close(); }
  });
  const stop = () => events.close();
  const closed = new Promise(resolve => events.once("close", resolve));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Watching ${input}`);
  try {
    await closed;
  } finally {
    stopped = true;
    clearTimeout(reconciliation);
    clearTimeout(queued);
    events.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    while (rebuilding) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
