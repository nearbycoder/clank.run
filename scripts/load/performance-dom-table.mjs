// Keyed-table A/B in a real headless browser: create, replace, update, select, swap, remove, append, clear.
// node scripts/load/performance-dom-table.mjs BASELINE_DIST CANDIDATE_DIST [ROUNDS=7]
// Set CHROME to the browser binary (default: google-chrome-stable). Loopback only; builds are read-only inputs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const [basePath, candPath, roundsIn = "7"] = process.argv.slice(2);
if (!basePath || !candPath) throw new Error("Provide baseline and candidate dist directories.");
if (!Number.isSafeInteger(Number(roundsIn)) || Number(roundsIn) < 1 || Number(roundsIn) > 50) throw new Error("Invalid rounds.");
const dirs = { baseline: resolve(basePath), candidate: resolve(candPath) };
const page = `<!doctype html><meta charset="utf-8"><title>dom ab</title><body><div id="root"></div><script type="module">
const impl = {};
for (const label of ["baseline", "candidate"]) { const [dom, core] = await Promise.all([import("/" + label + "/dom.js"), import("/" + label + "/core.js")]); impl[label] = { ...dom, ...core }; }
const rounds = ${Number(roundsIn)};
const adjectives = ["pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint"], nouns = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger"];
let nextId = 1;
const build = (n, signal) => Array.from({ length: n }, (_, i) => ({ id: nextId++, label: signal(adjectives[i % 10] + " " + nouns[(i * 7) % 10]) }));
function fixture(label) {
  const { h, For, render, signal, batch, computed } = impl[label];
  const root = document.createElement("div"); document.getElementById("root").replaceChildren(root);
  const rows = signal([]), selected = signal(0);
  const Row = ({ item }) => h("tr", { class: () => selected.value === item.id ? "danger" : "" },
    h("td", { class: "col-md-1" }, item.id),
    h("td", { class: "col-md-4" }, h("a", { onClick: () => { selected.value = item.id; } }, item.label)),
    h("td", { class: "col-md-1" }, h("a", { onClick: () => { rows.value = rows.value.filter((r) => r !== item); } }, h("span", { class: "glyphicon glyphicon-remove", "aria-hidden": "true" }))),
    h("td", { class: "col-md-6" }));
  const stop = render(root, h("table", { class: "table" }, h("tbody", null, h(For, { each: rows, by: "id" }, (item) => h(Row, { item })))));
  return { root, rows, selected, stop, signal, batch };
}
const scenarios = {
  create1k: { setup: (f) => {}, run: (f) => { f.rows.value = build(1000, f.signal); } },
  replace1k: { setup: (f) => { f.rows.value = build(1000, f.signal); }, run: (f) => { f.rows.value = build(1000, f.signal); } },
  update10th: { setup: (f) => { f.rows.value = build(1000, f.signal); }, run: (f) => { const r = f.rows.value; f.batch(() => { for (let i = 0; i < r.length; i += 10) r[i].label.value += " !!!"; }); } },
  select: { setup: (f) => { f.rows.value = build(1000, f.signal); f.selected.value = f.rows.value[5].id; }, run: (f) => { f.selected.value = f.rows.value[500].id; } },
  swap: { setup: (f) => { f.rows.value = build(1000, f.signal); }, run: (f) => { const r = f.rows.value.slice(); const t = r[1]; r[1] = r[998]; r[998] = t; f.rows.value = r; } },
  remove: { setup: (f) => { f.rows.value = build(1000, f.signal); }, run: (f) => { const r = f.rows.value; f.rows.value = r.filter((_, i) => i !== 500); } },
  append1k: { setup: (f) => { f.rows.value = build(1000, f.signal); }, run: (f) => { f.rows.value = [...f.rows.value, ...build(1000, f.signal)]; } },
  clear: { setup: (f) => { f.rows.value = build(1000, f.signal); }, run: (f) => { f.rows.value = []; } },
  create10k: { setup: (f) => {}, run: (f) => { f.rows.value = build(10000, f.signal); } },
};
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
const results = {};
for (const [name, scenario] of Object.entries(scenarios)) {
  const samples = { baseline: [], candidate: [] };
  for (let round = 0; round < rounds + 2; round++) {
    for (const label of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const f = fixture(label); scenario.setup(f); f.root.offsetHeight;
      await new Promise((r) => setTimeout(r, 0));
      const start = performance.now(); scenario.run(f); const script = performance.now() - start; f.root.offsetHeight; const total = performance.now() - start;
      if (round >= 2) samples[label].push([script, total]);
      f.stop();
    }
  }
  results[name] = { baseline: [median(samples.baseline.map((s) => s[0])), median(samples.baseline.map((s) => s[1]))], candidate: [median(samples.candidate.map((s) => s[0])), median(samples.candidate.map((s) => s[1]))] };
}
await fetch("/done", { method: "POST", body: JSON.stringify(results) });
</script>`;
const types = { ".js": "text/javascript" };
let finish;
const done = new Promise((r) => { finish = r; });
const server = createServer(async (req, res) => {
  if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end(page); }
  if (req.url === "/done") { let body = ""; for await (const c of req) body += c; res.end("ok"); return finish(JSON.parse(body)); }
  const m = /^\/(baseline|candidate)\/([A-Za-z0-9._-]+\.js)$/.exec(req.url);
  if (!m) { res.statusCode = 404; return res.end(); }
  try { res.setHeader("content-type", "text/javascript"); res.end(await readFile(join(dirs[m[1]], m[2]))); } catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(34181, "127.0.0.1", r));
const profile = mkdtempSync(join(tmpdir(), "clank-dom-ab-"));
const chrome = spawn(process.env.CHROME ?? "google-chrome-stable", ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, "--window-size=1200,900", "http://127.0.0.1:34181/"], { stdio: "ignore" });
const timer = setTimeout(() => { console.error("timeout"); chrome.kill("SIGKILL"); process.exit(1); }, 240000);
const results = await done; clearTimeout(timer); chrome.kill("SIGKILL"); server.close();
for (const [name, r] of Object.entries(results)) console.log(`${name.padEnd(12)} script base ${r.baseline[0].toFixed(2).padStart(8)}ms cand ${r.candidate[0].toFixed(2).padStart(8)}ms ${(r.baseline[0] / r.candidate[0]).toFixed(2)}x   +layout base ${r.baseline[1].toFixed(2).padStart(8)}ms cand ${r.candidate[1].toFixed(2).padStart(8)}ms ${(r.baseline[1] / r.candidate[1]).toFixed(2)}x`);
process.exit(0);
