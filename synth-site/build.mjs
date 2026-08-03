import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildFramework } from "../scripts/build.mjs";
import { compile } from "../scripts/compiler.mjs";

const siteRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(siteRoot, "..");
const sourceRoot = join(siteRoot, "src");
const outputRoot = join(siteRoot, "dist");
const vendorRoot = join(siteRoot, "vendor");
let temporaryFile = 0;

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path}`);
    else files.push(path);
  }
  return files;
}

async function writeAtomically(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.clank-synth-${process.pid}-${temporaryFile++}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

await buildFramework({ quiet: true });
await Promise.all([
  rm(outputRoot, { recursive: true, force: true }),
  rm(vendorRoot, { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(outputRoot, { recursive: true }),
  mkdir(vendorRoot, { recursive: true }),
]);

await Promise.all([
  cp(join(projectRoot, "dist"), vendorRoot, { recursive: true }),
  cp(join(projectRoot, "package.json"), join(vendorRoot, "package.json")),
  cp(join(projectRoot, "LICENSE"), join(vendorRoot, "LICENSE")),
  cp(join(projectRoot, "brand"), join(outputRoot, "brand"), { recursive: true }),
]);

const { CLANK_THEME_PRESETS, createClankThemeStylesheet } = await import("../dist/ui-theme.js");

for (const path of await filesUnder(sourceRoot)) {
  const target = join(outputRoot, relative(sourceRoot, path));
  if (/\.tsx?$/u.test(path)) {
    const javascript = compile(await readFile(path, "utf8"), {
      filename: path,
      jsxImportSource: "../vendor/dom.js",
    });
    await writeAtomically(target.replace(/\.tsx?$/u, ".js"), javascript);
  } else {
    const contents = path.endsWith("styles.css")
      ? `${createClankThemeStylesheet(CLANK_THEME_PRESETS)}\n${await readFile(path, "utf8")}`
      : await readFile(path);
    await writeAtomically(target, contents);
  }
}

console.log(`Built Clank Synth: 16-step sequencer, 6 instruments, ${CLANK_THEME_PRESETS.length} Clank themes, zero runtime dependencies.`);
