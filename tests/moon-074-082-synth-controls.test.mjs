import test from "node:test";
import assert from "node:assert/strict";
import { data, SynthView, h, render, renderToString, browser, control, step, elements, patternDocument, audioFixture, settled } from "./helpers/synth-fixture.mjs";
function mount(t, stored = null, audio) {
  const f = browser(t, stored, audio);
  const root = f.document.createElement("main"); f.document.body.append(root);
  const dispose = render(root, h(SynthView, { frameworkVersion: "test" })); f.onDispose(dispose);
  return { ...f, root, dispose, saved: () => JSON.parse(f.values.get(data.STORAGE_KEY)) };
}
function fire(node, name, details = {}) {
  const event = { target: node, currentTarget: node, defaultPrevented: false, prevented: 0,
    preventDefault() { this.defaultPrevented = true; this.prevented++; }, stopPropagation() { this.stopped = true; }, ...details };
  for (const callback of [...(node.listeners.get(name) ?? [])]) callback(event);
  return event;
}
function agent(root, id) { const node = elements(root).find((entry) => entry.getAttribute("data-clank-id") === id); assert.ok(node); return node; }
function input(root, label, value) { const node = control(root, label); node.value = String(value); fire(node, "input"); }
async function importFile(root, file) { const node = control(root, "Import pattern JSON"); node.files = [file]; fire(node, "change"); await settled(); return node; }
const exported = (value) => ({ size: JSON.stringify(value).length, text: async () => JSON.stringify(value) });

test("072–082 SSR remains deterministic with 96 pressed steps, one tab stop and useful new controls", async () => {
  const first = await renderToString(h(SynthView, { frameworkVersion: "test" }));
  assert.equal(first, await renderToString(h(SynthView, { frameworkVersion: "test" })));
  assert.equal((first.match(/data-clank-id="step-/gu) ?? []).length, 96);
  assert.equal((first.match(/tabindex="0"/giu) ?? []).length, 1);
  for (const name of ["Undo pattern edit", "Redo pattern edit", "Import pattern JSON", "Tap tempo", "Reset all mix levels, mutes, and solos", "Rotate Kick left one step", "Clear Lead steps"]) assert.ok(first.includes(name), name);
  assert.ok(first.includes("Audio is off"));
});

test("072/073 real controls preserve saved zero swing and master and update the actual lazy audio gain", async (t) => {
  const f = mount(t, JSON.stringify({ ...patternDocument(), preset: "Custom", theme: "clank", swing: 0, master: 0 }));
  assert.equal(Number(control(f.root, "Swing percentage").value), 0);
  assert.equal(Number(control(f.root, "Master volume").value), 0);
  assert.equal(f.audio.contexts.length, 0);
  input(f.root, "Master volume", .35);
  fire(agent(f.root, "audio-enable"), "click"); await settled();
  assert.equal(f.audio.contexts[0].gains[0].gain.value, .35);
  input(f.root, "Master volume", .6);
  assert.equal(f.audio.contexts[0].gains[0].gain.value, .6);
});

test("074/075 window shortcut respects real nested controls, starts only body Space and removes handlers on disposal", async (t) => {
  const f = mount(t);
  const space = { key: " ", code: "Space" };
  for (const target of [agent(f.root, "transport-play"), control(f.root, "Tempo in beats per minute"), control(f.root, "Select a pattern preset"), step(f.root, 0).children[0]]) fire(f.view, "keydown", { ...space, target });
  fire(f.view, "keydown", { ...space, target: f.document.body, repeat: true });
  assert.equal(f.audio.contexts.length, 0);
  fire(f.view, "keydown", { ...space, target: f.document.body }); await settled();
  assert.equal(f.audio.contexts.length, 1); assert.ok(f.audio.timers.size);
  f.dispose(); assert.equal(f.audio.timers.size, 0); assert.equal(f.audio.intervals.size, 0);
  assert.equal(f.audio.contexts[0].closeCalls, 1); assert.equal(f.view.listenerCount(), 0);
  fire(f.view, "keydown", { ...space, target: f.document.body }); assert.equal(f.audio.timers.size, 0);
});

test("076 invalid and oversized imports leave state/history/audio untouched with useful inline error", async (t) => {
  const f = mount(t); const before = f.saved();
  let read = false;
  await importFile(f.root, { size: 16_385, text: async () => { read = true; return "{}"; } });
  assert.equal(read, false); assert.deepEqual(f.saved(), before);
  assert.match(f.root.textContent, /16 KB/u);
  await importFile(f.root, exported({ ...patternDocument(), pattern: [[1]] }));
  assert.deepEqual(f.saved(), before); assert.equal(control(f.root, "Undo pattern edit").hasAttribute("disabled"), true);
  assert.match(f.root.textContent, /six tracks of 16 steps/u); assert.equal(f.audio.contexts.length, 0);
});

test("076/077 valid import is atomic, stops playback, supports complete undo/redo and never autoplays", async (t) => {
  const f = mount(t); const original = f.saved();
  fire(agent(f.root, "transport-play"), "click"); await settled();
  const next = { ...patternDocument(), name: "Custom", bpm: 160, swing: 0, master: .4, volumes: [.1, .2, .3, .4, .5, .6], pattern: Array.from({ length: 6 }, () => Array(16).fill(0)) };
  const file = await importFile(f.root, exported(next));
  assert.equal(file.value, "");
  assert.deepEqual(f.saved(), { theme: "clank", preset: "Custom", bpm: 160, swing: 0, master: .4, volumes: next.volumes, pattern: next.pattern });
  assert.equal(f.audio.timers.size, 0); assert.equal(f.audio.intervals.size, 0);
  assert.equal(control(f.root, "Undo pattern edit").hasAttribute("disabled"), false);
  fire(control(f.root, "Undo pattern edit"), "click"); assert.deepEqual(f.saved(), original);
  fire(control(f.root, "Redo pattern edit"), "click"); assert.equal(f.saved().bpm, 160); assert.deepEqual(f.saved().pattern, next.pattern);
  assert.equal(f.audio.timers.size, 0); assert.equal(f.audio.contexts.length, 1);
});

test("076 delayed imports cannot overwrite intervening edits or update a disposed view", async (t) => {
  const f = mount(t); let resolve;
  await importFile(f.root, { size: 100, text: () => new Promise((done) => { resolve = done; }) });
  fire(step(f.root, 0), "click"); const edited = f.saved();
  resolve(JSON.stringify({ ...patternDocument(), bpm: 180 })); await settled();
  assert.deepEqual(f.saved(), edited); assert.match(f.root.textContent, /changed while loading/u);
  await importFile(f.root, { size: 100, text: () => new Promise((done) => { resolve = done; }) });
  f.dispose(); resolve(JSON.stringify(patternDocument())); await settled();
  assert.deepEqual(f.saved(), edited); assert.equal(f.audio.contexts.length, 0);
});

test("076 delayed imports reject every intervening tempo or mix edit while transport ticks remain harmless", async (t) => {
  const edits = [
    ["tempo", (f) => input(f.root, "Tempo in beats per minute", 150)],
    ["swing", (f) => input(f.root, "Swing percentage", 25)],
    ["master", (f) => input(f.root, "Master volume", .25)],
    ...data.TRACKS.map((track) => [`${track.name} level`, (f) => input(f.root, `${track.name} volume`, .2)]),
    ["mute", (f) => fire(control(f.root, "Mute Kick"), "click")],
    ["solo", (f) => fire(control(f.root, "Solo Lead"), "click")],
    ["reset mix", (f) => fire(control(f.root, "Reset all mix levels, mutes, and solos"), "click")],
    ["tap tempo", (f, t) => {
      let now = 100;
      const previous = Object.getOwnPropertyDescriptor(globalThis, "performance");
      Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
      t.after(() => Object.defineProperty(globalThis, "performance", previous));
      fire(control(f.root, "Tap tempo"), "click"); now += 500; fire(control(f.root, "Tap tempo"), "click");
    }],
  ];
  for (const [name, edit] of edits) await t.test(name, async (t) => {
    const f = mount(t); let resolve;
    if (name === "reset mix") input(f.root, "Master volume", .1);
    await importFile(f.root, { size: 100, text: () => new Promise((done) => { resolve = done; }) });
    edit(f, t); const changed = f.saved();
    resolve(JSON.stringify({ ...patternDocument(), bpm: 90, master: .9 })); await settled();
    assert.deepEqual(f.saved(), changed);
    assert.match(f.root.textContent, /changed while loading/u);
  });
  await t.test("transport ticks", async (t) => {
    const f = mount(t); let resolve;
    await importFile(f.root, { size: 100, text: () => new Promise((done) => { resolve = done; }) });
    fire(agent(f.root, "transport-play"), "click"); await settled();
    f.audio.contexts[0].currentTime = .06;
    for (const id of [...f.audio.timers.keys()]) f.audio.run(id);
    for (const { callback } of f.audio.intervals.values()) callback();
    resolve(JSON.stringify({ ...patternDocument(), bpm: 90 })); await settled();
    assert.equal(f.saved().bpm, 90);
    assert.doesNotMatch(f.root.textContent, /changed while loading/u);
    assert.equal(f.audio.timers.size, 0);
  });
});

test("075 transport starts on activation so a canceled pointer cannot swallow the following Stop", async (t) => {
  const f = mount(t);
  const play = agent(f.root, "transport-play");
  fire(play, "pointerdown");
  await settled();
  assert.equal(f.audio.contexts.length, 0, "Pressing and releasing outside the button leaves the audio gate stable");
  fire(play, "pointercancel");
  fire(play, "click");
  assert.equal(f.audio.contexts.length, 1, "The click begins audio unlock within its user activation");
  await settled();
  assert.ok(f.audio.timers.size);
  fire(play, "pointerdown");
  fire(play, "click"); await settled();
  assert.equal(f.audio.timers.size, 0);
  assert.equal(f.audio.intervals.size, 0);
  assert.equal(play.getAttribute("data-clank-label"), "Play the synth");
});

test("077–079 every track clear/rotation is undoable; a new edit drops redo; audio ticks do not add history", async (t) => {
  const f = mount(t); const original = f.saved().pattern;
  fire(agent(f.root, "transport-play"), "click"); await settled();
  for (const id of [...f.audio.timers.keys()]) f.audio.run(id);
  assert.equal(control(f.root, "Undo pattern edit").hasAttribute("disabled"), true);
  fire(agent(f.root, "transport-play"), "click");
  for (let index = 0; index < 6; index++) {
    const track = data.TRACKS[index];
    fire(control(f.root, `Clear ${track.name} steps`), "click");
    assert.deepEqual(f.saved().pattern[index], Array(16).fill(0));
    fire(control(f.root, "Undo pattern edit"), "click"); assert.deepEqual(f.saved().pattern, original);
    fire(control(f.root, `Rotate ${track.name} right one step`), "click");
    assert.deepEqual(f.saved().pattern[index], [original[index][15], ...original[index].slice(0, -1)]);
    assert.equal(control(f.root, "Redo pattern edit").hasAttribute("disabled"), true);
    fire(control(f.root, "Undo pattern edit"), "click"); assert.deepEqual(f.saved().pattern, original);
  }
  assert.equal(f.audio.timers.size, 0);
});

test("080 tap tempo updates the real tempo control without starting audio", (t) => {
  const f = mount(t); let now = 0;
  const prior = Object.getOwnPropertyDescriptor(globalThis, "performance");
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
  t.after(() => Object.defineProperty(globalThis, "performance", prior));
  fire(control(f.root, "Tap tempo"), "click"); now = 500; fire(control(f.root, "Tap tempo"), "click");
  assert.equal(Number(control(f.root, "Tempo in beats per minute").value), 120);
  assert.equal(f.audio.contexts.length, 0);
});

test("081 roving step keys focus and scroll the correct cell; Enter/Space toggle once without transport", (t) => {
  const f = mount(t);
  let current = step(f.root, 0);
  for (const [key, index] of [["ArrowRight", 1], ["ArrowDown", 17], ["End", 31], ["Home", 16]]) {
    fire(current, "keydown", { key }); current = step(f.root, index);
    assert.equal(f.document.activeElement, current); assert.equal(current.tabIndex, 0);
    assert.equal(elements(f.root).filter((node) => node.getAttribute("data-step-index") !== null && node.tabIndex === 0).length, 1);
    assert.deepEqual(current.scrolled, { block: "nearest", inline: "nearest" });
  }
  const before = current.getAttribute("aria-pressed");
  const event = fire(current, "keydown", { key: " ", code: "Space" });
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.notEqual(current.getAttribute("aria-pressed"), before);
  fire(f.view, "keydown", event); assert.equal(f.audio.contexts.length, 0);
  fire(current, "keydown", { key: " ", code: "Space", repeat: true }); assert.notEqual(current.getAttribute("aria-pressed"), before);
  fire(current, "keydown", { key: "Enter", code: "Enter" }); assert.equal(current.getAttribute("aria-pressed"), before);
});

test("082 reset mix restores all six levels, mute/solo pressed states and actual master while preserving tempo/pattern", async (t) => {
  const f = mount(t);
  input(f.root, "Tempo in beats per minute", 141); input(f.root, "Swing percentage", 0);
  fire(step(f.root, 1), "click"); const original = f.saved().pattern;
  for (const track of data.TRACKS) {
    input(f.root, `${track.name} volume`, .15); fire(control(f.root, `Mute ${track.name}`), "click"); fire(control(f.root, `Solo ${track.name}`), "click");
    assert.equal(control(f.root, `Unmute ${track.name}`).getAttribute("aria-pressed"), "true");
    assert.equal(control(f.root, `Unsolo ${track.name}`).getAttribute("aria-pressed"), "true");
  }
  input(f.root, "Master volume", .25); fire(agent(f.root, "audio-enable"), "click"); await settled();
  fire(control(f.root, "Reset all mix levels, mutes, and solos"), "click");
  for (const track of data.TRACKS) {
    assert.equal(Number(control(f.root, `${track.name} volume`).value), .82);
    assert.equal(control(f.root, `Mute ${track.name}`).getAttribute("aria-pressed"), "false");
    assert.equal(control(f.root, `Solo ${track.name}`).getAttribute("aria-pressed"), "false");
  }
  assert.equal(f.saved().master, .78); assert.equal(f.audio.contexts[0].gains[0].gain.value, .78);
  assert.equal(f.saved().bpm, 141); assert.equal(f.saved().swing, 0); assert.deepEqual(f.saved().pattern, original);
  assert.equal(f.audio.timers.size, 0);
});

test("075 disposing the real view during a pending audio resume cannot start playback later", async (t) => {
  const audio = audioFixture({ suspended: true, deferResume: true });
  const f = mount(t, null, audio);
  fire(agent(f.root, "transport-play"), "click"); f.dispose(); audio.resume(); await settled();
  assert.equal(audio.timers.size, 0); assert.equal(audio.intervals.size, 0); assert.equal(audio.contexts[0].closeCalls, 1);
  assert.equal(f.view.listenerCount(), 0);
});

test("076 Copy JSON retains all existing export fields and round-trips through the importer", async (t) => {
  const f = mount(t); let copied;
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { async writeText(value) { copied = value; } } } });
  t.after(() => prior ? Object.defineProperty(globalThis, "navigator", prior) : delete globalThis.navigator);
  input(f.root, "Swing percentage", 0); input(f.root, "Master volume", .45);
  fire(control(f.root, "Copy pattern JSON"), "click"); await settled();
  const value = data.importPattern(copied);
  assert.equal(value.version, 1); assert.equal(value.swing, 0); assert.equal(value.master, .45);
  assert.deepEqual(value.pattern, f.saved().pattern); assert.equal(value.volumes.length, 6);
  assert.match(f.root.textContent, /Pattern copied/u);
});
