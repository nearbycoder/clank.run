import test from "node:test";
import assert from "node:assert/strict";
import { effect, store, toRaw } from "../dist/core.js";

test("rejected non-writable assignments retain native values without notifying effects", () => {
  for (const configurable of [true, false]) {
    const raw = {};
    Object.defineProperty(raw, "fixed", { value: 1, enumerable: true, configurable });
    const state = store(raw);
    const seen = [];
    const stop = effect(() => { seen.push([state.fixed, Object.keys(state), "fixed" in state]); });
    try {
      assert.equal(Reflect.set(state, "fixed", 2), false);
      assert.equal(Reflect.set(state, "fixed", 1), false);
      assert.throws(() => { state.fixed = 3; }, TypeError);
      assert.equal(state.fixed, 1);
      assert.equal(toRaw(state).fixed, 1);
      assert.deepEqual(seen, [[1, ["fixed"], true]]);
    } finally {
      stop();
    }
  }
});

test("rejected non-configurable deletes preserve values, keys, and membership", () => {
  const raw = {};
  Object.defineProperty(raw, "fixed", { value: 1, writable: true, enumerable: true });
  const state = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([state.fixed, Object.keys(state), "fixed" in state]); });
  try {
    assert.equal(Reflect.deleteProperty(state, "fixed"), false);
    assert.throws(() => { delete state.fixed; }, TypeError);
    assert.equal(state.fixed, 1);
    assert.deepEqual(seen, [[1, ["fixed"], true]]);
    state.fixed = 2;
    assert.deepEqual(seen, [[1, ["fixed"], true], [2, ["fixed"], true]]);
  } finally {
    stop();
  }
});

test("sealed and non-extensible stores reject additions without phantom values or shape changes", () => {
  for (const preventExtensions of [Object.seal, Object.preventExtensions]) {
    const raw = preventExtensions({ existing: 1 });
    const state = store(raw);
    const seen = [];
    const stop = effect(() => {
      seen.push([state.existing, state.missing, Object.keys(state), "missing" in state]);
    });
    try {
      assert.equal(Reflect.set(state, "missing", 2), false);
      assert.equal(Reflect.set(state, "missing", undefined), false);
      assert.equal(Reflect.set(state, "unread", 3), false);
      assert.equal(state.unread, undefined);
      assert.equal(state.missing, undefined);
      assert.deepEqual(seen, [[1, undefined, ["existing"], false]]);
      state.existing = 2;
      assert.deepEqual(seen, [
        [1, undefined, ["existing"], false],
        [2, undefined, ["existing"], false],
      ]);
    } finally {
      stop();
    }
  }
});

test("rejected symbol and prototype-property additions leave the native object unchanged", () => {
  const key = Symbol("missing");
  const raw = Object.preventExtensions(Object.create(null));
  const state = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([state[key], state.__proto__, Reflect.ownKeys(state)]); });
  try {
    assert.equal(Reflect.set(state, key, 1), false);
    assert.equal(Reflect.set(state, "__proto__", { injected: true }), false);
    assert.equal(Object.getPrototypeOf(raw), null);
    assert.deepEqual(seen, [[undefined, undefined, []]]);
    assert.equal(state.__proto__, undefined);
  } finally {
    stop();
  }
});

test("inherited non-writable and getter-only properties reject writes without poisoning cached reads", () => {
  const nativeFunction = () => { throw new Error("reading a function must not call it"); };
  const prototype = Object.create(null, {
    fixed: { value: 1, enumerable: true },
    getterOnly: { get() { return nativeFunction; }, enumerable: true },
  });
  const raw = Object.create(prototype);
  const state = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([state.fixed, state.getterOnly, Object.keys(state)]); });
  try {
    assert.equal(Reflect.set(state, "fixed", 2), false);
    assert.equal(Reflect.set(state, "getterOnly", "attempted"), false);
    assert.equal(state.fixed, 1);
    assert.equal(state.getterOnly, nativeFunction);
    assert.deepEqual(seen, [[1, nativeFunction, []]]);
    assert.deepEqual(Reflect.ownKeys(raw), []);
  } finally {
    stop();
  }
});

test("accessor setters publish their native result when ignoring or normalizing an assignment", () => {
  let value = "original";
  const raw = Object.create({
    get value() { return value; },
    set value(next) { if (typeof next === "string") value = next.trim(); },
  });
  const state = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([state.value, Object.keys(state)]); });
  try {
    assert.equal(Reflect.set(state, "value", 123), true);
    assert.deepEqual(seen, [["original", []]]);
    assert.equal(Reflect.set(state, "value", " next "), true);
    assert.equal(state.value, "next");
    assert.deepEqual(seen, [["original", []], ["next", []]]);
  } finally {
    stop();
  }
});

test("a throwing inherited setter preserves its error and does not publish the attempted value", () => {
  const rejection = new Error("write rejected");
  const state = store(Object.create({
    get value() { return "original"; },
    set value(_) { throw rejection; },
  }));
  const seen = [];
  const stop = effect(() => { seen.push([state.value, Object.keys(state)]); });
  try {
    assert.throws(() => Reflect.set(state, "value", "attempted"), (error) => error === rejection);
    assert.deepEqual(seen, [["original", []]]);
    assert.equal(state.value, "original");
  } finally {
    stop();
  }
});

test("arrays with non-writable length reject new indexes without phantom entries", () => {
  const raw = ["first"];
  Object.defineProperty(raw, "length", { writable: false });
  const values = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([values.length, values[1], Object.keys(values), 1 in values]); });
  try {
    assert.equal(Reflect.set(values, "1", "attempted"), false);
    assert.equal(Reflect.set(values, "1", undefined), false);
    assert.deepEqual(seen, [[1, undefined, ["0"], false]]);
    assert.equal(values[1], undefined);
    assert.equal(Reflect.set(values, "length", 0), false);
    assert.deepEqual(seen, [[1, undefined, ["0"], false]]);
  } finally {
    stop();
  }
});

test("rejected array truncation still publishes removed entries and shape in a single effect run", () => {
  const raw = ["kept", "fixed", "removed"];
  Object.defineProperty(raw, "1", { configurable: false });
  const values = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([values.length, values[2], Object.keys(values), 2 in values]); });
  try {
    assert.equal(Reflect.set(values, "length", 0), false);
    assert.deepEqual(seen, [
      [3, "removed", ["0", "1", "2"], true],
      [2, undefined, ["0", "1"], false],
    ]);
    assert.equal(Reflect.set(values, "length", 0), false);
    assert.equal(seen.length, 2);
  } finally {
    stop();
  }
});
