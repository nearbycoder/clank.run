import test from "node:test";
import assert from "node:assert/strict";
import { effect, store, toRaw } from "../dist/core.js";

test("array truncation refreshes cached indexes before shared effects run", () => {
  const values = store(["kept", "removed", { name: "removed object" }]);
  const snapshots = [];
  const stop = effect(() => {
    snapshots.push([values.length, values[0], values[1], values[2]?.name]);
  });
  values.length = 1;
  assert.deepEqual(snapshots, [
    [3, "kept", "removed", "removed object"],
    [1, "kept", undefined, undefined],
  ]);
  assert.equal(values[1], undefined);
  assert.equal(values[2], undefined);
  assert.deepEqual(toRaw(values), ["kept"]);
  stop();
});

test("array length uses its native numeric value after coercion", () => {
  const values = store(["kept", "removed"]);
  const snapshots = [];
  const stop = effect(() => { snapshots.push([values.length, values[1]]); });
  assert.equal(Reflect.set(values, "length", "1"), true);
  assert.equal(values.length, 1);
  assert.deepEqual(snapshots, [[2, "removed"], [1, undefined]]);
  stop();
});

test("truncation preserves retained indexes, non-index keys, and unchanged holes", () => {
  const metadata = Symbol("metadata");
  const raw = ["zero", "one", "two", , "four"];
  Object.assign(raw, { "01": "leading zero", "1.5": "fraction", "-0": "negative zero" });
  raw[metadata] = "symbol";
  const values = store(raw);
  const retained = [];
  const removed = [];
  const holes = [];
  const stopRetained = effect(() => {
    retained.push([values[1], values["01"], values["1.5"], values["-0"], values[metadata]]);
  });
  const stopRemoved = effect(() => { removed.push(values[2]); });
  const stopHoles = effect(() => { holes.push(values[3]); });
  values.length = 2;
  values.length = 5;
  values.length = 5;
  assert.deepEqual(retained, [["one", "leading zero", "fraction", "negative zero", "symbol"]]);
  assert.deepEqual(removed, ["two", undefined]);
  assert.deepEqual(holes, [undefined]);
  assert.equal(values[2], undefined);
  stopRetained();
  stopRemoved();
  stopHoles();
});

test("truncation handles the highest array index without invalidating ordinary numeric keys", () => {
  const raw = [];
  raw[4_294_967_294] = "last index";
  raw[4_294_967_295] = "ordinary property";
  const values = store(raw);
  const lastIndex = [];
  const ordinaryProperty = [];
  const stopIndex = effect(() => { lastIndex.push(values[4_294_967_294]); });
  const stopProperty = effect(() => { ordinaryProperty.push(values[4_294_967_295]); });
  values.length = 0;
  assert.deepEqual(lastIndex, ["last index", undefined]);
  assert.deepEqual(ordinaryProperty, ["ordinary property"]);
  stopIndex();
  stopProperty();
});

test("truncation exposes inherited values when cached own indexes are removed", () => {
  const prototype = Object.create(Array.prototype);
  const fallback = () => "inherited";
  Object.defineProperty(prototype, "1", { value: fallback, writable: true, configurable: true });
  const raw = ["kept", "own"];
  Object.setPrototypeOf(raw, prototype);
  const values = store(raw);
  const snapshots = [];
  const stop = effect(() => { snapshots.push(values[1]); });
  values.length = 1;
  assert.deepEqual(snapshots, ["own", fallback]);
  assert.equal(values[1], fallback);
  stop();
});

test("invalid and non-writable length writes preserve cached values and effects", () => {
  const raw = ["first", "second"];
  const values = store(raw);
  const snapshots = [];
  const stop = effect(() => { snapshots.push([values.length, values[1]]); });
  for (const length of [-1, 1.5, 4_294_967_296, NaN]) {
    assert.throws(() => Reflect.set(values, "length", length), RangeError);
  }
  Object.defineProperty(raw, "length", { writable: false });
  assert.equal(Reflect.set(values, "length", 0), false);
  assert.equal(values.length, 2);
  assert.equal(values[1], "second");
  assert.deepEqual(snapshots, [[2, "second"]]);
  stop();
});

test("a rejected truncation publishes the actual length and indexes removed before failure", () => {
  const raw = ["zero", "one", "fixed", "three", "four"];
  Object.defineProperty(raw, "2", { configurable: false });
  const values = store(raw);
  const snapshots = [];
  const stop = effect(() => {
    snapshots.push([values.length, values[1], values[2], values[3], values[4]]);
  });
  assert.equal(Reflect.set(values, "length", 1), false);
  assert.equal(values.length, 3);
  assert.deepEqual(snapshots, [
    [5, "one", "fixed", "three", "four"],
    [3, "one", "fixed", undefined, undefined],
  ]);
  assert.equal(values[3], undefined);
  assert.equal(values[4], undefined);
  stop();
});
