import test from "node:test";
import assert from "node:assert/strict";
import {
  For,
  createContext,
  h,
  onMount,
  provideContext,
  renderDocument,
  renderToString,
  signal,
  useContext,
} from "../dist/index.js";

test("SSR escapes content, resolves reactive attributes, and emits hydration markers", async () => {
  const title = signal("<unsafe>");
  const html = await renderToString(h("article", {
    class: "card",
    classList: { active: true, hidden: false },
    style: { color: "red", "--space": 2 },
    agentLabel: title,
  }, title));
  assert.match(html, /^<article /);
  assert.match(html, /class="card active"/);
  assert.match(html, /style="color:red;--space:2"/);
  assert.match(html, /data-clank-label="&lt;unsafe&gt;"/);
  assert.match(await renderToString(h("button", { "aria-expanded": false }, "Menu")), /aria-expanded="false"/);
  assert.doesNotMatch(html, /aria-label/);
  assert.match(html, /<!--clank:start-->&lt;unsafe&gt;<!--clank:end-->/);
});

test("SSR evaluates component context and keyed control flow without running mounts", async () => {
  const Theme = createContext("light");
  let mounted = false;
  function Row({ item }) {
    return h("li", { "data-id": item.id }, `${useContext(Theme)}:${item.title}`);
  }
  function App() {
    provideContext(Theme, "dark");
    onMount(() => { mounted = true; });
    return h("ul", {}, h(For, {
      each: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }],
      by: "id",
    }, (item) => h(Row, { item })));
  }
  const html = await renderToString(h(App));
  assert.equal(mounted, false);
  assert.match(html, /<!--clank:for--><li data-id="a">dark:Alpha<\/li><li data-id="b">dark:Beta<\/li><!--clank:\/for-->/);
});

test("renderDocument creates a full page and script-safe serialized state", async () => {
  const html = await renderDocument(h("main", {}, "Ready"), {
    title: "Tasks & notes",
    state: { text: "</script><script>alert(1)</script>" },
    scripts: ["/app.js"],
    stylesheets: ["/app.css"],
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Tasks &amp; notes<\/title>/);
  assert.match(html, /<div id="app"><main>Ready<\/main><\/div>/);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /<script type="module" src="\/app.js"><\/script>/);
});

test("SSR rejects executable URL and raw iframe attributes and supports CSP nonces", async () => {
  await assert.rejects(
    () => renderToString(h("a", { href: "java\nscript:alert(1)" }, "unsafe")),
    /Unsafe URL scheme/,
  );
  await assert.rejects(
    () => renderToString(h("iframe", { srcdoc: "<script>alert(1)</script>" })),
    /srcdoc/,
  );
  const skipped = await renderToString(h("button", { oNcLiCk: "alert(1)" }, "Safe"));
  assert.doesNotMatch(skipped, /onclick/i);

  await assert.rejects(
    () => renderDocument(h("main"), { scripts: ["data:text/javascript,alert(1)"] }),
    /Unsafe data URL/,
  );
  const nonce = "0123456789abcdef0123456789abcdef";
  const document = await renderDocument(h("main"), {
    nonce,
    state: { safe: true },
    scripts: ["/app.js"],
  });
  assert.equal((document.match(new RegExp(`nonce="${nonce}"`, "g")) ?? []).length, 2);
});
