import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { platformConsolePage } from "../dist/platform-console.js";

function node(tagName, className, text = "") {
  return {
    tagName, className, hidden: false, children: [], dataset: {}, attributes: {}, value: "", text,
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    get textContent() { return this.text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { this.text = String(value); this.children = []; },
    set innerHTML(_value) { throw new Error("Traffic data must only render as text"); },
  };
}

const firstProject = { id: "one", name: "First <project>" };
const secondProject = { id: "two", name: "Second project" };
const points = Object.freeze([
  Object.freeze({ at: 0, requests: 0, p95LatencyMs: 0 }),
  Object.freeze({ at: Date.UTC(2026, 8, 20, 3, 4, 5, 678), requests: 123456, p95LatencyMs: 1234.56789 }),
]);
const metrics = (range = "24h", selectedPoints = points) => ({ range, intervalMs: 60000, points: selectedPoints });

async function fixture() {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const nodes = new Map();
  const state = {
    currentProject: "one", projectTab: "performance", range: "24h", projectLoadGeneration: 0,
    projectData: { detail: { project: firstProject }, metrics: metrics() },
  };
  const calls = [];
  const context = {
    state,
    q(selector) { if (!nodes.has(selector)) nodes.set(selector, node("div")); return nodes.get(selector); },
    clear(element) { element.textContent = ""; }, el: node,
    api(path) { calls.push(path); throw new Error("Displaying traffic data must not fetch"); },
    renderProject() { context.renderTrafficTable(state.projectData.metrics); },
    toast() {}, handleAuthFailure: () => false, navigate: async () => {}, loadDashboard: async () => {},
    clearInterval() {}, clearTimeout() {}, initial: {}, renderActivity() {}, window: { location: { assign() {} } },
  };
  const functions = ["renderTrafficTable", "loadProject", "returnToSignIn"]
    .map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`))[0]).join("\n");
  runInNewContext(functions, context);
  return {
    html, state, nodes, context, calls,
    rows: () => context.q("#traffic-table-body").children,
    render: data => context.renderTrafficTable(data),
  };
}
const values = f => f.rows().map(row => row.children.map(cell => cell.textContent));

function pendingApi(f) {
  const pending = [];
  f.context.api = path => {
    f.calls.push(path);
    return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
  };
  return pending;
}

function resolveLoad(pending, index, project, data) {
  pending[index].resolve({ project });
  pending[index + 1].resolve(data);
}

test("traffic table uses native disclosure, caption, scoped headers and keyboard-scrollable bounded overflow", async () => {
  const f = await fixture();
  assert.match(f.html, /<details class="traffic-data" id="traffic-data"><summary>View traffic data table<\/summary>/);
  assert.match(f.html, /id="traffic-table-wrap" role="region" aria-labelledby="traffic-table-caption" tabindex="0" hidden/);
  assert.match(f.html, /<caption id="traffic-table-caption">Traffic buckets<\/caption><thead><tr><th scope="col">Bucket start \(UTC\)<\/th><th scope="col">Requests<\/th><th scope="col">P95 latency \(ms\)<\/th>/);
  assert.match(f.html, /\.traffic-table-wrap\{max-height:22rem;max-width:100%;overflow:auto\}/);
  assert.match(f.html, /\.traffic-table\{min-width:0;table-layout:fixed\}/);
  assert.match(f.html, /\.traffic-table time span\{display:block\}/);
  assert.match(f.html, /renderChart\(data.points\);renderTrafficTable\(data\);/);
});

test("rendered rows preserve every zero bucket, exact UTC timestamps and unrounded request and latency values", async () => {
  const f = await fixture();
  const before = JSON.stringify(points);
  f.render(metrics());
  assert.deepEqual(values(f), [
    ["1970-01-0100:00:00.000Z", "0", "0"],
    ["2026-09-2003:04:05.678Z", "123456", "1234.56789"],
  ]);
  assert.equal(f.rows()[0].children[0].tagName, "th");
  assert.equal(f.rows()[0].children[0].attributes.scope, "row");
  assert.equal(f.rows()[0].children[0].children[0].attributes.datetime, "1970-01-01T00:00:00.000Z");
  assert.equal(f.rows()[1].children[0].children[0].attributes.datetime, "2026-09-20T03:04:05.678Z");
  assert.equal(f.context.q("#traffic-table-caption").textContent, "Traffic buckets · First <project> · 24h · 60000 ms per bucket");
  assert.equal(f.context.q("#traffic-table-wrap").hidden, false);
  assert.equal(f.context.q("#traffic-table-message").hidden, true);
  assert.equal(JSON.stringify(points), before);
  assert.deepEqual(f.calls, []);
});

test("empty and unavailable data are distinct and missing values never become fabricated zeros", async () => {
  const f = await fixture();
  f.render(metrics("24h", [{ at: null, requests: null, p95LatencyMs: undefined }, { at: Infinity, requests: -1, p95LatencyMs: NaN }]));
  assert.deepEqual(values(f), [["Unavailable", "Unavailable", "Unavailable"], ["Unavailable", "Unavailable", "Unavailable"]]);
  f.render(metrics("24h", []));
  assert.deepEqual(values(f), []);
  assert.equal(f.context.q("#traffic-table-wrap").hidden, true);
  assert.equal(f.context.q("#traffic-table-message").hidden, false);
  assert.equal(f.context.q("#traffic-table-message").textContent, "No traffic buckets are available for this range.");
  f.render(null);
  assert.equal(f.context.q("#traffic-table-message").textContent, "Traffic data is unavailable for this project and range.");
});

test("an old project's snapshot or an old selected range cannot populate the table", async () => {
  const f = await fixture();
  f.render(metrics());
  f.state.currentProject = "two";
  f.render(metrics());
  assert.deepEqual(values(f), []);
  assert.equal(f.context.q("#traffic-table-caption").textContent, "Traffic buckets");
  f.state.currentProject = "one";
  f.state.range = "1h";
  f.render(metrics());
  assert.deepEqual(values(f), []);
  f.render(metrics("1h"));
  assert.equal(f.rows().length, 2);
});

test("changing ranges clears old rows while loading and refreshes the disclosure without extra requests", async () => {
  const f = await fixture();
  f.render(metrics());
  f.context.q("#traffic-data").open = true;
  f.state.range = "15m";
  const pending = pendingApi(f);
  const load = f.context.loadProject(true);
  assert.deepEqual(values(f), []);
  assert.equal(f.context.q("#traffic-table-message").textContent, "Loading traffic data…");
  assert.deepEqual(f.calls, ["/api/projects/one", "/api/projects/one/metrics?range=15m"]);
  resolveLoad(pending, 0, firstProject, metrics("15m", [{ at: 123, requests: 0, p95LatencyMs: 0 }]));
  await load;
  assert.deepEqual(values(f), [["1970-01-0100:00:00.123Z", "0", "0"]]);
  assert.match(f.context.q("#traffic-table-caption").textContent, /15m/);
  assert.equal(f.context.q("#traffic-data").open, true, "refresh preserves the native disclosure state");
  assert.equal(f.calls.length, 2);
});

test("project changes clear old rows before awaiting and ignore out-of-order project and range responses", async () => {
  const f = await fixture();
  f.render(metrics());
  const pending = pendingApi(f);
  const firstLoad = f.context.loadProject(true);
  f.state.currentProject = "two";
  f.state.projectData = null;
  const secondLoad = f.context.loadProject(true);
  assert.deepEqual(values(f), []);
  resolveLoad(pending, 2, secondProject, metrics("24h", [{ at: 456, requests: 8, p95LatencyMs: 1.2 }]));
  await secondLoad;
  resolveLoad(pending, 0, firstProject, metrics());
  await firstLoad;
  assert.deepEqual(values(f), [["1970-01-0100:00:00.456Z", "8", "1.2"]]);
  assert.match(f.context.q("#traffic-table-caption").textContent, /Second project/);
  f.state.range = "1h";
  const olderRangeLoad = f.context.loadProject(true);
  f.state.range = "7d";
  const newerRangeLoad = f.context.loadProject(true);
  resolveLoad(pending, 6, secondProject, metrics("7d", [{ at: 789, requests: 9, p95LatencyMs: 2.3 }]));
  await newerRangeLoad;
  resolveLoad(pending, 4, secondProject, metrics("1h"));
  await olderRangeLoad;
  assert.deepEqual(values(f), [["1970-01-0100:00:00.789Z", "9", "2.3"]]);
  assert.match(f.context.q("#traffic-table-caption").textContent, /7d/);
});

test("a failed metrics refresh removes stale rows and sign-out purges rendered project data", async () => {
  const f = await fixture();
  f.render(metrics());
  const pending = pendingApi(f);
  const load = f.context.loadProject(true);
  pending[0].resolve({ project: firstProject });
  pending[1].reject(new Error("Unavailable"));
  await load;
  assert.deepEqual(values(f), []);
  assert.equal(f.context.q("#traffic-table-message").textContent, "Traffic data is unavailable. Refresh to try again.");
  f.render(metrics());
  f.context.returnToSignIn();
  assert.deepEqual(values(f), []);
  assert.equal(f.context.q("#traffic-table-wrap").hidden, true);
  assert.equal(f.context.q("#traffic-table-caption").textContent, "Traffic buckets");
});
