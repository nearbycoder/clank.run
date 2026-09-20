import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const docsRoot = new URL("../docs-site/", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "clank-search-highlights-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await mkdir(join(directory, "dist"));
await mkdir(join(directory, "content"));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
await symlink(fileURLToPath(new URL("vendor/", docsRoot)), join(directory, "vendor"));

const entries = [
  { slug: "signals", title: "CreateApp() & Signals", groupId: "framework", groupTitle: "Framework" },
  { slug: "signals-extra", title: "More signals", groupId: "start", groupTitle: "Start" },
].map((entry) => ({ ...entry, description: "Learn createApp() and signals.", headings: [], source: `${entry.slug}.md`, words: 40, readingMinutes: 1 }));
const groups = [
  { id: "framework", title: "Framework", description: "Framework guides", slugs: ["signals"] },
  { id: "start", title: "Start", description: "Start guides", slugs: ["signals-extra"] },
];
await writeFile(join(directory, "content/manifest.json"), JSON.stringify({
  protocol: "clank-docs/1", frameworkVersion: "0.0.0", assetVersion: "test", browserAssets: {}, docs: entries, groups,
}));
for (const entry of entries) {
  await writeFile(join(directory, `content/${entry.slug}.md`), `# ${entry.title}\n\nUse createApp() with Signals & native links.\n`);
}
for (const name of ["server.tsx", "search.tsx", "markdown.ts", "highlight.ts"]) {
  const filename = fileURLToPath(new URL(`src/${name}`, docsRoot));
  let source = await readFile(filename, "utf8");
  if (name === "server.tsx") {
    // Expose the actual page component without opening a listening socket.
    const startup = source.indexOf("\nconst server = await serve(app, {");
    assert.ok(startup > 0);
    source = `${source.slice(0, startup)}\nexport { SearchPage };\n`;
  }
  await writeFile(join(directory, "dist", name.replace(/\.tsx?$/u, ".js")), compile(source, {
    filename, jsxImportSource: "../vendor/dom.js", sourceMap: false,
  }));
}
const { SearchBox, SearchHighlight } = await import(pathToFileURL(join(directory, "dist/search.js")));
const { SearchPage } = await import(pathToFileURL(join(directory, "dist/server.js")));
const { h, hydrate, render } = await import("../docs-site/vendor/dom.js");
const { renderToString } = await import("../docs-site/vendor/ssr.js");
const markup = (component, props) => renderToString(h(component, props), { markers: false });
const highlight = (text, query) => markup(SearchHighlight, { text, query });

test("search highlighting matches literal punctuation, multiple words, repeats, and longest terms", async () => {
  assert.equal(await highlight("CreateApp() and SIGNALS; signals.", "  signals\tcreateApp()  "),
    "<mark>CreateApp()</mark> and <mark>SIGNALS</mark>; <mark>signals</mark>.");
  for (const term of ["a+b", "[x]", "(a+)+$", ".*", "?", "^", "|", "\\", "{2}", "$"]) {
    assert.equal(await highlight(`before ${term} after`, term), `before <mark>${term}</mark> after`);
  }
  assert.equal(await highlight("signals signal signals", "signal signals signals"),
    "<mark>signals</mark> <mark>signal</mark> <mark>signals</mark>");
  assert.equal(await highlight("a".repeat(2_000), "(a+)+$"), "a".repeat(2_000));
  assert.equal(await highlight("İstanbul 😀 CreateApp() café", "createApp() CAFÉ"),
    "İstanbul 😀 <mark>CreateApp()</mark> <mark>café</mark>");
});

test("highlighting preserves escaped original text, bounds the query, and handles empty or unmatched input", async () => {
  const unsafe = '<script>alert(1)</script> & &amp; "quoted"';
  assert.equal(await highlight(unsafe, "<script>"),
    '<mark>&lt;script&gt;</mark>alert(1)&lt;/script&gt; &amp; &amp;amp; "quoted"');
  assert.equal(await highlight("Safe & sound", '<img src=x onerror="bad()">'), "Safe &amp; sound");
  assert.equal(await highlight("A & B", " \t\n "), "A &amp; B");
  assert.equal(await highlight("A & B", "unmatched"), "A &amp; B");
  assert.equal(await highlight("", "signal"), "");
  const bounded = "x".repeat(120);
  assert.equal(await highlight(`ignored ${bounded}`, `${bounded} ignored`), `ignored <mark>${bounded}</mark>`);
});

test("quick and full search render native highlighted links and preserve category filters and snippets", async () => {
  const quick = await markup(SearchBox, { entries, initialQuery: "createApp() signals", searchGroup: "framework" });
  assert.match(quick, /<strong><mark>CreateApp\(\)<\/mark> &amp; <mark>Signals<\/mark><\/strong>/u);
  assert.match(quick, /href="\/docs\/signals"[^>]*aria-label="Open CreateApp\(\) &amp; Signals"/u);
  assert.doesNotMatch(quick, /href="\/docs\/signals-extra"|role="(?:listbox|option)"|<mark[^>]+>/u);
  assert.match(quick, /name="group" value="framework"/u);
  assert.match(quick, /role="region" aria-label="Matching guides" hidden/u);

  const full = await markup(SearchPage, { query: "createApp() signals", group: groups[0] });
  assert.match(full, /1 matching guide in Framework\./u);
  assert.match(full, /<h2><mark>CreateApp\(\)<\/mark> &amp; <mark>Signals<\/mark><\/h2>/u);
  assert.ok(full.includes('<p><mark>CreateApp()</mark> &amp; <mark>Signals</mark> Use <mark>createApp()</mark> with <mark>Signals</mark> &amp; native links.</p>'));
  assert.doesNotMatch(full, /href="\/docs\/signals-extra"|<mark[^>]+>/u);
  assert.match(full, /<small>1 min read · Open guide →<\/small>/u);
  const empty = await markup(SearchPage, { query: "unmatched" });
  assert.match(empty, /No matching guides/u);
  assert.doesNotMatch(empty, /<mark>/u);
});

test("retained hydrated quick-result links update highlights when the query changes", async (t) => {
  const domTests = await readFile(new URL("./dom.test.mjs", import.meta.url), "utf8");
  const fixtureStart = domTests.indexOf("class FakeNode {");
  const fixtureEnd = domTests.indexOf("const { For, Portal,");
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart);
  const { FakeElement } = new Function(`${domTests.slice(fixtureStart, fixtureEnd)}\nreturn { FakeElement };`)();
  const root = new FakeElement("main");
  const view = h(SearchBox, { entries, initialQuery: "signals", searchGroup: "framework" });
  const dispose = render(root, view);
  t.after(dispose);
  const attach = hydrate(root, view);
  t.after(attach);
  assert.equal(root.getAttribute("data-clank-hydration"), "attached");
  const descendants = (node) => node.childNodes.flatMap((child) => [child, ...descendants(child)]);
  const input = descendants(root).find((node) => node.localName === "input" && node.getAttribute("type") === "search");
  const link = descendants(root).find((node) => node.localName === "a");
  const marks = () => descendants(link).filter((node) => node.localName === "mark").map((node) => node.textContent);
  assert.deepEqual(marks(), ["Signals"]);
  input.value = "createApp()";
  input.listeners.get("input")({ currentTarget: input });
  assert.equal(descendants(root).find((node) => node.localName === "a"), link, "The ranked result retains its native link");
  assert.deepEqual(marks(), ["CreateApp()"]);
  assert.equal(link.textContent, "CreateApp() & SignalsFramework↗");
  assert.equal(link.getAttribute("aria-label"), "Open CreateApp() & Signals");
  input.value = "Framework";
  input.listeners.get("input")({ currentTarget: input });
  assert.equal(descendants(root).some((node) => node.localName === "mark"), false);
});
