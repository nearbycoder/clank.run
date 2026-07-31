import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const checkedLinks = [];

const markdownFiles = [
  ...(await rootMarkdownFiles()),
  ...(await walkMarkdown(path.join(root, "docs"))),
];

for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    const target = match[1].replace(/^<|>$/gu, "");
    if (isExternal(target) || target.startsWith("#")) continue;

    const pathname = target.split("#", 1)[0].split("?", 1)[0];
    if (!pathname) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      failures.push(`${relative(file)} contains an invalid encoded link: ${target}`);
      continue;
    }

    const destination = path.resolve(path.dirname(file), decoded);
    if (!isInsideRoot(destination)) {
      failures.push(`${relative(file)} links outside the repository: ${target}`);
      continue;
    }

    try {
      await stat(destination);
      checkedLinks.push(`${relative(file)} -> ${relative(destination)}`);
    } catch {
      failures.push(`${relative(file)} contains a broken local link: ${target}`);
    }
  }
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
const documentation = await walkMarkdown(path.join(root, "docs"));
for (const file of documentation) {
  const target = relative(file);
  const slug = path.basename(target, ".md");
  const canonical = `https://docs.clank.run/docs/${slug}`;
  if (!readme.includes(`](${target})`) && !readme.includes(`](${canonical})`)) {
    failures.push(`README.md does not index ${target}.`);
  }
}

const sourceDirectory = path.join(root, "src");
const distributionDirectory = path.join(root, "dist");
const declarations = (await readdir(sourceDirectory))
  .filter((name) => name.endsWith(".d.ts"))
  .sort();
for (const declaration of declarations) {
  const source = await readFile(path.join(sourceDirectory, declaration), "utf8");
  let built;
  try {
    built = await readFile(path.join(distributionDirectory, declaration), "utf8");
  } catch {
    failures.push(`dist/${declaration} is missing; run the build before the documentation audit.`);
    continue;
  }
  if (built !== source) failures.push(`dist/${declaration} does not match src/${declaration}.`);
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
for (const [name, entry] of Object.entries(packageJson.exports ?? {})) {
  for (const field of ["types", "import"]) {
    const target = entry?.[field];
    if (typeof target !== "string") {
      failures.push(`package export ${name} is missing its ${field} target.`);
      continue;
    }
    const destination = path.resolve(root, target);
    if (!isInsideRoot(destination)) {
      failures.push(`package export ${name} points outside the repository: ${target}`);
      continue;
    }
    try {
      await stat(destination);
    } catch {
      failures.push(`package export ${name} has a missing ${field} target: ${target}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`documentation audit failed: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation audit passed: ${markdownFiles.length} Markdown files, `
      + `${checkedLinks.length} local links, ${documentation.length} indexed guides, `
      + `${declarations.length} synchronized declaration files, and `
      + `${Object.keys(packageJson.exports ?? {}).length} package exports.`,
  );
}

async function rootMarkdownFiles() {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

async function walkMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkMarkdown(target));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
  }
  return files.sort();
}

function isExternal(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target);
}

function isInsideRoot(target) {
  const result = path.relative(root, target);
  return result === "" || (!result.startsWith(`..${path.sep}`) && result !== ".." && !path.isAbsolute(result));
}

function relative(target) {
  return path.relative(root, target).split(path.sep).join("/");
}
