import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildFramework } from "../scripts/build.mjs";
import { compile } from "../scripts/compiler.mjs";
import { groups } from "./content-manifest.mjs";

const siteRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(siteRoot, "..");
const sourceRoot = join(siteRoot, "src");
const outputRoot = join(siteRoot, "dist");
const contentRoot = join(siteRoot, "content");
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
  const temporary = `${path}.clank-docs-${process.pid}-${temporaryFile++}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function plainText(markdown) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[`*_>#|~-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function documentMetadata(slug, source, markdown, group) {
  const title = markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? slug.replaceAll("-", " ");
  const paragraphs = markdown
    .replace(/^#\s+.+$/mu, "")
    .split(/\n\s*\n/u)
    .map((entry) => plainText(entry))
    .filter((entry) => entry.length > 50 && !entry.startsWith("```"));
  const description = (paragraphs[0] ?? `Documentation for ${title}.`).slice(0, 240);
  const headings = [...markdown.matchAll(/^#{2,4}\s+(.+)$/gmu)].map((match) => plainText(match[1])).filter(Boolean);
  const words = plainText(markdown).split(/\s+/u).filter(Boolean).length;
  return {
    slug,
    source,
    groupId: group.id,
    groupTitle: group.title,
    title,
    description,
    headings,
    words,
    readingMinutes: Math.max(1, Math.ceil(words / 220))
  };
}

await buildFramework({ quiet: true });
await Promise.all([
  rm(outputRoot, { recursive: true, force: true }),
  rm(contentRoot, { recursive: true, force: true }),
  rm(join(siteRoot, "vendor"), { recursive: true, force: true })
]);
await Promise.all([
  mkdir(outputRoot, { recursive: true }),
  mkdir(contentRoot, { recursive: true }),
  mkdir(vendorRoot, { recursive: true })
]);

for (const path of await filesUnder(sourceRoot)) {
  const target = join(outputRoot, relative(sourceRoot, path));
  if (/\.tsx?$/u.test(path)) {
    await writeAtomically(
      target.replace(/\.tsx?$/u, ".js"),
      compile(await readFile(path, "utf8"), {
        filename: path,
        jsxImportSource: "../vendor/dom.js"
      })
    );
  } else {
    await writeAtomically(target, await readFile(path));
  }
}

await cp(join(projectRoot, "brand"), join(outputRoot, "brand"), { recursive: true });
await cp(join(projectRoot, "dist"), vendorRoot, { recursive: true });
await Promise.all([
  cp(join(projectRoot, "package.json"), join(vendorRoot, "package.json")),
  cp(join(projectRoot, "LICENSE"), join(vendorRoot, "LICENSE"))
]);

const canonicalDocs = new Set((await readdir(join(projectRoot, "docs")))
  .filter((name) => extname(name) === ".md")
  .map((name) => `docs/${name}`));
const listedDocs = new Set();
const metadata = [];
for (const group of groups) {
  for (const [slug, source] of group.entries) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error(`Invalid documentation slug: ${slug}`);
    if (metadata.some((entry) => entry.slug === slug)) throw new Error(`Duplicate documentation slug: ${slug}`);
    if (source.startsWith("docs/")) listedDocs.add(source);
    const markdown = await readFile(join(projectRoot, source), "utf8");
    await writeAtomically(join(contentRoot, `${slug}.md`), markdown);
    metadata.push(documentMetadata(slug, source, markdown, group));
  }
}
const missing = [...canonicalDocs].filter((source) => !listedDocs.has(source));
const unknown = [...listedDocs].filter((source) => !canonicalDocs.has(source));
if (missing.length || unknown.length) {
  throw new Error(`Documentation manifest drift. Missing: ${missing.join(", ") || "none"}. Unknown: ${unknown.join(", ") || "none"}.`);
}

const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const assetHash = createHash("sha256");
for (const directory of [outputRoot, contentRoot]) {
  for (const path of (await filesUnder(directory)).sort()) {
    assetHash.update(relative(siteRoot, path));
    assetHash.update(await readFile(path));
  }
}
const assetVersion = assetHash.digest("hex").slice(0, 16);
const appPath = join(outputRoot, "app.js");
await writeAtomically(
  appPath,
  (await readFile(appPath, "utf8")).replaceAll("\"./search.js\"", `"./search.${assetVersion}.js"`),
);
await writeAtomically(join(contentRoot, "manifest.json"), `${JSON.stringify({
  protocol: "clank-docs/1",
  frameworkVersion: packageJson.version,
  assetVersion,
  groups: groups.map(({ id, title, description, entries }) => ({
    id,
    title,
    description,
    slugs: entries.map(([slug]) => slug)
  })),
  docs: metadata
}, null, 2)}\n`);

console.log(`Built Clank Docs: ${metadata.length} guides, ${metadata.reduce((sum, entry) => sum + entry.words, 0).toLocaleString()} words, zero dependencies.`);
