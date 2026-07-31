import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path}`);
    else output.push(path);
  }
  return output;
}

async function writeAtomically(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.clank-design-${process.pid}-${temporaryFile++}`;
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

const vendorHash = createHash("sha256");
for (const path of (await filesUnder(vendorRoot)).sort()) {
  vendorHash.update(relative(vendorRoot, path));
  vendorHash.update(await readFile(path));
}
const vendorVersion = vendorHash.digest("hex").slice(0, 16);

function versionRelativeImports(javascript) {
  return javascript.replace(/(["'])((?:\.\.\/|\.\/)[^"'?]+\.js)\1/gu, (_match, quote, path) => `${quote}${path}?v=${vendorVersion}${quote}`);
}

for (const path of await filesUnder(vendorRoot)) {
  if (!path.endsWith(".js")) continue;
  await writeAtomically(path, versionRelativeImports(await readFile(path, "utf8")));
}

function versionVendorImports(javascript) {
  return javascript.replace(/(["'])\.\.\/vendor\/([^"'?]+\.js)\1/gu, (_match, quote, path) => `${quote}../vendor/${path}?v=${vendorVersion}${quote}`);
}

for (const path of await filesUnder(sourceRoot)) {
  const target = join(outputRoot, relative(sourceRoot, path));
  if (/\.tsx?$/u.test(path)) {
    const javascript = compile(await readFile(path, "utf8"), {
      filename: path,
      jsxImportSource: "../vendor/dom.js",
    });
    await writeAtomically(target.replace(/\.tsx?$/u, ".js"), versionVendorImports(javascript));
  } else {
    await writeAtomically(target, await readFile(path));
  }
}

const { CLANK_THEME_PRESETS, createClankThemeStylesheet } = await import("../dist/ui-theme.js");
const sourceStyles = await readFile(join(sourceRoot, "styles.css"), "utf8");
await writeAtomically(join(outputRoot, "styles.css"), `${createClankThemeStylesheet(CLANK_THEME_PRESETS)}\n${sourceStyles}`);

const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const assetHash = createHash("sha256");
for (const path of (await filesUnder(outputRoot)).sort()) {
  if (path.endsWith("manifest.json")) continue;
  assetHash.update(relative(siteRoot, path));
  assetHash.update(await readFile(path));
}
const assetVersion = assetHash.digest("hex").slice(0, 16);
await writeAtomically(join(outputRoot, "manifest.json"), `${JSON.stringify({
  protocol: "clank-design/1",
  frameworkVersion: packageJson.version,
  assetVersion,
  vendorVersion,
  componentCount: 37,
  themeCount: CLANK_THEME_PRESETS.length,
}, null, 2)}\n`);

console.log(`Built Clank Design Studio: 37 components, ${CLANK_THEME_PRESETS.length} themes, zero dependencies.`);
