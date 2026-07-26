import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const docsRoot = new URL("../docs-site/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("content/manifest.json", docsRoot), "utf8"));

async function startDocumentationServer(t) {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "dist/server.js",
  ], {
    cwd: docsRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      DOCS_ORIGIN: "https://docs.clank.run",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });

  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Documentation server did not start.\nstdout:\n${output}\nstderr:\n${errors}`));
    }, 10_000);
    child.stdout.on("data", () => {
      const match = output.match(/Clank Documentation: (https?:\/\/[^\s]+)/u);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Documentation server exited with ${code}.\nstdout:\n${output}\nstderr:\n${errors}`));
    });
  });

  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return origin;
}

test("documentation site serves every human and agent contract securely", async (t) => {
  const origin = await startDocumentationServer(t);
  const response = await fetch(origin);
  const home = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/u);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  assert.match(response.headers.get("x-content-type-options") ?? "", /nosniff/u);
  assert.match(home, /Install one package/u);
  assert.match(home, /npm install --global @clank\.run\/framework/u);
  assert.match(home, /Running in four commands/u);
  assert.match(home, /Registration and secure sessions/u);
  assert.match(home, /Machine-readable by default/u);
  assert.match(home, /<link rel="canonical" href="https:\/\/docs\.clank\.run\/"/u);

  const stylesheet = home.match(/href="(\/assets\/styles\.[a-f0-9]{16}\.css)"/u)?.[1];
  const browserModule = home.match(/import\("(\/assets\/app\.[a-f0-9]{16}\.js)"\)/u)?.[1];
  assert.ok(stylesheet, "home page should reference a content-addressed stylesheet");
  assert.ok(browserModule, "home page should reference a content-addressed browser module");

  const [styleResponse, moduleResponse] = await Promise.all([
    fetch(`${origin}${stylesheet}`),
    fetch(`${origin}${browserModule}`),
  ]);
  const moduleSource = await moduleResponse.text();
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("cache-control") ?? "", /immutable/u);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get("cache-control") ?? "", /immutable/u);
  assert.match(moduleSource, new RegExp(`search\\.${manifest.assetVersion}\\.js`, "u"));
  assert.equal((await fetch(`${origin}/assets/app.outdated.js`)).status, 404);

  const guideResponses = await Promise.all(manifest.docs.map((doc) => fetch(`${origin}/docs/${doc.slug}`)));
  assert.equal(guideResponses.length, 46);
  assert.deepEqual([...new Set(guideResponses.map((guide) => guide.status))], [200]);

  const cli = await (await fetch(`${origin}/docs/cli`)).text();
  assert.match(cli, /Deployment CLI/u);
  assert.match(cli, /Raw Markdown/u);
  assert.match(cli, /On this page/u);

  const gettingStarted = await (await fetch(`${origin}/docs/getting-started`)).text();
  assert.match(gettingStarted, /Getting started with the npm package/u);
  assert.match(gettingStarted, /You do not need to clone the Clank repository/u);
  assert.match(gettingStarted, /This is the structure of the app created from npm/u);
  assert.match(gettingStarted, /src\/backend\.ts/u);
  assert.match(gettingStarted, /npm run deploy:check/u);

  const redirect = await fetch(`${origin}/docs`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/docs/getting-started");

  const trailingSlash = await fetch(`${origin}/docs/cli/`, { redirect: "manual" });
  assert.equal(trailingSlash.status, 308);
  assert.equal(trailingSlash.headers.get("location"), "/docs/cli");

  const injectedSearch = await (await fetch(`${origin}/search?q=${encodeURIComponent("<script>alert(1)</script>")}`)).text();
  assert.doesNotMatch(injectedSearch, /<script>alert\(1\)<\/script>/u);
  assert.match(injectedSearch, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);

  const raw = await fetch(`${origin}/raw/cli.md`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get("content-type") ?? "", /^text\/plain/u);
  assert.match(await raw.text(), /^# Deployment CLI/mu);

  const index = await (await fetch(`${origin}/api/docs.json`)).json();
  assert.equal(index.protocol, "clank-docs/1");
  assert.equal(index.docs.length, manifest.docs.length);
  assert.equal(index.agentEndpoints.full, "https://docs.clank.run/llms-full.txt");

  const document = await (await fetch(`${origin}/api/docs/cli.json`)).json();
  assert.equal(document.protocol, "clank-doc/1");
  assert.equal(document.slug, "cli");
  assert.ok(document.markdown.length > 5_000);

  const [compact, corpus, sitemap, robots, health] = await Promise.all([
    fetch(`${origin}/llms.txt`).then((entry) => entry.text()),
    fetch(`${origin}/llms-full.txt`).then((entry) => entry.text()),
    fetch(`${origin}/sitemap.xml`).then((entry) => entry.text()),
    fetch(`${origin}/robots.txt`).then((entry) => entry.text()),
    fetch(`${origin}/healthz`).then((entry) => entry.json()),
  ]);
  assert.match(compact, /## Agent entry points/u);
  assert.match(compact, /clank help --json/u);
  assert.ok(corpus.length > 250_000);
  assert.match(corpus, /# Clank complete documentation/u);
  assert.equal((sitemap.match(/<url>/gu) ?? []).length, manifest.docs.length + 1);
  assert.match(robots, /https:\/\/docs\.clank\.run\/sitemap\.xml/u);
  assert.deepEqual(health, { ok: true, service: "clank-docs", version: manifest.frameworkVersion });

  const missing = await fetch(`${origin}/not-a-real-page`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /This page is not in the contract/u);
});

test("documentation manifest covers every canonical guide exactly once", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
  assert.equal(manifest.frameworkVersion, packageJson.version);
  assert.equal(manifest.protocol, "clank-docs/1");
  assert.equal(manifest.docs.length, 46);
  assert.equal(new Set(manifest.docs.map((doc) => doc.slug)).size, manifest.docs.length);
  assert.ok(manifest.docs.every((doc) =>
    doc.title
    && doc.description
    && doc.source
    && doc.groupId
    && doc.words > 0
    && doc.readingMinutes > 0));
});

test("documentation Markdown allows only explicit safe link protocols", async () => {
  const { renderMarkdown } = await import("../docs-site/dist/markdown.js");
  const rendered = renderMarkdown([
    "## <script>unsafe heading</script>",
    "",
    "[JavaScript](javascript:alert(1))",
    "[VBScript](vbscript:msgbox(1))",
    "[Data](data:text/html,unsafe)",
    "[Protocol relative](//attacker.example/path)",
    "[HTTPS](https://clank.run/docs)",
    "[Email](mailto:hello@clank.run)",
    "[Internal](/docs/security)",
  ].join("\n"));

  assert.doesNotMatch(rendered.html, /<script/iu);
  assert.doesNotMatch(rendered.html, /href="(?:java|vb)script:/iu);
  assert.doesNotMatch(rendered.html, /href="data:/iu);
  assert.doesNotMatch(rendered.html, /href="\/\/attacker/iu);
  assert.match(rendered.html, /href="https:\/\/clank\.run\/docs"/u);
  assert.match(rendered.html, /href="mailto:hello@clank\.run"/u);
  assert.match(rendered.html, /href="\/docs\/security"/u);
  assert.equal(rendered.toc[0].id, "scriptunsafe-headingscript");
});
