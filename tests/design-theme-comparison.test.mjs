import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { CLANK_THEME_PRESETS, clankThemeVariables } from "../dist/ui-theme.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-theme-comparison-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
for (const filename of ["theme-comparison-data.ts", "theme-comparison.tsx"]) {
  const source = await readFile(new URL(`../design-site/src/tools/${filename}`, import.meta.url), "utf8");
  await writeFile(join(temporary, filename.replace(/\.tsx?$/u, ".js")), compile(source.replaceAll("../../vendor/", runtime), { filename, sourceMap: false }));
}
const { compareThemeTokens } = await import(pathToFileURL(join(temporary, "theme-comparison-data.js")).href);
const { ThemeComparison } = await import(pathToFileURL(join(temporary, "theme-comparison.js")).href);

test("theme comparison includes all canonical CSS tokens in stable order with exact values for every preset pair", () => {
  const expectedOrder = Object.keys(clankThemeVariables(CLANK_THEME_PRESETS[0]));
  for (const left of CLANK_THEME_PRESETS) {
    for (const right of CLANK_THEME_PRESETS) {
      const leftValues = clankThemeVariables(left);
      const rightValues = clankThemeVariables(right);
      const compared = compareThemeTokens(left, right);
      assert.equal(compared.total, expectedOrder.length);
      assert.deepEqual(compared.tokens.map((token) => token.variable), expectedOrder);
      assert.equal(compared.changedCount, expectedOrder.filter((variable) => leftValues[variable] !== rightValues[variable]).length);
      assert.deepEqual(Object.fromEntries(compared.tokens.map((token) => [token.variable, token.leftValue])), leftValues);
      assert.deepEqual(Object.fromEntries(compared.tokens.map((token) => [token.variable, token.rightValue])), rightValues);
      for (const token of compared.tokens) assert.equal(token.changed, token.leftValue !== token.rightValue);
      const reversed = compareThemeTokens(right, left);
      assert.equal(reversed.changedCount, compared.changedCount);
      assert.deepEqual(reversed.tokens.map((token) => token.variable), expectedOrder);
    }
  }
});

test("changed-only comparison retains canonical ordering and complete counts, including equal presets", () => {
  for (const left of CLANK_THEME_PRESETS) {
    for (const right of CLANK_THEME_PRESETS) {
      const complete = compareThemeTokens(left, right);
      const changed = compareThemeTokens(left, right, true);
      assert.equal(changed.total, complete.total);
      assert.equal(changed.changedCount, complete.changedCount);
      assert.equal(changed.tokens.length, complete.changedCount);
      assert.deepEqual(changed.tokens, complete.tokens.filter((token) => token.changed));
      if (left.id === right.id) {
        assert.equal(complete.changedCount, 0);
        assert.equal(complete.tokens.length, 32);
        assert.deepEqual(changed.tokens, []);
      }
    }
  }
});

test("comparison defaults to the selected preset and a distinct preset with labeled SSR controls and exact values", async () => {
  for (const selected of CLANK_THEME_PRESETS) {
    const other = CLANK_THEME_PRESETS.find((theme) => theme.id !== selected.id);
    const expected = compareThemeTokens(selected, other);
    const html = (await renderToString(h(ThemeComparison, { theme: () => selected }), { markers: false }));
    assert.match(html, /<label[^>]*for="theme-comparison-left"/u);
    assert.match(html, /<label[^>]*for="theme-comparison-right"/u);
    assert.match(html, /<select[^>]*id="theme-comparison-left"/u);
    assert.match(html, /<select[^>]*id="theme-comparison-right"/u);
    assert.match(html, /<label[^>]*for="theme-comparison-changed"/u);
    assert.match(html, /<input[^>]*id="theme-comparison-changed"[^>]*type="checkbox"/u);
    assert.match(html, /role="status" aria-live="polite"/u);
    assert.match(html, /<dl[^>]*aria-label="Theme token comparison"[^>]*class="theme-comparison-list"/u);
    const selects = [...html.matchAll(/<select[^>]*>([^]*?)<\/select>/gu)];
    assert.match(selects[0][1], new RegExp(`<option value="${selected.id}" selected>`));
    assert.match(selects[1][1], new RegExp(`<option value="${other.id}" selected>`));
    assert.equal((html.match(/class="theme-comparison-row"/gu) ?? []).length, expected.total);
    assert.equal((html.match(/<option /gu) ?? []).length, CLANK_THEME_PRESETS.length * 2);
    assert.ok(html.includes(`${expected.changedCount} of ${expected.total} tokens differ between ${selected.name} and ${other.name}. Showing ${expected.total}.`));
    assert.ok(html.includes(`First: ${selected.name}`));
    assert.ok(html.includes(`Second: ${other.name}`));
    assert.ok(html.includes(selected.tokens.accent));
    assert.ok(html.includes(other.tokens.accent));
    assert.doesNotMatch(html, /No differences\./u);
  }
});
