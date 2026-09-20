import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-log-wrap-"));
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
  ...["renderLogs", "renderCurrentLogs", "updateLogSearch", "updateLogStream", "returnToSignIn", "startRefresh", "renderAutoRefresh"].map(name => line(`function ${name}(`)),
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
      get height() { return this.className === "log-line" ? this.children[2].textContent.includes("\n") || (this.parentElement.dataset.wrap !== "off" && this.children[2].textContent.length > 100) ? 60 : 20 : 76; },
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
  list.scrollLeft = 0;
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
  const context = {
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

test("035: Wrap lines exposes a pressed button and horizontal scrolling stays inside the viewport", () => {
  assert.match(html, /id="log-wrap" type="button" aria-controls="log-list" aria-pressed="true">Wrap lines/);
  assert.match(html, /\.logs\[data-wrap="off"\] \.log-line\{width:max-content;min-width:100%\}/);
  assert.match(html, /\.logs\[data-wrap="off"\] \.log-line span\{white-space:pre;overflow-wrap:normal\}/);
  assert.match(html, /\.logs\{[^}]*overflow:auto/);
});

test("035: toggling wrap preserves the exact reading row and pixel offset in both directions", () => {
  const f = fixture();
  f.render(logs(1, 50).map(log => ({ ...log, message: log.message + "x".repeat(150) })));
  f.scroll(617);
  const key = f.anchor().dataset.logKey, offset = f.anchor().getBoundingClientRect().top;
  f.q("#log-wrap").onclick();
  assert.equal(f.q("#log-wrap").attributes["aria-pressed"], "false");
  assert.equal(f.list.dataset.wrap, "off");
  assert.equal(f.list.scrollTop, 217);
  assert.equal(f.anchor().dataset.logKey, key);
  assert.equal(f.anchor().getBoundingClientRect().top, offset);
  assert.equal(f.status, "Reading earlier messages");
  f.list.scrollLeft = 120;
  f.render();
  assert.equal(f.list.scrollLeft, 120, "refresh preserves horizontal reading position");
  f.q("#log-wrap").onclick();
  assert.equal(f.q("#log-wrap").attributes["aria-pressed"], "true");
  assert.equal(f.list.scrollTop, 617);
  assert.equal(f.list.scrollLeft, 0);
  assert.equal(f.anchor().dataset.logKey, key);
  assert.equal(f.anchor().getBoundingClientRect().top, offset);
  assert.deepEqual(f.requests, []);
});

test("035: wrapping preserves bottom-following, loaded filters and the explicit Latest action", () => {
  const f = fixture();
  f.render(logs(1, 50).map(log => ({ ...log, message: log.message + "x".repeat(150) })));
  f.context.updateLogStream("stderr");
  f.context.updateLogSearch("worker");
  f.q("#log-wrap").onclick();
  assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
  assert.equal(f.state.logView.following, true);
  assert.equal(f.state.logSearch, "worker");
  assert.equal(f.state.logStream, "stderr");
  f.scroll(110);
  f.latest.onclick();
  f.q("#log-wrap").onclick();
  assert.equal(f.list.scrollTop, f.list.scrollHeight - f.list.clientHeight);
  assert.equal(f.state.logView.following, true);
});

test("035: the wrapping preference survives empty output but is reset on sign-out", () => {
  const f = fixture();
  f.render();
  f.q("#log-wrap").onclick();
  f.render([]);
  assert.equal(f.list.dataset.wrap, "off");
  assert.equal(f.q("#log-wrap").attributes["aria-pressed"], "false");
  f.context.returnToSignIn();
  assert.equal(f.state.logWrap, true);
  assert.equal(f.q("#log-wrap").attributes["aria-pressed"], "true");
  assert.equal(f.list.children.length, 0);
});
