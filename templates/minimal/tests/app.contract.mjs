import test from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "@clank.run/framework";
import { StarterView } from "../dist/view.js";

test("starter view server-renders deterministic hydration content", async () => {
  const first = await renderToString(StarterView());
  const second = await renderToString(StarterView());
  assert.equal(first, second);
  assert.match(first, /Clank starter/u);
  assert.match(first, /Server rendered, hydrated in place/u);
  assert.match(first, />0 clicks</u);
  assert.match(first, /data-clank-id="starter-counter"/u);
});
