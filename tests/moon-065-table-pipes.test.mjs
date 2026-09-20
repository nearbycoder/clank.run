import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-table-pipes-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
for (const name of ["markdown", "highlight"]) {
  const source = await readFile(new URL(`../docs-site/src/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { renderMarkdown } = await import(pathToFileURL(join(directory, "markdown.js")));

function rows(markdown) {
  return [...renderMarkdown(markdown).html.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)]
    .map(([, row]) => [...row.matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/gu)].map(([, cell]) => cell));
}

test("table cells retain escaped pipes in headers, bodies, and optional outer edges", () => {
  assert.deepEqual(rows(String.raw`| A \| B | Value |
| --- | --- |
| x\|y | ordinary |
\|leading | trailing\|
| middle | end\||`), [
    ["A | B", "Value"],
    ["x|y", "ordinary"],
    ["|leading", "trailing|"],
    ["middle", "end|"],
  ]);
  assert.deepEqual(rows("| Single |\n---\n| |\n| \\| |"), [["Single"], [""], ["|"]]);
});

test("table code spans protect pipes across matching, differing, and repeated backtick runs", () => {
  const markdown = [
    "Code | Meaning",
    "--- | ---",
    "| `a|b` | union |",
    "| ``a|`b`` | embedded tick |",
    "| ```a|``b|`c``` | longer delimiter |",
    "| `a|``b` | shorter delimiter |",
    "| `a\\|b` | escaped code pipe |",
    "| `left|right` and ``up|down`` | two spans |",
    "| `not closed | next |",
    "| ``literal `a|b` | next |",
    "| `a\\` | literal code backslash |",
  ].join("\n");
  assert.deepEqual(rows(markdown), [
    ["Code", "Meaning"],
    ["<code>a|b</code>", "union"],
    ["<code>a|`b</code>", "embedded tick"],
    ["<code>a|``b|`c</code>", "longer delimiter"],
    ["<code>a|``b</code>", "shorter delimiter"],
    ["<code>a|b</code>", "escaped code pipe"],
    ["<code>left|right</code> and <code>up|down</code>", "two spans"],
    ["`not closed", "next"],
    ["``literal <code>a|b</code>", "next"],
    ["<code>a\\</code>", "literal code backslash"],
  ]);
});

test("odd backslash counts escape table pipes while even counts leave separators active", () => {
  for (let count = 0; count <= 6; count++) {
    const slashes = "\\".repeat(count);
    const escaped = count % 2 === 1;
    const header = escaped ? "Left | Right\n--- | ---" : "Left | Middle | Right\n--- | --- | ---";
    assert.deepEqual(rows(`${header}\n| before${slashes}|after | tail |`).at(-1), escaped
      ? [`before${slashes.slice(1)}|after`, "tail"]
      : [`before${slashes}`, "after", "tail"], `Backslash count ${count}`);
    assert.deepEqual(rows(`Code | Right\n--- | ---\n| \`before${slashes}|after\` | tail |`).at(-1),
      [`<code>before${escaped ? slashes.slice(1) : slashes}|after</code>`, "tail"]);
  }
  assert.deepEqual(rows("Left | Right\n--- | ---\n| \\`literal | next |"), [
    ["Left", "Right"], ["\\`literal", "next"],
  ]);
});

test("alignment dividers and ragged rows retain their column boundaries", () => {
  assert.deepEqual(rows("Left | Center | Right\n:--- | :---: | ---:\none | two | three\nshort | row\nextra | row | values | ignored"), [
    ["Left", "Center", "Right"],
    ["one", "two", "three"],
    ["short", "row", ""],
    ["extra", "row", "values"],
  ]);
  for (const divider of ["---", "--- | --- | ---", ":-- | ---", "---\\|---"]) {
    assert.doesNotMatch(renderMarkdown(`Left | Right\n${divider}\none | two`).html, /<table>/u);
  }
});

test("protected pipes do not turn non-table prose into tables or consume following paragraphs", () => {
  for (const text of ["Plain | text", "Escaped \\| text\n---", "`a|b`\n---", "``a|`b``\n---"]) {
    assert.doesNotMatch(renderMarkdown(text).html, /<table>/u);
  }
  const html = renderMarkdown("A | B\n--- | ---\none | two\nAfter `a|b` stays prose\nwith another line.").html;
  assert.equal((html.match(/<tr>/gu) ?? []).length, 2);
  assert.match(html, /<\/table><\/div>\n<p>After <code>a\|b<\/code> stays prose with another line\.<\/p>/u);
});

test("table cell tokenization preserves HTML escaping and safe link handling", () => {
  const html = renderMarkdown([
    "Code | Text",
    "--- | ---",
    '| ``<script> | "quoted"`` | <img src=x onerror="bad()">\\|[unsafe](javascript:evil) |',
    "| `a|b` | [safe](/docs/security) and [data](data:text/html,unsafe) |",
    "",
    '## ``<b>|`tick`` & [safe](/docs/security)',
  ].join("\n")).html;
  assert.match(html, /<code>&lt;script&gt; \| &quot;quoted&quot;<\/code>/u);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;\|unsafe/u);
  assert.match(html, /<a href="\/docs\/security">safe<\/a>/u);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data):/u);
  assert.match(html, /aria-label="Link to &lt;b&gt;\|`tick &amp; safe"/u);
});

test("the platform dashboard guide keeps the full performance range in its two-column table", async () => {
  const markdown = await readFile(new URL("../docs/platform-dashboard.md", import.meta.url), "utf8");
  const performance = rows(markdown).find((row) => row[0].includes("/performance"));
  assert.deepEqual(performance, [
    "<code>/projects/&lt;project-slug&gt;/performance</code>",
    "Project traffic and latency, with <code>?range=15m|1h|24h|7d|30d</code>",
  ]);
});
