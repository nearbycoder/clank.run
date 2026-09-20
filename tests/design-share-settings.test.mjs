import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-share-settings-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
await writeFile(join(temporary, "manifest.json"), JSON.stringify({ frameworkVersion: "test", assetVersion: "test", vendorVersion: "test", componentCount: 39, themeCount: 10 }));
const runtime = new URL("../dist/", import.meta.url).href;
const sourceRoot = fileURLToPath(new URL("../design-site/src/", import.meta.url));
for (const filename of ["studio.tsx", "stories.tsx", "server.tsx", ...(await readdir(join(sourceRoot, "tools"))).filter((name) => /\.tsx?$/u.test(name)).map((name) => `tools/${name}`)]) {
  const source = (await readFile(join(sourceRoot, filename), "utf8")).replaceAll("../../vendor/", runtime).replaceAll("../vendor/", runtime);
  const target = join(temporary, filename.replace(/\.tsx?$/u, ".js"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, compile(source, { filename, sourceMap: false }));
}
const { DEFAULT_PREVIEW_SETTINGS, parsePreviewSettings, previewSettingsQuery, studioViewFromPath, shouldNavigatePreview, copyPreviewLink } = await import(pathToFileURL(join(temporary, "tools/share-settings-data.js")).href);
const { DesignStudio } = await import(pathToFileURL(join(temporary, "studio.js")).href);

test("preview links round-trip every setting, with concise defaults and bounded custom widths", () => {
  assert.equal(previewSettingsQuery(DEFAULT_PREVIEW_SETTINGS), "");
  assert.deepEqual(parsePreviewSettings(""), DEFAULT_PREVIEW_SETTINGS);
  for (const width of ["responsive", "mobile", "tablet", "desktop", 280, 523, 1600]) {
    for (const panel of ["anatomy", "code", "tokens"]) {
      const settings = { theme: "midnight", width, panel, grid: true, outlines: true };
      assert.deepEqual(parsePreviewSettings(previewSettingsQuery(settings)), settings);
    }
  }
  assert.equal(previewSettingsQuery({ theme: "clank", width: "mobile", panel: "code", grid: true }), "?width=mobile&grid=1&panel=code");
});

test("unknown, duplicate, malformed, oversized, and CSS or URL-like values cannot influence preview state", () => {
  for (const search of ["?width=279", "?width=1601", "?width=280.5", "?width=Infinity", "?width=calc(100vw)", "?width=__proto__", "?theme=https://evil.invalid/theme.css", "?theme=toString", "?panel=javascript:alert(1)", "?grid=true&outlines=yes", "?theme=%FF&width=%FF", "?theme=midnight&theme=terminal", "?width=300&width=600", "?grid=1&grid=0", `?theme=midnight&x=${"a".repeat(2048)}`]) {
    assert.deepEqual(parsePreviewSettings(search), DEFAULT_PREVIEW_SETTINGS, search.slice(0, 100));
  }
  assert.deepEqual(parsePreviewSettings("?theme=terminal&redirect=https://evil.invalid&url=javascript:alert(1)&unknown=1"), { ...DEFAULT_PREVIEW_SETTINGS, theme: "terminal" });
  assert.equal(previewSettingsQuery({ theme: '<script>alert(1)</script>', width: "400px", panel: "other", grid: 1, outlines: "1" }), "");
});

test("Back and Forward route decoding recognizes only local catalog routes without throwing", () => {
  assert.equal(studioViewFromPath("/"), "overview");
  assert.equal(studioViewFromPath("/themes"), "themes");
  assert.equal(studioViewFromPath("/components/switch"), "switch");
  assert.equal(studioViewFromPath("/components/%73witch"), "switch");
  for (const path of ["/components/%", "/components/%FF", "/components/unknown", "/other", "https://evil.invalid", "/components/%2F%2Fevil.invalid"]) assert.equal(studioViewFromPath(path), "missing");
});

test("modified and already-handled link clicks keep their native behavior", () => {
  const event = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  assert.equal(shouldNavigatePreview(event), true);
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey", "defaultPrevented"]) assert.equal(shouldNavigatePreview({ ...event, [key]: true }), false);
  for (const button of [1, 2]) assert.equal(shouldNavigatePreview({ ...event, button }), false);
});

test("copy status reports success only after clipboard writing succeeds", async () => {
  let copied;
  const link = "https://design.clank.run/components/switch?theme=midnight&width=280";
  assert.equal(await copyPreviewLink(link, { async writeText(value) { copied = value; } }), true);
  assert.equal(copied, link);
  assert.equal(await copyPreviewLink(link), false);
  assert.equal(await copyPreviewLink(link, { async writeText() { throw new Error("Permission denied"); } }), false);
});

test("SSR uses shared settings for controls, the frame, inspector, theme, and ordinary navigation links", async () => {
  const initialSettings = parsePreviewSettings("?theme=midnight&width=523&grid=1&outlines=1&panel=code");
  const html = (await renderToString(h(DesignStudio, { initialView: "switch", initialTheme: "clank", initialSettings, frameworkVersion: "test" }), { markers: false }));
  assert.match(html, /data-theme="midnight"/u);
  assert.match(html, /<div(?=[^>]*class="preview-stage")(?=[^>]*data-grid="")(?=[^>]*data-outlines="")[^>]*>/u);
  assert.match(html, /data-viewport="custom" style="--preview-width:523px"/u);
  assert.match(html, /523px requested/u);
  assert.match(html, /Focused package import/u);
  assert.doesNotMatch(html, /<h2>Semantic parts<\/h2>/u);
  assert.match(html, /href="\/themes\?theme=midnight&amp;width=523&amp;grid=1&amp;outlines=1&amp;panel=code"/u);
  assert.match(html, /href="\/components\/dialog\?theme=midnight&amp;width=523&amp;grid=1&amp;outlines=1&amp;panel=code"/u);
  assert.match(html, /Copy preview link/u);
  assert.doesNotMatch(html, /Preview link copied/u);
  assert.match(html, /role="switch"/u);
});

test("direct deep links serialize identical hydration state and serve every preview module", async (t) => {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(temporary, "server.js")], { cwd: temporary, env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DESIGN_ORIGIN: "https://design.clank.run" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  });
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${errors}`)), 10_000);
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Clank Design Studio: (https?:\/\/[^\s]+)/u);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${errors}`)); });
  });
  const query = "?theme=midnight&width=280&grid=1&outlines=1&panel=tokens";
  const response = await fetch(`${origin}/components/switch${query}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="en" data-clank-theme="midnight" style="color-scheme:dark">/u);
  assert.match(html, /"initialSettings":\{"theme":"midnight","width":280,"grid":true,"outlines":true,"panel":"tokens"\}/u);
  assert.match(html, /style="--preview-width:280px"/u);
  assert.match(html, /Machine-readable by construction/u);
  assert.match(html, /rel="canonical" href="https:\/\/design\.clank\.run\/components\/switch"/u);
  for (const filename of ["preview-width.js", "preview-width-data.js", "share-settings.js", "share-settings-data.js", "studio-data.js", "copy-text.js", "copy-text-data.js", "theme-sandbox-export-data.js"]) {
    assert.equal((await fetch(`${origin}/assets/tools/${filename}`)).status, 200, filename);
  }
  assert.equal((await fetch(`${origin}/assets/tools/unknown.js`)).status, 404);
  const themes = await (await fetch(`${origin}/themes?theme=terminal&width=desktop`)).text();
  assert.match(themes, /"initialSettings":\{"theme":"terminal","width":"desktop"/u);
  const invalid = await (await fetch(`${origin}/components/switch?width=1601&theme=unknown&panel=evil`)).text();
  assert.match(invalid, /"initialSettings":\{"theme":"clank","width":"responsive","grid":false,"outlines":false,"panel":"anatomy"\}/u);
});
