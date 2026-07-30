import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("production image includes every local control-plane runtime import", async () => {
  const [dockerfile, entrypoint, railway] = await Promise.all([
    readFile(new URL("Dockerfile", root), "utf8"),
    readFile(new URL("scripts/clank-platform.mjs", root), "utf8"),
    readFile(new URL("railway.json", root), "utf8").then(JSON.parse),
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
  const preDeploy = railway.deploy?.preDeployCommand;
  assert.equal(typeof preDeploy, "string", "Railway must preflight the built runtime image");
  const runtimeImports = [...entrypoint.matchAll(/\bfrom\s+"((?:\.\.\/dist|\.\/)[^"]+)"/gu)]
    .map((match) => match[1].startsWith("../dist/")
      ? `./dist/${match[1].slice("../dist/".length)}`
      : `./scripts/${match[1].slice(2)}`);
  for (const imported of runtimeImports) {
    assert.ok(
      preDeploy.includes(`import('${imported}')`),
      `Railway pre-deploy must import ${imported} before mounting persistent state`,
    );
  }
});
