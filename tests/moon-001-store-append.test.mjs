import test from "node:test";
import assert from "node:assert/strict";
import { effect, store } from "../dist/core.js";

test("store index appends update cached length and its subscribers", () => {
  const values = store(["first"]);
  const lengths = [];
  const stop = effect(() => { lengths.push(values.length); });
  values[values.length] = "second";
  values[values.length] = "third";
  assert.equal(values.length, 3);
  assert.deepEqual(lengths, [1, 2, 3]);
  assert.equal(values[2], "third");
  stop();
});

test("store sparse index appends publish the native resulting length", () => {
  const values = store([]);
  const lengths = [];
  const stop = effect(() => { lengths.push(values.length); });
  values[7] = "eighth";
  assert.equal(values.length, 8);
  assert.deepEqual(lengths, [0, 8]);
  assert.equal(values[7], "eighth");
  stop();
});

test("filling an array hole or replacing an index does not invalidate length", () => {
  const values = store(new Array(3));
  const lengths = [];
  const stop = effect(() => { lengths.push(values.length); });
  values[1] = "filled";
  values[1] = "replaced";
  values.note = "metadata";
  assert.equal(values.length, 3);
  assert.deepEqual(lengths, [3]);
  assert.equal(values[1], "replaced");
  stop();
});

test("an index append settles value, length, and iteration before shared effects run", () => {
  const values = store(["first"]);
  const snapshots = [];
  const stop = effect(() => {
    snapshots.push([values.length, values[1], Object.keys(values).join(",")]);
  });
  values[1] = "second";
  assert.deepEqual(snapshots, [
    [1, undefined, "0"],
    [2, "second", "0,1"],
  ]);
  stop();
});
