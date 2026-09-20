import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { filterConsoleActivitySearch } from "../dist/platform-console-activity-search.js";
import { filterConsoleActivityAction } from "../dist/platform-console-activity-action.js";
import { platformConsolePage } from "../dist/platform-console.js";

const events = Object.freeze([
  Object.freeze({ id: 30, action: "release.deploy", project: { name: "Customer Portal", slug: "portal" }, organization: { name: "Main team" }, actor: { id: "user-a", email: "Owner@Example.test" }, metadata: { private: "metadata-only" }, createdAt: 1000 }),
  Object.freeze({ id: 20, action: "membership.role_changed", project: null, organization: { name: "Research <script>team</script>", slug: "research" }, actor: { id: "user-b", email: null }, metadata: {}, createdAt: 1000 }),
  Object.freeze({ id: 10, action: "token.revoke", project: null, organization: null, actor: { id: "system", email: "robot@example.test" }, metadata: {}, createdAt: 1000 }),
]);
const ids = rows => Array.from(rows, event => event.id);

test("activity search matches action, displayed target, and actor across audit shapes", () => {
  for (const [search, expected] of [
    [" RELEASE.DEPLOY ", [30]], ["release deploy", [30]], ["role changed", [20]],
    ["customer", [30]], ["portal", [30]], ["research", [20]], ["account", [10]],
    ["OWNER@", [30]], ["user-b", [20]], ["system", [10]],
    ["metadata-only", []], ["Main team", []], ["missing", []],
  ]) assert.deepEqual(ids(filterConsoleActivitySearch(events, search)), expected, search);
  assert.deepEqual(ids(events), [30, 20, 10]);
});

test("activity search is bounded, literal, immutable, and accepts an empty loaded snapshot", () => {
  for (const search of ["", "   ", null, undefined, {}, 5]) {
    assert.deepEqual(filterConsoleActivitySearch(events, search), events);
    assert.notEqual(filterConsoleActivitySearch(events, search), events);
  }
  assert.deepEqual(ids(filterConsoleActivitySearch(events, "<script>")), [20]);
  assert.deepEqual(filterConsoleActivitySearch(events, "[.*"), []);
  assert.deepEqual(filterConsoleActivitySearch([], "release"), []);
  const long = [{ ...events[0], action: "x".repeat(200) }];
  assert.deepEqual(filterConsoleActivitySearch(long, "x".repeat(200) + "ignored"), long);
});

function node(tagName, className, textContent) {
  return { tagName, className, textContent, value: "", hidden: false, dataset: {}, children: [], append(...children) { this.children.push(...children); }, setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; } };
}

async function fixture() {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const nodes = new Map();
  const state = { activityEvents: [...events], activitySearch: "", activityNextBefore: 10, activityLoading: false };
  const context = {
    state, filterConsoleActivitySearch, filterConsoleActivityAction,
    q: selector => { if (!nodes.has(selector)) nodes.set(selector, node("div")); return nodes.get(selector); },
    clear: element => { element.children = []; }, el: node, formatDate: String,
  };
  const functions = ["activityScopeKey", "syncActivityScope", "renderActivity", "updateActivitySearch", "loadActivity"].map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`))[0]).join("\n");
  runInNewContext(functions, context);
  return { html, nodes, state, context };
}

test("activity results show counts and safe text while preserving older-event navigation with no matches", async () => {
  const { html, state, context } = await fixture();
  assert.match(html, /<label for="activity-search">Search loaded events<\/label>/);
  assert.match(html, /id="activity-search" type="search" maxlength="200"/);
  assert.match(html, /id="activity-count" role="status"/);
  state.activitySearch = "research";
  runInNewContext("renderActivity()", context);
  assert.equal(context.q("#activity-count").textContent, "1 of 3 loaded events shown");
  assert.equal(context.q("#activity-list").children[0].children[0].children[1].children[1].textContent, "Research <script>team</script>");
  state.activitySearch = "not-loaded";
  runInNewContext("renderActivity()", context);
  assert.equal(context.q("#activity-count").textContent, "0 of 3 loaded events shown");
  assert.equal(context.q("#activity-list").children[0].children[0].textContent, "No matching loaded events");
  assert.match(context.q("#activity-list").children[0].children[1].textContent, /load older events/);
  assert.equal(context.q("#activity-footer").hidden, false);
  state.activityEvents = [];
  state.activityNextBefore = null;
  runInNewContext("renderActivity()", context);
  assert.equal(context.q("#activity-list").children[0].children[0].textContent, "No auditable workspace events yet");
  assert.equal(context.q("#activity-footer").hidden, true);
});

test("activity search combines new pages and remains applied when refresh merges the head without discarding older pages", async () => {
  const { state, context } = await fixture();
  const requests = [];
  const older = { ...events[0], id: 5 };
  const refreshed = { ...events[0], id: 40 };
  const pages = [{ events: [older], nextBefore: 5 }, { events: [refreshed], nextBefore: null }];
  Object.assign(context, {
    api: async path => { requests.push(path); return pages.shift(); },
    toast: () => {}, handleAuthFailure: () => false,
  });
  runInNewContext('updateActivitySearch("release")', context);
  assert.equal(requests.length, 0, "search must not trigger API requests");
  await runInNewContext("loadActivity(false)", context);
  assert.equal(context.q("#activity-count").textContent, "2 of 4 loaded events shown");
  assert.deepEqual(ids(state.activityEvents), [30, 20, 10, 5]);
  assert.equal(state.activityNextBefore, 5);
  await runInNewContext("loadActivity(true)", context);
  assert.equal(state.activitySearch, "release");
  assert.equal(context.q("#activity-count").textContent, "3 of 5 loaded events shown");
  assert.deepEqual(ids(state.activityEvents), [40, 30, 20, 10, 5]);
  assert.equal(state.activityNextBefore, 5);
  assert.deepEqual(requests, ["/api/audit?limit=50&before=10", "/api/audit?limit=50"]);
  assert.equal(context.q("#activity-footer").hidden, false);
  assert.equal(context.q("#activity-more").disabled, false);
});

test("activity search can be cleared with Escape, the clear button, and native search clearing", async () => {
  const { html, state, context } = await fixture();
  const handlers = html.split("\n").filter(line => line.startsWith('q("#activity-search') && /\.on/.test(line)).join("\n");
  runInNewContext(handlers, context);
  const input = context.q("#activity-search");
  input.oninput({ target: { value: "owner" } });
  assert.equal(state.activitySearch, "owner");
  let prevented = false;
  input.onkeydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(state.activitySearch, "");
  assert.equal(context.q("#activity-count").textContent, "3 of 3 loaded events shown");
  input.oninput({ target: { value: "x".repeat(201) } });
  assert.equal(state.activitySearch.length, 200);
  context.q("#activity-search-clear").onclick();
  assert.equal(input.focused, true);
  assert.equal(context.q("#activity-search-clear").hidden, true);
  input.oninput({ target: { value: "research" } });
  input.onsearch({ target: { value: "" } });
  assert.equal(state.activitySearch, "");
});

test("sign-out clears the activity search and rendered event data before navigation", async () => {
  const { html, state, context } = await fixture();
  const destinations = [];
  state.activitySearch = "owner@example.test";
  Object.assign(context, { clearInterval() {}, clearTimeout() {}, initial: {}, window: { location: { assign: path => destinations.push(path) } } });
  const reset = html.match(/function returnToSignIn\(\)\{[^\n]+/)[0];
  runInNewContext(`${reset}\nreturnToSignIn()`, context);
  assert.equal(state.activitySearch, "");
  assert.equal(state.activityEvents.length, 0);
  assert.equal(context.q("#activity-search").value, "");
  assert.equal(context.q("#activity-count").textContent, "0 of 0 loaded events shown");
  assert.equal(context.q("#activity-footer").hidden, true);
  assert.deepEqual(destinations, ["/login"]);
});
