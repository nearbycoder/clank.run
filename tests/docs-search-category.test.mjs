import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const docsRoot = new URL("../docs-site/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("content/manifest.json", docsRoot), "utf8"));
const metadata = new Map(manifest.docs.map((doc) => [doc.slug, doc]));

async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), "clank-docs-category-"));
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
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  for (const name of ["content", "vendor"]) {
    await symlink(fileURLToPath(new URL(`${name}/`, docsRoot)), join(directory, name));
  }
  for (const name of ["server.tsx", "search.tsx", "markdown.ts", "highlight.ts"]) {
    const path = fileURLToPath(new URL(`src/${name}`, docsRoot));
    await writeFile(join(directory, "dist", name.replace(/\.tsx?$/u, ".js")), compile(await readFile(path, "utf8"), {
      filename: path,
      jsxImportSource: "../vendor/dom.js",
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

function searchSection(html) {
  const section = html.match(/<section class="search-page">([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(section, "Expected server-rendered full search");
  return section;
}

function resultSlugs(html) {
  const results = searchSection(html).split('<div class="search-results">')[1];
  assert.ok(results);
  return [...results.matchAll(/<a href="\/docs\/([a-z0-9-]+)"/gu)].map((match) => match[1]);
}

function bootState(html) {
  const encoded = html.match(/<script type="application\/json"[^>]*id="__CLANK_STATE__">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(encoded, "Expected hydration state");
  return JSON.parse(encoded);
}

function selectedGroup(html) {
  const select = searchSection(html).match(/<select id="search-category" name="group">([\s\S]*?)<\/select>/u)?.[1];
  assert.ok(select, "Category select should be present without JavaScript");
  const selected = [...select.matchAll(/<option value="([^"]*)" selected(?:="")?>/gu)];
  assert.equal(selected.length, 1, "Exactly one category is selected");
  return selected[0][1];
}

test("docs search category filter preserves ranked results, query, and no-script submission", async (t) => {
  const origin = await startServer(t);
  const all = await (await fetch(`${origin}/search?q=clank`)).text();
  const slugs = resultSlugs(all);
  assert.ok(slugs.length > 10);
  assert.equal(selectedGroup(all), "");
  assert.match(searchSection(all), new RegExp(`${slugs.length} matching guides across the complete documentation corpus`, "u"));
  assert.match(searchSection(all), /<label for="search-category">Category<\/label>/u);
  assert.match(searchSection(all), /<form(?=[^>]*class="search-filters")(?=[^>]*action="\/search")(?=[^>]*method="get")/u);
  assert.match(searchSection(all), /<input type="hidden" name="q" value="clank"/u);
  assert.match(searchSection(all), /<button type="submit">Apply filter<\/button>/u);
  for (const group of manifest.groups) {
    const response = await fetch(`${origin}/search?q=clank&group=${group.id}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const expected = slugs.filter((slug) => metadata.get(slug).groupId === group.id);
    assert.deepEqual(resultSlugs(html), expected, `Restrict to ${group.id}, retaining the original ranking`);
    assert.equal(selectedGroup(html), group.id);
    assert.match(searchSection(html), new RegExp(`${expected.length} matching guide${expected.length === 1 ? "" : "s"} in `, "u"));
    assert.match(searchSection(html), /href="\/search\?q=clank">Reset to all categories<\/a>/u);
    const headerForm = html.match(/<form[^>]*class="search-box"[\s\S]*?<\/form>/u)?.[0];
    assert.ok(headerForm.includes(`name="group" value="${group.id}"`), "Header search retains the selected category");
    const quickResults = [...headerForm.matchAll(/<a href="\/docs\/([a-z0-9-]+)"/gu)].map((match) => match[1]);
    assert.ok(quickResults.every((slug) => metadata.get(slug).groupId === group.id), "Quick-search suggestions respect the active category");
    assert.equal(bootState(html).searchGroup, group.id, "Hydration retains the selected category");
    assert.equal(bootState(html).initialQuery, "clank");
    assert.match(html, new RegExp(`rel="canonical" href="https://docs\\.clank\\.run/search\\?q=clank&amp;group=${group.id}"`, "u"));
  }
  const empty = await (await fetch(`${origin}/search?q=nosuchterm982762&group=start`)).text();
  assert.deepEqual(resultSlugs(empty), []);
  assert.match(searchSection(empty), /0 matching guides in Start with npm/u);
  assert.match(searchSection(empty), /No matching guides/u);
  assert.match(searchSection(empty), /reset to all categories to search the complete documentation/u);
  const noQuery = await (await fetch(`${origin}/search?group=framework`)).text();
  assert.equal(selectedGroup(noQuery), "framework");
  assert.match(searchSection(noQuery), /Enter a search term/u);
  assert.match(searchSection(noQuery), /href="\/search">Reset to all categories/u);
  assert.match(noQuery, /name="group" value="framework"/u);
});

test("docs search ignores unknown or oversized categories and escapes submitted text", async (t) => {
  const origin = await startServer(t);
  const baseline = resultSlugs(await (await fetch(`${origin}/search?q=security`)).text());
  for (const group of ["unknown-category", "FRAMEWORK", "framework ", "start/start", "x".repeat(65), 'start\"><script>alert(1)</script>']) {
    const html = await (await fetch(`${origin}/search?${new URLSearchParams({ q: "security", group })}`)).text();
    assert.deepEqual(resultSlugs(html), baseline);
    assert.equal(selectedGroup(html), "");
    assert.equal(bootState(html).searchGroup, undefined);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
    assert.doesNotMatch(html, /name="group" value=/u);
    assert.match(html, /rel="canonical" href="https:\/\/docs\.clank\.run\/search\?q=security"/u);
  }
  const query = '\"><script>alert(1)</script>&';
  const html = await (await fetch(`${origin}/search?${new URLSearchParams({ q: `  ${query}  `, group: "framework" })}`)).text();
  assert.equal(selectedGroup(html), "framework");
  assert.equal(bootState(html).initialQuery, query);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
  assert.match(searchSection(html), /&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;/u);
  assert.ok(searchSection(html).includes(`href="/search?q=${encodeURIComponent(query)}"`), "Reset preserves and URL-encodes the search query");
  const bounded = await (await fetch(`${origin}/search?${new URLSearchParams({ q: "x".repeat(121), group: "start" })}`)).text();
  assert.equal(bootState(bounded).initialQuery.length, 120);
  assert.equal(bootState(bounded).searchGroup, "start");
  const index = await (await fetch(`${origin}/api/docs.json?group=framework`)).json();
  assert.equal(index.docs.length, manifest.docs.length, "The machine-readable corpus remains complete");
});
