import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-heading-permalinks-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
for (const name of ["markdown", "highlight"]) {
  const source = await readFile(new URL(`../docs-site/src/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}
const { renderMarkdown } = await import(pathToFileURL(join(directory, "markdown.js")));

function permalinks(html) {
  return [...html.matchAll(/<a class="heading-anchor"([^>]*)>([\s\S]*?)<\/a>/gu)];
}

test("every rendered heading has a named keyboard-accessible fragment link with a decorative icon", () => {
  const rendered = renderMarkdown([
    "# Article title",
    "",
    ...[1, 2, 3, 4, 5, 6].map((level) => `${"#".repeat(level)} Level ${level}`),
  ].join("\n"));

  assert.equal(rendered.title, "Article title");
  assert.doesNotMatch(rendered.html, /Article title/u, "the article title remains separate from its body");
  const links = permalinks(rendered.html);
  assert.equal(links.length, 6);
  for (const [index, [, attributes, content]] of links.entries()) {
    const level = index + 1;
    assert.match(attributes, new RegExp(`href="#level-${level}"`, "u"));
    assert.match(attributes, new RegExp(`aria-label="Link to Level ${level}"`, "u"));
    assert.doesNotMatch(attributes, /aria-hidden|tabindex|disabled/u, "native links remain in the tab order and accessibility tree");
    assert.equal(content, '<span aria-hidden="true">#</span>');
    assert.match(rendered.html, new RegExp(`<h${level} id="level-${level}">.*Level ${level}</h${level}>`, "u"));
  }
  assert.deepEqual(rendered.toc, [1, 2, 3].map((level) => ({ id: `level-${level}`, title: `Level ${level}`, level })));
});

test("permalinks retain duplicate heading IDs and use rendered text for formatted heading names", () => {
  const rendered = renderMarkdown([
    "## Install `clank` & **configure** [the app](/docs/app)",
    "## Install `clank` & **configure** [the app](/docs/app)",
    "### *Next* __steps__",
  ].join("\n"));
  const links = permalinks(rendered.html);
  assert.equal(links.length, 3);
  assert.equal(rendered.toc[1].id, `${rendered.toc[0].id}-2`);
  for (const [index, [, attributes]] of links.entries()) {
    assert.ok(attributes.includes(`href="#${rendered.toc[index].id}"`));
  }
  assert.match(links[0][1], /aria-label="Link to Install clank &amp; configure the app"/u);
  assert.match(links[2][1], /aria-label="Link to Next steps"/u);
  assert.match(rendered.html, /<code>clank<\/code> &amp; <strong>configure<\/strong> <a href="\/docs\/app">the app<\/a>/u);
});

test("heading names preserve escaped literal text without admitting attribute or HTML injection", () => {
  const rendered = renderMarkdown('## <img src=x onerror="bad()"> & "quoted" \'text\' `a_b`');
  const [[, attributes]] = permalinks(rendered.html);
  assert.match(attributes, /aria-label="Link to &lt;img src=x onerror=&quot;bad\(\)&quot;&gt; &amp; &quot;quoted&quot; &#39;text&#39; a_b"/u);
  assert.doesNotMatch(rendered.html, /<img| onerror="|<script/iu);
  assert.match(rendered.html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/u);
  assert.equal(rendered.toc[0].id, "img-srcx-onerrorbad-quoted-text-ab");
});

test("permalinks reveal on focus, have an explicit focus ring, and remain available on narrow screens", async () => {
  const styles = await readFile(new URL("../docs-site/src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.heading-anchor:focus\s*\{[^}]*opacity:\s*1\s*;/u);
  assert.match(styles, /\.heading-anchor:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--clank-focus\);[^}]*outline-offset:\s*3px;/u);
  const screenStyles = styles.split("@media print")[0];
  assert.doesNotMatch(screenStyles, /\.heading-anchor\s*\{[^}]*display:\s*none/u);
  assert.match(screenStyles, /\.heading-anchor\s*\{[^}]*position:\s*static;[^}]*display:\s*inline-block;[^}]*opacity:\s*1;/u);
});
