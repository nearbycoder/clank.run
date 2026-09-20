import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-create-pending-"));
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
const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
const lines = html.split("\n");
const line = prefix => {
  const found = lines.find(value => value.startsWith(prefix));
  assert.ok(found, `missing console fixture: ${prefix}`);
  return found;
};
const source = [
  line("function titleConsoleTime("),
  line("const state="), line("async function api("), line("function syncCreateSubmits("),
  line("function renderIdentity("), line('q("#new-site").onclick='),
  line('q("#site-form").onsubmit='), line('q("#add-domain").onclick='),
  line('q("#domain-form").onsubmit='), "globalThis.consoleState=state;",
].join("\n");
const tick = () => new Promise(resolve => setImmediate(resolve));
const created = { project: { id: "created-project", placement: "provider" } };

function fixture() {
  const nodes = new Map(), requests = [], toasts = [], authFailures = [], opened = [], loadedProjects = [];
  const hooks = {};
  let dashboardLoads = 0, prevented = 0;
  function q(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", dataset: {}, attributes: {}, disabled: false, hidden: false, open: false,
      closes: 0, resets: 0, focuses: 0,
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focuses++; },
      showModal() { this.open = true; },
      close() { this.open = false; this.closes++; },
      reset() {
        this.resets++;
        const fields = selector === "#site-form" ? ["site-name", "site-slug", "site-organization", "site-placement"] : ["domain-hostname"];
        fields.forEach(id => { q(`#${id}`).value = ""; });
      },
    });
    return nodes.get(selector);
  }
  const initial = { authenticated: true, impersonation: null, csrfToken: "test-csrf", platformAdmin: false };
  const context = {
    q, initial, qa: () => [q("#site-submit"), q("#domain-submit")], hooks,
    fetch(path, options) {
      return new Promise((resolve, reject) => requests.push({ path, options, reject,
        succeed: data => resolve({ ok: true, json: async () => data }),
        fail: (status, message = "Request failed") => resolve({ ok: false, status, json: async () => ({ error: { message } }) }),
      }));
    },
    toast: (...values) => toasts.push(values),
    handleAuthFailure(error) { authFailures.push(error.status); if (error.status !== 401) return false; initial.authenticated = false; return true; },
    async loadDashboard() { dashboardLoads++; await hooks.dashboard?.(); },
    async openProject(id) { opened.push(id); await hooks.open?.(); },
    async loadProject() { loadedProjects.push(context.consoleState.currentProject); await hooks.project?.(); },
    configureSitePlacement() {}, initials: () => "T", clearTimeout() {}, setTimeout() { return 1; },
    formatDate: String,
  };
  runInNewContext(source, context);
  const state = context.consoleState;
  state.dashboard = { account: { usage: { projects: 0 } }, limits: { projectsPerAccount: 10 }, organizations: [{ usage: { projects: 0, limit: 10 } }] };
  const select = id => { state.currentProject = id; state.projectData = { detail: { project: { id } }, domains: [], domainLimit: 10 }; };
  select("alpha");
  const submit = kind => q(`#${kind}-form`).onsubmit({ preventDefault() { prevented++; } });
  return { q, state, initial, requests, toasts, authFailures, opened, loadedProjects, hooks, context, select, submit,
    openDomain(id = state.currentProject) { select(id); q("#add-domain").onclick(); },
    fillSite() { q("#new-site").onclick(); q("#site-name").value = "My project"; q("#site-slug").value = "my-project"; q("#site-slug").dataset.edited = "1"; q("#site-organization").value = "my-workspace"; q("#site-placement").value = "provider"; },
    get dashboardLoads() { return dashboardLoads; }, get prevented() { return prevented; },
  };
}

test("creation dialogs expose dedicated submit controls to pending and read-only state", () => {
  for (const kind of ["site", "domain"]) {
    assert.match(html, new RegExp(`<button[^>]*id="${kind}-submit"[^>]*data-mutation[^>]*type="submit"`));
  }
});

test("project creation coalesces repeated submits through refresh and restores controls after success", async () => {
  const f = fixture();
  f.fillSite();
  let resumeDashboard;
  f.hooks.dashboard = () => new Promise(resolve => { resumeDashboard = resolve; });
  const pending = f.submit("site");
  await f.submit("site");
  assert.equal(f.prevented, 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.q("#site-submit").disabled, true);
  assert.equal(f.q("#site-form").attributes["aria-busy"], "true");
  assert.equal(f.requests[0].path, "/api/projects");
  assert.equal(f.requests[0].options.method, "POST");
  assert.equal(f.requests[0].options.headers["x-clank-csrf"], "test-csrf");
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { name: "My project", slug: "my-project", organizationId: "my-workspace", placement: "provider" });
  f.requests[0].succeed(created);
  await tick();
  f.context.renderIdentity();
  assert.equal(f.q("#site-submit").disabled, true, "dashboard identity refresh keeps the submit disabled");
  await f.submit("site");
  f.q("#new-site").onclick();
  assert.equal(f.q("#site-dialog").open, false, "the pending form cannot be reopened and cleared again");
  assert.equal(f.requests.length, 1);
  resumeDashboard();
  await pending;
  assert.equal(f.q("#site-submit").disabled, false);
  assert.equal(f.q("#site-form").attributes["aria-busy"], "false");
  assert.equal(f.q("#site-form").resets, 1);
  assert.equal(f.q("#site-slug").dataset.edited, "");
  assert.deepEqual(f.opened, ["created-project"]);
});

test("project creation failure preserves values and permits a retry", async () => {
  const f = fixture();
  f.fillSite();
  const pending = f.submit("site");
  f.requests[0].fail(409, "Slug already exists");
  await pending;
  assert.equal(f.q("#site-submit").disabled, false);
  assert.equal(f.q("#site-dialog").open, true);
  assert.equal(f.q("#site-error").textContent, "Slug already exists");
  assert.equal(f.q("#site-name").value, "My project");
  assert.equal(f.q("#site-slug").value, "my-project");
  assert.equal(f.q("#site-slug").dataset.edited, "1");
  assert.equal(f.q("#site-form").resets, 0);
  f.q("#site-slug").value = "other-slug";
  const retry = f.submit("site");
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.parse(f.requests[1].options.body).slug, "other-slug");
  f.requests[1].succeed(created);
  await retry;
  assert.equal(f.q("#site-error").textContent, "");
});

test("domain creation captures its project and coalesces repeated submits through refresh", async () => {
  const f = fixture();
  f.openDomain("project/alpha");
  f.q("#domain-hostname").value = "app.example.test";
  let resumeProject;
  f.hooks.project = () => new Promise(resolve => { resumeProject = resolve; });
  const pending = f.submit("domain");
  await f.submit("domain");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/api/projects/project%2Falpha/domains");
  assert.equal(f.requests[0].options.headers["x-clank-csrf"], "test-csrf");
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { hostname: "app.example.test" });
  assert.equal(f.q("#domain-submit").disabled, true);
  f.requests[0].succeed({});
  await tick();
  f.context.renderIdentity();
  await f.submit("domain");
  assert.equal(f.requests.length, 1);
  assert.equal(f.q("#domain-submit").disabled, true);
  resumeProject();
  await pending;
  assert.equal(f.q("#domain-submit").disabled, false);
  assert.equal(f.q("#domain-form").attributes["aria-busy"], "false");
  assert.equal(f.q("#domain-hostname").value, "");
  assert.equal(f.q("#domain-dialog").open, false);
  assert.deepEqual(f.loadedProjects, ["project/alpha"]);
});

test("domain failure preserves input and restores a retryable form", async () => {
  const f = fixture();
  f.openDomain();
  f.q("#domain-hostname").value = "app.example.test";
  const resets = f.q("#domain-form").resets;
  const pending = f.submit("domain");
  f.requests[0].reject(new Error("Network unavailable"));
  await pending;
  assert.equal(f.q("#domain-error").textContent, "Network unavailable");
  assert.equal(f.q("#domain-hostname").value, "app.example.test");
  assert.equal(f.q("#domain-form").resets, resets);
  assert.equal(f.q("#domain-dialog").open, true);
  assert.equal(f.q("#domain-submit").disabled, false);
  const retry = f.submit("domain");
  f.requests[1].succeed({});
  await retry;
  assert.equal(f.q("#domain-error").textContent, "");
  assert.equal(f.loadedProjects.length, 1);
});

test("an earlier project's completion leaves the newer domain request and form untouched", async () => {
  const f = fixture();
  f.openDomain("alpha");
  f.q("#domain-hostname").value = "alpha.example.test";
  const first = f.submit("domain");
  f.q("#domain-dialog").close();
  f.openDomain("beta");
  f.q("#domain-hostname").value = "beta.example.test";
  const second = f.submit("domain");
  const resets = f.q("#domain-form").resets;
  f.requests[0].succeed({});
  await first;
  assert.equal(f.q("#domain-submit").disabled, true);
  assert.equal(f.q("#domain-form").attributes["aria-busy"], "true");
  assert.equal(f.q("#domain-hostname").value, "beta.example.test");
  assert.equal(f.q("#domain-form").resets, resets);
  assert.equal(f.q("#domain-dialog").open, true);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.loadedProjects.length, 0);
  await f.submit("domain");
  assert.equal(f.requests.length, 2);
  f.requests[1].succeed({});
  await second;
  assert.equal(f.q("#domain-submit").disabled, false);
  assert.deepEqual(f.loadedProjects, ["beta"]);
});

test("stale domain errors cannot replace another project's form or sign out its session", async () => {
  for (const status of [401, 403, 500]) {
    const f = fixture();
    f.openDomain("alpha");
    f.q("#domain-hostname").value = "alpha.example.test";
    const pending = f.submit("domain");
    f.q("#domain-dialog").close();
    f.openDomain("beta");
    f.q("#domain-hostname").value = "beta.example.test";
    f.q("#domain-error").textContent = "Current form message";
    f.requests[0].fail(status, "Old error");
    await pending;
    assert.equal(f.q("#domain-error").textContent, "Current form message");
    assert.equal(f.q("#domain-hostname").value, "beta.example.test");
    assert.equal(f.q("#domain-dialog").open, true);
    assert.equal(f.q("#domain-submit").disabled, false);
    assert.equal(f.initial.authenticated, true);
    assert.equal(f.authFailures.length, 0);
  }
});

test("domain form cannot submit after selection changes until it is opened for that project", async () => {
  const f = fixture();
  f.openDomain("alpha");
  f.q("#domain-hostname").value = "alpha.example.test";
  f.select("beta");
  await f.submit("domain");
  assert.equal(f.requests.length, 0);
  assert.equal(f.q("#domain-hostname").value, "alpha.example.test");
  f.openDomain("beta");
  assert.equal(f.q("#domain-hostname").value, "");
  f.q("#domain-hostname").value = "beta.example.test";
  const pending = f.submit("domain");
  assert.equal(f.requests[0].path, "/api/projects/beta/domains");
  f.requests[0].succeed({});
  await pending;
});

test("creation forms retain read-only authorization and current authentication failure handling", async () => {
  for (const kind of ["site", "domain"]) {
    const f = fixture();
    if (kind === "site") f.fillSite(); else f.openDomain();
    f.initial.impersonation = { actor: { email: "support@example.test" }, target: { email: "user@example.test" }, reason: "Support", expiresAt: Date.now() + 1000 };
    f.context.renderIdentity();
    await f.submit(kind);
    assert.equal(f.requests.length, 0);
    assert.equal(f.q(`#${kind}-submit`).disabled, true);
    assert.match(f.q(`#${kind}-error`).textContent, /read-only/);
    assert.equal(f.q(`#${kind}-form`).attributes["aria-busy"], "false");
    f.initial.impersonation = null;
    f.context.renderIdentity();
    assert.equal(f.q(`#${kind}-submit`).disabled, false);
    const pending = f.submit(kind);
    f.requests[0].fail(401, "Sign in required");
    await pending;
    assert.equal(f.initial.authenticated, false);
    assert.equal(f.q(`#${kind}-error`).textContent, "");
    assert.equal(f.q(`#${kind}-submit`).disabled, false);
  }
});
