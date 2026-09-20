import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-runtime-draft-"));
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
  line("function renderRuntimePolicy("), line("function editRuntimeDraft("), line("async function api("),
  line("async function loadProject("), line("async function openProject("), line("function returnToSignIn("),
  ...lines.filter(value => /^q\("#runtime-(?:policy|idle-timeout)/.test(value) && /\.on/.test(value)),
].join("\n");
const tick = () => new Promise(resolve => setImmediate(resolve));
const detail = (id = "alpha", runtime = {}) => ({ project: { id, slug: id, placement: "local", activeReleaseId: "release" }, access: { canManageRuntime: true }, runtime: { policy: "always_on", idleTimeoutMs: 300000, state: "online", sleepEligible: false, ...runtime } });

function fixture() {
  const nodes = new Map(), requests = [], toasts = [], authFailures = [], destinations = [];
  function element(tagName = "div") {
    return { tagName, value: "", textContent: "", children: [], attributes: {}, dataset: {}, hidden: false, disabled: false,
      get options() { return this.children; }, append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      focus() { this.focused = true; },
    };
  }
  function q(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); }
  const state = { currentProject: "alpha", currentProjectSlug: "alpha", projectTab: "settings", projectLoadGeneration: 0, runtimeDraft: null,
    projectData: { detail: detail() }, dashboard: { projects: [{ id: "alpha", slug: "alpha" }, { id: "beta", slug: "beta" }] }, route: { slug: "beta" },
  };
  const initial = { authenticated: true, csrfToken: "test-csrf", impersonation: null };
  const context = { q, state, initial, AbortController, setTimeout: () => 1, duration: String, document: { createElement: element },
    fetch(path, options) { return new Promise((resolve, reject) => requests.push({ path, options, reject,
      succeed: data => resolve({ ok: true, json: async () => data }),
      fail: (status, message) => resolve({ ok: false, status, json: async () => ({ error: { message } }) }),
    })); },
    toast: (...args) => toasts.push(args), handleAuthFailure(error) { authFailures.push(error.status); if (error.status === 401) context.returnToSignIn(); return error.status === 401; },
    renderProject: () => context.renderRuntimePolicy(state.projectData.detail), renderTrafficTable() {}, renderLogs() {}, renderActivity() {},
    PROJECT_TABS: ["settings", "performance"], showProjectTab() {}, resetNavigation() {}, closeSidebar() {},
    clear(node) { node.children = []; }, clearInterval() {}, clearTimeout() {},
    window: { scrollTo() {}, location: { assign: path => destinations.push(path) } },
  };
  runInNewContext(source, context);
  context.renderRuntimePolicy(state.projectData.detail);
  const refresh = runtime => { state.projectData.detail = detail(state.currentProject, runtime); context.renderRuntimePolicy(state.projectData.detail); };
  const edit = (policy, timeout = "1800000") => { q("#runtime-policy").value = policy; q("#runtime-idle-timeout").value = timeout; q("#runtime-policy").onchange(); };
  const submit = () => q("#runtime-policy-form").onsubmit({ preventDefault() {} });
  return { q, state, initial, context, requests, toasts, authFailures, destinations, refresh, edit, submit };
}

test("038: unchanged runtime settings track server refreshes, including nonstandard idle timeouts", () => {
  const f = fixture();
  f.refresh({ policy: "on_demand", idleTimeoutMs: 123456, state: "sleeping" });
  assert.equal(f.q("#runtime-policy").value, "on_demand");
  assert.equal(f.q("#runtime-idle-timeout").value, "123456");
  assert.equal(f.q("#runtime-idle-timeout").options.some(option => option.value === "123456"), true);
  assert.equal(f.q("#runtime-state-copy").textContent, "sleeping");
  assert.equal(f.state.runtimeDraft.dirty, false);
  assert.equal(f.q("#runtime-policy-cancel").hidden, true);
});

test("038: dirty policy and timeout survive automatic detail refresh while live runtime status updates", async () => {
  const f = fixture();
  f.edit("on_demand", "1800000");
  const pending = f.context.loadProject(true);
  assert.equal(f.requests[0].path, "/api/projects/alpha");
  f.requests[0].succeed(detail("alpha", { policy: "suspended", idleTimeoutMs: 600000, state: "sleeping" }));
  await pending;
  assert.equal(f.q("#runtime-policy").value, "on_demand");
  assert.equal(f.q("#runtime-idle-timeout").value, "1800000");
  assert.equal(f.state.runtimeDraft.dirty, true);
  assert.equal(f.q("#runtime-policy-draft").textContent, "Unsaved changes");
  assert.equal(f.q("#runtime-policy-cancel").hidden, false);
  assert.equal(f.q("#runtime-state-copy").textContent, "sleeping");
});

test("038: Cancel discards the draft and restores the newest server values without a request", () => {
  const f = fixture();
  f.edit("on_demand");
  f.refresh({ policy: "suspended", idleTimeoutMs: 600000 });
  f.q("#runtime-policy-error").textContent = "Previous error";
  f.q("#runtime-policy-cancel").onclick();
  assert.equal(f.q("#runtime-policy").value, "suspended");
  assert.equal(f.q("#runtime-idle-timeout").value, "600000");
  assert.equal(f.state.runtimeDraft.dirty, false);
  assert.equal(f.q("#runtime-policy-draft").textContent, "");
  assert.equal(f.q("#runtime-policy-error").textContent, "");
  assert.equal(f.q("#runtime-policy").focused, true);
  assert.deepEqual(f.requests, []);
});

test("038: failed saves preserve drafts through refresh and allow retry with CSRF intact", async () => {
  const f = fixture();
  f.edit("on_demand");
  const pending = f.submit();
  await f.submit();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/api/projects/alpha/runtime");
  assert.equal(f.requests[0].options.method, "PUT");
  assert.equal(f.requests[0].options.headers["x-clank-csrf"], "test-csrf");
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { policy: "on_demand", idleTimeoutMs: 1800000 });
  assert.equal(f.q("#runtime-policy-form").attributes["aria-busy"], "true");
  f.refresh({ policy: "suspended", idleTimeoutMs: 600000 });
  assert.equal(f.q("#runtime-policy").disabled, true);
  f.q("#runtime-policy-cancel").onclick();
  assert.equal(f.state.runtimeDraft.pending, true);
  f.requests[0].fail(500, "Could not save policy");
  await pending;
  assert.equal(f.q("#runtime-policy-error").textContent, "Could not save policy");
  assert.equal(f.q("#runtime-policy").value, "on_demand");
  assert.equal(f.q("#runtime-idle-timeout").value, "1800000");
  assert.equal(f.state.runtimeDraft.dirty, true);
  assert.equal(f.q("#runtime-policy-submit").disabled, false);
  f.refresh({ policy: "always_on", idleTimeoutMs: 300000 });
  assert.equal(f.q("#runtime-policy").value, "on_demand");
  assert.equal(f.q("#runtime-policy-error").textContent, "Could not save policy");
  const retry = f.submit();
  f.requests[1].succeed({});
  await tick();
  assert.equal(f.requests[2].path, "/api/projects/alpha");
  f.requests[2].succeed(detail("alpha", { policy: "on_demand", idleTimeoutMs: 1800000 }));
  await retry;
  assert.equal(f.state.runtimeDraft.dirty, false);
  assert.equal(f.state.runtimeDraft.pending, false);
  assert.equal(f.q("#runtime-policy-error").textContent, "");
  assert.equal(f.q("#runtime-policy-cancel").hidden, true);
});

test("038: a successful save invalidates older reads and keeps confirmed values if follow-up refresh fails", async () => {
  const f = fixture();
  f.edit("on_demand");
  const staleRead = f.context.loadProject(true);
  const save = f.submit();
  f.requests[1].succeed({});
  await tick();
  assert.equal(f.requests[2].path, "/api/projects/alpha");
  f.requests[0].succeed(detail("alpha", { policy: "suspended", idleTimeoutMs: 600000 }));
  await staleRead;
  f.requests[2].reject(new Error("Refresh temporarily unavailable"));
  await save;
  assert.equal(f.q("#runtime-policy").value, "on_demand");
  assert.equal(f.q("#runtime-idle-timeout").value, "1800000");
  assert.equal(f.state.runtimeDraft.dirty, false);
  assert.equal(f.state.runtimeDraft.pending, false);
});

test("038: switching projects clears fields immediately and stale save outcomes cannot change the new draft", async () => {
  for (const status of [200, 401, 500]) {
    const f = fixture();
    f.edit("on_demand");
    const old = f.submit();
    const next = f.context.openProject("beta", "settings", true);
    assert.equal(f.state.runtimeDraft, null);
    assert.equal(f.q("#runtime-policy").value, "");
    assert.equal(f.q("#runtime-idle-timeout").value, "");
    assert.equal(f.q("#runtime-policy-submit").disabled, true);
    f.requests[1].succeed(detail("beta", { policy: "suspended", idleTimeoutMs: 600000 }));
    await next;
    f.edit("always_on", "3600000");
    if (status === 200) f.requests[0].succeed({}); else f.requests[0].fail(status, "Stale save error");
    await old;
    assert.equal(f.state.runtimeDraft.projectId, "beta");
    assert.equal(f.state.runtimeDraft.dirty, true);
    assert.equal(f.q("#runtime-policy").value, "always_on");
    assert.equal(f.q("#runtime-idle-timeout").value, "3600000");
    assert.equal(f.q("#runtime-policy-error").textContent, "");
    assert.equal(f.q("#runtime-policy-submit").disabled, false);
    assert.equal(f.requests.length, 2);
    assert.equal(f.authFailures.length, 0);
    assert.equal(f.toasts.length, 0);
  }
});

test("038: returning to the same project cannot let an earlier save clear a newer draft", async () => {
  const f = fixture();
  f.edit("on_demand");
  const old = f.submit();
  f.context.loadProject = async () => {};
  await f.context.openProject("beta", "settings", true);
  await f.context.openProject("alpha", "settings", true);
  f.state.projectData = { detail: detail() };
  f.context.renderRuntimePolicy(f.state.projectData.detail);
  f.edit("suspended", "3600000");
  f.requests[0].succeed({});
  await old;
  assert.equal(f.q("#runtime-policy").value, "suspended");
  assert.equal(f.q("#runtime-idle-timeout").value, "3600000");
  assert.equal(f.state.runtimeDraft.dirty, true);
  assert.equal(f.toasts.length, 0);
});

test("038: role loss, provider placement and read-only support sessions retain draft values while blocking saves", async () => {
  for (const block of [f => { f.state.projectData.detail.access.canManageRuntime = false; }, f => { f.state.projectData.detail.project.placement = "provider"; }, f => { f.initial.impersonation = {}; }]) {
    const f = fixture();
    f.edit("on_demand");
    block(f);
    f.context.renderRuntimePolicy(f.state.projectData.detail);
    assert.equal(f.q("#runtime-policy").value, "on_demand");
    assert.equal(f.q("#runtime-policy-submit").disabled, true);
    await f.submit();
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.runtimeDraft.dirty, true);
  }
});

test("038: current authentication failures clear draft state during sign-out", async () => {
  const f = fixture();
  f.edit("on_demand");
  const pending = f.submit();
  f.requests[0].fail(401, "Sign in required");
  await pending;
  assert.equal(f.state.runtimeDraft, null);
  assert.equal(f.q("#runtime-policy").value, "");
  assert.equal(f.q("#runtime-idle-timeout").value, "");
  assert.equal(f.q("#runtime-policy-draft").textContent, "");
  assert.equal(f.q("#runtime-policy-submit").disabled, true);
  assert.deepEqual(f.destinations, ["/login"]);
});
