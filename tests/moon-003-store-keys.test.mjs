import test from "node:test";
import assert from "node:assert/strict";
import { batch, effect, store } from "../dist/core.js";

test("array truncation invalidates ownKeys, Object.keys, and for-in observers", () => {
  const values = store(["kept", "removed", "also removed"]);
  const ownKeys = [];
  const enumerableKeys = [];
  const iteratedKeys = [];
  const stops = [
    effect(() => { ownKeys.push(Reflect.ownKeys(values)); }),
    effect(() => { enumerableKeys.push(Object.keys(values)); }),
    effect(() => {
      const keys = [];
      for (const key in values) keys.push(key);
      iteratedKeys.push(keys);
    }),
  ];
  values.length = 1;
  assert.deepEqual(ownKeys, [["0", "1", "2", "length"], ["0", "length"]]);
  assert.deepEqual(enumerableKeys, [["0", "1", "2"], ["0"]]);
  assert.deepEqual(iteratedKeys, [["0", "1", "2"], ["0"]]);
  for (const stop of stops) stop();
});

test("length growth, unchanged lengths, and truncating holes preserve shape observers", () => {
  const metadata = Symbol("metadata");
  const raw = ["kept"];
  raw.length = 6;
  raw["01"] = "ordinary key";
  raw[4_294_967_295] = "outside array index range";
  raw[metadata] = "symbol key";
  const values = store(raw);
  const keys = [];
  const stop = effect(() => { keys.push(Reflect.ownKeys(values)); });
  values.length = 8;
  values.length = 8;
  values.length = 1;
  assert.deepEqual(keys, [["0", "length", "01", "4294967295", metadata]]);
  stop();
});

test("truncation notices non-enumerable and sparse own indexes", () => {
  const raw = [];
  Object.defineProperty(raw, "4294967294", { value: "last index", configurable: true });
  const values = store(raw);
  const keys = [];
  const stop = effect(() => { keys.push(Reflect.ownKeys(values)); });
  values.length = 0;
  assert.deepEqual(keys, [["4294967294", "length"], ["length"]]);
  stop();
});

test("a rejected truncation notifies shape observers about indexes removed before failure", () => {
  const raw = ["zero", "fixed", "removed", "also removed"];
  Object.defineProperty(raw, "1", { configurable: false });
  const values = store(raw);
  const keys = [];
  const stop = effect(() => { keys.push(Object.keys(values)); });
  assert.equal(Reflect.set(values, "length", 0), false);
  assert.deepEqual(keys, [["0", "1", "2", "3"], ["0", "1"]]);
  assert.equal(Reflect.set(values, "length", 0), false);
  assert.deepEqual(keys, [["0", "1", "2", "3"], ["0", "1"]]);
  stop();
});

test("truncation settles keys, length, and cached values together in shared effects", () => {
  const values = store(["kept", "removed", "also removed"]);
  const snapshots = [];
  const stop = effect(() => {
    snapshots.push([Object.keys(values), values.length, values[1], values[2]]);
  });
  values.length = 1;
  assert.deepEqual(snapshots, [
    [["0", "1", "2"], 3, "removed", "also removed"],
    [["0"], 1, undefined, undefined],
  ]);
  batch(() => {
    values[1] = "replacement";
    values[2] = "temporary";
    values.length = 2;
  });
  assert.deepEqual(snapshots.at(-1), [["0", "1"], 2, "replacement", undefined]);
  assert.equal(snapshots.length, 3);
  stop();
});
