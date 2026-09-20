import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-log-scroll-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
await Promise.all([
  "platform-console", "ui-theme", "platform-console-project-sort", "platform-console-project-status",
  "platform-console-project-workspace", "platform-console-activity-search", "platform-console-activity-action",
  "platform-console-log-search", "platform-console-usage-export",
].map(async name => {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}));
const { platformConsolePage } = await import(pathToFileURL(join(directory, "platform-console.js")));
const { filterConsoleLogSearch } = await import(pathToFileURL(join(directory, "platform-console-log-search.js")));
const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
const lines = html.split("\n");
const line = prefix => {
  const found = lines.find(value => value.startsWith(prefix));
  assert.ok(found, `missing console fixture: ${prefix}`);
  return found;
};
const source = [
  ...["renderLogs", "renderCurrentLogs", "updateLogSearch", "updateLogStream", "returnToSignIn", "startRefresh", "refreshVisibleView", "renderAutoRefresh"].map(name => line(`function ${name}(`)),
  line("async function openProject("), line("async function loadProject("), line('q("#auto-refresh").onclick='),
  ...lines.filter(value => /^q\("#log-(?:search|stream)/.test(value) && /\.on/.test(value)),
].join("\n");
const logs = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => ({ id: first + index, createdAt: (first + index) * 1000, stream: index % 2 ? "stderr" : "stdout", message: `Worker message ${first + index}` }));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const nodes = new Map(), requests = [], timers = new Map(), destinations = [];
  let nextTimer = 1;
  function element(tagName = "div", className, textContent = "") {
    return {
      tagName, className, textContent, children: [], parentElement: null, dataset: {}, attributes: {}, hidden: false, value: "", disabled: false,
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      get height() { return this.className === "log-line" ? this.children[2].textContent.includes("\n") ? 60 : 20 : 76; },
      getBoundingClientRect() {
        const parent = this.parentElement;
        const before = parent.children.slice(0, parent.children.indexOf(this)).reduce((sum, child) => sum + child.height, 0);
        const top = parent.getBoundingClientRect().top + 12 + before - parent.scrollTop;
        return { top, bottom: top + this.height };
      },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      focus(options) { this.focused = true; this.focusOptions = options; },
      set innerHTML(_value) { throw new Error("Logs must render as text"); },
    };
  }
  function q(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); }
  const list = q("#log-list");
  let scrollTop = 0;
  Object.defineProperties(list, {
    clientHeight: { value: 100, writable: true },
    scrollHeight: { get() { return Math.max(this.clientHeight, 24 + this.children.reduce((sum, child) => sum + child.height, 0)); } },
    scrollTop: { get() { return Math.min(scrollTop, Math.max(0, this.scrollHeight - this.clientHeight)); }, set(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); } },
  });
  list.getBoundingClientRect = () => ({ top: 100, bottom: 200 });
  const state = {
    currentProject: "alpha", currentProjectSlug: "alpha", projectTab: "logs", projectLoadGeneration: 0,
    logSearch: "", logStream: "all", logView: null, refreshPaused: false, refreshTimer: null,
    dashboard: { projects: [{ id: "alpha", slug: "alpha" }, { id: "beta", slug: "beta" }] }, route: { slug: "beta" },
    projectData: { detail: { project: { id: "alpha" } }, logs: logs(1, 50), logRuntime: null },
  };
  const context = { document: { hidden: false },
    q, state, initial: { authenticated: true }, filterConsoleLogSearch, el: element, formatNumber: String,
    clear(node) { node.children = []; if (node === list) node.scrollTop = 0; },
    async api(path) { requests.push(path); return path.endsWith("/logs?limit=100") ? { logs: state.projectData.logs, runtime: null } : state.projectData.detail; },
    renderProject: () => context.renderCurrentLogs(), renderTrafficTable() {}, toast() {}, handleAuthFailure: () => false,
    PROJECT_TABS: ["logs", "performance"], showProjectTab() {}, resetNavigation() {}, closeSidebar() {}, renderActivity() {},
    window: { scrollTo() {}, location: { assign: path => destinations.push(path) } },
    setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; }, clearInterval(id) { timers.delete(id); }, clearTimeout() {},
  };
  runInNewContext(source, context);
  const render = entries => { if (entries) state.projectData.logs = entries; context.renderCurrentLogs(); };
  const scroll = top => { list.scrollTop = top; list.onscroll?.(); };
  const rows = () => list.children.filter(child => child.className === "log-line");
  const anchor = () => rows().find(row => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
  return { state, context, q, list, requests, timers, destinations, render, scroll, rows, anchor,
    get latest() { return q("#log-latest"); }, get status() { return q("#log-follow").textContent; },
  };
}

test("Latest is an accessible action tied to the keyboard-reachable log list and status", () => {
  assert.match(html, /id="log-latest" type="button" aria-controls="log-list" aria-describedby="log-follow" aria-label="Jump to latest log messages and follow new output" disabled>Latest/);
  assert.match(html, /id="log-follow" role="status">No messages to follow/);
  assert.match(html, /id="log-list" tabindex="0" aria-label="Runtime log messages"/);
});

test("initial logs and refreshes within 32 pixels of the bottom follow the latest output", () => {
  for (const distance of [0, 1, 32]) {
    const f = fixture();
    f.render();
    assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
    f.scroll(f.list.scrollHeight - f.list.clientHeight - distance);
    f.render(logs(1, 60));
    assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
    assert.equal(f.state.logView.following, true);
    assert.equal(f.status, "Following latest loaded messages");
    assert.equal(f.latest.disabled, false);
  }
});

test("appended and unchanged refreshes preserve a mid-log row and its exact pixel offset", () => {
  for (const position of [190, 891]) {
    const f = fixture();
    f.render();
    f.scroll(position);
    const key = f.anchor().dataset.logKey, offset = f.anchor().getBoundingClientRect().top;
    f.render(logs(1, 60));
    assert.equal(f.list.scrollTop, position);
    assert.equal(f.anchor().dataset.logKey, key);
    assert.equal(f.anchor().getBoundingClientRect().top, offset);
    assert.equal(f.status, "Reading earlier messages");
    f.render();
    assert.equal(f.list.scrollTop, position);
    assert.equal(f.state.logView.following, false);
  }
});

test("refresh reads the actual pre-render scroll position even before a scroll event is delivered", () => {
  const f = fixture();
  f.render();
  f.list.scrollTop = 190;
  f.render(logs(1, 60));
  assert.equal(f.list.scrollTop, 190);
  assert.equal(f.state.logView.following, false);
});

test("rolling truncation preserves the retained reading anchor instead of its obsolete scrollTop", () => {
  const f = fixture();
  f.render();
  f.scroll(310);
  const key = f.anchor().dataset.logKey, offset = f.anchor().getBoundingClientRect().top;
  f.render(logs(11, 60).map(log => ({ ...log, stream: log.id % 2 ? "stdout" : "stderr" })));
  assert.equal(f.list.scrollTop, 110);
  assert.equal(f.anchor().dataset.logKey, key);
  assert.equal(f.anchor().getBoundingClientRect().top, offset);
  assert.equal(f.status, "Reading earlier messages");
});

test("multiline row heights and provider identity do not shift the retained viewport anchor", () => {
  const f = fixture();
  const entries = logs(1, 50).map(log => ({ ...log, source: "provider", releaseId: "release-one", message: log.id % 3 === 0 ? `${log.message}\nSecond line\nThird line` : log.message }));
  f.render(entries);
  f.scroll(420);
  const key = f.anchor().dataset.logKey, offset = f.anchor().getBoundingClientRect().top;
  f.render(entries.slice(3).concat(logs(51, 55)));
  assert.equal(f.list.scrollTop, 320);
  assert.equal(f.anchor().dataset.logKey, key);
  assert.equal(f.anchor().getBoundingClientRect().top, offset);
});

test("a reading anchor that is no longer retained lands at the oldest available output", () => {
  const f = fixture();
  f.render();
  f.scroll(190);
  f.render(logs(40, 90));
  assert.equal(f.list.scrollTop, 0);
  assert.equal(f.rows()[0].children[2].textContent, "Worker message 40");
  assert.equal(f.status, "Reading earlier messages");
  f.render(logs(100, 150));
  assert.equal(f.list.scrollTop, 0);
});

test("the list stays bounded to 500 latest loaded rows through rolling refreshes", () => {
  const f = fixture();
  f.render(logs(1, 600));
  assert.equal(f.rows().length, 500);
  assert.equal(f.rows()[0].children[2].textContent, "Worker message 101");
  assert.equal(f.q("#log-count").textContent, "500 of 600 loaded messages shown");
  f.scroll(5000);
  const key = f.anchor().dataset.logKey, offset = f.anchor().getBoundingClientRect().top;
  f.render(logs(1, 610));
  assert.equal(f.rows().length, 500);
  assert.equal(f.list.scrollTop, 4800);
  assert.equal(f.anchor().dataset.logKey, key);
  assert.equal(f.anchor().getBoundingClientRect().top, offset);
});

test("filters search all loaded messages before applying the 500-row display cap", () => {
  const f = fixture();
  f.render(logs(1, 600));
  f.context.updateLogSearch("Worker message 10");
  assert.equal(f.rows().length, 11);
  assert.equal(f.rows()[0].children[2].textContent, "Worker message 10");
  assert.equal(f.q("#log-count").textContent, "11 of 600 loaded messages shown");
  assert.equal(f.status, "Following latest loaded messages");
});

test("Latest jumps and resumes following without moving page focus or starting a fetch", () => {
  const f = fixture();
  f.render();
  f.scroll(190);
  f.latest.onclick();
  assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
  assert.equal(f.state.logView.following, true);
  assert.equal(f.list.focused, true);
  assert.equal(f.list.focusOptions.preventScroll, true);
  f.render(logs(1, 70));
  assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
  assert.deepEqual(f.requests, []);
});

test("search and stream changes start at the latest match and retain filtered reading positions on refresh", () => {
  const f = fixture();
  f.render();
  f.scroll(190);
  f.context.updateLogStream("stderr");
  f.context.updateLogSearch("worker");
  assert.equal(f.rows().length, 25);
  assert.ok(f.rows().every(row => row.children[1].textContent === "stderr"));
  assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
  f.scroll(110);
  const key = f.anchor().dataset.logKey;
  f.render(logs(1, 60));
  assert.equal(f.state.logSearch, "worker");
  assert.equal(f.state.logStream, "stderr");
  assert.equal(f.q("#log-count").textContent, "30 of 60 loaded messages shown");
  assert.equal(f.anchor().dataset.logKey, key);
  assert.equal(f.list.scrollTop, 110);
  assert.deepEqual(f.requests, []);
});

test("empty and no-match states clear follow labels and disable Latest until matching logs exist", () => {
  const f = fixture();
  f.render();
  f.scroll(190);
  f.context.updateLogSearch("missing");
  assert.equal(f.latest.disabled, true);
  assert.equal(f.status, "No messages to follow");
  assert.equal(f.list.scrollTop, 0);
  f.latest.onclick();
  assert.equal(f.list.focused, undefined);
  assert.match(f.list.children[0].textContent, /No loaded messages match/);
  f.render([]);
  assert.match(f.list.children[0].textContent, /first deployment/);
  f.context.updateLogSearch("");
  f.render(logs(1, 50));
  assert.equal(f.latest.disabled, false);
  assert.equal(f.status, "Following latest loaded messages");
  assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
});

test("project switching clears old rows, filters and scroll state before loading, and invalidates old callbacks", async () => {
  const f = fixture();
  f.render();
  f.context.updateLogStream("stderr");
  f.context.updateLogSearch("worker");
  f.scroll(110);
  const oldLatest = f.latest.onclick;
  f.context.loadProject = async () => {};
  await f.context.openProject("beta", "logs", true);
  assert.equal(f.state.logSearch, "");
  assert.equal(f.state.logStream, "all");
  assert.equal(f.rows().length, 0);
  assert.equal(f.latest.disabled, true);
  assert.equal(f.status, "No messages to follow");
  oldLatest();
  assert.equal(f.list.focused, undefined);
  f.state.projectData = { detail: { project: { id: "beta" } }, logs: logs(1, 60), logRuntime: null };
  f.render();
  assert.equal(f.state.logView.projectId, "beta");
  assert.equal(f.state.logView.following, true);
  assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
  f.context.returnToSignIn();
  assert.equal(f.state.logView, null);
  assert.equal(f.list.children.length, 0);
  assert.equal(f.list.onscroll, null);
  assert.equal(f.latest.onclick, null);
  assert.equal(f.latest.disabled, true);
  assert.equal(f.status, "No messages to follow");
  assert.deepEqual(f.destinations, ["/login"]);
});

test("following and Latest use the existing refresh timer and honor global pause without duplicate reads", async () => {
  const f = fixture();
  f.render();
  f.context.startRefresh();
  assert.equal(f.timers.size, 1);
  const poll = [...f.timers.values()][0];
  f.scroll(190);
  poll();
  await tick();
  assert.deepEqual(f.requests, ["/api/projects/alpha", "/api/projects/alpha/logs?limit=100"]);
  assert.equal(f.list.scrollTop, 190);
  f.latest.onclick();
  assert.equal(f.requests.length, 2);
  f.q("#auto-refresh").onclick();
  assert.equal(f.state.refreshPaused, true);
  assert.equal(f.timers.size, 0);
  f.scroll(190);
  f.latest.onclick();
  poll();
  await tick();
  assert.equal(f.state.refreshPaused, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests.length, 2);
});
