import test from "node:test";
import assert from "node:assert/strict";
import { browser, button, elements, h, render, DesignStudio, UI_COMPONENT_CATALOG, setClipboard, settled, load } from "./helpers/design-studio-fixture.mjs";
const { componentUsage } = await load("tools/studio-data");
const { copyRenderedText } = await load("tools/copy-text-data");

function usage(t) {
  const f = browser(t);
  const root = f.document.createElement("main"); f.document.body.append(root);
  const dispose = render(root, h(DesignStudio, { initialView: "input", initialTheme: "clank", initialSettings: { panel: "code" }, frameworkVersion: "test" }));
  f.onDispose(dispose);
  return { ...f, root, dispose, copy: button(root, "Copy usage example") };
}

test("each usage example uses the current catalog entry and copy success waits for exact clipboard text", async (t) => {
  for (const entry of UI_COMPONENT_CATALOG) {
    const text = componentUsage(entry);
    assert.ok(text.includes(`import { ${entry.factory} } from "@clank.run/framework/ui/${entry.slug}";`));
    assert.ok(text.includes(`const ${entry.slug.replaceAll("-", "_")} = ${entry.factory}(`));
  }
  let finish, copied;
  setClipboard(t, { writeText: (text) => { copied = text; return new Promise((resolve) => { finish = resolve; }); } });
  const f = usage(t);
  f.copy.emit("click");
  assert.equal(f.copy.textContent, "Copying…");
  assert.doesNotMatch(f.root.textContent, /usage example copied\./u);
  finish(); await settled();
  assert.equal(copied, componentUsage(UI_COMPONENT_CATALOG.find((entry) => entry.slug === "input")));
  assert.match(f.root.textContent, /Input usage example copied\./u);
});

test("clipboard failure selects only current rendered usage and never falsely announces a copy", async (t) => {
  setClipboard(t, { writeText: async () => { throw new Error("denied"); } });
  const f = usage(t); f.copy.emit("click"); await settled();
  assert.equal(f.selection.node.tagName, "CODE");
  assert.equal(f.selection.node.textContent, componentUsage(UI_COMPONENT_CATALOG.find((entry) => entry.slug === "input")));
  assert.equal(f.document.activeElement.tagName, "PRE");
  assert.match(f.root.textContent, /Text selected\. Press Ctrl\+C or Command\+C/u);
  assert.doesNotMatch(f.root.textContent, /usage example copied\./u);
});

test("stale, detached, and mismatched previews cannot steal selection after a failed copy", async (t) => {
  let reject;
  setClipboard(t, { writeText: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const f = usage(t); f.copy.emit("click"); f.dispose(); reject(new Error("denied")); await settled();
  assert.equal(f.selection.node, null);
  assert.equal(await copyRenderedText("exact", () => ({ isConnected: false, textContent: "exact" })), "unavailable");
  assert.equal(await copyRenderedText("exact", () => ({ isConnected: true, textContent: "wrong" })), "unavailable");
  assert.equal(await copyRenderedText("exact", () => { throw new Error("Must not read stale DOM"); }, undefined, () => false), "stale");
});
