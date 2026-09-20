import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { filterConsoleActivityAction } from "../dist/platform-console-activity-action.js";
import { filterConsoleActivitySearch } from "../dist/platform-console-activity-search.js";
import { platformConsolePage } from "../dist/platform-console.js";

const event = (id, action, email = "owner@example.test") => Object.freeze({ id, action, actor: { id: "user-1", email }, project: null, organization: null, metadata: {}, createdAt: 1000 });
const events = Object.freeze([event(30, "release.deploy"), event(20, "token.revoke"), event(10, "release.deploy", "member@example.test")]);
const ids = rows => rows.map(row => row.id);

test("activity action choices are distinct, sorted, exact, and limited to loaded events", () => {
  const filtered = filterConsoleActivityAction(events, "release.deploy");
  assert.deepEqual(filtered.actions, ["release.deploy", "token.revoke"]);
  assert.equal(filtered.action, "release.deploy");
  assert.deepEqual(ids(filtered.events), [30, 10]);
  assert.deepEqual(ids(events), [30, 20, 10]);
  for (const value of ["", "unknown", "Release.deploy", " release.deploy", null, {}, 1, "x".repeat(129)]) {
    const result = filterConsoleActivityAction(events, value);
    assert.equal(result.action, "");
    assert.deepEqual(result.events, events);
    assert.notEqual(result.events, events);
  }
  assert.deepEqual(filterConsoleActivityAction([], "release.deploy"), { actions: [], action: "", events: [] });
});

test("activity action values are bounded without trimming or accidentally matching a prefix", () => {
  const atLimit = "x".repeat(128);
  const snapshot = [event(1, atLimit), event(2, `${atLimit}x`), event(3, ""), event(4, "action\nlabel")];
  assert.deepEqual(filterConsoleActivityAction(snapshot, atLimit).actions, [atLimit]);
  assert.deepEqual(ids(filterConsoleActivityAction(snapshot, atLimit).events), [1]);
  assert.equal(filterConsoleActivityAction(snapshot, `${atLimit}x`).action, "");
  assert.equal(filterConsoleActivityAction(snapshot, "action\nlabel").action, "");
  assert.equal(filterConsoleActivityAction(snapshot, "").events.length, 4, "All actions still displays events with unsupported selector values");
});

function node(tagName, className, textContent) {
  return { tagName, className, textContent, value: "", hidden: false, children: [], append(...children) { this.children.push(...children); }, focus() {} };
}

async function fixture() {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const state = { activityEvents: [...events], activitySearch: "", activityAction: "", activityNextBefore: 10, activityLoading: false };
  const nodes = new Map();
  const context = {
    state, filterConsoleActivitySearch, filterConsoleActivityAction,
    q: selector => { if (!nodes.has(selector)) nodes.set(selector, node("div")); return nodes.get(selector); },
    clear: element => { element.children = []; }, el: node, formatDate: String,
  };
  const functions = ["renderActivity", "updateActivitySearch", "loadActivity"].map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`))[0]).join("\n");
  const handler = html.split("\n").find(line => line.startsWith('q("#activity-action").onchange='));
  runInNewContext(`${functions}\n${handler}\nrenderActivity()`, context);
  return { html, state, context };
}

test("the action selector composes with search and keeps all loaded action choices available", async () => {
  const { html, state, context } = await fixture();
  assert.match(html, /<label for="activity-action">Action<\/label><select class="input" id="activity-action">/);
  const selector = context.q("#activity-action");
  assert.equal(selector.value, "");
  assert.deepEqual(selector.children.map(option => option.value), ["", "release.deploy", "token.revoke"]);
  assert.equal(selector.children[0].textContent, "All actions");
  selector.onchange({ target: { value: "release.deploy" } });
  assert.equal(context.q("#activity-count").textContent, "2 of 3 loaded events shown");
  runInNewContext('updateActivitySearch("member@")', context);
  assert.equal(state.activityAction, "release.deploy");
  assert.equal(selector.value, "release.deploy");
  assert.equal(context.q("#activity-count").textContent, "1 of 3 loaded events shown");
  assert.equal(selector.children.length, 3);
  selector.onchange({ target: { value: "token.revoke" } });
  assert.equal(context.q("#activity-count").textContent, "0 of 3 loaded events shown");
  assert.equal(context.q("#activity-list").children[0].children[0].textContent, "No matching loaded events");
  assert.match(context.q("#activity-list").children[0].children[1].textContent, /action filter.*load older events/);
  assert.equal(context.q("#activity-footer").hidden, false);
  selector.onchange({ target: { value: "invented.action" } });
  assert.equal(state.activityAction, "");
  assert.equal(selector.value, "");
  assert.equal(context.q("#activity-count").textContent, "1 of 3 loaded events shown");
});

test("older pages add action choices; refresh preserves a valid choice and resets a missing choice", async () => {
  const { state, context } = await fixture();
  const requests = [];
  const pages = [
    { events: [event(5, "backup.create")], nextBefore: 5 },
    { events: [event(40, "backup.create"), event(35, "release.deploy")], nextBefore: null },
    { events: [event(50, "release.deploy")], nextBefore: null },
  ];
  Object.assign(context, { api: async path => { requests.push(path); return pages.shift(); }, toast() {}, handleAuthFailure: () => false });
  const selector = context.q("#activity-action");
  selector.onchange({ target: { value: "release.deploy" } });
  assert.equal(requests.length, 0, "filtering must not fetch events");
  await runInNewContext("loadActivity(false)", context);
  assert.equal(state.activityAction, "release.deploy");
  assert.equal(context.q("#activity-count").textContent, "2 of 4 loaded events shown");
  assert.deepEqual(selector.children.map(option => option.value), ["", "backup.create", "release.deploy", "token.revoke"]);
  selector.onchange({ target: { value: "backup.create" } });
  await runInNewContext("loadActivity(true)", context);
  assert.equal(state.activityAction, "backup.create");
  assert.equal(selector.value, "backup.create");
  assert.equal(context.q("#activity-count").textContent, "1 of 2 loaded events shown");
  await runInNewContext("loadActivity(true)", context);
  assert.equal(state.activityAction, "");
  assert.equal(selector.value, "");
  assert.equal(context.q("#activity-count").textContent, "1 of 1 loaded events shown");
  assert.deepEqual(requests, ["/api/audit?limit=50&before=10", "/api/audit?limit=50", "/api/audit?limit=50"]);
});

test("action labels remain literal text and sign-out clears the selected action", async () => {
  const { html, state, context } = await fixture();
  const unsafe = '<img src=x onerror="alert(1)">';
  state.activityEvents = [event(1, unsafe)];
  state.activityAction = unsafe;
  runInNewContext("renderActivity()", context);
  const option = context.q("#activity-action").children[1];
  assert.equal(option.value, unsafe);
  assert.equal(option.textContent, unsafe);
  assert.equal(Object.hasOwn(option, "innerHTML"), false);
  const destinations = [];
  Object.assign(context, { clearInterval() {}, clearTimeout() {}, initial: {}, window: { location: { assign: path => destinations.push(path) } } });
  const reset = html.match(/function returnToSignIn\(\)\{[^\n]+/)[0];
  runInNewContext(`${reset}\nreturnToSignIn()`, context);
  assert.equal(state.activityAction, "");
  assert.equal(context.q("#activity-action").value, "");
  assert.equal(context.q("#activity-action").children.length, 1);
  assert.deepEqual(destinations, ["/login"]);
});
