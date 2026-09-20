import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-activity-retention-"));
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
const { filterConsoleActivitySearch } = await import(pathToFileURL(join(directory, "platform-console-activity-search.js")));
const { filterConsoleActivityAction } = await import(pathToFileURL(join(directory, "platform-console-activity-action.js")));
const source = [
  ...["activityScopeKey", "syncActivityScope", "renderActivity", "updateActivitySearch", "returnToSignIn"].map(name => line(`function ${name}(`)),
  line("async function loadActivity("), line('q("#activity-action").onchange='), line('q("#activity-more").onclick='),
].join("\n");
const event = (id, extra = {}) => ({ id, action: id % 2 ? "release.deploy" : "token.revoke", actor: { id: "owner", email: "owner@example.test" }, project: null, organization: null, metadata: { changed: id }, createdAt: id * 1000, ...extra });
const ids = events => Array.from(events, item => item.id);

function fixture() {
  const nodes = new Map(), requests = [], toasts = [], failures = [], destinations = [];
  function element(tagName = "div", className, textContent = "") {
    return { tagName, className, textContent, children: [], dataset: {}, attributes: {}, value: "", open: false, isConnected: false, hidden: false,
      connect(value) { this.isConnected = value; for (const child of this.children) child.connect(value); },
      append(...children) { for (const child of children) { child.parentElement = this; child.connect(this.isConnected); this.children.push(child); } },
      setAttribute(name, value) { this.attributes[name] = value; }, focus() {},
      set innerHTML(_value) { throw new Error("Audit metadata must be rendered as text"); },
    };
  }
  function q(selector) { if (!nodes.has(selector)) { const node = element(); node.isConnected = true; nodes.set(selector, node); } return nodes.get(selector); }
  const state = { workspaceId: "alpha", dashboard: { account: { id: "account-one" } }, activityScope: null, activityRenderedScope: null, activityGeneration: 0, activityExpanded: new Set(), activityEvents: [event(100), event(90), event(80)], activityNextBefore: 80, activityLoading: false, activitySearch: "", activityAction: "" };
  const context = { q, state, filterConsoleActivityAction, filterConsoleActivitySearch, el: element, formatDate: String,
    clear(node) { for (const child of node.children) child.connect(false); node.children = []; },
    api: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
    toast: (...args) => toasts.push(args), handleAuthFailure(error) { failures.push(error.status); return error.status === 401; },
    initial: {}, clearInterval() {}, clearTimeout() {}, window: { location: { assign: path => destinations.push(path) } },
  };
  runInNewContext(source, context);
  context.renderActivity();
  const details = id => q("#activity-list").children.flatMap(item => item.children).find(node => node.className === "activity-details" && node.dataset.eventId === String(id));
  const toggle = (id, open) => { const node = details(id); node.open = open; node.ontoggle(); return node; };
  return { q, state, context, requests, toasts, failures, destinations, details, toggle, load: (reset = true, silent = true) => context.loadActivity(reset, silent), render: () => context.renderActivity() };
}

test("036: head refresh merges by ID, updates overlapping rows, and retains older pages and their cursor", async () => {
  const f = fixture();
  const older = f.load(false);
  f.requests[0].resolve({ events: [event(80, { metadata: { version: "updated" } }), event(70), event(60)], nextBefore: 60 });
  await older;
  assert.deepEqual(ids(f.state.activityEvents), [100, 90, 80, 70, 60]);
  assert.equal(f.state.activityEvents[2].metadata.version, "updated");
  const head = f.load();
  f.requests[1].resolve({ events: [event(110), event(100, { metadata: { version: "head" } })], nextBefore: 100 });
  await head;
  assert.deepEqual(ids(f.state.activityEvents), [110, 100, 90, 80, 70, 60]);
  assert.equal(f.state.activityEvents[1].metadata.version, "head");
  assert.equal(f.state.activityNextBefore, 60);
  const next = f.load(false);
  assert.equal(f.requests[2].path, "/api/audit?limit=50&before=60");
  f.requests[2].resolve({ events: [event(50)], nextBefore: null });
  await next;
  const finalHead = f.load();
  f.requests[3].resolve({ events: [event(120)], nextBefore: 120 });
  await finalHead;
  assert.equal(f.state.activityNextBefore, null, "an exhausted older cursor stays exhausted");
  assert.equal(f.q("#activity-footer").hidden, true);
  await f.load(false);
  assert.equal(f.requests.length, 4, "an exhausted older action cannot fetch the head again");
});

test("036: first-page loading adopts its cursor, filters survive head merges, and duplicate loads coalesce", async () => {
  const f = fixture();
  f.state.activityEvents = [];
  f.state.activityNextBefore = null;
  const first = f.load();
  await f.load();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ events: [event(101), event(100)], nextBefore: 100 });
  await first;
  f.context.updateActivitySearch("owner@");
  f.q("#activity-action").onchange({ target: { value: "release.deploy" } });
  const head = f.load();
  f.requests[1].resolve({ events: [event(102)], nextBefore: null });
  await head;
  assert.equal(f.state.activitySearch, "owner@");
  assert.equal(f.state.activityAction, "release.deploy");
  assert.equal(f.q("#activity-count").textContent, "1 of 3 loaded events shown");
  assert.equal(f.state.activityNextBefore, 100);
});

test("036: a failed head read preserves loaded rows, filters and the older-page cursor", async () => {
  const f = fixture();
  f.context.updateActivitySearch("owner@");
  const pending = f.load(true, false);
  f.requests[0].reject(new Error("Network unavailable"));
  await pending;
  assert.deepEqual(ids(f.state.activityEvents), [100, 90, 80]);
  assert.equal(f.state.activityNextBefore, 80);
  assert.equal(f.state.activitySearch, "owner@");
  assert.equal(f.state.activityLoading, false);
  assert.equal(f.q("#activity-more").disabled, false);
  assert.deepEqual(f.toasts, [["Network unavailable", true]]);
});

test("036: workspace and account changes clear retained state and reject stale completions and failures", async () => {
  for (const change of [f => { f.state.workspaceId = "beta"; }, f => { f.state.dashboard.account.id = "account-two"; }]) {
    for (const reject of [false, true]) {
      const f = fixture();
      f.context.updateActivitySearch("owner@");
      const first = f.load();
      change(f);
      const second = f.load();
      assert.equal(f.requests.length, 2);
      assert.equal(f.state.activityEvents.length, 0);
      assert.equal(f.state.activityNextBefore, null);
      assert.equal(f.state.activitySearch, "");
      if (reject) f.requests[0].reject(Object.assign(new Error("Old session error"), { status: 401 }));
      else f.requests[0].resolve({ events: [event(999)], nextBefore: 999 });
      await first;
      assert.equal(f.state.activityLoading, true);
      assert.equal(f.failures.length, 0);
      assert.equal(f.toasts.length, 0);
      f.requests[1].resolve({ events: [event(5)], nextBefore: 5 });
      await second;
      assert.deepEqual(ids(f.state.activityEvents), [5]);
      assert.equal(f.state.activityNextBefore, 5);
    }
  }
});

test("037: expanded event IDs survive refreshes and filters while metadata remains safe text", async () => {
  const f = fixture();
  f.toggle(90, true);
  const head = f.load();
  f.requests[0].resolve({ events: [event(110), event(90, { metadata: { value: "<script>literal</script>" } })], nextBefore: 90 });
  await head;
  assert.equal(f.details(90).open, true);
  assert.equal(f.details(90).children[1].textContent, JSON.stringify({ value: "<script>literal</script>" }, null, 2));
  const stale = f.details(90);
  f.context.updateActivitySearch("missing");
  assert.equal(f.details(90), undefined);
  assert.equal(f.state.activityExpanded.has("90"), true);
  stale.open = false;
  stale.ontoggle();
  f.context.updateActivitySearch("");
  assert.equal(f.details(90).open, true, "detached details cannot erase a retained choice");
  f.toggle(90, false);
  f.render();
  assert.equal(f.details(90).open, false);
});

test("037: synchronous rerender captures an open row before the browser delivers its toggle event", () => {
  const f = fixture();
  f.details(80).open = true;
  f.context.updateActivitySearch("owner@");
  assert.equal(f.details(80).open, true);
  assert.equal(f.state.activityExpanded.has("80"), true);
});

test("037: expansion memory is bounded, pruned to retained details and reset on scope changes", () => {
  const f = fixture();
  f.state.activityEvents = Array.from({ length: 130 }, (_, index) => event(130 - index));
  f.render();
  for (const item of f.state.activityEvents) f.toggle(item.id, true);
  assert.equal(f.state.activityExpanded.size, 100);
  f.render();
  assert.equal(f.state.activityExpanded.size, 100);
  f.state.activityEvents = [event(1), event(2, { metadata: {} })];
  f.render();
  assert.deepEqual(Array.from(f.state.activityExpanded), ["1"]);
  const old = f.details(1);
  f.state.workspaceId = "beta";
  f.render();
  old.open = true;
  old.ontoggle();
  assert.equal(f.state.activityExpanded.size, 0);
  assert.equal(f.state.activityEvents.length, 0);
  f.state.activityEvents = [event(1)];
  f.render();
  assert.equal(f.details(1).open, false);
});

test("036/037: sign-out invalidates pending reads and clears pagination and expanded detail memory", async () => {
  const f = fixture();
  f.toggle(90, true);
  const pending = f.load();
  f.context.returnToSignIn();
  f.requests[0].resolve({ events: [event(999)], nextBefore: 999 });
  await pending;
  assert.equal(f.state.activityEvents.length, 0);
  assert.equal(f.state.activityExpanded.size, 0);
  assert.equal(f.state.activityNextBefore, null);
  assert.equal(f.state.activityLoading, false);
  assert.deepEqual(f.destinations, ["/login"]);
});
