import test from "node:test";
import assert from "node:assert/strict";
import {
  batch,
  computed,
  createRoot,
  effect,
  onCleanup,
  resource,
  signal,
  snapshot,
  store,
  transaction,
  untrack,
} from "../dist/core.js";

test("signals and computed values update effects synchronously", () => {
  const count = signal(2);
  const doubled = computed(() => count.value * 2);
  const seen = [];
  const stop = effect(() => { seen.push(doubled.value); });
  count.value = 3;
  count.update((value) => value + 1);
  assert.deepEqual(seen, [4, 6, 8]);
  stop();
  count.value = 10;
  assert.deepEqual(seen, [4, 6, 8]);
});

test("batch coalesces effects and transactions roll back atomically", () => {
  const left = signal(1);
  const right = signal(2);
  const totals = [];
  effect(() => totals.push(left.value + right.value));
  batch(() => {
    left.value = 10;
    right.value = 20;
  });
  assert.deepEqual(totals, [3, 30]);
  assert.throws(() => transaction(() => {
    left.value = 100;
    right.value = 200;
    throw new Error("cancel");
  }), /cancel/);
  assert.equal(left.value, 10);
  assert.equal(right.value, 20);
  assert.deepEqual(totals, [3, 30, 30]);
});

test("untrack reads without creating dependencies", () => {
  const tracked = signal(1);
  const ignored = signal(2);
  let runs = 0;
  effect(() => {
    tracked.value;
    untrack(() => ignored.value);
    runs++;
  });
  ignored.value = 3;
  assert.equal(runs, 1);
  tracked.value = 2;
  assert.equal(runs, 2);
});

test("computed peek stays untracked by callers while retaining its own dependencies", () => {
  const source = signal(2);
  const doubled = computed(() => source.value * 2);
  assert.equal(doubled.peek(), 4);
  source.value = 3;
  assert.equal(doubled.peek(), 6);

  let runs = 0;
  const stop = effect(() => {
    runs++;
    doubled.peek();
  });
  source.value = 4;
  assert.equal(runs, 1, "peek must not subscribe the surrounding effect");
  assert.equal(doubled.peek(), 8);
  stop();
});

test("stores track nested properties and produce plain snapshots", () => {
  const state = store({ user: { name: "Ada" }, tags: ["math"] });
  const names = [];
  effect(() => names.push(state.user.name));
  state.user.name = "Grace";
  state.tags.push("compiler");
  assert.deepEqual(names, ["Ada", "Grace"]);
  assert.deepEqual(snapshot(state), { user: { name: "Grace" }, tags: ["math", "compiler"] });
});

test("roots dispose their effects and cleanup callbacks", () => {
  const value = signal(0);
  let runs = 0;
  let cleaned = false;
  let dispose;
  createRoot((stop) => {
    dispose = stop;
    effect(() => { value.value; runs++; });
    onCleanup(() => { cleaned = true; });
  });
  value.value++;
  dispose();
  value.value++;
  assert.equal(runs, 2);
  assert.equal(cleaned, true);
});

test("failed roots clean up immediately and snapshots do not mutate object prototypes", () => {
  const value = signal(0);
  let runs = 0;
  let cleaned = false;
  assert.throws(() => createRoot(() => {
    effect(() => { value.value; runs++; });
    onCleanup(() => { cleaned = true; });
    throw new Error("root failed");
  }), /root failed/);
  value.value++;
  assert.equal(runs, 1);
  assert.equal(cleaned, true);

  const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  const output = snapshot(store(input));
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(output.__proto__, { polluted: true });
  assert.equal(output.safe, 1);
});

test("resources ignore stale async results", async () => {
  const resolvers = [];
  const result = resource((parameter) => new Promise((resolve) => resolvers.push([parameter, resolve])), { immediate: false });
  const first = result.reload("first");
  const second = result.reload("second");
  resolvers[1][1]("new");
  await second;
  resolvers[0][1]("old");
  await first;
  assert.equal(result.data.value, "new");
  assert.equal(result.status.value, "ready");
});
