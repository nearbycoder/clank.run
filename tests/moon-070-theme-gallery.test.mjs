import test from "node:test";
import assert from "node:assert/strict";
import { browser, button, elements, h, render, renderToString, DesignStudio, CLANK_THEME_PRESETS, settled, load } from "./helpers/design-studio-fixture.mjs";
const { filterThemeGallery } = await load("tools/studio-data");

test("theme search combines case-insensitive names, descriptions, tags, and color scheme", () => {
  const ids = (query, scheme = "all") => filterThemeGallery(CLANK_THEME_PRESETS, query, scheme).entries.map((theme) => theme.id);
  assert.deepEqual(ids("  MIDNIGHT  "), ["midnight"]);
  assert.deepEqual(ids("fjord"), ["nordic"]);
  assert.deepEqual(ids("PILL"), ["candy"]);
  assert.deepEqual(ids("square", "light"), ["sandstone"]);
  assert.deepEqual(ids("square", "dark"), ["terminal"]);
  assert.equal(ids("", "light").length, 6);
  assert.equal(ids("", "dark").length, 4);
  assert.deepEqual(ids("no such theme"), []);
  assert.equal(filterThemeGallery(CLANK_THEME_PRESETS, null, "unknown").count, 10);
  assert.equal(filterThemeGallery(CLANK_THEME_PRESETS, "", "all").active, false);
});

test("theme filters expose labels/count/reset and never change the selected theme or URL", async (t) => {
  const html = await renderToString(h(DesignStudio, { initialView: "themes", initialTheme: "midnight", frameworkVersion: "test" }), { markers: false });
  assert.match(html, /for="theme-gallery-search"/u);
  assert.match(html, /for="theme-gallery-scheme"/u);
  assert.match(html, /role="status" aria-live="polite"[^>]*>10 of 10 themes/u);
  const f = browser(t, { url: "https://design.example/themes?theme=midnight" });
  const root = f.document.createElement("main"); f.document.body.append(root);
  f.onDispose(render(root, h(DesignStudio, { initialView: "themes", initialTheme: "midnight", frameworkVersion: "test" })));
  const search = f.document.getElementById("theme-gallery-search");
  const scheme = f.document.getElementById("theme-gallery-scheme");
  const cards = () => elements(root).filter((node) => node.getAttribute("class") === "theme-card");
  scheme.value = "light"; scheme.emit("change"); await settled();
  assert.equal(cards().length, 6);
  assert.match(root.textContent, /Current theme: Midnight\. It remains active/u);
  search.value = "pill"; search.emit("input"); await settled();
  assert.equal(cards().length, 1); assert.match(cards()[0].textContent, /Candy/u);
  search.value = "no match"; search.emit("input"); await settled();
  assert.equal(cards().length, 0); assert.match(root.textContent, /0 of 10 themes/u);
  button(root, "Reset themes").emit("click"); await settled();
  assert.equal(cards().length, 10); assert.equal(search.value, ""); assert.equal(scheme.value, "all");
  assert.equal(f.document.documentElement.dataset.clankTheme, "midnight");
  assert.equal(f.view.location.href, "https://design.example/themes?theme=midnight");
  assert.equal(f.history.length, 0);
});
