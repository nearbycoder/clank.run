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

const temporary = await mkdtemp(join(tmpdir(), "clank-theme-sandbox-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
for (const filename of ["token-inspector-data.ts", "contrast-checker-data.ts", "theme-sandbox-data.ts", "theme-sandbox.tsx"]) {
  const source = await readFile(new URL(`../design-site/src/tools/${filename}`, import.meta.url), "utf8");
  await writeFile(join(temporary, filename.replace(/\.tsx?$/u, ".js")), compile(source.replaceAll("../../vendor/", runtime), { filename, sourceMap: false }));
}
const { SANDBOX_TOKEN_NAMES, createThemeSandbox, applySandboxOverride, resetSandboxOverride, sandboxTheme, validateSandboxToken } = await import(pathToFileURL(join(temporary, "theme-sandbox-data.js")).href);
const { ThemeSandbox } = await import(pathToFileURL(join(temporary, "theme-sandbox.js")).href);

test("sandbox accepts each preset's editable values while preserving canonical token order and immutable presets", () => {
  const before = JSON.stringify(CLANK_THEME_PRESETS);
  assert.equal(SANDBOX_TOKEN_NAMES.length, 27);
  assert.deepEqual(SANDBOX_TOKEN_NAMES, CLANK_THEME_TOKEN_NAMES.filter((name) => !name.startsWith("font") && !name.startsWith("shadow")));
  for (const base of CLANK_THEME_PRESETS) {
    let state = createThemeSandbox(base.id);
    for (const name of SANDBOX_TOKEN_NAMES) {
      const applied = applySandboxOverride(state, name, base.tokens[name]);
      assert.equal(applied.error, null, `${base.id}: ${name}`);
      state = applied.state;
    }
    assert.deepEqual(state.overrides, {});
    const edited = applySandboxOverride(state, "accent", "#ff0088").state;
    assert.equal(sandboxTheme(edited).tokens.accent, "#ff0088");
    assert.deepEqual(clankThemeVariables(sandboxTheme(state)), clankThemeVariables(base));
    assert.ok(Object.isFrozen(edited));
    assert.ok(Object.isFrozen(edited.overrides));
    assert.ok(Object.isFrozen(sandboxTheme(edited).tokens));
  }
  assert.equal(JSON.stringify(CLANK_THEME_PRESETS), before);
});

test("sandbox uses bounded typed values instead of arbitrary CSS", () => {
  const valid = [
    ["accent", " #abc "], ["overlay", "#abcd"], ["accent", "#aabbccdd"],
    ["text", "rgb(12, 50, 255)"], ["overlay", "rgba(0, 0, 0, .5)"],
    ["surface", "rgb(20% 40% 60% / 50%)"], ["overlay", "transparent"],
    ["radiusLg", "2rem"], ["radiusFull", "1000px"], ["radiusXs", "0px"],
    ["controlHeight", "1.5rem"], ["controlHeight", "80px"], ["borderWidth", ".5rem"],
    ["density", ".5"], ["density", "1.5"], ["motionFast", "0ms"], ["motionNormal", "2s"],
  ];
  for (const [name, value] of valid) assert.equal(validateSandboxToken(name, value).error, null, `${name}: ${value}`);
  const invalid = [
    ["accent", "4px"], ["accent", "rgb(256, 0, 0)"], ["accent", "rgba(1, 2, 3, 1.1)"],
    ["accent", "rgb(20%, 2, 3)"], ["accent", "hsl(0 100% 50%)"], ["accent", "currentColor"],
    ["radiusSm", "-1px"], ["radiusSm", "1001px"], ["radiusSm", "10%"], ["radiusSm", "1px 2px"],
    ["controlHeight", "23px"], ["controlHeight", "81px"], ["borderWidth", "9px"],
    ["density", "0"], ["density", "1.51"], ["density", "1px"], ["motionFast", "2.1s"],
    ["motionFast", "3000ms"], ["motionFast", "2px"], ["motionFast", "-1ms"],
    ["fontSans", "sans-serif"], ["shadowSm", "none"], ["unknown", "#fff"],
    ["accent", ""], ["accent", " ".repeat(97)], ["accent", null],
  ];
  for (const [name, value] of invalid) assert.ok(validateSandboxToken(name, value).error, `${name}: ${value}`);
});

test("malicious and reference-bearing values never replace the last valid preview", () => {
  const initial = createThemeSandbox("clank");
  const last = applySandboxOverride(initial, "accent", "#ffee00").state;
  const malicious = [
    "url(https://example.invalid/track)", "URL(https://example.invalid/track)",
    "image-set(url(https://example.invalid/track) 1x)", "@import 'https://example.invalid/track'",
    "expression(alert(1))", "var(--untrusted)", "env(safe-area-inset-top)", "attr(data-value)",
    "calc(1px + 1px)", "clamp(1px, 2px, 3px)", "#fff;background:url(https://example.invalid)",
    "#fff}body{color:red", "</style><script>alert(1)</script>", "u\\72l(https://example.invalid)",
    "rgb(0,0,0)/* comment */", "#fff\n", "#fff\u0000", "https://example.invalid",
  ];
  for (const draft of malicious) {
    const applied = applySandboxOverride(last, "accent", draft);
    assert.ok(applied.error, draft);
    assert.equal(applied.state, last);
    assert.equal(sandboxTheme(applied.state).tokens.accent, "#ffee00");
  }
  assert.throws(() => sandboxTheme({ baseId: "clank", overrides: { accent: "url(https://example.invalid)" } }), TypeError);
  assert.throws(() => sandboxTheme({ baseId: "clank", overrides: { fontSans: "url(https://example.invalid)" } }), TypeError);
});

test("token reset, reset all, and base changes have distinct predictable scope", () => {
  let state = createThemeSandbox("clank");
  state = applySandboxOverride(state, "accent", "#123456").state;
  state = applySandboxOverride(state, "radiusSm", "20px").state;
  const resetOne = resetSandboxOverride(state, "accent");
  assert.deepEqual(resetOne.overrides, { radiusSm: "20px" });
  assert.equal(sandboxTheme(resetOne).tokens.accent, CLANK_THEME_PRESETS[0].tokens.accent);
  assert.deepEqual(resetSandboxOverride(state).overrides, {});
  assert.deepEqual(state.overrides, { accent: "#123456", radiusSm: "20px" });
  assert.deepEqual(applySandboxOverride(resetOne, "radiusSm", CLANK_THEME_PRESETS[0].tokens.radiusSm).state.overrides, {});
  for (const base of CLANK_THEME_PRESETS) {
    const switched = createThemeSandbox(base.id);
    assert.equal(switched.baseId, base.id);
    assert.deepEqual(switched.overrides, {});
    assert.equal(sandboxTheme(switched).scheme, base.scheme);
    assert.deepEqual(sandboxTheme(switched).tokens, base.tokens);
  }
  assert.throws(() => createThemeSandbox("does-not-exist"), TypeError);
  assert.throws(() => sandboxTheme({ baseId: "does-not-exist", overrides: {} }), TypeError);
});

test("sandbox SSR labels editor controls, announces errors, and limits theme variables to the sample", async () => {
  for (const base of CLANK_THEME_PRESETS) {
    const html = (await renderToString(h(ThemeSandbox, { theme: () => base }))).replace(/<!--[^]*?-->/gu, "");
    for (const id of ["theme-sandbox-base", "theme-sandbox-token", "theme-sandbox-value", "theme-sandbox-sample-input"]) {
      assert.match(html, new RegExp(`<label[^>]*for="${id}"`));
      assert.match(html, new RegExp(`<(?:select|input)[^>]*id="${id}"`));
    }
    assert.match(html, /maxlength="96"/u);
    assert.match(html, /aria-describedby="theme-sandbox-hint theme-sandbox-error"/u);
    assert.match(html, /id="theme-sandbox-error" role="alert"/u);
    assert.match(html, /role="status" aria-live="polite"/u);
    assert.match(html, new RegExp(`<option value="${base.id}" selected>`));
    assert.match(html, /<option value="accent" selected>/u);
    assert.equal((html.match(/style="/gu) ?? []).length, 1);
    assert.match(html, /<section[^>]*aria-label="Scoped theme sandbox preview"[^>]*style="--clank-/u);
    assert.ok(html.includes(`--clank-accent:${base.tokens.accent}`));
    assert.ok(html.includes("No overrides applied. 0 edited tokens."));
    assert.ok(html.includes("Apply override"));
    assert.ok(html.includes("Reset token"));
    assert.ok(html.includes("Reset all"));
    assert.doesNotMatch(html, /Applied token overrides/u);
  }
});
