import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../../scripts/compiler.mjs";
export { h, render } from "../../dist/dom.js";
export { renderToString } from "../../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-synth-improvements-"));
test.after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../../dist/", import.meta.url).href;
for (const filename of ["view.tsx", "synth-data.ts", "synth-audio.ts"]) {
  const source = (await readFile(new URL(`../../synth-site/src/${filename}`, import.meta.url), "utf8")).replaceAll("../vendor/", runtime);
  await writeFile(join(temporary, filename.replace(/\.tsx?$/u, ".js")), compile(source, { filename, sourceMap: false }));
}
const load = (name) => import(pathToFileURL(join(temporary, `${name}.js`)).href);
export const data = await load("synth-data");
export const { SynthView } = await load("view");
export const { createSynthAudio } = await load("synth-audio");
export const patternDocument = () => ({ version: 1, name: "Neon Pulse", bpm: 112, swing: 8, master: 0.78, pattern: data.patternFromPreset("Neon Pulse"), volumes: data.TRACKS.map(() => 0.82) });
export const settled = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

// Use the established minimal browser fixture with the actual Clank renderer.
const fixture = await readFile(new URL("../design-specimen-reset.test.mjs", import.meta.url), "utf8");
const start = fixture.indexOf("class EventTarget {");
const end = fixture.indexOf("function specimen(");
assert.ok(start >= 0 && end > start);
const shared = new Function("assert", `${fixture.slice(start, end)}\nreturn { browser, descendants, Element };`)(assert);
export const descendants = shared.descendants;
export const elements = (root) => descendants(root).filter((node) => node.nodeType === 1);
const closest = shared.Element.prototype.closest;
shared.Element.prototype.closest = function (selector) {
  if (selector === ".step-grid" && this.getAttribute("class")?.split(/\s/u).includes("step-grid")) return this;
  if (selector.startsWith("button, input,") && ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A", "SUMMARY"].includes(this.tagName)) return this;
  return closest.call(this, selector);
};
shared.Element.prototype.querySelector = function (selector) {
  const step = /^\[data-step-index="(\d+)"\]$/u.exec(selector)?.[1];
  return elements(this).find((node) => step !== undefined && node.getAttribute("data-step-index") === step) ?? null;
};
shared.Element.prototype.scrollIntoView = function (options) { this.scrolled = options; };
export function browser(t, stored = null, audio = audioFixture()) {
  const f = shared.browser(t);
  const values = new Map(stored === null ? [] : [[data.STORAGE_KEY, stored]]);
  f.view.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  Object.assign(f.view, audio.host);
  return { ...f, values, audio };
}
export function control(root, name) {
  const result = elements(root).find((node) => node.getAttribute("aria-label") === name);
  assert.ok(result, `Missing control: ${name}`);
  return result;
}
export function step(root, index) {
  return elements(root).find((node) => node.getAttribute("data-step-index") === String(index));
}
export function audioFixture({ suspended = false, deferResume = false } = {}) {
  const timers = new Map(), intervals = new Map(), contexts = [];
  let serial = 0; const resumeResolvers = [];
  class Parameter {
    value = 0; calls = [];
    setValueAtTime(...args) { this.calls.push(["value", ...args]); this.value = args[0]; }
    exponentialRampToValueAtTime(...args) { this.calls.push(["ramp", ...args]); }
    setTargetAtTime(...args) { this.calls.push(["target", ...args]); this.value = args[0]; }
  }
  class Node {
    gain = new Parameter(); frequency = new Parameter(); disconnected = false; stops = []; starts = []; onended = null;
    connect(next) { return next; }
    disconnect() { this.disconnected = true; }
    start(time) { this.starts.push(time); }
    stop(time) { this.stops.push(time); }
  }
  class Context {
    currentTime = 0; sampleRate = 8; state = suspended ? "suspended" : "running"; nodes = []; gains = []; closeCalls = 0;
    destination = new Node();
    constructor() { contexts.push(this); }
    createGain() { const node = new Node(); this.nodes.push(node); this.gains.push(node); return node; }
    createOscillator() { const node = new Node(); this.nodes.push(node); return node; }
    createBufferSource() { const node = new Node(); this.nodes.push(node); return node; }
    createBiquadFilter() { const node = new Node(); this.nodes.push(node); return node; }
    createBuffer() { return { getChannelData: () => new Float32Array(4) }; }
    resume() {
      if (!deferResume) { this.state = "running"; return Promise.resolve(); }
      return new Promise((resolve) => { resumeResolvers.push(() => { this.state = "running"; resolve(); }); });
    }
    close() { this.closeCalls++; this.state = "closed"; return Promise.resolve(); }
  }
  const host = {
    AudioContext: Context,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { const id = ++serial; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  return { host, timers, intervals, contexts, resume: () => { for (const resolve of resumeResolvers.splice(0)) resolve(); }, run(id) { const timer = timers.get(id); timers.delete(id); timer?.callback(); } };
}
