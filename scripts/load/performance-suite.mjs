// In-process A/B microbenchmarks. Builds are read-only inputs; nothing touches a real database.
// node scripts/load/performance-suite.mjs BASELINE_DIST CANDIDATE_DIST [FILTER] [ROUNDS=5] [WINDOW_MS=300]
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const [basePath, candPath, filter = "", roundsIn = "5", msIn = "300"] = process.argv.slice(2);
if (!basePath || !candPath) throw new Error("Provide baseline and candidate dist directories.");
const rounds = Number(roundsIn), windowMs = Number(msIn);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) throw new Error("Invalid rounds.");
if (!Number.isFinite(windowMs) || windowMs < 10 || windowMs > 10_000) throw new Error("Invalid window.");
const load = async (dir) => {
  const base = pathToFileURL(`${resolve(dir)}/`);
  const mod = (name) => import(new URL(`${name}.js`, base));
  const [index, core, dom, ssr, server, node, router] = await Promise.all(["index", "core", "dom", "ssr", "server", "node", "router"].map(mod));
  return { index, core, dom, ssr, server, node, router };
};
const apis = { baseline: await load(basePath), candidate: await load(candPath) };

const scenarios = {
  "core.create": ({ core }) => () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) { const s = core.signal(i); const c = new core.Computed(() => s.value + 1); sum += c.value; }
    return sum;
  },
  "core.fanout": ({ core }) => {
    let run;
    core.createRoot(() => {
      const source = core.signal(0);
      const branches = Array.from({ length: 100 }, (_, i) => core.computed(() => source.value + i));
      let total = 0;
      core.effect(() => { total = 0; for (const b of branches) total += b.value; });
      let v = 0;
      run = () => { for (let i = 0; i < 20; i++) source.value = ++v; return total; };
    });
    return run;
  },
  "core.chain": ({ core }) => {
    let run;
    core.createRoot(() => {
      const source = core.signal(0);
      let last = source;
      for (let i = 0; i < 50; i++) { const prev = last; last = core.computed(() => prev.value + 1); }
      let seen = 0;
      const tail = last;
      core.effect(() => { seen = tail.value; });
      let v = 0;
      run = () => { for (let i = 0; i < 40; i++) source.value = ++v; return seen; };
    });
    return run;
  },
  "core.manyEffects": ({ core }) => {
    let run;
    core.createRoot(() => {
      const source = core.signal(0);
      let total = 0;
      for (let i = 0; i < 1000; i++) core.effect(() => { total += source.value; });
      let v = 0;
      run = () => { source.value = ++v; source.value = ++v; return total; };
    });
    return run;
  },
  "core.batchWrites": ({ core }) => {
    let run;
    core.createRoot(() => {
      const signals = Array.from({ length: 100 }, (_, i) => core.signal(i));
      const sum = core.computed(() => { let t = 0; for (const s of signals) t += s.value; return t; });
      let seen = 0;
      core.effect(() => { seen = sum.value; });
      let v = 0;
      run = () => { for (let r = 0; r < 10; r++) core.batch(() => { v++; for (const s of signals) s.value = v; }); return seen; };
    });
    return run;
  },
  "core.readHot": ({ core }) => {
    const s = core.signal(1); const c = new core.Computed(() => s.value * 2);
    return () => { let t = 0; for (let i = 0; i < 20000; i++) t += s.value + c.value + s.peek(); return t; };
  },
  "core.store": ({ core }) => {
    let run;
    core.createRoot(() => {
      const state = core.store({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, done: false, title: `t${i}` })), filter: "all" });
      let count = 0;
      core.effect(() => { count = 0; for (const item of state.items) if (item.done) count++; });
      let i = 0;
      run = () => { for (let r = 0; r < 20; r++) { const item = state.items[i++ % 50]; item.done = !item.done; } return count; };
    });
    return run;
  },
  "ssr.static": ({ dom, ssr }) => {
    const { h } = dom;
    const items = Array.from({ length: 200 }, (_, id) => ({ id, title: `Item ${id} <tag> & "quoted"` }));
    return () => ssr.renderToString(h("ul", { class: "list" }, ...items.map((item) => h("li", { "data-id": item.id, class: "row item" }, h("span", { class: "title" }, item.title), h("a", { href: `/items/${item.id}`, title: item.title }, "Open")))));
  },
  "ssr.components": ({ dom, ssr, core }) => {
    const { h, For } = dom;
    const items = Array.from({ length: 200 }, (_, id) => ({ id, title: `Item ${id}`, done: id % 3 === 0 }));
    const Badge = ({ done }) => h("span", { class: { badge: true, done }, "aria-pressed": done }, done ? "Done" : "Open");
    const Row = ({ item }) => { const label = core.computed(() => `${item.id}: ${item.title}`); return h("li", { class: "row", style: { color: item.done ? "green" : "red", paddingLeft: "4px" } }, h(Badge, { done: item.done }), label, h("button", { type: "button", onClick: () => {}, disabled: item.done }, "Toggle")); };
    const Page = () => h("main", { id: "app" }, h("h1", null, "Tasks"), h("ul", null, h(For, { each: items, by: "id" }, (item) => h(Row, { item }))));
    return () => ssr.renderToString(h(Page));
  },
  "ssr.document": ({ dom, ssr }) => {
    const { h } = dom;
    const rows = Array.from({ length: 60 }, (_, id) => ({ id, name: `User ${id}`, email: `user${id}@example.com` }));
    const Layout = ({ children }) => h("div", { class: "layout" }, h("header", null, h("nav", null, ...["Home", "Docs", "Pricing", "Blog"].map((t) => h("a", { href: `/${t.toLowerCase()}` }, t)))), h("main", null, children), h("footer", null, "© Clank"));
    const Table = () => h("table", null, h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Email"))), h("tbody", null, ...rows.map((r) => h("tr", { key: r.id }, h("td", null, r.name), h("td", null, h("a", { href: `mailto:${r.email}` }, r.email))))));
    return () => ssr.renderDocument(h(Layout, null, h(Table)), { title: "Users", state: { rows }, stylesheets: ["/app.css"], scripts: ["/app.js"] });
  },
  "dom.h": ({ dom }) => {
    const { h } = dom;
    return () => { let n = 0; for (let i = 0; i < 2000; i++) { const v = h("li", { class: "row", "data-id": i }, h("span", null, "x"), "text"); n += v.props.children.length; } return n; };
  },
  "router.matchPath": ({ router }) => {
    const patterns = ["/", "/users", "/users/:id", "/users/:id/posts/:postId", "/files/*", "/docs/:slug?"];
    const paths = ["/", "/users", "/users/42", "/users/42/posts/7", "/files/a/b/c.txt", "/docs", "/nope/x/y"];
    return () => { let hits = 0; for (let r = 0; r < 50; r++) for (const p of patterns) for (const path of paths) if (router.matchPath(p, path)) hits++; return hits; };
  },
  "server.route": ({ server }) => {
    const app = server.createApp();
    app.use(server.securityHeaders());
    for (let i = 0; i < 40; i++) app.get(`/api/resource${i}/:id`, ({ params }) => server.json({ id: params.id, i }));
    app.get("/health", () => server.text("ok"));
    const first = new Request("http://localhost/api/resource0/abc"), last = new Request("http://localhost/api/resource39/xyz"), health = new Request("http://localhost/health"), missing = new Request("http://localhost/missing");
    return async () => { let s = 0; for (let i = 0; i < 25; i++) { s += (await app.handle(first)).status + (await app.handle(last)).status + (await app.handle(health)).status + (await app.handle(missing)).status; } return s; };
  },
  "server.json": ({ server }) => {
    const payload = { ok: true, items: Array.from({ length: 20 }, (_, i) => ({ id: i, title: `Task ${i}`, done: false })) };
    return () => { let n = 0; for (let i = 0; i < 200; i++) n += server.json(payload).status + server.html("<p>hi</p>", { headers: { "cache-control": "no-store" } }).status; return n; };
  },
  "schema.parse": ({ index }) => {
    const { s } = index;
    const schema = s.object({ title: s.string(), done: s.boolean(), count: s.number(), tags: s.array(s.string()), meta: s.object({ a: s.string(), b: s.number() }) });
    const value = { title: "hello", done: false, count: 3, tags: ["a", "b", "c"], meta: { a: "x", b: 1 } };
    return () => { let n = 0; for (let i = 0; i < 500; i++) n += schema.parse(value).count; return n; };
  },
  "backend.query": async ({ index }) => {
    const { defineBackend, defineDatabase, defineTable, openBackend, s } = index;
    const definition = defineBackend({ schema: defineDatabase({ items: defineTable({ title: s.string(), done: s.boolean(), count: s.number() }) }) }).functions(({ query, mutation }) => ({
      list: query({ args: {}, handler: ({ db }) => db.table("items").query().limit(20).collect() }),
      get: query({ args: { n: s.number() }, handler: ({ db }, { n }) => db.table("items").query().limit(n).collect() }),
      seed: mutation({ args: {}, handler: ({ db }) => { for (let n = 0; n < 40; n++) db.table("items").insert({ title: `Task ${n} ${"x".repeat(100)}`, done: false, count: n }); } }),
      write: mutation({ args: {}, handler: ({ db }) => { const item = db.table("items").query().first(); return db.table("items").patch(item._id, { count: item.count + 1 }); } }),
    }));
    const backend = await openBackend(definition, { path: ":memory:", agent: false, verifyOrigin: false });
    await backend.mutation("seed", {});
    let n = 0;
    const body = (v) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
    const run = async () => {
      let s = 0;
      for (let i = 0; i < 20; i++) {
        s += (await backend.handle(new Request("http://localhost/__clank/query/list", body({})))).status;
        s += (await backend.handle(new Request("http://localhost/__clank/query/get", body({ n: 1 + (n++ % 5) })))).status;
      }
      return s;
    };
    run.close = () => backend.close(); run.backend = backend;
    return run;
  },
  "backend.mutation": async ({ index }) => {
    const { defineBackend, defineDatabase, defineTable, openBackend, s } = index;
    const definition = defineBackend({ schema: defineDatabase({ items: defineTable({ title: s.string(), done: s.boolean(), count: s.number() }) }) }).functions(({ query, mutation }) => ({
      list: query({ args: {}, handler: ({ db }) => db.table("items").query().limit(20).collect() }),
      seed: mutation({ args: {}, handler: ({ db }) => { for (let n = 0; n < 40; n++) db.table("items").insert({ title: `Task ${n} ${"x".repeat(100)}`, done: false, count: n }); } }),
      write: mutation({ args: {}, handler: ({ db }) => { const item = db.table("items").query().first(); return db.table("items").patch(item._id, { count: item.count + 1 }); } }),
      add: mutation({ args: { title: s.string() }, handler: ({ db }, { title }) => db.table("items").insert({ title, done: false, count: 0 }) }),
    }));
    const backend = await openBackend(definition, { path: ":memory:", agent: false, verifyOrigin: false });
    await backend.mutation("seed", {});
    const body = (v) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
    const run = async () => {
      let s = 0;
      for (let i = 0; i < 10; i++) {
        s += (await backend.handle(new Request("http://localhost/__clank/mutation/write", body({})))).status;
        s += (await backend.handle(new Request("http://localhost/__clank/query/list", body({})))).status;
      }
      return s;
    };
    run.close = () => backend.close();
    return run;
  },
  "backend.direct": async ({ index }) => {
    const { defineBackend, defineDatabase, defineTable, openBackend, s } = index;
    const definition = defineBackend({ schema: defineDatabase({ items: defineTable({ title: s.string(), done: s.boolean(), count: s.number() }).index("by_count", ["count"]) }) }).functions(({ query, mutation }) => ({
      byCount: query({ args: { n: s.number() }, handler: ({ db }, { n }) => db.table("items").query().where("count", "eq", n).collect() }),
      seed: mutation({ args: {}, handler: ({ db }) => { for (let n = 0; n < 500; n++) db.table("items").insert({ title: `Task ${n}`, done: n % 2 === 0, count: n % 50 }); } }),
      add: mutation({ args: { title: s.string() }, handler: ({ db }, { title }) => db.table("items").insert({ title, done: false, count: 999 }) }),
    }));
    const backend = await openBackend(definition, { path: ":memory:", agent: false, verifyOrigin: false });
    await backend.mutation("seed", {});
    let n = 0;
    const run = async () => {
      let s = 0;
      for (let i = 0; i < 20; i++) { s += (await backend.query("byCount", { n: n++ % 50 })).length; }
      await backend.mutation("add", { title: `x${n}` });
      return s;
    };
    run.close = () => backend.close();
    return run;
  },
};

async function measure(run) {
  let ops = 0;
  const start = performance.now();
  let now = start;
  while (now - start < windowMs) { const r = run(); if (r instanceof Promise) await r; ops++; now = performance.now(); }
  return ops / (now - start) * 1000;
}
const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const results = [];
for (const [name, make] of Object.entries(scenarios)) {
  if (filter && !filter.split(",").some((f) => name.includes(f))) continue;
  let runs;
  try { runs = { baseline: await make(apis.baseline), candidate: await make(apis.candidate) }; }
  catch (error) { console.log(`${name.padEnd(22)} SETUP FAILED: ${error.message}`); continue; }
  try {
    const a = await runs.baseline(), b = await runs.candidate();
    if (typeof a === "string") assert.equal(b, a, `${name}: output differs`);
    for (const label of ["baseline", "candidate"]) { const end = performance.now() + 150; while (performance.now() < end) await runs[label](); }
    const samples = { baseline: [], candidate: [] };
    for (let round = 0; round < rounds; round++) {
      for (const label of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) samples[label].push(await measure(runs[label]));
    }
    const base = median(samples.baseline), cand = median(samples.candidate);
    results.push({ name, base, cand });
    console.log(`${name.padEnd(22)} base ${base.toFixed(1).padStart(10)}/s  cand ${cand.toFixed(1).padStart(10)}/s  ${(cand / base).toFixed(2)}x`);
  } catch (error) { console.log(`${name.padEnd(22)} FAILED: ${error.stack}`); }
  finally { runs.baseline.close?.(); runs.candidate.close?.(); }
}
