import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { serve } from "../dist/node.js";
import { loadBundledDocumentation, routeBundledDocumentation } from "../scripts/platform-documentation.mjs";

const execFileAsync = promisify(execFile);
const publicUrl = "https://clank.run";
const environment = Object.freeze({ CLANK_DOCUMENTATION_HOST: "docs.clank.run" });

function handlers() {
  const calls = [];
  const platform = { handle(request) { calls.push(["platform", request]); return new Response("platform"); } };
  const app = { handle(request) { calls.push(["docs", request]); return new Response("docs"); } };
  return { calls, platform, app };
}

test("bundled documentation is opt-in and leaves the default platform handler unchanged", async () => {
  const { platform } = handlers();
  const disabled = await loadBundledDocumentation({}, publicUrl, () => assert.fail("Disabled docs must not load"));
  assert.equal(disabled, null);
  assert.equal(routeBundledDocumentation(platform, disabled), platform);
});

test("bundled documentation validates one hostname and prevents masking the platform", async () => {
  for (const host of ["", " docs.clank.run", "docs.clank.run ", "https://docs.clank.run", "docs.clank.run:443",
    "docs.clank.run/path", "*.clank.run", "docs.clank.run,other.example", "docs.clank.run\nother.example",
    "docs..clank.run", "docs.clank.run.", "-docs.clank.run", "docs-.clank.run", "docs_clank.run",
    "doſ.clank.run", "K.clank.run", "a".repeat(64) + ".run", Array(5).fill("a".repeat(63)).join(".")]) {
    await assert.rejects(loadBundledDocumentation({ CLANK_DOCUMENTATION_HOST: host }, publicUrl,
      () => assert.fail(`Invalid host must not load: ${host}`)), /one exact hostname/u);
  }
  await assert.rejects(loadBundledDocumentation({ CLANK_DOCUMENTATION_HOST: "CLANK.RUN" }, publicUrl,
    () => assert.fail("Platform collision must not load")), /must differ/u);
  const { app } = handlers();
  const enabled = await loadBundledDocumentation({ CLANK_DOCUMENTATION_HOST: "DOCS.CLANK.RUN" }, publicUrl, async () => ({ app }));
  assert.equal(enabled.hostname, "docs.clank.run");
  assert.ok(Object.isFrozen(enabled));
});

test("a package without the optional bundle works by default and fails clearly when enabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clank-optional-docs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "platform-documentation.mjs");
  await writeFile(file, await readFile(new URL("../scripts/platform-documentation.mjs", import.meta.url)));
  const isolated = await import(pathToFileURL(file).href);
  assert.equal(await isolated.loadBundledDocumentation({}, publicUrl), null);
  await assert.rejects(isolated.loadBundledDocumentation(environment, publicUrl), { code: "ERR_MODULE_NOT_FOUND" });
  await assert.rejects(loadBundledDocumentation(environment, publicUrl, async () => ({ app: {} })), /must export an app/u);
});

test("documentation routes only the exact URL hostname and preserves requests on both paths", async () => {
  const { calls, platform, app } = handlers();
  const documentation = await loadBundledDocumentation(environment, publicUrl, async () => ({ app }));
  const router = routeBundledDocumentation(platform, documentation);
  for (const [url, headers, expected] of [
    ["https://docs.clank.run/docs/getting-started?from=home", {}, "docs"],
    ["https://docs.clank.run/", { host: "DOCS.CLANK.RUN:443" }, "docs"],
    ["https://docs.clank.run/", { host: "docs.clank.run", "x-forwarded-host": "clank.run" }, "docs"],
    ["https://clank.run/", { "x-forwarded-host": "docs.clank.run" }, "platform"],
    ["https://app.apps.clank.run/", { "x-forwarded-host": "docs.clank.run" }, "platform"],
    ["https://preview.docs.clank.run/", {}, "platform"],
    ["https://docs.clank.run.evil.example/", {}, "platform"],
    ["https://docs.clank.run/", { host: "clank.run", "x-forwarded-host": "docs.clank.run" }, "platform"],
    ["https://docs.clank.run/", { host: "docs.clank.run:99999" }, "platform"],
    ["https://docs.clank.run/", { host: "docs.clank.run,other.example" }, "platform"],
    ["https://docs.clank.run/", { host: "docs.clank.run/path" }, "platform"],
  ]) {
    const request = new Request(url, { method: "POST", body: "unaltered body", headers });
    assert.equal(await (await router.handle(request)).text(), expected, url);
    assert.deepEqual(calls.at(-1), [expected, request]);
    assert.equal(await request.text(), "unaltered body");
  }
});

test("trusted proxy URL rewriting cannot select docs when the raw Host belongs to the platform", async (t) => {
  const { calls, platform, app } = handlers();
  const documentation = await loadBundledDocumentation(environment, publicUrl, async () => ({ app }));
  const server = await serve(routeBundledDocumentation(platform, documentation), {
    hostname: "127.0.0.1", port: 0, trustProxy: true, allowedHosts: [],
  });
  t.after(() => server.close());
  const request = (headers) => new Promise((resolve, reject) => {
    const incoming = get(server.url, { headers }, async (response) => {
      try {
        let body = "";
        for await (const chunk of response) body += chunk;
        resolve(body);
      } catch (error) { reject(error); }
    });
    incoming.on("error", reject);
  });
  assert.equal(await request({ host: "clank.run", "x-forwarded-host": "docs.clank.run" }), "platform");
  assert.equal(new URL(calls.at(-1)[1].url).hostname, "docs.clank.run", "Exercise the adapter's trusted proxy rewrite");
  assert.equal(await request({ host: "docs.clank.run", "x-forwarded-host": "docs.clank.run" }), "docs");
});

test("importing the built docs app with no direct entry never starts a second listener", async () => {
  const entry = new URL("../docs-site/dist/server.js", import.meta.url).href;
  const { stdout } = await execFileAsync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e",
    `const { app } = await import(${JSON.stringify(entry)}); if (typeof app.handle !== 'function') throw new Error('Missing app'); console.log('imported');`], {
    env: { ...process.env, PORT: "not-a-port" }, timeout: 15_000,
  });
  assert.equal(stdout.trim(), "imported");
});

test("the bundled app serves the canonical prompt and assets while platform routes retain ownership", async () => {
  const documentation = await loadBundledDocumentation(environment, publicUrl);
  const { platform } = handlers();
  const router = routeBundledDocumentation(platform, documentation);
  for (const path of ["/", "/docs/getting-started"]) {
    const response = await router.handle(new Request(`https://docs.clank.run${path}`));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Build with your agent|Set up with an agent/u);
    assert.match(body, /Copy setup prompt|Set up with an agent/u);
    if (path === "/") {
      const asset = body.match(/href="([^"]+\.css)"/u)?.[1];
      assert.ok(asset);
      const styles = await router.handle(new Request(new URL(asset, "https://docs.clank.run")));
      assert.equal(styles.status, 200);
      assert.match(await styles.text(), /agent-setup-card/u);
    }
  }
  const raw = await router.handle(new Request("https://docs.clank.run/raw/getting-started.md"));
  assert.equal(raw.status, 200);
  assert.match(await raw.text(), /## Set up with an agent/u);
  const fallback = await router.handle(new Request("https://clank.run/_clank/readyz"));
  assert.equal(await fallback.text(), "platform");
});
