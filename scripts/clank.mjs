#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, watch, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

if (command !== "build" && command !== "watch") {
  const { run } = await import("./cli-deploy.mjs");
  if (args.includes("--help") || args.includes("-h")) {
    await run("help", [command, ...(args.includes("--json") ? ["--json"] : [])]);
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
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
      : reject(new Error(
          configured
            ? `Tailwind build exited with ${code ?? signal}.`
            : "Tailwind CLI is unavailable. Run npm install or set CLANK_TAILWIND_EXECUTABLE to the standalone binary.",
        )));
  }));
}

async function build() {
  const started = performance.now();
  await mkdir(output, { recursive: true });
  const files = await filesUnder(input);
  const expectedOutputs = new Set(files.map(outputFor));
  if (resolvedTailwindInput) expectedOutputs.add(join(output, "styles.css"));
  await Promise.all(files.map(compileFile));
  await compileTailwind();
  for (const path of await filesUnder(output)) {
    if (!path.includes(".clank-build-") && !expectedOutputs.has(path)) await rm(path, { force: true });
  }
  console.log(`Compiled ${files.length} files in ${(performance.now() - started).toFixed(1)}ms.`);
}

try {
  await build();
} catch (error) {
  console.error(`clank: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (command === "watch") {
  console.log(`Watching ${input}`);
  let queued;
  for await (const event of watch(input, { recursive: true })) {
    if (event.filename && !/\.(?:tsx?|html|css|json|svg)$/.test(event.filename)) continue;
    clearTimeout(queued);
    queued = setTimeout(() => void build().catch((error) => {
      console.error(`clank: ${error instanceof Error ? error.message : String(error)}`);
    }), 40);
  }
}
