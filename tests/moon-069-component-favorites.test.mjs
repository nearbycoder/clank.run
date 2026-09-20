import test from "node:test";
import assert from "node:assert/strict";
import { browser, button, elements, h, render, DesignStudio, UI_COMPONENT_CATALOG, settled, load } from "./helpers/design-studio-fixture.mjs";
const { FAVORITES_KEY, favoriteComponentIds, readFavoriteComponents, saveFavoriteComponents, toggleFavoriteComponent } = await load("tools/studio-data");

test("favorite storage accepts only versioned, bounded, unique IDs from the supplied catalog", () => {
  assert.equal(UI_COMPONENT_CATALOG.length, 39);
  const all = UI_COMPONENT_CATALOG.map((entry) => entry.slug);
  assert.deepEqual(favoriteComponentIds({ version: 1, ids: [...all, ...all] }, UI_COMPONENT_CATALOG), all);
  assert.deepEqual(favoriteComponentIds({ version: 1, ids: [null, "https://evil.invalid", "input", "input", "__proto__", "switch"] }, UI_COMPONENT_CATALOG), ["input", "switch"]);
  assert.deepEqual(favoriteComponentIds({ version: 1, ids: ["input", "custom"] }, [{ slug: "custom" }]), ["custom"], "No hardcoded duplicate catalog");
  assert.deepEqual(favoriteComponentIds({ version: 1, ids: [...Array(128).fill(null), "input"] }, UI_COMPONENT_CATALOG), []);
  for (const value of [null, [], ["input"], { version: 2, ids: all }, { ids: all }, { version: 1, ids: {} }]) assert.deepEqual(favoriteComponentIds(value, UI_COMPONENT_CATALOG), []);
  assert.deepEqual(toggleFavoriteComponent(UI_COMPONENT_CATALOG, ["input"], "input"), []);
  assert.deepEqual(toggleFavoriteComponent(UI_COMPONENT_CATALOG, ["input"], "switch"), ["switch", "input"]);
  assert.deepEqual(toggleFavoriteComponent(UI_COMPONENT_CATALOG, ["input"], "__proto__"), ["input"]);
});

test("accessible favorite toggles persist, merge another tab, restore navigation, and retain preview settings", async (t) => {
  const stored = new Map([[FAVORITES_KEY, JSON.stringify({ version: 1, ids: ["switch"] })]]);
  const f = browser(t, { stored });
  const root = f.document.createElement("main"); f.document.body.append(root);
  const settings = { theme: "midnight", width: 523, grid: true, outlines: true, panel: "code" };
  f.onDispose(render(root, h(DesignStudio, { initialView: "input", initialTheme: "midnight", initialSettings: settings, frameworkVersion: "test" })));
  await settled();
  const favorites = () => elements(root).find((node) => node.getAttribute("class") === "favorite-navigation");
  const links = () => elements(favorites()).filter((node) => node.tagName === "A");
  assert.deepEqual(links().map((node) => node.textContent), ["Switch"]);
  const toggle = button(root, "Favorite");
  assert.equal(toggle.getAttribute("aria-label"), "Favorite Input");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  stored.set(FAVORITES_KEY, JSON.stringify({ version: 1, ids: ["switch", "checkbox"] }));
  toggle.focus(); toggle.emit("click"); await settled();
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(f.document.activeElement, toggle);
  assert.deepEqual(readFavoriteComponents(UI_COMPONENT_CATALOG), ["input", "switch", "checkbox"]);
  assert.deepEqual(links().map((node) => node.textContent), ["Input", "Switch", "Checkbox"]);
  assert.ok(links()[0].getAttribute("href").endsWith("?theme=midnight&width=523&grid=1&outlines=1&panel=code"));
  assert.equal(links()[0].getAttribute("aria-current"), "page");
  assert.match(root.textContent, /Input added to favorites\./u);
  const before = f.view.location.href;
  stored.set(FAVORITES_KEY, JSON.stringify({ version: 1, ids: ["switch"] }));
  f.view.emit("storage", { key: FAVORITES_KEY }); await settled();
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.deepEqual(links().map((node) => node.textContent), ["Switch"]);
  assert.equal(f.view.location.href, before);
  stored.clear(); f.view.emit("storage", { key: null }); await settled();
  assert.equal(links().length, 0);
});

test("malformed or oversized storage resets safely and blocked storage preserves in-memory favorites", (t) => {
  const f = browser(t);
  for (const raw of ["{", "x".repeat(8193), JSON.stringify({ version: 1, ids: ["missing"] })]) {
    f.stored.set(FAVORITES_KEY, raw);
    assert.deepEqual(readFavoriteComponents(UI_COMPONENT_CATALOG), []);
  }
  f.localStorage.getItem = () => { throw new Error("blocked"); };
  f.localStorage.setItem = () => { throw new Error("blocked"); };
  assert.deepEqual(readFavoriteComponents(UI_COMPONENT_CATALOG, ["input", "bad"]), ["input"]);
  assert.doesNotThrow(() => saveFavoriteComponents(UI_COMPONENT_CATALOG, ["input"]));
  const root = f.document.createElement("main"); f.document.body.append(root);
  f.onDispose(render(root, h(DesignStudio, { initialView: "input", initialTheme: "clank", frameworkVersion: "test" })));
  const toggle = button(root, "Favorite");
  toggle.emit("click"); assert.equal(toggle.getAttribute("aria-pressed"), "true");
  toggle.emit("click"); assert.equal(toggle.getAttribute("aria-pressed"), "false");
});

test("failed writes retain local toggles while readable storage still merges another tab", async (t) => {
  for (const initial of [[], ["switch"]]) await t.test(JSON.stringify(initial), async (t) => {
    const stored = new Map([[FAVORITES_KEY, JSON.stringify({ version: 1, ids: initial })]]);
    const f = browser(t, { stored });
    const save = f.localStorage.setItem;
    f.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    const root = f.document.createElement("main"); f.document.body.append(root);
    f.onDispose(render(root, h(DesignStudio, { initialView: "input", initialTheme: "clank", frameworkVersion: "test" })));
    await settled();
    const toggle = button(root, "Favorite");
    const names = () => elements(elements(root).find((node) => node.getAttribute("class") === "favorite-navigation"))
      .filter((node) => node.tagName === "A").map((node) => node.textContent);
    toggle.emit("click"); assert.equal(toggle.getAttribute("aria-pressed"), "true");
    toggle.emit("click"); assert.equal(toggle.getAttribute("aria-pressed"), "false");
    toggle.emit("click"); assert.equal(toggle.getAttribute("aria-pressed"), "true");
    stored.set(FAVORITES_KEY, JSON.stringify({ version: 1, ids: ["checkbox"] }));
    f.view.emit("storage", { key: FAVORITES_KEY });
    assert.deepEqual(names(), ["Input", "Checkbox"], "Unsaved local intent overlays the latest saved IDs");
    f.localStorage.setItem = save;
    toggle.emit("click");
    assert.deepEqual(readFavoriteComponents(UI_COMPONENT_CATALOG), ["checkbox"]);
    stored.set(FAVORITES_KEY, JSON.stringify({ version: 1, ids: ["switch"] }));
    f.view.emit("storage", { key: FAVORITES_KEY });
    assert.deepEqual(names(), ["Switch"], "Successful persistence clears the local overrides");
  });
});
