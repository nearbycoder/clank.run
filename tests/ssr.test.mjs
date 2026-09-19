import test from "node:test";
import assert from "node:assert/strict";
import {
  For,
  Portal,
  createCheckbox,
  createContext,
  computed,
  effect,
  h,
  onCleanup,
  onMount,
  provideContext,
  renderDocument,
  renderToString,
  signal,
  useContext,
  useId,
} from "../dist/index.js";

test("completed SSR components release subscriptions across repeated requests", async () => {
  const source = signal(1);
  let runs = 0;
  function Page() {
    const doubled = computed(() => source.value * 2);
    effect(() => { doubled.value; runs++; });
    return h("p", {}, doubled);
  }
  for (let index = 0; index < 100; index++) {
    assert.match(await renderToString(h(Page)), />2<!--/);
  }
  assert.equal(runs, 100);
  source.value = 2;
  assert.equal(runs, 100, "finished requests must not remain subscribed to shared server state");
  assert.match(await renderToString(h(Page)), />4<!--/);
  assert.equal(runs, 101);
});

test("SSR owns component cleanup through async rendering and isolates concurrent requests", async () => {
  const source = signal(1);
  const pending = new Map();
  const cleaned = [];
  function Page({ id }) {
    const doubled = computed(() => source.value * 2);
    onCleanup(() => cleaned.push(id));
    return new Promise((resolve) => pending.set(id, () => resolve(h("p", {}, doubled))));
  }
  const first = renderToString(h(Page, { id: "first" }));
  const second = renderToString(h(Page, { id: "second" }));
  assert.deepEqual(cleaned, []);
  pending.get("first")();
  assert.match(await first, />2<!--/);
  assert.deepEqual(cleaned, ["first"]);
  source.value = 3;
  pending.get("second")();
  assert.match(await second, />6<!--/);
  assert.deepEqual(cleaned, ["first", "second"]);
});

test("SSR releases component resources after evaluation and child-render failures", async () => {
  for (const duringEvaluation of [true, false]) {
    let cleaned = 0;
    function Page() {
      onCleanup(() => { cleaned++; });
      if (duringEvaluation) throw new Error("render failed");
      return Promise.reject(new Error("render failed"));
    }
    await assert.rejects(renderToString(h(Page)), /render failed/);
    assert.equal(cleaned, 1);
  }
});

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
  const reversedClassOrder = await renderToString(h("div", {
    classList: { active: true, hidden: false },
    className: ["card active", { ready: true }],
  }));
  assert.match(reversedClassOrder, /class="card active ready"/);
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

test("SSR preserves portal content between hydration markers", async () => {
  const html = await renderToString(h("main", {}, h(Portal, {}, h("dialog", {}, "Portalled"))));
  assert.equal(html, "<main><!--clank:portal--><dialog>Portalled</dialog><!--clank:/portal--></main>");
});

test("headless control parts render deterministic hydration-ready form markup", async () => {
  function HeadlessProbe() {
    const checkbox = createCheckbox({
      id: "ssr-sync",
      name: "sync",
      defaultChecked: false,
      required: true,
    });
    return h("form", {},
      h("button", checkbox.root(),
        h("span", checkbox.indicator({ keepMounted: true }), "✓"),
        "Keep synchronized",
      ),
      h("input", checkbox.input()),
    );
  }

  const first = await renderToString(h(HeadlessProbe));
  const second = await renderToString(h(HeadlessProbe));
  assert.equal(first, second);
  assert.match(first, /id="ssr-sync"/);
  assert.match(first, /role="checkbox"/);
  assert.match(first, /aria-checked="false"/);
  assert.match(first, /data-state="unchecked"/);
  assert.match(first, /id="ssr-sync-input"/);
  assert.match(first, /name="sync"/);
  assert.match(first, /aria-hidden="true"/);
});

test("render-root IDs are deterministic across independent SSR renders", async () => {
  function LabelledInput() {
    const id = useId("field");
    return h("label", { for: id }, "Name", h("input", { id }));
  }
  const view = h("form", {}, h(LabelledInput), h(LabelledInput));
  const first = await renderToString(view);
  const second = await renderToString(view);
  assert.equal(first, second);
  assert.match(first, /for="clank-field-1"/);
  assert.match(first, /for="clank-field-2"/);
});
