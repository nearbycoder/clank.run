import test from "node:test";
import assert from "node:assert/strict";

import { defineJourney, runJourney } from "../dist/index.js";

test('native focus, keyboard and layout capabilities are optional for old journeys and explicit for new ones', async () => {
  const legacy = driverFixture(), calls = []; let focused;
  const native = { ...legacy.driver, focus(id) { calls.push(['focus', id]); focused = id; return id === 'task-add'; },
    press(key) { calls.push(['press', key]); if (key === 'Tab') focused = 'task-title'; }, focusedTarget: () => focused,
    layout: () => ({ clientWidth: 390, scrollWidth: 390 }) };
  const journey = defineJourney({ name: 'Native acceptance', steps: [{ focus: 'task-add' }, { expect: { focused: 'task-add' } },
    { press: 'Tab' }, { expect: { focused: 'task-title', noHorizontalOverflow: true } }] });
  const report = await runJourney(journey, native, { baseUrl: 'https://app.test' }); assert.equal(report.ok, true);
  assert.deepEqual(calls, [['focus', 'task-add'], ['press', 'Tab']]);
  for (const step of [{ focus: 'task-add' }, { press: 'Tab' }, { expect: { focused: 'task-add' } }, { expect: { noHorizontalOverflow: true } }]) {
    const missing = await runJourney(defineJourney({ name: 'Missing capability', steps: [step] }), legacy.driver, { baseUrl: 'https://app.test' });
    assert.equal(missing.ok, false); assert.match(missing.error, /does not (support|report)/);
  }
  const overflow = await runJourney(journey, { ...native, layout: () => ({ clientWidth: 390, scrollWidth: 391 }) }, { baseUrl: 'https://app.test' });
  assert.equal(overflow.ok, false); assert.match(overflow.error, /horizontal overflow/);
  const invalid = await runJourney(journey, { ...native, layout: () => ({ clientWidth: NaN, scrollWidth: 0 }) }, { baseUrl: 'https://app.test' });
  assert.equal(invalid.ok, false); assert.match(invalid.error, /invalid document measurements/);
});

test('native key and observation contracts reject unsupported values and inherited operations', () => {
  for (const step of [{ press: 'Control+script' }, { expect: { focused: '<selector>' } }, { expect: { noHorizontalOverflow: false } }]) {
    assert.throws(() => defineJourney({ name: 'Bad native assertion', steps: [step] }), TypeError);
  }
  const inherited = Object.assign(Object.create({ press: 'arbitrary code' }), { expect: { text: 'Ready' } });
  assert.deepEqual(defineJourney({ name: 'Own operation', steps: [inherited] }).steps, [{ expect: { text: 'Ready' } }]);
});

function driverFixture() {
  let url = "https://app.test/old";
  let text = "Tasks";
  let viewport;
  const nodes = [
    { id: "task-title", tag: "input", role: "textbox", label: "Task title", value: "" },
    { id: "task-add", tag: "button", role: "button", label: "Add task" },
  ];
  const driver = {
    async navigate(next) { url = next; },
    currentUrl: () => url,
    inspect: () => structuredClone(nodes),
    activate(id) {
      if (id !== "task-add") return false;
      nodes.push({ id: "task-created", tag: "article", label: "Created task" });
      text = "Tasks Created task";
      return true;
    },
    input(id, value, options) {
      const node = nodes.find((entry) => entry.id === id);
      if (!node || typeof value !== "string") return false;
      node.value = value;
      node.secret = options?.secret;
      return true;
    },
    visibleText: () => text,
    settle: async () => {},
    setViewport(value) { viewport = value; },
  };
  return { driver, nodes, getViewport: () => viewport, setUrl: (value) => { url = value; } };
}

test("semantic browser journeys validate, execute, wait, inspect, and redact input values", async () => {
  const mutableSteps = [
    { input: { target: "task-title", value: "private test title" } },
    { expect: { target: "task-title", state: { value: "private test title", role: "textbox" } } },
    { activate: "task-add" },
    { wait: { target: "task-created", text: "Created task", timeoutMs: 500 } },
    { visit: "/settings?tab=profile" },
    { expect: { url: "/settings?tab=profile" } },
    { inspect: "settings-ready" },
  ];
  const journey = defineJourney({
    name: "Create and configure a task",
    description: "Exercises semantic controls without CSS selectors.",
    viewport: { width: 390, height: 844 },
    steps: mutableSteps,
  });
  mutableSteps[0].input.value = "mutated after definition";
  const fixture = driverFixture();
  fixture.nodes.push({
    id: "oauth-link",
    tag: "a",
    role: "link",
    href: "https://app.test/callback?code=private-code#private-fragment",
  });
  const observed = [];
  const report = await runJourney(journey, fixture.driver, {
    baseUrl: "https://app.test",
    onStep(step) {
      observed.push(step.status);
      throw new Error("reporter failures are isolated");
    },
  });

  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.path, "/settings", "report paths omit query strings that may contain tokens");
  assert.deepEqual(fixture.getViewport(), { width: 390, height: 844 });
  assert.deepEqual(observed, Array(7).fill("passed"));
  assert.equal(report.steps[6].surface.some((node) => Object.hasOwn(node, "value")), false);
  assert.equal(report.steps[6].surface.find((node) => node.id === "oauth-link").href, "https://app.test/callback");
  assert.doesNotMatch(JSON.stringify(report), /private test title|mutated after definition/);
  assert.ok(Object.isFrozen(journey));
  assert.ok(Object.isFrozen(journey.steps));
});

test("journeys fail closed on protected controls, cross-origin navigation, and unmet waits", async () => {
  const fixture = driverFixture();
  fixture.driver.input = () => false;
  const protectedReport = await runJourney(defineJourney({
    name: "Protected input",
    steps: [{ input: { target: "password", value: "never report me" } }],
  }), fixture.driver, { baseUrl: "https://app.test" });
  assert.equal(protectedReport.ok, false);
  assert.match(protectedReport.error, /protected/);
  assert.doesNotMatch(JSON.stringify(protectedReport), /never report me/);

  const crossOrigin = driverFixture();
  crossOrigin.driver.activate = () => {
    crossOrigin.setUrl("https://attacker.test/stolen?token=secret");
    return true;
  };
  const originReport = await runJourney(defineJourney({
    name: "Origin boundary",
    steps: [{ activate: "task-add" }],
  }), crossOrigin.driver, { baseUrl: "https://app.test" });
  assert.equal(originReport.ok, false);
  assert.match(originReport.error, /outside the configured journey origin/);
  assert.equal(originReport.path, "/stolen");
  assert.doesNotMatch(JSON.stringify(originReport), /token=secret/);

  const waiting = driverFixture();
  const waitReport = await runJourney(defineJourney({
    name: "Bounded wait",
    steps: [{ wait: { target: "never-created", timeoutMs: 50 } }],
  }), waiting.driver, { baseUrl: "https://app.test", timeoutMs: 1_000 });
  assert.equal(waitReport.ok, false);
  assert.match(waitReport.error, /Waited 50ms/);
});

test("journeys resolve login secrets only at runtime and never report their values", async () => {
  const fixture = driverFixture();
  const journey = defineJourney({
    name: "Private login",
    steps: [{ input: { target: "task-title", value: { env: "CLANK_TEST_PASSWORD" } } }],
  });
  const report = await runJourney(journey, fixture.driver, {
    baseUrl: "https://app.test",
    resolveSecret(name) {
      assert.equal(name, "CLANK_TEST_PASSWORD");
      return "super-private-password";
    },
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(fixture.nodes[0].value, "super-private-password");
  assert.equal(fixture.nodes[0].secret, true);
  assert.doesNotMatch(JSON.stringify(report), /super-private-password/);

  const missing = await runJourney(journey, driverFixture().driver, { baseUrl: "https://app.test" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /cannot be resolved/);
  assert.throws(() => defineJourney({
    name: "Invalid secret",
    steps: [{ input: { target: "task-title", value: { env: "bad secret" } } }],
  }), /uppercase environment-style/);
});

test("journey contracts reject ambiguous operations, unsafe paths, unknown state, and excessive input", () => {
  assert.throws(() => defineJourney({ name: "Empty", steps: [] }), /1 through 100/);
  assert.throws(() => defineJourney({
    name: "Ambiguous",
    steps: [{ activate: "save", visit: "/saved" }],
  }), /exactly one operation/);
  assert.throws(() => defineJourney({
    name: "External",
    start: "https://attacker.test",
    steps: [{ expect: { text: "no" } }],
  }), /relative application path/);
  assert.throws(() => defineJourney({
    name: "Unknown state",
    steps: [{ expect: { target: "save", state: { color: "green" } } }],
  }), /unknown key color/);
  assert.throws(() => defineJourney({
    name: "Huge input",
    steps: [{ input: { target: "title", value: "x".repeat(16 * 1024 + 1) } }],
  }), /bounded text/);
});
