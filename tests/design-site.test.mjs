import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const designRoot = new URL("../design-site/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("dist/manifest.json", designRoot), "utf8"));

async function startDesignServer(t) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "dist/server.js"], {
    cwd: designRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DESIGN_ORIGIN: "https://design.clank.run" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Design server did not start.\nstdout:\n${output}\nstderr:\n${errors}`)), 10_000);
    child.stdout.on("data", () => {
      const match = output.match(/Clank Design Studio: (https?:\/\/[^\s]+)/u);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Design server exited with ${code}.\n${errors}`)); });
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return origin;
}

test("Design Studio serves every real component and theme contract securely", async (t) => {
  const origin = await startDesignServer(t);
  const response = await fetch(origin);
  const home = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(home, /Inspect every state/u);
  assert.match(home, /37[^<]*<\/strong><span>interactive families/u);
  assert.match(home, /10[^<]*<\/strong><span>complete themes/u);
  assert.match(home, /<link rel="canonical" href="https:\/\/design\.clank\.run\/"/u);
  assert.match(home, /rel="icon" href="\/brand\/favicon\.ico\?v=[a-f0-9]{16}"/u);

  const stylesheet = home.match(/href="(\/assets\/styles\.[a-f0-9]{16}\.css)"/u)?.[1];
  const appModule = home.match(/import\("(\/assets\/app\.[a-f0-9]{16}\.js)"\)/u)?.[1];
  assert.ok(stylesheet);
  assert.ok(appModule);
  const [styleResponse, appResponse, studioModule, storiesModule, vendorModule] = await Promise.all([
    fetch(`${origin}${stylesheet}`),
    fetch(`${origin}${appModule}`),
    fetch(`${origin}/assets/studio.js`),
    fetch(`${origin}/assets/stories.js`),
    fetch(`${origin}/vendor/dom.js?v=${manifest.vendorVersion}`),
  ]);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("cache-control") ?? "", /immutable/u);
  const styleSource = await styleResponse.text();
  assert.match(styleSource, /\.scrollbar\.vertical\s*\{[^}]*width:\s*16px/u);
  assert.match(styleSource, /\.scroll-thumb::after\s*\{[^}]*pointer-events:\s*none/u);
  assert.match(styleSource, /\.component-heading h1\s*\{[^}]*overflow-wrap:\s*anywhere/u);
  assert.match(styleSource, /\.nav-popup\s*\{[^}]*width:\s*min\(320px,\s*calc\(100vw - 32px\)\)[^}]*min-width:\s*0/u);
  assert.equal(appResponse.status, 200);
  assert.match(appResponse.headers.get("cache-control") ?? "", /immutable/u);
  assert.match(await appResponse.text(), /\.\/studio\.js/u);
  assert.equal(studioModule.status, 200);
  assert.equal(storiesModule.status, 200);
  assert.match(studioModule.headers.get("cache-control") ?? "", /must-revalidate/u);
  assert.match(storiesModule.headers.get("cache-control") ?? "", /must-revalidate/u);
  const studioSource = await studioModule.text();
  const storiesSource = await storiesModule.text();
  for (const feedback of ["Deploy started.", "Draft saved.", "was added as", "Bold applied.", "Italic applied.", "Link inserted."]) {
    assert.ok(storiesSource.includes(feedback), `interactive story feedback is missing: ${feedback}`);
  }
  for (const source of [studioSource, storiesSource]) {
    assert.match(source, /\.\.\/vendor\/[^"']+\.js\?v=[a-f0-9]{16}/u);
    assert.ok(source.includes(`?v=${manifest.vendorVersion}`));
  }
  assert.equal(vendorModule.status, 200);
  assert.match(await vendorModule.text(), new RegExp(`from "\\./core\\.js\\?v=${manifest.vendorVersion}"`, "u"));
  assert.equal((await fetch(`${origin}/assets/app.outdated.js`)).status, 404);

  const catalogResponse = await fetch(`${origin}/api/catalog.json`);
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(catalog.protocol, "clank-design/1");
  assert.equal(catalog.total, 37);
  assert.equal(new Set(catalog.components.map((entry) => entry.slug)).size, 37);
  assert.ok(catalog.components.every((entry) => entry.import === `@clank.run/framework/ui/${entry.slug}`));

  for (const component of catalog.components) {
    const componentResponse = await fetch(`${origin}/components/${component.slug}`);
    const page = await componentResponse.text();
    assert.equal(componentResponse.status, 200, component.slug);
    const escapedName = component.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(page, new RegExp(`<h1[^>]*>[\\s\\S]{0,80}${escapedName}[\\s\\S]{0,80}</h1>`, "u"), component.slug);
    assert.ok(page.includes(component.description), component.slug);
  }
  assert.equal((await fetch(`${origin}/components/not-real`)).status, 404);

  const themesResponse = await fetch(`${origin}/api/themes.json`);
  const themes = await themesResponse.json();
  assert.equal(themesResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(themes.protocol, "clank-theme-catalog/1");
  assert.equal(themes.total, 10);
  assert.deepEqual(themes.themes.map((theme) => theme.id), ["clank", "porcelain", "midnight", "sakura", "terminal", "tangerine", "nordic", "grape", "sandstone", "candy"]);
  assert.ok(themes.themes.every((theme) => theme.protocol === "clank-theme/1" && Object.keys(theme.tokens).length === 32));
  const themesPage = await (await fetch(`${origin}/themes`)).text();
  assert.match(themesPage, /One anatomy\. Ten personalities\./u);
  for (const theme of themes.themes) assert.match(themesPage, new RegExp(`>${theme.name}<`, "u"));

  const [health, discovery, serverCard, compact, sitemap, favicon] = await Promise.all([
    fetch(`${origin}/healthz`).then((entry) => entry.json()),
    fetch(`${origin}/.well-known/clank`).then((entry) => entry.json()),
    fetch(`${origin}/.well-known/mcp/server-card.json`).then((entry) => entry.json()),
    fetch(`${origin}/llms.txt`).then((entry) => entry.text()),
    fetch(`${origin}/sitemap.xml`).then((entry) => entry.text()),
    fetch(`${origin}/favicon.ico`),
  ]);
  assert.deepEqual(health, { ok: true, service: "clank-design", version: manifest.frameworkVersion, components: 37, themes: 10 });
  assert.equal(discovery.mcp.endpoint, "https://design.clank.run/__clank/mcp");
  assert.equal(discovery.mcp.authentication, "none");
  assert.equal(serverCard.serverInfo.name, "clank-design");
  assert.equal(serverCard.authentication.required, false);
  assert.match(compact, /@clank\.run\/framework\/ui\/theme/u);
  assert.equal((sitemap.match(/<url>/gu) ?? []).length, 39);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/x-icon");

  let rpcId = 0;
  let session;
  async function mcp(method, params = {}) {
    const mcpResponse = await fetch(`${origin}/__clank/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const payload = await mcpResponse.json();
    assert.equal(mcpResponse.status, 200, JSON.stringify(payload));
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    if (method === "initialize") session = mcpResponse.headers.get("mcp-session-id");
    return payload.result;
  }
  const initialized = await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "design-test", version: "1.0.0" } });
  assert.equal(initialized.serverInfo.name, "clank-design");
  assert.ok(session);
  const listed = await mcp("tools/list");
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["design.component", "design.components", "design.theme", "design.themes"]);
  const called = await mcp("tools/call", { name: "design.theme", arguments: { id: "midnight" } });
  assert.equal(called.structuredContent.theme.id, "midnight");
  assert.equal(Object.keys(called.structuredContent.theme.tokens).length, 32);
});

test("Design Studio source remains a zero-dependency first-party Clank project", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", designRoot), "utf8"));
  assert.equal(packageJson.private, true);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.equal(packageJson[field], undefined);
  }
  assert.equal(manifest.protocol, "clank-design/1");
  assert.match(manifest.vendorVersion, /^[a-f0-9]{16}$/u);
  assert.equal(manifest.componentCount, 37);
  assert.equal(manifest.themeCount, 10);
});
