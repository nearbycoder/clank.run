import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { filterConsoleLogSearch } from "../dist/platform-console-log-search.js";
import { platformConsolePage } from "../dist/platform-console.js";

const logs = Object.freeze([
  Object.freeze({ createdAt: 1000, stream: "stdout", message: "Started worker · [REDACTED]", raw: "private-source-value" }),
  Object.freeze({ createdAt: 2000, stream: "stderr", message: "Worker failed <script>alert(1)</script>" }),
  Object.freeze({ createdAt: 3000, stream: "stdout", message: "Health check passed" }),
  Object.freeze({ createdAt: 4000, stream: "<custom>", message: "Worker recovered" }),
]);

function node(tagName, className, textContent) {
  return {
    tagName, className, textContent, value: "", hidden: false, children: [], dataset: {},
    append(...children) { this.children.push(...children); }, focus() { this.focused = true; },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    set innerHTML(_value) { throw new Error("Log output must be rendered as text"); },
  };
}

async function fixture() {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const nodes = new Map();
  const state = {
    currentProject: "p1", currentProjectSlug: "first", projectTab: "logs", logSearch: "", logStream: "all", projectLoadGeneration: 0,
    projectData: { detail: { project: { id: "p1" } }, logs, logRuntime: { available: true, generation: 3, logsTruncated: true } },
    dashboard: { projects: [{ id: "p1", slug: "first" }, { id: "p2", slug: "second" }] }, route: { slug: "second" },
  };
  const requests = [];
  const context = {
    state, filterConsoleLogSearch, formatNumber: String,
    q: selector => { if (!nodes.has(selector)) nodes.set(selector, node("div")); return nodes.get(selector); },
    clear: element => { element.children = []; }, el: node,
    api: path => { requests.push(path); throw new Error("Stream filtering must not fetch logs"); },
  };
  const functions = ["renderLogs", "renderCurrentLogs", "updateLogSearch", "updateLogStream", "openProject", "loadProject", "returnToSignIn"]
    .map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`))[0]).join("\n");
  const handlers = html.split("\n").filter(line => /^q\("#log-(?:search|stream)/.test(line) && /\.on/.test(line)).join("\n");
  runInNewContext(`${functions}\n${handlers}`, context);
  return { html, state, context, requests, visible: () => context.q("#log-list").children.filter(child => child.className === "log-line") };
}

function streams(f) { return f.visible().map(line => line.children[1].textContent); }
function messages(f) { return f.visible().map(line => line.children[2].textContent); }
function select(f, value) { f.context.q("#log-stream").onchange({ target: { value } }); }
function search(f, value) { f.context.q("#log-search").oninput({ target: { value } }); }

test("runtime stream selector is labeled and combines with loaded message search and counts", async () => {
  const f = await fixture();
  assert.match(f.html, /<label for="log-stream">Stream<\/label>/);
  assert.match(f.html, /id="log-stream" aria-describedby="log-count log-summary"><option value="all">All streams<\/option><option value="stdout">stdout<\/option><option value="stderr">stderr<\/option>/);
  select(f, "stdout");
  assert.deepEqual(streams(f), ["stdout", "stdout"]);
  assert.equal(f.context.q("#log-count").textContent, "2 of 4 loaded messages shown");
  search(f, " WORKER ");
  assert.deepEqual(messages(f), [logs[0].message]);
  assert.equal(f.context.q("#log-count").textContent, "1 of 4 loaded messages shown");
  select(f, "stderr");
  assert.deepEqual(messages(f), [logs[1].message]);
  assert.equal(f.context.q("#log-stream").value, "stderr");
  assert.match(f.context.q("#log-summary").textContent, /provider generation 3 · older output truncated · secrets redacted/);
  assert.deepEqual(f.requests, []);
});

test("All streams retains unknown streams and log content only renders as text", async () => {
  const f = await fixture();
  select(f, "all");
  assert.deepEqual(streams(f), ["stdout", "stderr", "stdout", "<custom>"]);
  assert.deepEqual(messages(f), logs.map(log => log.message));
  assert.equal(f.visible()[1].children[0].textContent, new Date(2000).toLocaleTimeString());
  search(f, "private-source-value");
  assert.deepEqual(messages(f), [], "search never inspects raw fields");
  assert.equal(f.context.q("#log-count").textContent, "0 of 4 loaded messages shown");
  search(f, "<script>");
  assert.deepEqual(messages(f), [logs[1].message]);
  assert.deepEqual(f.requests, []);
});

test("unexpected stream values normalize to All streams without evaluating or coercing input", async () => {
  const f = await fixture();
  for (const value of [undefined, null, 7, "STDERR", "unknown", { toString() { throw new Error("Do not coerce"); } }]) {
    select(f, value);
    assert.equal(f.state.logStream, "all");
    assert.equal(f.context.q("#log-stream").value, "all");
    assert.equal(f.visible().length, 4);
  }
  f.state.logStream = "bad cached value";
  runInNewContext("renderCurrentLogs()", f.context);
  assert.equal(f.state.logStream, "all");
  assert.equal(f.visible().length, 4);
});

test("clearing search retains stream selection and no-match guidance names both filters", async () => {
  const f = await fixture();
  select(f, "stderr");
  search(f, "health");
  assert.equal(f.visible().length, 0);
  assert.match(f.context.q("#log-list").children[0].textContent, /Clear the search and choose All streams/);
  f.context.q("#log-search-clear").onclick();
  assert.equal(f.state.logSearch, "");
  assert.equal(f.state.logStream, "stderr");
  assert.deepEqual(messages(f), [logs[1].message]);
  f.state.projectData.logs = [];
  select(f, "stdout");
  assert.equal(f.context.q("#log-count").textContent, "0 of 0 loaded messages shown");
  assert.match(f.context.q("#log-list").children[0].textContent, /first deployment/);
});

test("same-project refresh keeps stream and message filters applied to the newly authorized snapshot", async () => {
  const f = await fixture();
  select(f, "stderr");
  search(f, "worker");
  const refreshed = [logs[0], { ...logs[1], message: "Worker retry failed" }, { ...logs[1], message: "Connection reset" }];
  Object.assign(f.context, {
    api: async path => {
      f.requests.push(path);
      return path.endsWith("/logs?limit=100") ? { logs: refreshed, runtime: null } : f.state.projectData.detail;
    },
    renderProject: () => runInNewContext("renderCurrentLogs()", f.context), toast() {}, handleAuthFailure: () => false,
  });
  await runInNewContext("loadProject(true)", f.context);
  assert.equal(f.state.logStream, "stderr");
  assert.equal(f.state.logSearch, "worker");
  assert.deepEqual(messages(f), ["Worker retry failed"]);
  assert.equal(f.context.q("#log-count").textContent, "1 of 3 loaded messages shown");
  assert.deepEqual(f.requests, ["/api/projects/p1", "/api/projects/p1/logs?limit=100"]);
});

test("project changes clear stream selection before loading and exclude a stale project's log snapshot", async () => {
  const f = await fixture();
  select(f, "stderr");
  search(f, "worker");
  Object.assign(f.context, {
    PROJECT_TABS: ["logs", "performance"], showProjectTab() {}, resetNavigation() {}, closeSidebar() {},
    window: { scrollTo() {} }, loadProject: async () => {},
  });
  await runInNewContext('openProject("p1", "logs", true)', f.context);
  assert.equal(f.state.logStream, "stderr");
  await runInNewContext('openProject("p2", "logs", true)', f.context);
  assert.equal(f.state.logStream, "all");
  assert.equal(f.state.logSearch, "");
  assert.equal(f.context.q("#log-stream").value, "all");
  assert.equal(f.state.projectData, null);
  assert.deepEqual(messages(f), []);
  f.state.projectData = { detail: { project: { id: "p1" } }, logs };
  select(f, "stdout");
  assert.deepEqual(messages(f), []);
  assert.equal(f.context.q("#log-count").textContent, "0 of 0 loaded messages shown");
  assert.deepEqual(f.requests, []);
});

test("sign-out clears stream selection and all rendered authorized log data", async () => {
  const f = await fixture();
  select(f, "stderr");
  const destinations = [];
  Object.assign(f.context, {
    clearInterval() {}, clearTimeout() {}, initial: {}, renderActivity() {},
    window: { location: { assign: path => destinations.push(path) } },
  });
  runInNewContext("returnToSignIn()", f.context);
  assert.equal(f.state.logStream, "all");
  assert.equal(f.context.q("#log-stream").value, "all");
  assert.equal(f.state.projectData, null);
  assert.deepEqual(messages(f), []);
  assert.equal(f.context.q("#log-count").textContent, "0 of 0 loaded messages shown");
  assert.deepEqual(destinations, ["/login"]);
});
