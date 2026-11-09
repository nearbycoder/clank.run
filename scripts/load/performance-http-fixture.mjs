// Loopback-only fixture for performance-http.mjs: an in-memory backend behind the Node adapter.
if (!process.send) throw new Error("Start this internal fixture through performance-http.mjs.");
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [dist, port] = process.argv.slice(2);
const base = pathToFileURL(`${resolve(dist)}/`);
const mod = (name) => import(new URL(`${name}.js`, base));
const [index, dom, ssr, server, node] = await Promise.all(["index", "dom", "ssr", "server", "node"].map(mod));
const { h } = dom;
const { defineBackend, defineDatabase, defineTable, openBackend, s } = index;
const definition = defineBackend({ schema: defineDatabase({ items: defineTable({ title: s.string(), done: s.boolean(), count: s.number() }) }) }).functions(({ query, mutation }) => ({
  list: query({ args: {}, handler: ({ db }) => db.table("items").query().limit(20).collect() }),
  seed: mutation({ args: {}, handler: ({ db }) => { for (let n = 0; n < 40; n++) db.table("items").insert({ title: `Task ${n} ${"x".repeat(100)}`, done: false, count: n }); } }),
  write: mutation({ args: {}, handler: ({ db }) => { const item = db.table("items").query().first(); return db.table("items").patch(item._id, { count: item.count + 1 }); } }),
}));
const backend = await openBackend(definition, { path: ":memory:", agent: false, verifyOrigin: false });
await backend.mutation("seed", {});
const rows = Array.from({ length: 50 }, (_, id) => ({ id, name: `User ${id}`, email: `user${id}@example.com` }));
const Layout = ({ children }) => h("div", { class: "layout" }, h("header", null, h("nav", null, ...["Home", "Docs", "Pricing", "Blog"].map((t) => h("a", { href: `/${t.toLowerCase()}` }, t)))), h("main", null, children), h("footer", null, "© Clank"));
const Table = () => h("table", null, h("tbody", null, ...rows.map((r) => h("tr", { key: r.id }, h("td", null, r.name), h("td", null, h("a", { href: `mailto:${r.email}` }, r.email))))));
const app = server.createApp();
app.use(server.securityHeaders());
for (let i = 0; i < 20; i++) app.get(`/api/resource${i}/:id`, ({ params }) => server.json({ id: params.id, i }));
app.get("/text", () => server.text("Hello, World!"));
app.get("/json", () => server.json({ message: "Hello, World!" }));
app.get("/page", async () => server.html(await ssr.renderDocument(h(Layout, null, h(Table)), { title: "Users" })));
app.route("*", "/__clank/*", ({ request }) => backend.handle(request));
const handle = await node.serve(app, { port: Number(port), hostname: "127.0.0.1", ...(process.env.COMPRESS ? { compression: true } : {}) });
process.send?.({ ready: true, url: handle.url });
process.on("message", async (m) => { if (m === "stop") { await handle.close().catch(() => {}); backend.close(); process.exit(0); } });
