import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { expression, h, render } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";
import { signal } from "../dist/core.js";

const root = await mkdtemp(join(tmpdir(), "clank-starter-views-"));
test.after(() => rm(root, { recursive: true, force: true }));
const runtime = new URL("../dist/index.js", import.meta.url).href;
const modules = {};
for (const name of ["auth-todo", "approval-queue", "customer-portal", "booking"]) {
  const filename = fileURLToPath(new URL(`../templates/${name}/src/view.tsx`, import.meta.url));
  let source = (await readFile(filename, "utf8")).replaceAll("__PROJECT_TITLE_JSON__", '"Fixture app"').replaceAll("@clank.run/framework", runtime);
  if (name === "booking") source += "\nexport { bookingCalendar };\n";
  const file = join(root, `${name}.mjs`);
  await writeFile(file, compile(source, { filename, jsxImportSource: runtime, sourceMap: false }));
  modules[name] = await import(pathToFileURL(file));
}
const domFixture = await readFile(new URL("./dom.test.mjs", import.meta.url), "utf8");
const { FakeElement } = new Function(`${domFixture.slice(domFixture.indexOf("class FakeNode {"), domFixture.indexOf("const { For, Portal,"))}\nreturn { FakeElement };`)();
FakeElement.prototype.focus = function () { document.activeElement = this; };
const descendants = (node) => node.childNodes.flatMap((child) => [child, ...descendants(child)]);
const find = (node, predicate) => descendants(node).find(predicate);
const control = (node, id) => find(node, (child) => child.getAttribute?.("data-clank-id") === id);
const click = (node) => node.listeners.get("click")({ currentTarget: node, preventDefault() {} });
const input = (node, value) => { node.value = value; node.listeners.get("input")({ currentTarget: node }); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const user = { id: "user-one", email: "one@example.invalid", role: "member", profile: { name: "One" } };
const todos = [
  { _id: "one", _version: 1, title: "Write report", done: false },
  { _id: "two", _version: 2, title: "Read report", done: true },
  { _id: "three", _version: 1, title: "Ship release", done: false },
];
function todoView(t, overrides = {}) {
  const node = new FakeElement("main");
  const props = { user, todos, version: 1, connected: true, add: async () => true, setDone: async () => true, remove: async () => true, logout() {}, ...overrides };
  t.after(render(node, h(modules["auth-todo"].TodoView, props)));
  return node;
}

test("083: todo starter exposes escaped server and local mutation errors", async (t) => {
  const html = await renderToString(h(modules["auth-todo"].TodoView, {
    user, todos: [], version: 1, connected: true, error: "Denied <script>alert(1)</script>", add() {}, setDone() {}, remove() {}, logout() {},
  }), { markers: false });
  assert.match(html, /role="alert"[^>]*>Denied &lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script\b/iu);
  const node = todoView(t, { remove: async () => { throw new Error("Could not remove"); } });
  await click(control(node, "todo-one-remove"));
  assert.ok(node.textContent.includes("Could not remove"));
  const source = await readFile(new URL("../templates/auth-todo/src/app.tsx", import.meta.url), "utf8");
  assert.match(source, /error=\{error\.value\}/u, "The live client's mutation error reaches its rendered view");
});

test("084: failed additions preserve drafts and focus, duplicate submissions coalesce, success clears only its draft", async (t) => {
  const first = deferred();
  const values = [];
  const node = todoView(t, { add: (title) => { values.push(title); return first.promise; } });
  const field = control(node, "new-todo"), button = control(node, "add-todo");
  const form = find(node, (child) => child.localName === "form");
  input(field, "  Retain this draft  ");
  const submit = () => form.listeners.get("submit")({ preventDefault() {} });
  const pending = submit();
  await submit();
  assert.deepEqual(values, ["Retain this draft"]);
  assert.equal(field.value, "  Retain this draft  ");
  assert.equal(button.getAttribute("disabled"), "");
  assert.equal(form.getAttribute("aria-busy"), "true");
  first.resolve(false);
  await pending;
  assert.equal(field.value, "  Retain this draft  ");
  assert.equal(document.activeElement, field);
  assert.equal(button.hasAttribute("disabled"), false);
  assert.ok(node.textContent.includes("Your draft is still here"));

  const second = deferred();
  const newer = todoView(t, { add: () => second.promise });
  const newerField = control(newer, "new-todo");
  const newerForm = find(newer, (child) => child.localName === "form");
  input(newerField, "submitted");
  const saving = newerForm.listeners.get("submit")({ preventDefault() {} });
  input(newerField, "newer draft");
  second.resolve(true);
  await saving;
  assert.equal(newerField.value, "newer draft");
  const saved = todoView(t);
  const savedField = control(saved, "new-todo");
  input(savedField, "saved draft");
  await find(saved, (child) => child.localName === "form").listeners.get("submit")({ preventDefault() {} });
  assert.equal(savedField.value, "");
});

test("085: a pending row blocks toggle/remove overlap while other rows remain usable", async (t) => {
  const operation = deferred();
  const calls = [];
  const node = todoView(t, {
    setDone: (id, done, version) => { calls.push(["toggle", id, done, version]); return operation.promise; },
    remove: async (id, version) => { calls.push(["remove", id, version]); return true; },
  });
  const toggle = control(node, "todo-one-toggle"), remove = control(node, "todo-one-remove");
  const saving = click(toggle);
  await click(toggle);
  await click(remove);
  await click(control(node, "todo-two-remove"));
  assert.deepEqual(calls, [["toggle", "one", true, 1], ["remove", "two", 2]]);
  assert.ok(toggle.hasAttribute("disabled") && remove.hasAttribute("disabled"));
  operation.resolve(false);
  await saving;
  assert.equal(toggle.hasAttribute("disabled"), false);
  await click(remove);
  assert.deepEqual(calls.at(-1), ["remove", "one", 1]);
});

test("086–087: completion filters and title search compose with counts and useful empty states", (t) => {
  const node = todoView(t);
  assert.ok(node.textContent.includes("All (3)") && node.textContent.includes("Active (2)") && node.textContent.includes("Completed (1)"));
  click(control(node, "todos-active"));
  assert.ok(control(node, "todo-one-toggle"));
  assert.equal(control(node, "todo-two-toggle"), undefined);
  input(control(node, "todo-search"), " REPORT ");
  assert.ok(control(node, "todo-one-toggle"));
  assert.equal(control(node, "todo-three-toggle"), undefined);
  assert.ok(node.textContent.includes("Showing 1 of 3 todos"));
  click(control(node, "todos-completed"));
  assert.ok(control(node, "todo-two-toggle"));
  assert.equal(control(node, "todo-one-toggle"), undefined);
  input(control(node, "todo-search"), "no match");
  assert.ok(node.textContent.includes("No todos match these filters"));
  assert.equal(control(node, "todos-completed").getAttribute("aria-pressed"), "true");
});

for (const [name, states, item] of [["approval-queue", ["pending", "approved", "rejected"], "088"], ["customer-portal", ["open", "closed"], "090"]]) {
  test(`${item}: ${name} status views preserve authorized records and update with live data`, (t) => {
    const rows = signal(states.map((status, index) => ({ _id: `row-${index}`, _version: 1, title: `${status} request`, detail: "detail", note: "", ownerId: user.id, status })));
    const node = new FakeElement("main");
    const props = { user, records: expression(() => rows.value), create: async () => true, update: async () => true, logout() {} };
    t.after(render(node, h(modules[name].RecipeView, props)));
    for (const status of states) {
      click(control(node, `filter-${status}`));
      const headings = descendants(node).filter((child) => child.localName === "h2").map((child) => child.textContent);
      assert.deepEqual(headings, [`${status} request`]);
      assert.equal(control(node, `filter-${status}`).getAttribute("aria-pressed"), "true");
    }
    rows.value = [];
    assert.ok(node.textContent.includes("No records yet"));
    assert.ok(node.textContent.includes("Showing 0 of 0 requests"));
  });
}

test("089: booking calendar export preserves UTC times, stable IDs, text escaping, and UTF-8 line folding", async () => {
  const row = { _id: "record-one", _creationTime: Date.UTC(2026, 0, 1), _version: 1, ownerId: user.id, status: "booked", startsAt: Date.UTC(2026, 9, 4, 14), endsAt: Date.UTC(2026, 9, 4, 14, 30), title: "Consultation, notes; " + "😀".repeat(35), detail: "2026-10-04T14:00", note: "First\\second\r\nBEGIN:VEVENT" };
  const { bookingCalendar, RecipeView } = modules.booking;
  const calendar = bookingCalendar(row, "bookings.example.invalid");
  const unfolded = calendar.replaceAll("\r\n ", "");
  assert.ok(unfolded.includes("DTSTART:20261004T140000Z\r\nDTEND:20261004T143000Z"));
  assert.ok(unfolded.includes("UID:record-one@bookings.example.invalid"));
  assert.ok(unfolded.includes("SUMMARY:Consultation\\, notes\\; "));
  assert.ok(unfolded.includes("First\\\\second\\nBEGIN:VEVENT"));
  assert.equal(unfolded.match(/\r\nBEGIN:VEVENT\r\n/gu).length, 1);
  assert.ok(calendar.endsWith("END:VCALENDAR\r\n"));
  for (const line of calendar.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(bookingCalendar(row, "bookings.example.invalid"), calendar);
  for (const invalid of [{ ...row, startsAt: NaN }, { ...row, endsAt: row.endsAt + 1 }, { ...row, status: "cancelled" }]) assert.throws(() => bookingCalendar(invalid, "fixture"), /Invalid booking/u);
  const props = { user, records: [row], create: async () => true, update: async () => true, logout() {} };
  const html = await renderToString(h(RecipeView, props), { markers: false });
  assert.match(html, /Add to calendar/u);
  const cancelled = await renderToString(h(RecipeView, { ...props, records: [{ ...row, status: "cancelled" }] }), { markers: false });
  assert.doesNotMatch(cancelled, /Add to calendar/u);
});
