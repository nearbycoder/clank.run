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
  assert.match(home, /rel="icon" href="\/brand\/favicon\.ico\?v=[a-f0-9]{16}" sizes="any"/u);
  assert.match(home, /src="\/brand\/clank-mark-64\.png"/u);
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
  const [favicon, mark, touchIcon] = await Promise.all([
    fetch(`${origin}/favicon.ico`),
    fetch(`${origin}/brand/clank-mark-64.png`),
    fetch(`${origin}/apple-touch-icon.png`),
  ]);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/x-icon");
  assert.ok((await favicon.arrayBuffer()).byteLength > 1_000);
  assert.equal(mark.status, 200);
  assert.equal(mark.headers.get("content-type"), "image/png");
  assert.ok((await mark.arrayBuffer()).byteLength > 1_000);
  assert.equal(touchIcon.status, 200);
  assert.equal(touchIcon.headers.get("content-type"), "image/png");
  assert.ok((await touchIcon.arrayBuffer()).byteLength > 1_000);
  const faviconHead = await fetch(`${origin}/favicon.ico`, { method: "HEAD" });
  assert.equal(faviconHead.status, 200);
  assert.equal(faviconHead.headers.get("content-type"), "image/x-icon");
  assert.equal((await faviconHead.arrayBuffer()).byteLength, 0);

  const guideResponses = await Promise.all(manifest.docs.map((doc) => fetch(`${origin}/docs/${doc.slug}`)));
  assert.equal(guideResponses.length, manifest.docs.length);
  assert.deepEqual([...new Set(guideResponses.map((guide) => guide.status))], [200]);

  const cli = await (await fetch(`${origin}/docs/cli`)).text();
  assert.match(cli, /Deployment CLI/u);
  assert.match(cli, /Interactive launcher/u);
  assert.match(cli, /clank create my-app --template=minimal/u);
  assert.match(cli, /clank login/u);
  assert.match(cli, /defaults to <code>https:\/\/clank\.run<\/code>/u);
  assert.match(cli, /Raw Markdown/u);
  assert.match(cli, /On this page/u);

  const gettingStarted = await (await fetch(`${origin}/docs/getting-started`)).text();
  assert.match(gettingStarted, /Getting started with the npm package/u);
  assert.match(gettingStarted, /You do not need to clone the Clank repository/u);
  assert.match(gettingStarted, /This is the structure of the app created from npm/u);
  assert.match(gettingStarted, /src\/backend\.ts/u);
  assert.match(gettingStarted, /npm run deploy:check/u);
  assert.match(gettingStarted, /class="tok-keyword"/u);
  assert.match(gettingStarted, /class="tok-string"/u);

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
  assert.equal(index.agentEndpoints.mcp, "https://docs.clank.run/__clank/mcp");

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

  const discoveryResponse = await fetch(`${origin}/.well-known/clank`);
  const discovery = await discoveryResponse.json();
  assert.equal(discoveryResponse.status, 200);
  assert.equal(discovery.mcp.endpoint, "https://docs.clank.run/__clank/mcp");
  assert.equal(discovery.mcp.authentication, "none");
  assert.equal(discovery.mcp.protocolVersion, "2025-11-25");

  const serverCard = await (await fetch(`${origin}/.well-known/mcp/server-card.json`)).json();
  assert.equal(serverCard.serverInfo.name, "clank-docs");
  assert.equal(serverCard.authentication.required, false);
  assert.equal(serverCard.capabilities.tools.listChanged, true);
  assert.equal(serverCard.contractRevision, discovery.contractRevision);
  assert.deepEqual(serverCard.tools, ["dynamic"]);

  let rpcId = 0;
  let mcpSession;
  const mcp = async (method, params = {}) => {
    const mcpResponse = await fetch(`${origin}/__clank/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const payload = await mcpResponse.json();
    assert.equal(mcpResponse.status, 200, JSON.stringify(payload));
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    if (method === "initialize") mcpSession = mcpResponse.headers.get("mcp-session-id");
    return payload.result;
  };
  const initialized = await mcp("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "docs-site-test", version: "1.0.0" },
  });
  assert.ok(mcpSession);
  assert.equal(initialized.serverInfo.name, "clank-docs");
  assert.equal(initialized.protocolVersion, "2025-11-25");
  assert.equal(initialized.capabilities.tools.listChanged, true);
  const toolList = await mcp("tools/list");
  assert.equal(toolList.ttlMs, 0);
  assert.equal(toolList.cacheScope, "private");
  assert.equal(toolList._meta["clank/contractRevision"], discovery.contractRevision);
  assert.deepEqual(
    toolList.tools.map((tool) => tool.name),
    ["docs.list", "docs.read", "docs.search"],
  );
  assert.ok(toolList.tools.every((tool) =>
    tool.annotations.readOnlyHint === true
    && tool.annotations.destructiveHint === false
    && tool.annotations.openWorldHint === false));

  const listed = await mcp("tools/call", { name: "docs.list", arguments: {} });
  assert.equal(listed.isError, false);
  assert.equal(listed.structuredContent.documents.length, manifest.docs.length);
  const searched = await mcp("tools/call", {
    name: "docs.search",
    arguments: { query: "authenticated MCP", limit: 5 },
  });
  assert.equal(searched.isError, false);
  assert.ok(searched.structuredContent.results.some((entry) => entry.slug === "agent-protocol"));
  const read = await mcp("tools/call", {
    name: "docs.read",
    arguments: { slug: "agent-protocol" },
  });
  assert.equal(read.isError, false);
  assert.match(read.structuredContent.markdown, /^# Agent protocol/mu);
  assert.match(read.structuredContent.markdown, /OAuth/u);
  const actionManifest = await mcp("resources/read", { uri: "clank://actions" });
  assert.match(actionManifest.contents[0].text, /docs\.search/u);

  const rejectedOrigin = await fetch(`${origin}/__clank/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  });
  assert.equal(rejectedOrigin.status, 403);
  assert.equal((await fetch(`${origin}/__clank/mcp`)).status, 400);
  const eventStream = await fetch(`${origin}/__clank/mcp`, {
    headers: {
      accept: "text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": mcpSession,
    },
  });
  assert.equal(eventStream.status, 200);
  assert.match(eventStream.headers.get("content-type"), /^text\/event-stream/u);
  const eventReader = eventStream.body.getReader();
  assert.match(new TextDecoder().decode((await eventReader.read()).value), /clank contract/u);
  await eventReader.cancel();

  const missing = await fetch(`${origin}/not-a-real-page`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /This page is not in the contract/u);
});

test("documentation manifest covers every canonical guide exactly once", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
  assert.equal(manifest.frameworkVersion, packageJson.version);
  assert.equal(manifest.protocol, "clank-docs/1");
  assert.equal(manifest.docs.length, 60);
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

test("documentation code fences highlight supported languages without changing or trusting code", async () => {
  const { renderMarkdown } = await import("../docs-site/dist/markdown.js");
  const { highlightCode } = await import("../docs-site/dist/highlight.js");
  const rendered = renderMarkdown([
    "```tsx",
    "const greeting: string = \"<hello>\";",
    "// rendered as text, never markup",
    "function App() { return <button disabled>{greeting}</button>; }",
    "```",
    "",
    "```json",
    "{\"enabled\": true, \"retries\": 3}",
    "```",
    "",
    "```sh",
    "clank deploy --server \"$CLANK_SERVER\"",
    "```",
    "",
    "```sql",
    "SELECT id FROM todos WHERE completed = false;",
    "```",
    "",
    "```html",
    "<script data-value=\"unsafe\">alert(1)</script>",
    "```",
    "",
    "```unknown",
    "</code><script>globalThis.compromised = true</script>",
    "```",
  ].join("\n"));

  assert.match(rendered.html, /class="tok-keyword">const<\/span>/u);
  assert.match(rendered.html, /class="tok-type">string<\/span>/u);
  assert.match(rendered.html, /class="tok-string">&quot;&lt;hello&gt;&quot;<\/span>/u);
  assert.match(rendered.html, /class="tok-comment">\/\/ rendered as text, never markup<\/span>/u);
  assert.match(rendered.html, /class="tok-function">App<\/span>/u);
  assert.match(rendered.html, /class="tok-tag">button<\/span>/u);
  assert.match(rendered.html, /class="tok-property">&quot;enabled&quot;<\/span>|class="tok-property">enabled<\/span>/u);
  assert.match(rendered.html, /class="tok-literal">true<\/span>/u);
  assert.match(rendered.html, /class="tok-function">clank<\/span>/u);
  assert.match(rendered.html, /class="tok-attribute">--server<\/span>/u);
  assert.match(rendered.html, /class="tok-variable">\$CLANK_SERVER<\/span>/u);
  assert.match(rendered.html, /class="tok-keyword">SELECT<\/span>/u);
  assert.match(rendered.html, /class="tok-tag">script<\/span>/u);
  assert.match(rendered.html, /&lt;\/code&gt;&lt;script&gt;globalThis\.compromised/u);
  assert.doesNotMatch(rendered.html, /<script>/iu);

  assert.match(highlightCode("color: var(--accent);", "css"), /tok-property">color/u);
  assert.match(highlightCode("const delta = left-right;", "ts"), /tok-operator">-<\/span>/u);
  assert.match(highlightCode("enabled: true # safe note", "yaml"), /tok-comment"># safe note/u);
  assert.match(highlightCode("flowchart TD\n%% safe note", "mermaid"), /tok-keyword">flowchart/u);
  assert.match(highlightCode("/* unfinished <script>", "js"), /&lt;script&gt;/u);
  assert.equal(
    highlightCode("</code><script>alert(1)</script>", "text"),
    "&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});
