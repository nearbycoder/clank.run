import test from "node:test";
import assert from "node:assert/strict";
import { createSynthAudio, audioFixture, patternDocument, settled } from "./helpers/synth-fixture.mjs";
function engine(options = {}) {
  const fixture = audioFixture(options);
  const mix = { ...patternDocument(), muted: Array(6).fill(false), soloed: Array(6).fill(false) };
  const events = { playing: [], step: [], elapsed: [], ready: [], status: [] };
  const audio = createSynthAudio({ host: () => fixture.host, mix: () => mix,
    ...Object.fromEntries(Object.keys(events).map((key) => [`on${key[0].toUpperCase()}${key.slice(1)}`, (value) => events[key].push(value)])),
  });
  return { ...fixture, mix, events, audio };
}

test("073 audio remains lazy and applies current master level, including zero, at context creation and later updates", async () => {
  const f = engine();
  assert.equal(f.contexts.length, 0);
  f.audio.setVolume(0);
  await f.audio.unlock();
  assert.equal(f.contexts.length, 1);
  const master = f.contexts[0].gains[0]; assert.equal(master.gain.value, 0);
  f.audio.setVolume(.24); assert.deepEqual(master.gain.calls.at(-1), ["target", .24, 0, .015]);
  await f.audio.start(); assert.equal(f.contexts.length, 1); assert.equal(master.gain.value, .24);
  f.audio.dispose();
});

test("075 stop clears scheduler, visuals, elapsed work and every scheduled source; stale callbacks cannot advance a restarted run", async () => {
  const f = engine();
  await f.audio.start();
  assert.equal(f.events.playing.at(-1), true);
  assert.ok(f.timers.size >= 2); assert.equal(f.intervals.size, 1);
  const stale = [...f.timers.values()].map((entry) => entry.callback);
  const sources = f.contexts[0].nodes.filter((node) => node.starts.length);
  assert.ok(sources.length > 1);
  f.audio.stop();
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0); assert.equal(f.events.step.at(-1), -1);
  for (const source of sources) { assert.equal(source.stops.at(-1), 0); assert.equal(source.disconnected, true); }
  await f.audio.start();
  const count = f.events.step.length;
  for (const callback of stale) callback();
  assert.equal(f.events.step.length, count);
  const visual = [...f.timers].find(([, timer]) => timer.delay !== 25);
  f.run(visual[0]); assert.equal(f.events.step.at(-1), 0, "a new run starts from step 1");
  f.audio.dispose();
  assert.equal(f.contexts[0].closeCalls, 1); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.contexts[0].gains[0].disconnected, true);
  f.audio.dispose(); assert.equal(f.contexts[0].closeCalls, 1);
  await f.audio.start(); assert.equal(f.contexts.length, 1);
});

for (const action of ["stop", "dispose"]) test(`075 ${action} while audio resumes prevents deferred playback and callbacks`, async () => {
  const f = engine({ suspended: true, deferResume: true });
  const pending = f.audio.start();
  f.audio[action](); const count = JSON.stringify(f.events);
  f.resume(); await pending;
  assert.equal(JSON.stringify(f.events), count);
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.contexts[0].nodes.filter((node) => node.starts.length).length, 0);
  f.audio.dispose();
});

test("075 starting during enable and restarting during an old resume each resolve only the current request", async () => {
  const f = engine({ suspended: true, deferResume: true });
  const enabled = f.audio.unlock(); const start = f.audio.start();
  f.resume(); await Promise.all([enabled, start]);
  assert.equal(f.events.playing.at(-1), true);
  f.audio.dispose();
  const g = engine({ suspended: true, deferResume: true });
  const old = g.audio.start(); g.audio.stop(); const next = g.audio.start();
  g.resume(); await Promise.all([old, next]);
  assert.equal(g.events.playing.filter(Boolean).length, 1);
  assert.equal(g.intervals.size, 1); g.audio.dispose();
});

test("075 ended sources release their graph and throttled scheduling does not replay a backlog", async () => {
  const f = engine(); await f.audio.start();
  const ended = f.contexts[0].nodes.find((node) => node.starts.length);
  ended.onended(); assert.equal(ended.disconnected, true); assert.equal(ended.onended, null);
  f.contexts[0].currentTime = 600;
  const scheduler = [...f.timers].find(([, timer]) => timer.delay === 25);
  const before = f.contexts[0].nodes.length; f.run(scheduler[0]);
  assert.ok(f.contexts[0].nodes.length - before <= 18, "at most one lookahead window is queued");
  f.audio.dispose(); await settled();
});

test("073 scheduled voices honor silence, mute and solo rather than creating zero-level voices", async () => {
  const f = engine(); f.mix.volumes.fill(0); await f.audio.start();
  assert.equal(f.contexts[0].nodes.filter((node) => node.starts.length).length, 1, "only the silent unlock handshake"); f.audio.dispose();
  const g = engine(); g.mix.soloed[1] = true; await g.audio.start();
  assert.equal(g.contexts[0].nodes.filter((node) => node.starts.length).length, 1, "the soloed snare is empty on step 1"); g.audio.dispose();
});
