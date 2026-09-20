import test from "node:test";
import assert from "node:assert/strict";
import { data, patternDocument } from "./helpers/synth-fixture.mjs";
const stored = (changes = {}) => JSON.stringify({ ...patternDocument(), preset: "Neon Pulse", theme: "clank", ...changes });

test("072 storage preserves valid zero values and independently rejects invalid numeric metadata and enums", () => {
  const value = data.readStoredState(stored({ swing: 0, master: 0, volumes: [0, 1, .2, .3, .4, .5] }));
  assert.equal(value.swing, 0); assert.equal(value.master, 0); assert.equal(value.volumes[0], 0);
  for (const invalid of [null, "120", false, -1, 1e300]) {
    const result = data.readStoredState(stored({ bpm: invalid, swing: invalid, master: invalid }));
    assert.equal(result.bpm, undefined); assert.equal(result.swing, undefined); assert.equal(result.master, undefined);
  }
  const invalid = data.readStoredState(stored({ preset: "constructor", theme: "invented", volumes: [0, 1, 0, 0, null, 0] }));
  assert.equal(invalid.preset, undefined); assert.equal(invalid.theme, undefined); assert.equal(invalid.volumes, undefined);
  assert.equal(data.readStoredState(stored().replace('"bpm":112', '"bpm":1e999')).bpm, undefined);
});

test("072 malformed, oversized, incomplete, nonbinary and prototype-shaped stored patterns are rejected", () => {
  for (const value of [null, "", "{", "[]", "null", "x".repeat(16385), '{"pattern":{}}']) assert.equal(data.readStoredState(value), null);
  for (const step of [true, false, "1", null, 2, -1, {}, []]) {
    const value = patternDocument(); value.pattern[0][0] = step;
    assert.equal(data.readStoredState(stored({ pattern: value.pattern })), null);
  }
  const value = patternDocument(); value.pattern[2].pop();
  assert.equal(data.readStoredState(stored({ pattern: value.pattern })), null);
  assert.deepEqual(data.patternFromPreset("__proto__"), data.patternFromPreset("Neon Pulse"));
});

test("076 imports the existing version 1 export with strict bounded fields and no arbitrary properties", () => {
  const value = patternDocument(); value.swing = 0; value.master = 0;
  assert.deepEqual(data.importPattern(JSON.stringify({ ...value, unexpected: "discarded" })), value);
  for (const changes of [{ version: 2 }, { version: "1" }, { name: "constructor" }, { bpm: 59 }, { bpm: 181 }, { swing: 41 }, { master: -1 }, { volumes: [1] }, { pattern: [] }]) {
    assert.throws(() => data.importPattern(JSON.stringify({ ...value, ...changes })));
  }
  assert.throws(() => data.importPattern('{"version":1,"bpm":1e999}'));
  assert.throws(() => data.importPattern("not json"), /valid JSON/u);
  assert.throws(() => data.importPattern(JSON.stringify({ ...value, extra: "é".repeat(9000) })), /16 KB/u);
});

test("077 history is bounded, clones snapshots, ignores identical states, and clears redo after a new edit", () => {
  const history = data.createPatternHistory(3);
  let current = patternDocument();
  for (let index = 0; index < 6; index++) {
    const next = { ...current, bpm: current.bpm + 1 };
    assert.equal(history.record(current, next), true); current = next;
  }
  current.pattern[0][0] = 0;
  const previous = history.undo(current);
  assert.equal(previous.bpm, 117); assert.equal(previous.pattern[0][0], 1);
  assert.equal(history.canRedo, true);
  const restored = history.redo(previous); assert.equal(restored.bpm, 118);
  assert.equal(history.record(restored, restored), false); assert.equal(history.canRedo, false);
  current = history.undo(restored);
  assert.equal(history.record(current, { ...current, name: "Custom" }), true); assert.equal(history.canRedo, false);
  let count = 0; while ((current = history.undo(current))) count++;
  assert.equal(count, 3); assert.equal(history.canUndo, false);
});

test("078/079 track clear and rotations preserve six 16-step rows, immutable source, wraparound and other tracks", () => {
  const original = patternDocument().pattern; const before = JSON.stringify(original);
  for (let track = 0; track < 6; track++) {
    const cleared = data.editTrack(original, track, "clear");
    assert.deepEqual(cleared[track], Array(16).fill(0));
    assert.notEqual(cleared[track], original[track]);
    for (let other = 0; other < 6; other++) if (other !== track) assert.equal(cleared[other], original[other]);
    const right = data.editTrack(original, track, "right");
    assert.equal(right[track][0], original[track][15]);
    assert.deepEqual(data.editTrack(right, track, "left"), original);
  }
  assert.equal(JSON.stringify(original), before);
});

test("080 tap tempo averages a bounded recent interval window, resets long pauses, ignores bounce, clamps tempo", () => {
  const tap = data.createTapTempo();
  assert.equal(tap(0), null); assert.equal(tap(500), 120); assert.equal(tap(1000), 120);
  assert.equal(tap(1001), null); assert.equal(tap(1500), 120);
  assert.equal(tap(4000), null); assert.equal(tap(5500), 60);
  assert.equal(tap(9000), null); assert.equal(tap(9200), 180);
  for (let time = 9700; time <= 11700; time += 500) tap(time);
  assert.equal(tap(12200), 120, "old fast taps leave the five-interval window");
  assert.equal(tap(NaN), null); assert.equal(tap(Infinity), null);
});

test("074 transport shortcut ignores controls, editable descendants, composition, repeats, prevented keys and modifiers", () => {
  const key = { code: "Space", target: { closest: () => null } };
  assert.equal(data.isTransportShortcut(key), true);
  for (const property of ["repeat", "isComposing", "defaultPrevented", "altKey", "ctrlKey", "metaKey", "shiftKey"]) assert.equal(data.isTransportShortcut({ ...key, [property]: true }), false);
  assert.equal(data.isTransportShortcut({ ...key, code: "Enter" }), false);
  assert.equal(data.isTransportShortcut({ ...key, target: { isContentEditable: true } }), false);
  assert.equal(data.isTransportShortcut({ ...key, target: { closest: () => ({}) } }), false);
});

test("081 step navigation is bounded, respects row Home/End and supports whole-grid endpoints", () => {
  assert.deepEqual(data.stepDestination("ArrowLeft", 0, 0), { track: 0, step: 0 });
  assert.deepEqual(data.stepDestination("ArrowUp", 0, 0), { track: 0, step: 0 });
  assert.deepEqual(data.stepDestination("ArrowDown", 5, 15), { track: 5, step: 15 });
  assert.deepEqual(data.stepDestination("ArrowRight", 5, 15), { track: 5, step: 15 });
  assert.deepEqual(data.stepDestination("Home", 3, 8), { track: 3, step: 0 });
  assert.deepEqual(data.stepDestination("End", 3, 8), { track: 3, step: 15 });
  assert.deepEqual(data.stepDestination("Home", 3, 8, true), { track: 0, step: 0 });
  assert.deepEqual(data.stepDestination("End", 3, 8, true), { track: 5, step: 15 });
});
