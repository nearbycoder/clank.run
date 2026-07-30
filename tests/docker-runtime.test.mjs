import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("production image includes every local control-plane runtime import", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    readFile(new URL("Dockerfile", root), "utf8"),
    readFile(new URL("scripts/clank-platform.mjs", root), "utf8"),
  ]);
  const runtimeStart = dockerfile.indexOf(" AS runtime");
  assert.notEqual(runtimeStart, -1, "Dockerfile must contain a named runtime stage");
  const runtime = dockerfile.slice(runtimeStart);
  const imports = [...entrypoint.matchAll(/\bfrom\s+"\.\/([^"]+\.mjs)"/gu)]
    .map((match) => match[1]);
  assert.ok(imports.length > 0, "control-plane entrypoint must have local runtime imports");
  for (const imported of imports) {
    assert.match(
      runtime,
      new RegExp(`\\b${imported.replaceAll(".", "\\.")}\\b`, "u"),
      `runtime image must copy scripts/${imported}`,
    );
  }
});
