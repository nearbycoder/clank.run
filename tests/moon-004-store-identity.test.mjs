import test from "node:test";
import assert from "node:assert/strict";
import { effect, observeReactivity, STORE, store, toRaw } from "../dist/core.js";

test("wrapping a store repeatedly preserves its proxy and raw identities", () => {
  const raw = { count: 0 };
  const state = store(raw);
  let wrapped = state;
  for (let index = 0; index < 5; index++) {
    wrapped = store(wrapped);
    assert.equal(wrapped, state);
    assert.equal(store(raw), state);
    assert.equal(toRaw(wrapped), raw);
  }
});

test("nested objects, arrays, shared stores, and cycles retain their original proxies", () => {
  const childRaw = { count: 0 };
  const child = store(childRaw);
  const raw = { child, items: [child, childRaw] };
  raw.self = raw;
  const state = store(raw);
  const items = state.items;
  assert.equal(store(state.child), child);
  assert.equal(state.items[0], child);
  assert.equal(state.items[1], child);
  assert.equal(store(items), items);
  assert.equal(state.self, state);
  assert.equal(store(state).self, state);
  assert.equal(toRaw(state.child), childRaw);
});

test("reused stores share subscriptions and publish each mutation once", () => {
  const state = store({ count: 0 });
  const reused = store(state);
  const seen = [];
  const stop = effect(() => { seen.push([state.count, reused.count]); });
  try {
    state.count = 1;
    reused.count = 2;
    assert.deepEqual(seen, [[0, 0], [1, 1], [2, 2]]);
  } finally {
    stop();
  }
});

test("assigning a reused store retains the original nested proxy and raw value", () => {
  const raw = { count: 0 };
  const child = store(raw);
  const state = store({ child: null });
  state.child = store(store(child));
  assert.equal(state.child, child);
  assert.equal(toRaw(state).child, raw);
  const seen = [];
  const stop = effect(() => { seen.push(state.child.count); });
  try {
    child.count = 1;
    state.child.count = 2;
    assert.deepEqual(seen, [0, 1, 2]);
  } finally {
    stop();
  }
});

test("store identity checks do not add reactive dependencies", () => {
  const raw = { count: 0 };
  const state = store(raw);
  const dependencies = [];
  const detachDiagnostics = observeReactivity((event) => {
    if (event.type === "dependency") dependencies.push(event);
  });
  let runs = 0;
  const stop = effect(() => {
    runs++;
    store(raw);
    store(state);
  });
  try {
    state.count = 1;
    state.added = true;
    assert.equal(runs, 1);
    assert.deepEqual(dependencies, []);
  } finally {
    stop();
    detachDiagnostics();
  }
});

test("a reused store property read subscribes to a single source", () => {
  const state = store({ count: 0 });
  const dependencies = [];
  const detachDiagnostics = observeReactivity((event) => {
    if (event.type === "dependency") dependencies.push(event);
  });
  const stop = effect(() => { void store(state).count; });
  try {
    assert.equal(dependencies.length, 1);
  } finally {
    stop();
    detachDiagnostics();
  }
});

test("forgeable store and raw markers do not bypass proxy creation", () => {
  for (const raw of [
    { count: 0, [STORE]: true, [Symbol.for("clank.raw")]: {} },
    Object.assign(Object.create({ [STORE]: true }), { count: 0 }),
  ]) {
    const state = store(raw);
    assert.notEqual(state, raw);
    assert.equal(toRaw(state), raw);
    const seen = [];
    const stop = effect(() => { seen.push(state.count); });
    try {
      state.count = 1;
      assert.deepEqual(seen, [0, 1]);
    } finally {
      stop();
    }
  }
});

test("store identity checks do not evaluate marker getters", () => {
  const raw = { count: 0 };
  for (const key of [STORE, Symbol.for("clank.raw")]) {
    Object.defineProperty(raw, key, {
      configurable: true,
      get() { throw new Error("marker getters are user code"); },
    });
  }
  const state = store(raw);
  assert.equal(store(state), state);
  assert.equal(store(raw), state);
  assert.equal(state.count, 0);
});
