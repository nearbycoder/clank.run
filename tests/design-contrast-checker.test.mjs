import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { CLANK_THEME_PRESETS } from "../dist/ui-theme.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-contrast-checker-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
for (const filename of ["token-inspector-data.ts", "contrast-checker-data.ts", "contrast-checker.tsx"]) {
  const source = await readFile(new URL(`../design-site/src/tools/${filename}`, import.meta.url), "utf8");
  await writeFile(join(temporary, filename.replace(/\.tsx?$/u, ".js")), compile(source.replaceAll("../../vendor/", runtime), { filename, sourceMap: false }));
}
const { calculateContrast, contrastChecks, contrastTokenOptions, parseOpaqueColor } = await import(pathToFileURL(join(temporary, "contrast-checker-data.js")).href);
const { ContrastChecker } = await import(pathToFileURL(join(temporary, "contrast-checker.js")).href);

test("contrast calculates WCAG sRGB luminance symmetrically without rounding thresholds", () => {
  assert.equal(calculateContrast("#000", "#fff").ratio, 21);
  assert.equal(calculateContrast("#112233", "#112233").ratio, 1);
  assert.equal(calculateContrast("#ffffff", "#123456").ratio, calculateContrast("#123456", "#ffffff").ratio);
  assert.ok(Math.abs(calculateContrast("#f00", "#fff").ratio - 3.9984767707539985) < 1e-12);
  const gray = calculateContrast("#777", "#fff").ratio;
  assert.ok(Math.abs(gray - 4.478089453577214) < 1e-12);
  assert.equal(contrastChecks(gray).find((check) => check.label === "AA normal text").passes, false);
  assert.deepEqual(contrastChecks(4.49999).map((check) => check.passes), [false, true, false, false]);
  assert.deepEqual(contrastChecks(4.5).map((check) => check.passes), [true, true, false, true]);
  assert.deepEqual(contrastChecks(3).map((check) => check.passes), [false, true, false, false]);
  assert.deepEqual(contrastChecks(7).map((check) => check.passes), [true, true, true, true]);
  for (const ratio of [null, NaN, Infinity]) assert.ok(contrastChecks(ratio).every((check) => !check.passes));
});

test("opaque sRGB parsing accepts equivalent hex and rgb forms", () => {
  for (const value of ["#fff", "#ffff", "#ffffff", "#ffffffff", "rgb(255, 255, 255)", "rgba(255, 255, 255, 1)", "rgb(100% 100% 100% / 100%)", "rgba(100%,100%,100%,100%)", " RGB(255 255 255) "]) {
    assert.deepEqual(parseOpaqueColor(value), { status: "opaque", channels: [1, 1, 1] }, value);
  }
  assert.deepEqual(parseOpaqueColor("#0a8f"), { status: "opaque", channels: [0, 170 / 255, 136 / 255] });
});

test("transparency, malformed input, and unsupported spaces never produce misleading contrast", () => {
  for (const value of ["transparent", "#fff0", "#fffffffe", "rgba(0,0,0,.68)", "rgb(0 0 0 / 20%)"]) {
    assert.equal(parseOpaqueColor(value).status, "translucent", value);
    assert.equal(calculateContrast(value, "#fff").ratio, null);
    assert.match(calculateContrast(value, "#fff").reason, /^Foreground: Translucent/u);
    assert.match(calculateContrast("#fff", value).reason, /^Background: Translucent/u);
  }
  for (const value of [undefined, "", "#ggg", "#fffff", "#fffffff", "red", "currentColor", "var(--clank-text)", "oklch(50% .2 20)", "rgb(256,0,0)", "rgb(-1 0 0)", "rgb(0,0,0,1,2)", "rgb(0 0 0 / 1 / 1)", "rgb(0,0%,0)", "rgba(0,0,0,2)", "rgb(0,0,0 / 1)", "rgb(0foo 0 0)", "#fff; color:red"]) {
    assert.equal(parseOpaqueColor(value).status, "unsupported", String(value));
    assert.equal(calculateContrast(value, "#fff").ratio, null);
  }
});

test("theme selector choices include only color tokens and identify every unavailable preset value", () => {
  for (const theme of CLANK_THEME_PRESETS) {
    const options = contrastTokenOptions(theme.tokens);
    assert.equal(options.length, 17);
    assert.equal(options.find((option) => option.name === "overlay").color.status, "translucent");
    assert.equal(options.filter((option) => option.color.status === "opaque").length, 16);
    assert.ok(options.every((option) => option.value === theme.tokens[option.name]));
    assert.ok(calculateContrast(theme.tokens.text, theme.tokens.canvas).ratio >= 4.5);
  }
});

test("contrast checker renders labeled token controls, accurate theme results, and scope guidance", async () => {
  let selected = CLANK_THEME_PRESETS[0];
  const props = { theme: () => selected };
  const first = await renderToString(h(ContrastChecker, props));
  for (const field of ["foreground", "background"]) {
    assert.match(first, new RegExp(`<label[^>]*for="contrast-${field}"`, "u"));
    assert.match(first, new RegExp(`<select[^>]*id="contrast-${field}"`, "u"));
  }
  assert.match(first, /<option value="overlay" disabled/u);
  assert.match(first, /role="status" aria-live="polite"/u);
  assert.ok(first.includes(`${calculateContrast(selected.tokens.text, selected.tokens.canvas).ratio.toFixed(3)}:1`));
  assert.ok(first.includes("do not certify a whole interface"));
  assert.match(first, /<div[^>]*role="group"[^>]*aria-label="Selected color pair preview"/u);
  assert.ok(first.includes("unrounded"));
  assert.ok(first.includes("18.67px"));
  assert.equal((first.match(/<li>/gu) ?? []).length, 4);
  selected = CLANK_THEME_PRESETS.find((theme) => theme.id === "porcelain");
  const second = await renderToString(h(ContrastChecker, props));
  assert.ok(second.includes(selected.name));
  assert.ok(second.includes(`${calculateContrast(selected.tokens.text, selected.tokens.canvas).ratio.toFixed(3)}:1`));
  assert.notEqual(first, second);
  selected = { ...selected, tokens: { ...selected.tokens, text: "rgba(0,0,0,.5)" } };
  const unavailable = await renderToString(h(ContrastChecker, props));
  assert.match(unavailable, /Foreground: Translucent colors/u);
  assert.doesNotMatch(unavailable, /class="contrast-sample"|class="contrast-results"/u);
});
