import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "./compiler.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let temporaryFile = 0;

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not compiled: ${path}`);
    else output.push(path);
  }
  return output;
}

async function writeFileAtomically(outputPath, contents) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.clank-build-${process.pid}-${temporaryFile++}`;
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function compileFile(sourcePath, outputPath, options = {}) {
  const source = await readFile(sourcePath, "utf8");
  const javascript = compile(source, {
    filename: sourcePath,
    jsxImportSource: options.jsxImportSource,
  });
  await writeFileAtomically(outputPath, javascript);
}

export async function build({ quiet = false } = {}) {
  const started = performance.now();
  const sourceRoot = join(projectRoot, "src");
  const outputRoot = join(projectRoot, "dist");
  await mkdir(outputRoot, { recursive: true });
  const sources = await filesUnder(sourceRoot);
  const expectedOutputs = new Set();
  for (const path of sources) {
    const output = join(outputRoot, relative(sourceRoot, path));
    if (path.endsWith(".d.ts")) {
      expectedOutputs.add(output);
      await writeFileAtomically(output, await readFile(path));
    } else if (/\.tsx?$/.test(path)) {
      const javascriptOutput = output.replace(/\.tsx?$/, ".js");
      expectedOutputs.add(javascriptOutput);
      await compileFile(path, javascriptOutput, { jsxImportSource: "./index.js" });
    }
  }
  for (const path of await filesUnder(outputRoot)) {
    if (!path.includes(".clank-build-") && !expectedOutputs.has(path)) await rm(path, { force: true });
  }

  const exampleRoot = join(projectRoot, "examples");
  for (const path of await filesUnder(exampleRoot)) {
    if (/\.tsx?$/.test(path)) await compileFile(path, path.replace(/\.tsx?$/, ".js"), { jsxImportSource: "/dist/index.js" });
  }
  if (!quiet) console.log(`Built Clank in ${(performance.now() - started).toFixed(1)}ms (zero dependencies).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}
