import test from "node:test";
import assert from "node:assert/strict";
import {
  ActionError,
  ValidationError,
  actionRunner,
  createAgentBridge,
  defineAction,
  defineView,
  s,
} from "../dist/ai.js";

test("schemas validate nested input and emit JSON Schema", () => {
  const input = s.object({
    title: s.string({ min: 2, description: "Task title" }),
    priority: s.optional(s.enum(["low", "high"])),
    tags: s.array(s.string()),
  });
  assert.deepEqual(input.parse({ title: "Ship", tags: ["work"] }), {
    title: "Ship",
    priority: undefined,
    tags: ["work"],
  });
  assert.throws(() => input.parse({ title: "x", tags: [7] }), ValidationError);
  const json = input.toJSONSchema();
  assert.deepEqual(json.required, ["title", "tags"]);
  assert.equal(json.additionalProperties, false);
});

test("schema contracts snapshot mutable builder inputs", () => {
  const options = { min: 2 };
  const text = s.string(options);
  options.min = 100;
  assert.equal(text.parse("ok"), "ok");

  const values = ["low", "high"];
  const priority = s.enum(values);
  values.push("admin");
  assert.throws(() => priority.parse("admin"), ValidationError);

  const shape = { name: s.string() };
  const profile = s.object(shape);
  shape.role = s.string();
  assert.deepEqual(profile.parse({ name: "Ada" }), { name: "Ada" });
  assert.throws(() => profile.parse({ name: "Ada", role: "admin" }), ValidationError);
});

test("common web schemas cover emails, URLs, dates, records, defaults, refinement, and coercion", () => {
  assert.equal(s.email().parse("ada@example.com"), "ada@example.com");
  assert.throws(() => s.email().parse("not-an-email"), ValidationError);
  assert.equal(s.url().parse("https://example.com/path"), "https://example.com/path");
  assert.throws(() => s.url().parse("ftp://example.com/file"), ValidationError);
  assert.equal(s.date().parse("2028-02-29"), "2028-02-29");
  assert.throws(() => s.date().parse("2027-02-29"), ValidationError);
  assert.equal(s.datetime().parse("2026-07-16T09:30:00-05:00"), "2026-07-16T09:30:00-05:00");
  assert.throws(() => s.datetime().parse("2026-07-16T09:30:00"), ValidationError);

  const flags = s.record(s.boolean(), { keyPattern: /^[a-z]+$/ });
  assert.deepEqual(flags.parse({ beta: true }), { beta: true });
  assert.throws(() => flags.parse({ "not-safe": true }), ValidationError);
  const unsafe = Object.create(null);
  unsafe.__proto__ = true;
  assert.throws(() => flags.parse(unsafe), ValidationError);

  const defaults = s.object({ tags: s.default(s.array(s.string()), ["new"]) });
  assert.deepEqual(defaults.parse({}), { tags: ["new"] });
  assert.deepEqual(defaults.toJSONSchema().required, []);
  assert.equal(s.refine(s.number(), (value) => value % 2 === 0, "Must be even.").parse(4), 4);
  assert.throws(() => s.refine(s.number(), (value) => value % 2 === 0, "Must be even.").parse(3), ValidationError);
  assert.equal(s.coerce.number({ integer: true }).parse("42"), 42);
  assert.equal(s.coerce.boolean().parse("false"), false);
});

test("actions publish contracts and bridge HTTP requests", async () => {
  const add = defineAction({
    name: "counter.add",
    description: "Add an amount to the counter.",
    input: s.object({ amount: s.number({ integer: true }) }),
    output: s.object({ value: s.number() }),
    sideEffects: "write",
    handler: ({ amount }) => ({ value: amount + 4 }),
  });
  const bridge = createAgentBridge([add]);
  assert.equal(bridge.manifest().actions[0].name, "counter.add");
  const manifest = await bridge.handle(new Request("http://test/.well-known/clank"));
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).protocol, "clank-agent/1");
  const unconfirmed = await bridge.handle(new Request("http://test/actions/counter.add", {
    method: "POST",
    body: JSON.stringify({ amount: 3 }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(unconfirmed.status, 428);
  assert.equal((await unconfirmed.json()).error.code, "CONFIRMATION_REQUIRED");
  const response = await bridge.handle(new Request("http://test/actions/counter.add", {
    method: "POST",
    body: JSON.stringify({ amount: 3 }),
    headers: {
      "content-type": "application/json",
      "x-clank-confirmation": "confirmed",
    },
  }));
  assert.deepEqual(await response.json(), { ok: true, output: { value: 7 } });
  const invalid = await bridge.handle(new Request("http://test/actions/counter.add", {
    method: "POST",
    body: JSON.stringify({ amount: "three" }),
    headers: {
      "content-type": "application/json",
      "x-clank-confirmation": "confirmed",
    },
  }));
  assert.equal(invalid.status, 422);
});

test("authorization and action runners expose safe async state", async () => {
  const action = defineAction({
    name: "secret.read",
    description: "Read a secret.",
    input: s.object({}),
    authorize: (_input, context) => context.user === "admin",
    sideEffects: "read",
    handler: () => "allowed",
  });
  await assert.rejects(() => action({}, { user: "guest" }), ActionError);
  const runner = actionRunner(action);
  assert.equal(await runner.run({}, { user: "admin" }), "allowed");
  assert.equal(runner.data.value, "allowed");
  assert.equal(runner.pending.value, false);
});

test("invalid action output is an internal failure, not an input validation error", async () => {
  const broken = defineAction({
    name: "broken.output",
    description: "Returns the wrong internal type.",
    input: s.object({}),
    output: s.number(),
    sideEffects: "none",
    confirmation: "never",
    handler: () => "secret internal output",
  });
  const response = await createAgentBridge([broken]).handle(new Request("https://app.test/actions/broken.output", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  const body = await response.text();
  assert.equal(response.status, 500);
  assert.match(body, /ACTION_FAILED/);
  assert.doesNotMatch(body, /secret internal output/);
  assert.doesNotMatch(body, /INVALID_INPUT/);
});

test("agent-described views validate user props without treating children as schema input", () => {
  const Greeting = defineView({
    name: "Greeting",
    description: "Greets one named person.",
    props: s.object({ name: s.string() }),
    render: ({ name, children }) => ({ name, childCount: children.length }),
  });
  assert.deepEqual(Greeting({ name: "Ada", children: ["welcome"] }), { name: "Ada", childCount: 1 });
  assert.equal(Greeting.viewManifest.name, "Greeting");
});
