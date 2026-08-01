import test from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "../vendor/index.js";
import { SynthView } from "../dist/view.js";

test("synth view server-renders a deterministic, hydrated sequencer", async () => {
  const first = await renderToString(SynthView({ frameworkVersion: "0.14.0" }));
  const second = await renderToString(SynthView({ frameworkVersion: "0.14.0" }));
  assert.equal(first, second);
  assert.match(first, /Program your own/gu);
  assert.match(first, /Build a loop/gu);
  assert.match(first, /Toggle Kick step 1/gu);
  assert.match(first, /Select a Clank design system theme/gu);
  assert.match(first, /data-clank-id="transport-play"/gu);
  assert.equal((first.match(/data-clank-id="step-/gu) ?? []).length, 96);
});
