import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { CLANK_THEME_PRESETS, CLANK_THEME_TOKEN_NAMES, clankThemeVariables } from "../dist/ui-theme.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-token-inspector-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
for (const filename of ["token-inspector-data.ts", "token-inspector.tsx"]) {
  const source = await readFile(new URL(`../design-site/src/tools/${filename}`, import.meta.url), "utf8");
  const javascript = compile(source.replaceAll("../../vendor/", runtime), { filename, sourceMap: false });
  await writeFile(join(temporary, filename.replace(/\.tsx?$/u, ".js")), javascript);
}
const { TOKEN_GROUPS, inspectThemeTokens } = await import(pathToFileURL(join(temporary, "token-inspector-data.js")).href);
const { TokenInspector } = await import(pathToFileURL(join(temporary, "token-inspector.js")).href);

test("token inspector covers each preset and uses the framework's exact CSS variable contract", () => {
  for (const theme of CLANK_THEME_PRESETS) {
    const rows = inspectThemeTokens(theme.tokens);
    assert.deepEqual(rows.map((row) => row.name), [...CLANK_THEME_TOKEN_NAMES]);
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.variable, row.value])), clankThemeVariables(theme));
    assert.deepEqual(new Set(rows.map((row) => row.group)), new Set(TOKEN_GROUPS));
    assert.equal(rows.find((row) => row.name === "borderWidth").group, "Geometry");
    assert.equal(rows.find((row) => row.name === "border").group, "Colors");
    assert.equal(rows.find((row) => row.name === "overlay").group, "Colors");
  }
});

test("token search matches names, CSS variables, groups, and current values together", () => {
  const theme = CLANK_THEME_PRESETS[0];
  assert.deepEqual(inspectThemeTokens(theme.tokens, "  COLORS   ACCENT  ").map((row) => row.name), ["accent", "accentHover", "accentContrast"]);
  assert.deepEqual(inspectThemeTokens(theme.tokens, "--clank-font-mono").map((row) => row.name), ["fontMono"]);
  assert.deepEqual(inspectThemeTokens(theme.tokens, "motion 220ms").map((row) => row.name), ["motionNormal"]);
  assert.deepEqual(inspectThemeTokens(theme.tokens, "controlHeight").map((row) => row.name), ["controlHeight"]);
  assert.deepEqual(inspectThemeTokens(theme.tokens, "radius colors"), []);
  assert.deepEqual(inspectThemeTokens(theme.tokens, ".*"), []);
  assert.equal(inspectThemeTokens(theme.tokens, "  \n ").length, 32);
});

test("token inspector renders labeled controls, semantic groups, and the selected theme values", async () => {
  let selected = CLANK_THEME_PRESETS[0];
  const props = { theme: () => selected };
  const first = await renderToString(h(TokenInspector, props));
  assert.match(first, /<label[^>]*for="theme-token-search"/u);
  assert.match(first, /<input[^>]*id="theme-token-search"[^>]*type="search"/u);
  assert.match(first, /role="status" aria-live="polite"/u);
  assert.equal((first.match(/class="token-row"/gu) ?? []).length, 32);
  assert.equal((first.match(/<h2>/gu) ?? []).length, TOKEN_GROUPS.length);
  assert.doesNotMatch(first, /<h3>/u);
  for (const group of TOKEN_GROUPS) assert.ok(first.includes(`aria-label="${group} tokens"`));
  assert.ok(first.includes(`background:${selected.tokens.accent}`));
  selected = CLANK_THEME_PRESETS.find((theme) => theme.id === "porcelain");
  const second = await renderToString(h(TokenInspector, props));
  assert.ok(second.includes(`background:${selected.tokens.accent}`));
  assert.ok(second.includes(selected.name));
  assert.notEqual(first, second);
});
