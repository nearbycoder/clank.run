import test from "node:test";
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
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

test("SSR defers successful component cleanup until synchronous siblings have rendered", async () => {
  const value = signal("before");
  let cleaned = 0;
  function First() {
    onCleanup(() => { cleaned++; value.value = "after"; });
    return "A";
  }
  function Second() { return value.value; }

  const rendered = renderToString([h(First), h(Second)]);
  assert.equal(cleaned, 0, "Cleanup must not run during synchronous sibling evaluation.");
  assert.equal(value.value, "before");
  assert.equal(await rendered, "Abefore");
  assert.equal(cleaned, 1);
  assert.equal(value.value, "after");
});

test("SSR releases completed component scopes while an asynchronous sibling is pending", async () => {
  const cleaned = [];
  let resolvePending;
  function Completed() {
    onCleanup(() => cleaned.push("completed"));
    return "A";
  }
  function Pending() {
    onCleanup(() => cleaned.push("pending"));
    return new Promise(resolve => { resolvePending = resolve; });
  }

  const rendered = renderToString([h(Completed), h(Pending)]);
  assert.deepEqual(cleaned, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cleaned, ["completed"]);
  resolvePending("B");
  assert.equal(await rendered, "AB");
  assert.deepEqual(cleaned, ["completed", "pending"]);
});

test("SSR normalizes custom Promise subclasses before attaching component cleanup", async () => {
  let cleaned = 0;
  class CustomPromise extends Promise {
    finally() { throw new Error("Custom finally must not be used by the renderer."); }
  }
  function Content({ fail = false }) {
    onCleanup(() => { cleaned++; });
    return fail
      ? CustomPromise.reject(new Error("Component failed."))
      : CustomPromise.resolve(h("p", {}, "content"));
  }

  assert.equal(await renderToString(h(Content)), "<p>content</p>");
  assert.equal(cleaned, 1);
  await assert.rejects(renderToString(h(Content, { fail: true })), /Component failed\./u);
  assert.equal(cleaned, 2);
});

test("synchronous SSR trees do not allocate a Promise for each row", async () => {
  const measured = [];
  for (const rows of [10, 1000]) {
    const view = h("ul", {}, ...Array.from({ length: rows }, (_, index) => h("li", { "data-index": index }, String(index))));
    let promises = 0;
    const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
    let output;
    hook.enable();
    try { output = renderToString(view); } finally { hook.disable(); }
    assert.ok(output instanceof Promise, "The public renderer remains asynchronous.");
    const html = await output;
    assert.equal((html.match(/<li /gu) ?? []).length, rows);
    assert.ok(html.endsWith(`<li data-index="${rows - 1}">${rows - 1}</li></ul>`));
    measured.push(promises);
  }
  assert.ok(measured[0] <= 2, `Static rendering allocated ${measured[0]} promises.`);
  assert.equal(measured[1], measured[0], "Promise allocations must not grow with a synchronous tree.");
});

test("a synchronous child failure preserves pending sibling cleanup and rejection handling", async () => {
  let rejectPending, tailRendered = 0;
  const cleaned = [];
  function Pending() {
    onCleanup(() => cleaned.push("pending"));
    return new Promise((_resolve, reject) => { rejectPending = reject; });
  }
  function Unsafe() {
    onCleanup(() => cleaned.push("unsafe"));
    return h("a", { href: ["javascript:alert(1)"] }, "unsafe");
  }
  function Tail() {
    tailRendered++;
    onCleanup(() => cleaned.push("tail"));
    return h("p", {}, "tail");
  }
  let rendering;
  assert.doesNotThrow(() => { rendering = renderToString([h(Pending), h(Unsafe), h(Tail)]); });
  await assert.rejects(rendering, /Unsafe URL scheme/u);
  assert.equal(tailRendered, 1, "A rejected sibling must not prevent other children from being observed.");
  assert.deepEqual(cleaned.sort(), ["tail", "unsafe"]);
  rejectPending(new Error("late sibling rejection"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cleaned.sort(), ["pending", "tail", "unsafe"]);
});

test("mixed asynchronous components retain order and nested keyed/portal markers", async () => {
  const cleaned = [];
  function Row({ item }) {
    onCleanup(() => cleaned.push(item.id));
    const text = computed(() => item.title);
    const output = h("li", { "data-id": item.id }, text);
    return item.async ? Promise.resolve(output) : output;
  }
  const items = [{ id: "a", title: "<Alpha>", async: true }, { id: "b", title: "Beta & co", async: false }];
  const view = h(Portal, {}, h("ul", {}, h(For, { each: items, by: "id" }, item => h(Row, { item }))));
  assert.equal(await renderToString(view), '<!--clank:portal--><ul><!--clank:for--><li data-id="a"><!--clank:start-->&lt;Alpha&gt;<!--clank:end--></li><li data-id="b"><!--clank:start-->Beta &amp; co<!--clank:end--></li><!--clank:/for--></ul><!--clank:/portal-->');
  assert.deepEqual(cleaned.sort(), ["a", "b"]);
});
