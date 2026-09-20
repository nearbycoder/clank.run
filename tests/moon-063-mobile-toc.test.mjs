import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const docsRoot = new URL("../docs-site/", import.meta.url);
const guide = [
  "# Fixture guide",
  "## Install & configure",
  '### <img src=x onerror="bad()"> & "quoted"',
  "## Install & configure",
  "# Appendix",
  `### ${"LongHeading".repeat(30)}`,
  "#### Detailed note",
].join("\n\n");

async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), "clank-mobile-toc-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await stopped;
      clearTimeout(timeout);
    }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, "dist"));
  await mkdir(join(directory, "content"));
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  await symlink(fileURLToPath(new URL("vendor/", docsRoot)), join(directory, "vendor"));
  const docs = ["guide", "empty"].map((slug) => ({
    slug, title: `${slug} fixture`, description: "A documentation fixture.",
    source: `docs/${slug}.md`, groupId: "test", groupTitle: "Test guides",
    words: 50, readingMinutes: 1, headings: [],
  }));
  await writeFile(join(directory, "content", "manifest.json"), JSON.stringify({
    protocol: "clank-docs/1", frameworkVersion: "0.0.0", assetVersion: "test", browserAssets: {}, docs,
    groups: [{ id: "test", title: "Test guides", description: "Test guides", slugs: docs.map((doc) => doc.slug) }],
  }));
  await writeFile(join(directory, "content", "guide.md"), guide);
  await writeFile(join(directory, "content", "empty.md"), "# Empty guide\n\nAn overview without sections.\n");
  for (const name of ["server.tsx", "search.tsx", "markdown.ts", "highlight.ts"]) {
    const path = fileURLToPath(new URL(`src/${name}`, docsRoot));
    await writeFile(join(directory, "dist", name.replace(/\.tsx?$/u, ".js")), compile(await readFile(path, "utf8"), {
      filename: path, jsxImportSource: "../vendor/dom.js", sourceMap: false,
    }));
  }
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "dist/server.js"], {
    cwd: directory,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DOCS_ORIGIN: "https://docs.clank.run" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Docs fixture did not start: ${output}\n${errors}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const origin = output.match(/Clank Documentation: (https?:\/\/[^\s]+)/u)?.[1];
      if (origin) { clearTimeout(timeout); resolve(origin); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Docs fixture exited (${code}): ${errors}`)); });
  });
}

function links(html) {
  const markup = html.replaceAll("<!--clank:start-->", "").replaceAll("<!--clank:end-->", "");
  return [...markup.matchAll(/<a\b(?=[^>]*class="toc-level-(\d)")(?=[^>]*href="#([^"]+)")[^>]*>([^<]*)<\/a>/gu)]
    .map(([, level, id, title]) => ({ level: Number(level), id, title }));
}

test("mobile guide navigation renders a closed native disclosure with matching desktop section links", async (t) => {
  const origin = await startServer(t);
  const response = await fetch(`${origin}/docs/guide`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const mobile = html.match(/<details class="mobile-toc">([\s\S]*?)<\/details>/u)?.[1];
  assert.ok(mobile, "The guide includes a closed disclosure without requiring client enhancement");
  assert.match(mobile, /^<summary>On this page<\/summary><nav aria-label="On this page">/u);
  assert.doesNotMatch(mobile, /tabindex|aria-expanded|role="button"|onclick|hidden/u);
  const header = html.match(/<header class="doc-header">([\s\S]*?)<\/header>/u)?.[1];
  assert.ok(header?.includes(mobile), "Section navigation is available before the article body");
  const desktop = html.match(/<aside\b(?=[^>]*class="toc")(?=[^>]*aria-label="On this page")[^>]*>([\s\S]*?)<\/aside>/u)?.[1];
  assert.ok(desktop, "The desktop sidebar is preserved");
  const sections = links(mobile);
  assert.equal(sections.length, 5, "Use the existing table of contents levels, excluding h4 and the article title");
  assert.deepEqual(sections, links(desktop));
  assert.deepEqual(sections.map(({ level }) => level), [2, 3, 2, 1, 3]);
  assert.equal(sections[0].id, "install-configure");
  assert.equal(sections[2].id, "install-configure-2", "Repeated headings keep their distinct fragment targets");
  assert.equal(sections[0].title, "Install &amp; configure");
  assert.equal(sections[1].title, '&lt;img src=x onerror="bad()"&gt; &amp; "quoted"');
  assert.doesNotMatch(mobile, /<img/u);
  const body = html.split('id="docs-article-body"')[1];
  for (const { level, id } of sections) {
    assert.ok(body.includes(`<h${level} id="${id}">`), `The fragment ${id} targets an existing heading`);
  }

  for (const path of ["/", "/search?q=guide", "/docs/empty", "/does-not-exist"]) {
    const page = await (await fetch(`${origin}${path}`)).text();
    assert.doesNotMatch(page, /class="mobile-toc"/u, `${path} must not show an empty or unrelated disclosure`);
  }
});

test("mobile section navigation has responsive, focus-reading, touch, wrapping, and print styles", async () => {
  const styles = await readFile(new URL("src/styles.css", docsRoot), "utf8");
  assert.match(styles, /\.mobile-toc\s*\{[^}]*display:\s*none;/u, "Avoid duplicate navigation on a full desktop layout");
  const narrow = styles.split("@media (max-width: 1180px)")[1]?.split("@media")[0];
  assert.ok(narrow);
  assert.match(narrow, /\.toc\s*\{\s*display:\s*none;/u);
  assert.match(narrow, /\.mobile-toc\s*\{\s*display:\s*block;/u);
  assert.match(styles, /body\[data-docs-focus\] \.mobile-toc\s*\{\s*display:\s*block;/u);
  assert.match(styles, /\.mobile-toc summary\s*\{[^}]*min-height:\s*44px;/u);
  assert.match(styles, /\.mobile-toc nav a\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*44px;[^}]*overflow-wrap:\s*anywhere;/u);
  assert.match(styles, /\.mobile-toc nav\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/u);
  assert.match(styles, /\.toc-level-3\s*\{[^}]*padding-left:\s*12px/u, "Nested sections retain their indentation");
  assert.match(styles, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--clank-focus\)/u);
  const printStyles = styles.split("@media print")[1];
  assert.match(printStyles, /body\.guide-page :is\([^)]*\.mobile-toc[^)]*\)\s*\{\s*display:\s*none !important;/u);
});
