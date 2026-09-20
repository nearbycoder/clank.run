import test from "node:test";
import assert from "node:assert/strict";
import { effect, store, toRaw } from "../dist/core.js";

test("shadowing inherited properties notifies own-key observers even when the value is unchanged", () => {
  const state = store(Object.create({ inherited: "same" }));
  const enumerableKeys = [];
  const ownKeys = [];
  const stops = [
    effect(() => { enumerableKeys.push(Object.keys(state)); }),
    effect(() => { ownKeys.push(Reflect.ownKeys(state)); }),
  ];
  try {
    state.inherited = "same";
    state.inherited = "replacement";
    assert.deepEqual(enumerableKeys, [[], ["inherited"]]);
    assert.deepEqual(ownKeys, [[], ["inherited"]]);
    assert.equal(Object.hasOwn(toRaw(state), "inherited"), true);
  } finally {
    for (const stop of stops) stop();
  }
});

test("symbol shadows settle own keys and cached values together when added and deleted", () => {
  const key = Symbol("inherited");
  const state = store(Object.create({ [key]: "fallback" }));
  const seen = [];
  const stop = effect(() => { seen.push([state[key], Reflect.ownKeys(state), key in state]); });
  try {
    state[key] = "own";
    assert.equal(Reflect.deleteProperty(state, key), true);
    assert.deepEqual(seen, [
      ["fallback", [], true],
      ["own", [key], true],
      ["fallback", [], true],
    ]);
    assert.equal(state[key], "fallback");
  } finally {
    stop();
  }
});

test("deleting inherited or missing properties preserves cached reads and does not notify", () => {
  const fallback = () => { throw new Error("a stored function must not be called"); };
  const state = store(Object.create({ inherited: fallback }));
  const seen = [];
  const stop = effect(() => { seen.push([state.inherited, state.missing, Reflect.ownKeys(state)]); });
  try {
    assert.equal(Reflect.deleteProperty(state, "inherited"), true);
    assert.equal(Reflect.deleteProperty(state, "missing"), true);
    assert.equal(state.inherited, fallback);
    assert.deepEqual(seen, [[fallback, undefined, []]]);
  } finally {
    stop();
  }
});

test("deleting an own function shadow publishes the inherited function without invoking it", () => {
  const fallback = () => { throw new Error("the fallback is a value, not an updater"); };
  const own = () => "own";
  const state = store(Object.assign(Object.create({ action: fallback }), { action: own }));
  const seen = [];
  const stop = effect(() => { seen.push([state.action, Object.keys(state), "action" in state]); });
  try {
    assert.equal(Reflect.deleteProperty(state, "action"), true);
    assert.deepEqual(seen, [[own, ["action"], true], [fallback, [], true]]);
    assert.equal(state.action, fallback);
  } finally {
    stop();
  }
});

test("deleting an own shadow reads inherited getters with the store as receiver", () => {
  let state;
  const fallback = { name: "inherited object" };
  const prototype = {
    get value() {
      assert.equal(this, state);
      return fallback;
    },
  };
  const raw = Object.create(prototype);
  Object.defineProperty(raw, "value", { value: "own", configurable: true, enumerable: true });
  state = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([toRaw(state.value), Object.keys(state)]); });
  try {
    delete state.value;
    assert.deepEqual(seen, [["own", ["value"]], [fallback, []]]);
    assert.equal(toRaw(state.value), fallback);
    assert.equal(state.value, store(fallback));
  } finally {
    stop();
  }
});

test("an undefined own shadow still notifies shape observers when deleted", () => {
  const state = store(Object.assign(Object.create({ value: undefined }), { value: undefined }));
  const seen = [];
  const stop = effect(() => { seen.push([state.value, Object.keys(state), "value" in state]); });
  try {
    delete state.value;
    assert.deepEqual(seen, [[undefined, ["value"], true], [undefined, [], true]]);
  } finally {
    stop();
  }
});

test("array index shadows update keys and inherited fallbacks without changing length", () => {
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, "1", { value: "fallback", writable: true, configurable: true });
  const raw = ["first", , "third"];
  Object.setPrototypeOf(raw, prototype);
  const values = store(raw);
  const seen = [];
  const stop = effect(() => { seen.push([values[1], values.length, Object.keys(values)]); });
  try {
    values[1] = "own";
    delete values[1];
    assert.deepEqual(seen, [
      ["fallback", 3, ["0", "2"]],
      ["own", 3, ["0", "1", "2"]],
      ["fallback", 3, ["0", "2"]],
    ]);
  } finally {
    stop();
  }
});

test("the special __proto__ assignment tracks its own property without changing the prototype", () => {
  const state = store({});
  const inherited = Object.getPrototypeOf(toRaw(state));
  const replacement = { marker: true };
  const seen = [];
  const stop = effect(() => { seen.push([toRaw(state.__proto__), Object.keys(state)]); });
  try {
    state.__proto__ = replacement;
    assert.equal(Object.getPrototypeOf(toRaw(state)), inherited);
    delete state.__proto__;
    assert.deepEqual(seen, [[inherited, []], [replacement, ["__proto__"]], [inherited, []]]);
    assert.equal(Object.getPrototypeOf(toRaw(state)), inherited);
  } finally {
    stop();
  }
});

test("uncached accessor assignments preserve native write behavior without reading getters", () => {
  const writes = [];
  const state = store(Object.create({
    get value() { throw new Error("an unread getter must stay unread"); },
    set value(next) { writes.push(next); },
    get readOnly() { throw new Error("a rejected write must not invoke its getter"); },
  }));
  const keys = [];
  const stop = effect(() => { keys.push(Object.keys(state)); });
  try {
    assert.equal(Reflect.set(state, "value", "written"), true);
    assert.equal(Reflect.set(state, "readOnly", "rejected"), false);
    assert.deepEqual(writes, ["written"]);
    assert.deepEqual(keys, [[]]);
  } finally {
    stop();
  }
});

test("deleting an unread shadow does not evaluate its inherited getter", () => {
  const raw = Object.create({ get value() { throw new Error("the fallback was not read"); } });
  Object.defineProperty(raw, "value", { value: "own", configurable: true, enumerable: true });
  const state = store(raw);
  const keys = [];
  const stop = effect(() => { keys.push(Object.keys(state)); });
  try {
    assert.equal(Reflect.deleteProperty(state, "value"), true);
    assert.deepEqual(keys, [["value"], []]);
  } finally {
    stop();
  }
});
