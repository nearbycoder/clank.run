import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext, Script } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-read-refresh-"));
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
const { sortConsoleProjects } = await import(pathToFileURL(join(directory, "platform-console-project-sort.js")));
const { filterConsoleProjectStatus } = await import(pathToFileURL(join(directory, "platform-console-project-status.js")));
const { filterConsoleProjectWorkspace } = await import(pathToFileURL(join(directory, "platform-console-project-workspace.js")));
const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
const lines = html.split("\n");
new Script(html.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/iu)[1]);
const select = prefix => { const value = lines.find(line => line.startsWith(prefix)); assert.ok(value, prefix); return value; };
const apiSource = select("async function api(");
const refreshSource = ["renderAutoRefresh", "startRefresh", "refreshVisibleView"].map(name => select(`function ${name}(`)).concat(select('document.addEventListener("visibilitychange"'), select('q("#auto-refresh").onclick=')).join("\n");
const tick = () => new Promise(resolve => setImmediate(resolve));
function requestFixture() {
  const timers = new Map(), calls = []; let nextTimer = 1;
  const initial = { csrfToken: "csrf-test", impersonation: null };
  const context = { initial, AbortController,
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch(path, options) { return new Promise((resolve, reject) => calls.push({ path, options, resolve, reject })); },
  };
  runInNewContext(apiSource, context);
  return { context, initial, timers, calls, api: (...args) => context.api(...args), timeout() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); } };
}
function refreshFixture(hidden = false) {
  const nodes = new Map(), timers = new Map(), calls = [], listeners = new Map(); let id = 0, pending;
  const state = { refreshTimer: null, refreshPaused: false, refreshHidden: false, refreshInFlight: null, currentProject: null, impersonationExpiryTimer: 999 };
  const initial = { authenticated: true };
  const document = { hidden, addEventListener(name, callback) { listeners.set(name, callback); } };
  const context = { state, initial, document,
    q(selector) { if (!nodes.has(selector)) nodes.set(selector, { hidden: true, setAttribute(name, value) { this[name] = value; } }); return nodes.get(selector); },
    setInterval(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; }, clearInterval(key) { timers.delete(key); },
  };
  for (const name of ["loadProject", "loadAdmin", "loadBilling", "loadUsage", "loadWorkspace", "loadActivity", "loadDashboard"]) context[name] = (...args) => { calls.push([name, ...args]); return pending; };
  runInNewContext(refreshSource, context);
  return { context, state, initial, document, timers, calls, nodes, start: () => context.startRefresh(), toggle: () => context.q("#auto-refresh").onclick(),
    visibility(value) { document.hidden = value; listeners.get("visibilitychange")(); },
    interval() { timers.get(state.refreshTimer).callback(); },
    hold() { pending = new Promise(resolve => { context.resolveLoad = resolve; }); }, release() { context.resolveLoad(); pending = undefined; },
  };
}

test("052: GET requests time out once after 15 seconds, abort the transport and offer a manual retry", async () => {
  const f = requestFixture(), pending = f.api("/api/dashboard");
  assert.equal(f.calls.length, 1); assert.equal(f.timers.values().next().value.delay, 15000);
  assert.equal(f.calls[0].options.signal.aborted, false);
  f.timeout(); await assert.rejects(pending, error => error.code === "READ_TIMEOUT" && /Use Refresh to retry/.test(error.message));
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
  f.calls[0].reject(new Error("late abort")); await tick();
  const retry = f.api("/api/dashboard"); assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ ok: true, json: async () => ({ okay: true }) }); assert.equal((await retry).okay, true); assert.equal(f.timers.size, 0);
});

test("052: the timeout also bounds a response body that never finishes, and settles without unhandled loser promises", async () => {
  const f = requestFixture(), pending = f.api("/api/usage"); let rejectBody;
  f.calls[0].resolve({ ok: true, json: () => new Promise((resolve, reject) => { rejectBody = reject; }) }); await tick();
  f.timeout(); await assert.rejects(pending, error => error.code === "READ_TIMEOUT");
  rejectBody(new Error("body aborted")); await tick(); assert.equal(f.calls.length, 1);
});

test("052: successful reads and HTTP/network failures clear their timer and preserve error codes/status for callers", async () => {
  for (const type of ["success", "http", "network"]) {
    const f = requestFixture(), pending = f.api("/api/organizations/w1");
    if (type === "success") { f.calls[0].resolve({ ok: true, json: async () => ({ organization: { id: "w1" } }) }); assert.equal((await pending).organization.id, "w1"); }
    if (type === "http") { f.calls[0].resolve({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHENTICATED", message: "Session expired" } }) }); await assert.rejects(pending, error => error.status === 401 && error.code === "UNAUTHENTICATED"); }
    if (type === "network") { const failure = new Error("Network failed"); f.calls[0].reject(failure); await assert.rejects(pending, error => error === failure); }
    assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
  }
});

test("052: mutations have no timeout or automatic retry and preserve exact CSRF/read-only boundaries", async () => {
  const f = requestFixture();
  const pending = f.api("/api/projects/p1/runtime", { method: "PUT", body: { policy: "always_on" } });
  assert.equal(f.timers.size, 0); assert.equal(f.calls[0].options.signal, undefined);
  assert.equal(f.calls[0].options.headers["x-clank-csrf"], "csrf-test"); assert.equal(f.calls[0].options.body, '{"policy":"always_on"}');
  f.calls[0].reject(new Error("failed")); await assert.rejects(pending, /failed/); assert.equal(f.calls.length, 1);
  f.initial.impersonation = {};
  await assert.rejects(f.api("/api/projects", { method: "POST", body: {} }), error => error.code === "IMPERSONATION_READ_ONLY"); assert.equal(f.calls.length, 1);
  const exit = f.api("/api/admin/impersonation", { method: "DELETE" }); assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ ok: true, json: async () => ({}) }); await exit;
});

test("053: hidden startup creates no interval and the first visible transition refreshes the active view once", async () => {
  const f = refreshFixture(true); f.start(); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.nodes.get("#auto-refresh-state").textContent, "Hidden");
  f.state.currentProject = "p1"; f.visibility(false); assert.deepEqual(f.calls, [["loadProject", true]]); assert.equal(f.timers.size, 1);
  f.visibility(false); assert.equal(f.calls.length, 1, "duplicate visible events do not trigger another immediate refresh"); await tick();
  f.interval(); assert.equal(f.calls.length, 2); await tick();
});

test("053: hiding cancels interval callbacks and visible restoration coalesces with an existing automatic read", async () => {
  const f = refreshFixture(); f.start(); const stale = f.timers.get(f.state.refreshTimer).callback;
  f.hold(); f.interval(); assert.equal(f.calls.length, 1);
  f.visibility(true); assert.equal(f.timers.size, 0); stale(); assert.equal(f.calls.length, 1);
  f.visibility(false); f.interval(); assert.equal(f.calls.length, 1, "one in-flight automatic refresh is shared");
  f.release(); await tick(); f.interval(); assert.equal(f.calls.length, 2); await tick();
});

test("053: manual pause survives hidden/visible transitions and leaves authentication expiry untouched", async () => {
  const f = refreshFixture(); f.start(); f.toggle(); assert.equal(f.state.refreshPaused, true);
  f.visibility(true); f.visibility(false); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.state.impersonationExpiryTimer, 999);
  assert.equal(f.nodes.get("#auto-refresh")["aria-pressed"], "false"); assert.equal(f.nodes.get("#auto-refresh-state").textContent, "Paused");
  f.toggle(); assert.equal(f.timers.size, 1); assert.equal(f.calls.length, 0); f.interval(); assert.equal(f.calls.length, 1); await tick();
});

test("053: restoration respects current authentication and active route without changing manual refresh routing", async () => {
  for (const [page, expected] of [["admin", "loadAdmin"], ["billing", "loadBilling"], ["usage", "loadUsage"], ["workspace", "loadWorkspace"], ["activity", "loadActivity"], ["overview", "loadDashboard"]]) {
    const f = refreshFixture(true); f.context.q(`#${page}-page`).hidden = false; f.start(); f.visibility(false);
    assert.equal(f.calls[0][0], expected); assert.equal(f.calls[0][1], true); if (page === "activity") assert.equal(f.calls[0][2], true); await tick();
  }
  const f = refreshFixture(); f.start(); f.visibility(true); f.initial.authenticated = false; f.visibility(false); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.match(html, /q\("#refresh"\)\.onclick=\(\)=>state.currentProject\?loadProject\(false\)/);
});

test("053: rejected automatic refresh releases its guard and never creates unhandled retry loops", async () => {
  const f = refreshFixture(); let reject; f.context.loadDashboard = () => { f.calls.push(["loadDashboard", true]); return new Promise((resolve, fail) => { reject = fail; }); };
  f.start(); f.interval(); assert.equal(f.calls.length, 1); reject(new Error("unexpected read failure")); await tick();
  assert.equal(f.state.refreshInFlight, null); assert.equal(f.calls.length, 1); f.interval(); assert.equal(f.calls.length, 2); reject(new Error("again")); await tick();
});
