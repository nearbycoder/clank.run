import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { filterConsoleLogSearch } from "../dist/platform-console-log-search.js";
import { platformConsolePage } from "../dist/platform-console.js";

const logs = Object.freeze([
  Object.freeze({ id: 1, createdAt: 1000, stream: "stdout", message: "Started SERVER · token=[REDACTED]", raw: "not-visible-secret" }),
  Object.freeze({ id: 2, createdAt: 2000, stream: "stderr", message: "<script>alert('text')</script> [.*]" }),
  Object.freeze({ id: 3, createdAt: 3000, stream: "stdout", message: "Completed request" }),
]);
const ids = rows => rows.map(row => row.id);

test("log search matches only redacted message text, case insensitively and literally", () => {
  for (const [query, expected] of [
    [" SERVER ", [1]], ["[redacted]", [1]], ["<script>", [2]], ["[.*]", [2]],
    ["stdout", []], ["stderr", []], ["not-visible-secret", []], ["missing", []],
  ]) assert.deepEqual(ids(filterConsoleLogSearch(logs, query)), expected, query);
  assert.deepEqual(ids(logs), [1, 2, 3]);
});

test("log search is bounded, immutable, and accepts an empty loaded snapshot", () => {
  for (const query of ["", "  ", null, undefined, {}, 42]) {
    assert.deepEqual(filterConsoleLogSearch(logs, query), logs);
    assert.notEqual(filterConsoleLogSearch(logs, query), logs);
  }
  assert.deepEqual(filterConsoleLogSearch([], "server"), []);
  const long = [{ message: "x".repeat(200) }];
  assert.deepEqual(filterConsoleLogSearch(long, "x".repeat(200) + "ignored"), long);
});

function node(tagName, className, textContent) {
  return {
    tagName, className, textContent, value: "", hidden: false, children: [], dataset: {},
    append(...children) { this.children.push(...children); }, focus() { this.focused = true; },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    set innerHTML(_value) { throw new Error("Log output must only use textContent"); },
  };
}

async function fixture() {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const nodes = new Map();
  const state = {
    currentProject: "p1", currentProjectSlug: "first", projectTab: "logs", logSearch: "", projectLoadGeneration: 0,
    projectData: { detail: { project: { id: "p1" } }, logs: [...logs], logRuntime: { available: true, generation: 7, logsTruncated: true } },
    dashboard: { projects: [{ id: "p1", slug: "first" }, { id: "p2", slug: "second" }] }, route: { slug: "second" },
  };
  const requests = [];
  const context = {
    state, filterConsoleLogSearch, formatNumber: String,
    q: selector => { if (!nodes.has(selector)) nodes.set(selector, node("div")); return nodes.get(selector); },
    clear: element => { element.children = []; }, el: node,
    api: path => { requests.push(path); throw new Error("Filtering must not fetch logs"); },
  };
  const functions = ["renderLogs", "renderCurrentLogs", "updateLogSearch", "openProject", "loadProject", "returnToSignIn"]
    .map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`))[0]).join("\n");
  const handlers = html.split("\n").filter(line => line.startsWith('q("#log-search') && /\.on/.test(line)).join("\n");
  runInNewContext(`${functions}\n${handlers}`, context);
  return { html, state, context, requests };
}

test("log results show loaded counts, preserve stream/time, and render markup as text", async () => {
  const { html, context, requests } = await fixture();
  assert.match(html, /<label for="log-search">Search loaded messages<\/label>/);
  assert.match(html, /id="log-search" type="search" maxlength="200"/);
  assert.match(html, /id="log-count" role="status"/);
  assert.match(html, /id="log-list" tabindex="0" aria-label="Runtime log messages"/);
  runInNewContext('updateLogSearch("<script>")', context);
  assert.equal(context.q("#log-count").textContent, "1 of 3 loaded messages shown");
  assert.match(context.q("#log-summary").textContent, /provider generation 7 · older output truncated · secrets redacted/);
  const line = context.q("#log-list").children[0];
  assert.deepEqual(line.children.map(child => child.tagName), ["time", "b", "span"]);
  assert.equal(line.children[0].textContent, new Date(logs[1].createdAt).toLocaleTimeString());
  assert.equal(line.children[1].textContent, "stderr");
  assert.equal(line.children[2].textContent, logs[1].message);
  assert.deepEqual(requests, []);
});

test("log search distinguishes no matches from an empty project and clears without a request", async () => {
  const { state, context, requests } = await fixture();
  const input = context.q("#log-search");
  input.oninput({ target: { value: "missing" } });
  assert.equal(context.q("#log-count").textContent, "0 of 3 loaded messages shown");
  assert.match(context.q("#log-list").children[0].textContent, /No loaded messages match your search/);
  assert.equal(context.q("#log-search-clear").hidden, false);
  let prevented = false;
  input.onkeydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(state.logSearch, "");
  assert.equal(context.q("#log-count").textContent, "3 of 3 loaded messages shown");
  input.oninput({ target: { value: "x".repeat(201) } });
  assert.equal(state.logSearch.length, 200);
  context.q("#log-search-clear").onclick();
  assert.equal(input.focused, true);
  assert.equal(context.q("#log-search-clear").hidden, true);
  input.oninput({ target: { value: "server" } });
  input.onsearch({ target: { value: "" } });
  assert.equal(state.logSearch, "");
  state.projectData.logs = [];
  input.oninput({ target: { value: "missing" } });
  assert.equal(context.q("#log-count").textContent, "0 of 0 loaded messages shown");
  assert.match(context.q("#log-list").children[0].textContent, /Runtime logs will appear after the first deployment/);
  assert.deepEqual(requests, []);
});

test("search stays applied when the current project's authorized log snapshot refreshes", async () => {
  const { state, context, requests } = await fixture();
  runInNewContext('updateLogSearch("server")', context);
  const refreshed = [{ ...logs[0], id: 4 }, { ...logs[2], id: 5 }];
  Object.assign(context, {
    api: async path => {
      requests.push(path);
      return path.endsWith("/logs?limit=100") ? { logs: refreshed, runtime: null } : state.projectData.detail;
    },
    renderProject: () => runInNewContext("renderCurrentLogs()", context), toast() {}, handleAuthFailure: () => false,
  });
  await runInNewContext("loadProject(true)", context);
  assert.equal(state.logSearch, "server");
  assert.deepEqual(ids(state.projectData.logs), [4, 5]);
  assert.equal(context.q("#log-count").textContent, "1 of 2 loaded messages shown");
  assert.deepEqual(requests, ["/api/projects/p1", "/api/projects/p1/logs?limit=100"]);
});

test("cross-project navigation resets search and rendered log data before the next request completes", async () => {
  const { state, context } = await fixture();
  runInNewContext('updateLogSearch("server")', context);
  Object.assign(context, {
    PROJECT_TABS: ["logs", "performance"], showProjectTab() {}, resetNavigation() {}, closeSidebar() {},
    window: { scrollTo() {} }, loadProject: async () => {},
  });
  await runInNewContext('openProject("p1", "logs", true)', context);
  assert.equal(state.logSearch, "server", "same-project navigation retains the filter");
  await runInNewContext('openProject("p2", "logs", true)', context);
  assert.equal(state.logSearch, "");
  assert.equal(context.q("#log-search").value, "");
  assert.equal(context.q("#log-search-clear").hidden, true);
  assert.equal(state.projectData, null);
  assert.equal(context.q("#log-count").textContent, "0 of 0 loaded messages shown");
  assert.equal(context.q("#log-list").children.some(child => child.className === "log-line"), false);
  state.projectData = { detail: { project: { id: "p1" } }, logs };
  runInNewContext('updateLogSearch("server")', context);
  assert.equal(context.q("#log-count").textContent, "0 of 0 loaded messages shown", "stale data never appears under another project");
});

test("sign-out removes search, provider metadata, and rendered log rows before navigation", async () => {
  const { state, context } = await fixture();
  runInNewContext('updateLogSearch("server")', context);
  const destinations = [];
  Object.assign(context, { clearInterval() {}, clearTimeout() {}, initial: {}, renderActivity() {}, window: { location: { assign: path => destinations.push(path) } } });
  runInNewContext("returnToSignIn()", context);
  assert.equal(state.logSearch, "");
  assert.equal(state.projectData, null);
  assert.equal(context.q("#log-search").value, "");
  assert.equal(context.q("#log-list").children.length, 0);
  assert.equal(context.q("#log-count").textContent, "0 of 0 loaded messages shown");
  assert.equal(context.q("#log-summary").textContent, "Latest 100 · secret values redacted");
  assert.deepEqual(destinations, ["/login"]);
});
