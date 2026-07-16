#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rename, rm, watch, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compile } from "./compiler.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "build";
let temporaryFile = 0;

if (command === "--help" || command === "help") {
  const { run } = await import("./cli-deploy.mjs");
  await run("help", args);
  process.exit(0);
}

if (command === "--version" || command === "-v" || command === "version") {
  const { run } = await import("./cli-deploy.mjs");
  await run("version", args);
  process.exit(0);
}

if (command !== "build" && command !== "watch") {
  const { run } = await import("./cli-deploy.mjs");
  await run(command, args);
  process.exit(0);
}

if (args.includes("--help")) {
  console.log(`Clank compiler

Usage:
  clank build [input=src] [output=dist] [--jsx-import-source=clank]
  clank watch [input=src] [output=dist] [--jsx-import-source=clank]

Compiles .ts and .tsx modules, copies static files, and installs no packages.`);
  process.exit(0);
}

const positionals = args.filter((argument) => !argument.startsWith("--"));
const option = (name, fallback) => args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const input = resolve(positionals[0] ?? "src");
const output = resolve(positionals[1] ?? "dist");
const jsxImportSource = option("jsx-import-source", "clank");

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
if (inside(input, output) || inside(output, input)) {
  console.error("Input and output directories must not overlap.");
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

async function build() {
  const started = performance.now();
  await mkdir(output, { recursive: true });
  const files = await filesUnder(input);
  const expectedOutputs = new Set(files.map(outputFor));
  await Promise.all(files.map(compileFile));
  for (const path of await filesUnder(output)) {
    if (!path.includes(".clank-build-") && !expectedOutputs.has(path)) await rm(path, { force: true });
  }
  console.log(`Compiled ${files.length} files in ${(performance.now() - started).toFixed(1)}ms.`);
}

await build();

if (command === "watch") {
  console.log(`Watching ${input}`);
  let queued;
  for await (const event of watch(input, { recursive: true })) {
    if (event.filename && !/\.(?:tsx?|html|css|json|svg)$/.test(event.filename)) continue;
    clearTimeout(queued);
    queued = setTimeout(() => void build().catch(console.error), 40);
  }
}
