import test from "node:test";
import assert from "node:assert/strict";
import { browser, button, elements, h, render, CLANK_THEME_PRESETS, setClipboard, settled, load } from "./helpers/design-studio-fixture.mjs";
const { createSandboxExport } = await load("tools/theme-sandbox-export-data");
const { createThemeSandbox, applySandboxOverride } = await load("tools/theme-sandbox-data");
const { ThemeSandbox } = await load("tools/theme-sandbox");

test("sandbox CSS contains only validated current overrides under a fixed scoped selector", () => {
  const base = createThemeSandbox("clank");
  const edited = applySandboxOverride(applySandboxOverride(base, "accent", " #AbC ").state, "radiusSm", "1rem").state;
  const file = createSandboxExport(edited);
  assert.equal(file.filename, "clank-sandbox-clank.css");
  assert.equal(file.mediaType, "text/css;charset=utf-8");
  assert.match(file.contents, /\[data-clank-sandbox\] \{\n  --clank-accent: #abc;\n  --clank-radius-sm: 1rem;\n\}/u);
  assert.doesNotMatch(file.contents, /:root|--clank-font|--clank-shadow|--clank-canvas/u);
  assert.equal(createSandboxExport(edited).contents, file.contents);
  assert.match(createSandboxExport(base).contents, /No overrides applied/u);
  for (const preset of CLANK_THEME_PRESETS) assert.equal(createSandboxExport(createThemeSandbox(preset.id)).filename, `clank-sandbox-${preset.id}.css`);
});

test("untrusted stored state cannot export CSS syntax, references, unknown names, or unbounded values", () => {
  for (const [token, value] of [["accent", '#fff;}body{color:red'], ["accent", '</style><script>bad()</script>'], ["accent", 'url(https://evil.invalid)'], ["accent", 'var(--other)'], ["accent", '#fff\\'], ["fontSans", "Arial"], ["unknown", "#fff"], ["density", "Infinity"], ["density", "NaN"], ["density", "2"], ["motionFast", "2001ms"], ["radiusSm", "1001px"], ["accent", "x".repeat(97)], ["accent", 123]]) {
    assert.throws(() => createSandboxExport({ baseId: "clank", overrides: { [token]: value } }), TypeError, `${token}: ${value}`);
  }
  for (const state of [null, [], {}, { baseId: '<style>', overrides: {} }, { baseId: "clank", overrides: [] }, { baseId: "clank", overrides: null }, JSON.parse('{"baseId":"clank","overrides":{"__proto__":"red"}}')]) assert.throws(() => createSandboxExport(state), TypeError);
});

test("copy and download use applied sandbox values while invalid drafts and stale feedback stay out", async (t) => {
  const f = browser(t);
  let copied;
  setClipboard(t, { writeText: async (text) => { copied = text; } });
  const root = f.document.createElement("main"); f.document.body.append(root);
  f.onDispose(render(root, h(ThemeSandbox, { theme: () => CLANK_THEME_PRESETS[0] })));
  const input = f.document.getElementById("theme-sandbox-value");
  input.value = "#123456"; input.emit("input"); button(root, "Apply override").emit("click"); await settled();
  button(root, "Copy override CSS").emit("click"); await settled();
  assert.match(copied, /--clank-accent: #123456;/u);
  assert.match(root.textContent, /Sandbox override CSS copied\./u);
  input.value = "url(https://evil.invalid)"; input.emit("input"); button(root, "Apply override").emit("click"); await settled();
  button(root, "Copy override CSS").emit("click"); await settled();
  assert.match(copied, /--clank-accent: #123456;/u); assert.doesNotMatch(copied, /evil/u);

  let blob, download, clicked = 0, revoked;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, set = globalThis.setTimeout;
  t.after(() => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; globalThis.setTimeout = set; });
  URL.createObjectURL = (value) => { blob = value; return "blob:scoped-test"; };
  URL.revokeObjectURL = (value) => { revoked = value; };
  globalThis.setTimeout = (callback) => { callback(); return 1; };
  const make = f.document.createElement;
  f.document.createElement = (tag) => {
    const node = make(tag);
    if (tag === "a") {
      node.click = () => { clicked++; download = node.download; };
      node.remove = () => node.parentNode?.removeChild(node);
    }
    return node;
  };
  button(root, "Download override CSS").emit("click");
  assert.equal(clicked, 1); assert.equal(download, "clank-sandbox-clank.css");
  assert.equal(await blob.text(), copied); assert.equal(revoked, "blob:scoped-test");
  button(root, "Reset all").emit("click"); await settled();
  assert.doesNotMatch(root.textContent, /Sandbox override CSS copied\.|Download requested for/u);
  const preview = elements(root).find((node) => node.getAttribute("aria-label") === "Sandbox override CSS");
  assert.match(preview.textContent, /No overrides applied/u);
});
