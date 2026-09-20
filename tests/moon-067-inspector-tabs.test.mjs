import test from "node:test";
import assert from "node:assert/strict";
import { browser, elements, h, render, renderToString, DesignStudio, settled } from "./helpers/design-studio-fixture.mjs";
const settings = { theme: "midnight", width: 523, grid: true, outlines: true, panel: "code" };

test("inspector SSR has one tab stop, linked tabpanels, and URL-selected panel content", async () => {
  const html = await renderToString(h(DesignStudio, { initialView: "input", initialTheme: "clank", initialSettings: settings, frameworkVersion: "test" }), { markers: false });
  const tabs = [...html.matchAll(/<button\b(?=[^>]*role="tab")([^>]*)>/gu)].map((match) => match[1]);
  assert.equal(tabs.length, 3);
  assert.equal(tabs.filter((tab) => /tabindex="0"/iu.test(tab)).length, 1);
  assert.equal(tabs.filter((tab) => /aria-selected="true"/u.test(tab)).length, 1);
  assert.match(tabs[1], /aria-selected="true"/u);
  for (const tab of tabs) {
    const id = tab.match(/\bid="([^"]+)"/u)[1];
    const panel = tab.match(/aria-controls="([^"]+)"/u)[1];
    assert.ok(html.includes(`id="${panel}" role="tabpanel" aria-labelledby="${id}"`));
  }
  assert.match(html, /Focused package import/u);
  assert.doesNotMatch(html, /<h2>Semantic parts/u);
});

test("inspector arrow/Home/End navigation moves one tab stop and updates only the panel URL setting", async (t) => {
  const f = browser(t);
  const root = f.document.createElement("main"); f.document.body.append(root);
  f.onDispose(render(root, h(DesignStudio, { initialView: "input", initialTheme: "midnight", initialSettings: settings, frameworkVersion: "test" })));
  const tabs = elements(root).filter((node) => node.getAttribute("role") === "tab");
  const selected = (index) => {
    assert.deepEqual(tabs.map((tab) => tab.getAttribute("aria-selected")), tabs.map((_, i) => String(i === index)));
    assert.deepEqual(tabs.map((tab) => tab.tabIndex), tabs.map((_, i) => i === index ? 0 : -1));
    assert.equal(f.view.location.search.includes("theme=midnight"), true);
    assert.equal(f.view.location.search.includes("width=523"), true);
    assert.equal(f.view.location.search.includes("grid=1&outlines=1"), true);
  };
  selected(1);
  for (const [from, key, to] of [[1, "ArrowRight", 2], [2, "Home", 0], [0, "End", 2], [2, "ArrowRight", 0], [0, "ArrowLeft", 2]]) {
    let prevented = false;
    tabs[from].emit("keydown", { key, preventDefault() { prevented = true; } });
    await settled();
    assert.equal(prevented, true); assert.equal(f.document.activeElement, tabs[to]); selected(to);
  }
  f.view.location = new URL("https://design.example/components/input?theme=midnight&width=523&grid=1&outlines=1&panel=code");
  f.view.emit("popstate"); await settled(); selected(1);
  assert.equal(f.document.activeElement, tabs[2], "History restoration does not steal keyboard focus");
});
