import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { platformConsolePage } from "../dist/platform-console.js";

async function fixture(authenticated = true) {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const nodes = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const calls = [];
  const destinations = [];
  let now = 0;
  let nextId = 1;
  const state = { refreshTimer: null, refreshPaused: false, currentProject: null, impersonationExpiryTimer: null };
  const initial = { authenticated, impersonation: null };
  const context = {
    state, initial,
    q(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        hidden: true, value: "", textContent: "", disabled: false,
        setAttribute(name, value) { this[name] = value; },
      });
      return nodes.get(selector);
    },
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay, next: now + delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) {
      const id = nextId++;
      timeouts.set(id, { callback, next: now + delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    clear() {}, renderActivity() {},
    showAuthenticated(value) { initial.authenticated = value; },
    loadDevice: async () => {},
    navigate: async path => destinations.push(path),
    window: { location: { assign: path => destinations.push(path) } },
    api: async (path, options) => {
      calls.push(["api", path, options.method]);
      return { user: { email: "member@example.invalid", profile: {} }, csrfToken: "test-token" };
    },
    toast(message) { throw new Error(message); },
  };
  for (const name of ["loadProject", "loadAdmin", "loadBilling", "loadUsage", "loadWorkspace", "loadActivity", "loadDashboard"]) {
    context[name] = async (...args) => { calls.push([name, ...args]); };
  }
  const functions = ["renderAutoRefresh", "startRefresh", "returnToSignIn", "handleAuthFailure"]
    .map(name => html.match(new RegExp(`function ${name}\\([^\\n]+`))[0]).join("\n");
  const handlers = html.split("\n").filter(line => /^q\("#(?:auto-refresh|auth-form|sign-out)"\)\./.test(line)).join("\n");
  const manualRefresh = html.match(/q\("#refresh"\)\.onclick=.+?;(?=q\("#mobile-menu"\))/)[0];
  runInNewContext(`${functions}\n${handlers}\n${manualRefresh}`, context);
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const jobs = [
        ...[...intervals].map(([id, task]) => ({ id, task, recurring: true })),
        ...[...timeouts].map(([id, task]) => ({ id, task, recurring: false })),
      ].filter(job => job.task.next <= end).sort((a, b) => a.task.next - b.task.next);
      if (!jobs.length) break;
      const job = jobs[0];
      now = job.task.next;
      if (job.recurring) job.task.next += job.task.delay;
      else timeouts.delete(job.id);
      job.task.callback();
    }
    now = end;
  };
  return {
    html, nodes, context, state, initial, intervals, timeouts, calls, destinations, advance,
    start: () => context.startRefresh(),
    toggle: () => context.q("#auto-refresh").onclick(),
    manual: () => context.q("#refresh").onclick(),
    login: () => context.q("#auth-form").onsubmit({ preventDefault() {} }),
    logout: () => context.q("#sign-out").onclick(),
  };
}

test("automatic refresh exposes a labeled toggle and replaces its 30-second interval", async () => {
  const f = await fixture();
  assert.match(f.html, /id="auto-refresh" type="button" aria-label="Automatic refresh" aria-pressed="true"/);
  assert.match(f.html, /id="auto-refresh-state" aria-hidden="true">Live<\/span>/);
  assert.match(f.html, /@media\(max-width:700px\)\{\.auto-refresh \.button-label\{display:none\}\}/);
  f.start();
  assert.equal(f.intervals.size, 1);
  assert.equal(f.context.q("#auto-refresh")["aria-pressed"], "true");
  assert.equal(f.context.q("#auto-refresh").disabled, false);
  f.advance(29999);
  assert.deepEqual(f.calls, []);
  f.advance(1);
  assert.deepEqual(f.calls, [["loadDashboard", true]]);
  const staleCallback = f.intervals.get(f.state.refreshTimer).callback;
  f.start();
  f.start();
  assert.equal(f.intervals.size, 1);
  staleCallback();
  assert.equal(f.calls.length, 1, "a replaced timer cannot issue a queued refresh");
  f.advance(30000);
  assert.equal(f.calls.length, 2);
});

test("pausing survives navigation and repeated starts while manual refresh remains available", async () => {
  const f = await fixture();
  f.start();
  const staleCallback = f.intervals.get(f.state.refreshTimer).callback;
  f.toggle();
  assert.equal(f.state.refreshPaused, true);
  assert.equal(f.state.refreshTimer, null);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.context.q("#auto-refresh")["aria-pressed"], "false");
  assert.equal(f.context.q("#auto-refresh-state").textContent, "Paused");
  assert.match(f.context.q("#auto-refresh").title, /^Resume/);
  f.state.currentProject = "another-project";
  f.start();
  f.start();
  staleCallback();
  f.advance(90000);
  assert.deepEqual(f.calls, []);
  await f.manual();
  assert.deepEqual(f.calls, [["loadProject", false]]);
  assert.equal(f.intervals.size, 0);
  f.toggle();
  assert.equal(f.state.refreshPaused, false);
  assert.equal(f.context.q("#auto-refresh-state").textContent, "Live");
  assert.equal(f.intervals.size, 1);
  assert.equal(f.calls.length, 1, "resume waits for the next interval instead of bursting requests");
  staleCallback();
  assert.equal(f.calls.length, 1, "a pre-pause callback remains stale after resume");
  f.advance(30000);
  assert.deepEqual(f.calls.at(-1), ["loadProject", true]);
  for (let index = 0; index < 4; index++) { f.toggle(); f.toggle(); }
  assert.equal(f.intervals.size, 1);
  f.advance(30000);
  assert.equal(f.calls.length, 3);
});

test("automatic refresh follows the active view without changing manual refresh semantics", async () => {
  const f = await fixture();
  f.start();
  for (const [view, loader] of [["admin", "loadAdmin"], ["billing", "loadBilling"], ["usage", "loadUsage"], ["workspace", "loadWorkspace"], ["activity", "loadActivity"]]) {
    for (const name of ["admin", "billing", "usage", "workspace", "activity"]) f.context.q(`#${name}-page`).hidden = name !== view;
    f.advance(30000);
    assert.deepEqual(f.calls.at(-1), view === "activity" ? [loader, true, true] : [loader, true]);
  }
  f.toggle();
  f.context.q("#activity-page").hidden = true;
  f.context.q("#usage-page").hidden = false;
  const beforeManual = f.calls.length;
  await f.manual();
  assert.deepEqual(f.calls.slice(beforeManual), [["loadDashboard", true], ["loadUsage", false]]);
  assert.equal(f.state.refreshPaused, true);
  assert.equal(f.intervals.size, 0);
});

test("pausing leaves impersonation expiry and other safety timeouts running", async () => {
  const f = await fixture();
  const safetyEvents = [];
  f.state.impersonationExpiryTimer = f.context.setTimeout(() => safetyEvents.push("impersonation expired"), 45000);
  f.context.setTimeout(() => safetyEvents.push("session expired"), 60000);
  f.start();
  f.toggle();
  assert.equal(f.timeouts.size, 2);
  f.advance(60000);
  assert.deepEqual(safetyEvents, ["impersonation expired", "session expired"]);
  assert.deepEqual(f.calls, []);
});

test("logout clears refresh state and successful authentication starts a fresh single timer", async () => {
  const f = await fixture();
  f.start();
  const staleCallback = f.intervals.get(f.state.refreshTimer).callback;
  f.toggle();
  await f.logout();
  assert.equal(f.initial.authenticated, false);
  assert.equal(f.state.refreshPaused, false);
  assert.equal(f.state.refreshTimer, null);
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.destinations, ["/login"]);
  const afterLogout = f.calls.length;
  f.start();
  f.toggle();
  staleCallback();
  f.advance(60000);
  assert.equal(f.calls.length, afterLogout);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.context.q("#auto-refresh").disabled, true);
  f.state.refreshPaused = true;
  await f.login();
  assert.equal(f.initial.authenticated, true);
  assert.equal(f.state.refreshPaused, false);
  assert.equal(f.context.q("#auto-refresh-state").textContent, "Live");
  assert.equal(f.context.q("#auto-refresh").disabled, false);
  assert.equal(f.intervals.size, 1);
  await f.login();
  assert.equal(f.intervals.size, 1, "a second auth success replaces its timer");
  assert.equal(f.context.q("#auth-error").textContent, "");
  f.context.handleAuthFailure({ status: 401 });
  f.context.returnToSignIn();
  assert.equal(f.intervals.size, 0);
  assert.equal(f.state.refreshPaused, false);
});

test("unauthenticated startup cannot poll or toggle refresh", async () => {
  const f = await fixture(false);
  f.start();
  f.toggle();
  f.advance(90000);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.state.refreshPaused, false);
  assert.deepEqual(f.calls, []);
});
