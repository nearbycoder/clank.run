import test from "node:test";
import assert from "node:assert/strict";
import {
  CLANK_THEME_COUNT,
  CLANK_THEME_PRESETS,
  CLANK_THEME_PROTOCOL,
  CLANK_THEME_TOKEN_NAMES,
  applyClankTheme,
  clankThemeVariables,
  createClankThemeStylesheet,
  defineClankTheme,
  getClankTheme,
} from "../dist/ui-theme.js";

test("the theme catalog exposes ten complete immutable and visually distinct presets", () => {
  assert.equal(CLANK_THEME_PROTOCOL, "clank-theme/1");
  assert.equal(CLANK_THEME_COUNT, 10);
  assert.equal(CLANK_THEME_PRESETS.length, 10);
  assert.equal(new Set(CLANK_THEME_PRESETS.map((theme) => theme.id)).size, 10);
  assert.ok(CLANK_THEME_PRESETS.some((theme) => theme.scheme === "light"));
  assert.ok(CLANK_THEME_PRESETS.some((theme) => theme.scheme === "dark"));
  assert.ok(new Set(CLANK_THEME_PRESETS.map((theme) => theme.tokens.radiusMd)).size >= 8);
  assert.ok(new Set(CLANK_THEME_PRESETS.map((theme) => theme.tokens.accent)).size === 10);
  assert.ok(Object.isFrozen(CLANK_THEME_PRESETS));

  for (const theme of CLANK_THEME_PRESETS) {
    assert.equal(theme.protocol, CLANK_THEME_PROTOCOL);
    assert.deepEqual(Object.keys(theme.tokens).sort(), [...CLANK_THEME_TOKEN_NAMES].sort());
    assert.ok(Object.isFrozen(theme));
    assert.ok(Object.isFrozen(theme.tokens));
    assert.ok(Object.isFrozen(theme.tags));
    assert.equal(getClankTheme(`  ${theme.id.toUpperCase()}  `), theme);
  }
  assert.equal(getClankTheme("missing"), undefined);
  assert.throws(() => { CLANK_THEME_PRESETS[0].tokens.accent = "red"; }, TypeError);
});

test("custom themes validate every token and refuse stylesheet injection", () => {
  const custom = defineClankTheme({
    id: "custom-blue",
    name: "Custom Blue",
    description: "A safe application-owned derivative.",
    scheme: "light",
    tags: ["Product", "product", "Blue"],
    tokens: { ...CLANK_THEME_PRESETS[1].tokens, accent: "#1457d9" },
  });
  assert.equal(custom.id, "custom-blue");
  assert.deepEqual(custom.tags, ["product", "blue"]);
  assert.equal(custom.tokens.accent, "#1457d9");
  assert.throws(() => defineClankTheme({
    ...custom,
    id: "Bad ID",
    tokens: { ...custom.tokens },
  }), /kebab-case/u);
  assert.throws(() => defineClankTheme({
    ...custom,
    id: "injected",
    tokens: { ...custom.tokens, accent: "red; } body { display: none" },
  }), /safe CSS value/u);
  assert.throws(() => defineClankTheme({
    ...custom,
    id: "unknown-token",
    tokens: { ...custom.tokens, surprise: "pink" },
  }), /Unknown theme token/u);
  const missing = { ...custom.tokens };
  delete missing.canvas;
  assert.throws(() => defineClankTheme({ ...custom, id: "missing-token", tokens: missing }), /canvas/u);
});

test("theme CSS variables and stylesheets are stable, scoped, and complete", () => {
  const theme = CLANK_THEME_PRESETS[0];
  const variables = clankThemeVariables(theme);
  assert.equal(Object.keys(variables).length, CLANK_THEME_TOKEN_NAMES.length);
  assert.equal(variables["--clank-accent"], theme.tokens.accent);
  assert.ok(Object.isFrozen(variables));

  const first = createClankThemeStylesheet();
  const second = createClankThemeStylesheet();
  assert.equal(first, second);
  assert.match(first, /^:root \{/u);
  assert.match(first, /:root\[data-clank-theme="terminal"\]/u);
  assert.match(first, /--clank-radius-md: 0;/u);
  assert.equal((first.match(/\[data-clank-theme=/gu) ?? []).length, 10);
  const customAttribute = createClankThemeStylesheet([theme], {
    attribute: "data-product-theme",
    rootFallback: false,
  });
  assert.doesNotMatch(customAttribute, /^:root \{/u);
  assert.match(customAttribute, /:root\[data-product-theme="clank"\]/u);
  assert.throws(() => createClankThemeStylesheet([], {}), /between 1 and 64/u);
  assert.throws(() => createClankThemeStylesheet([theme, theme]), /Duplicate theme id/u);
  assert.throws(() => createClankThemeStylesheet([theme], { attribute: "onclick" }), /data-\*/u);
});

test("applying a theme is portal-safe and cleanup restores every prior value", () => {
  const attributes = new Map([["data-clank-theme", "legacy"]]);
  const properties = new Map([
    ["--clank-accent", "hotpink"],
    ["color-scheme", "light"],
  ]);
  const target = {
    style: {
      getPropertyValue: (name) => properties.get(name) ?? "",
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  const cleanup = applyClankTheme(target, getClankTheme("midnight"));
  assert.equal(attributes.get("data-clank-theme"), "midnight");
  assert.equal(properties.get("--clank-accent"), getClankTheme("midnight").tokens.accent);
  assert.equal(properties.get("color-scheme"), "dark");
  assert.equal(properties.size, CLANK_THEME_TOKEN_NAMES.length + 1);
  cleanup();
  assert.equal(attributes.get("data-clank-theme"), "legacy");
  assert.equal(properties.get("--clank-accent"), "hotpink");
  assert.equal(properties.get("color-scheme"), "light");
  assert.equal(properties.size, 2);
  assert.throws(() => applyClankTheme({}, getClankTheme("clank")), /HTMLElement/u);
});

test("preset text and filled controls meet normal-text contrast across their surfaces", () => {
  function luminance(hex) {
    const channels = hex.slice(1).match(/../gu).map((part) => parseInt(part, 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function check(theme, foreground, background) {
    const values = [luminance(theme.tokens[foreground]), luminance(theme.tokens[background])].sort((a, b) => b - a);
    const contrast = (values[0] + 0.05) / (values[1] + 0.05);
    assert.ok(contrast >= 4.5, `${theme.id}: ${foreground} on ${background} is ${contrast.toFixed(2)}:1`);
  }
  for (const theme of CLANK_THEME_PRESETS) {
    for (const foreground of ["text", "textMuted", "textFaint", "accent", "accentHover"]) {
      for (const background of ["canvas", "canvasRaised", "surface", "surfaceMuted", "surfaceHover"]) {
        check(theme, foreground, background);
      }
    }
    check(theme, "accentContrast", "accent");
    check(theme, "accentContrast", "accentHover");
    check(theme, "dangerContrast", "danger");
  }
});
