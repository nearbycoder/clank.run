import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-preview-width-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
const sourceRoot = fileURLToPath(new URL("../design-site/src/", import.meta.url));
for (const filename of ["studio.tsx", "stories.tsx", ...(await readdir(join(sourceRoot, "tools"))).filter((name) => /\.tsx?$/u.test(name)).map((name) => `tools/${name}`)]) {
  const source = (await readFile(join(sourceRoot, filename), "utf8")).replaceAll("../../vendor/", runtime).replaceAll("../vendor/", runtime);
  const target = join(temporary, filename.replace(/\.tsx?$/u, ".js"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, compile(source, { filename: relative(sourceRoot, join(sourceRoot, filename)), sourceMap: false }));
}
const { PREVIEW_WIDTH_PRESETS, parsePreviewWidth, previewWidthPixels, previewWidthStyle, previewWidthLabel, observePreviewWidth } = await import(pathToFileURL(join(temporary, "tools/preview-width-data.js")).href);
const { PreviewWidthControls } = await import(pathToFileURL(join(temporary, "tools/preview-width.js")).href);
const { DesignStudio } = await import(pathToFileURL(join(temporary, "studio.js")).href);

test("custom widths accept whole pixels at both boundaries and reject nonfinite, out-of-range, or CSS input", () => {
  for (const value of [280, 281, 523, 1599, 1600, "280", "1600", " 768 "]) assert.equal(parsePreviewWidth(value), Number(value));
  for (const value of [279, 1601, 280.5, NaN, Infinity, -Infinity, "", " ", "279", "1601", "280.5", "NaN", "Infinity", "1e3", "0x400", "400px", "100%", "calc(100vw)", "320;display:none", null, undefined, true, {}, [], "__proto__", "toString"]) assert.equal(parsePreviewWidth(value), null, String(value));
  assert.equal(previewWidthStyle(523), "523px");
});

test("existing presets retain their width and invalid settings cannot masquerade as presets", () => {
  assert.deepEqual(PREVIEW_WIDTH_PRESETS, { responsive: null, mobile: 390, tablet: 768, desktop: 1120 });
  for (const [preset, pixels] of Object.entries(PREVIEW_WIDTH_PRESETS)) {
    assert.equal(parsePreviewWidth(preset), preset);
    assert.equal(previewWidthPixels(preset), pixels);
    assert.equal(previewWidthStyle(preset), pixels === null ? "100%" : `${pixels}px`);
  }
  assert.equal(parsePreviewWidth("custom"), null);
  assert.equal(parsePreviewWidth("Desktop"), null);
});

test("width labels distinguish requested size from the actual available frame", () => {
  assert.equal(previewWidthLabel(1600, 312), "1600px requested · 312px rendered");
  assert.equal(previewWidthLabel("desktop", 750), "1120px requested · 750px rendered");
  assert.equal(previewWidthLabel("responsive", 312), "Fluid · 312px rendered");
  assert.equal(previewWidthLabel("responsive", null), "Fluid · fits available space");
  assert.equal(previewWidthLabel(1600, null), "1600px requested · fits available space");
});

test("the frame is measured on mount and resize, and observer cleanup prevents stale route updates", (t) => {
  let callback;
  let disconnected = false;
  let width = 312.4;
  let observed;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  t.after(() => previous ? Object.defineProperty(globalThis, "ResizeObserver", previous) : delete globalThis.ResizeObserver);
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(handler) { callback = handler; }
    observe(element) { observed = element; }
    disconnect() { disconnected = true; }
  } });
  const element = { getBoundingClientRect: () => ({ width }) };
  const measured = [];
  const stop = observePreviewWidth(element, (value) => measured.push(value));
  assert.equal(observed, element);
  assert.deepEqual(measured, [312]);
  width = 640;
  callback();
  assert.deepEqual(measured, [312, 640]);
  width = NaN;
  callback();
  assert.deepEqual(measured, [312, 640]);
  stop();
  assert.equal(disconnected, true);
  width = 1600;
  callback();
  assert.deepEqual(measured, [312, 640]);
});

test("SSR exposes labeled bounded width editing and keeps preset selection accurate", async () => {
  for (const width of ["responsive", "mobile", "tablet", "desktop", 280, 1600]) {
    const html = (await renderToString(h(PreviewWidthControls, { value: () => width, onChange() { throw new Error("SSR must not change the setting"); } }), { markers: false }));
    assert.match(html, /<label for="preview-custom-width">Width \(px\)<\/label>/u);
    assert.match(html, /id="preview-custom-width"[^>]*type="number"[^>]*min="280"[^>]*max="1600"[^>]*step="1"/u);
    assert.match(html, /aria-describedby="preview-width-hint preview-width-error"/u);
    assert.match(html, /id="preview-width-error"[^>]*role="alert"/u);
    assert.match(html, /280–1600px; fits available space\./u);
    assert.match(html, /Apply width/u);
    assert.equal((html.match(/aria-pressed="true"/gu) ?? []).length, typeof width === "string" ? 1 : 0);
    assert.match(html, new RegExp(`value="${previewWidthPixels(width) ?? 768}"`, "u"));
  }
});

test("direct component SSR uses a stable fluid default and does not claim a browser measurement", async () => {
  const html = (await renderToString(h(DesignStudio, { initialView: "switch", initialTheme: "clank", frameworkVersion: "test" }), { markers: false }));
  assert.match(html, /<div(?=[^>]*class="preview-frame")(?=[^>]*data-viewport="responsive")(?=[^>]*style="--preview-width:100%")[^>]*>/u);
  assert.match(html, /Fluid · fits available space/u);
  assert.doesNotMatch(html, /\d+px rendered/u);
  assert.match(html, /Width \(px\)/u);
  assert.match(html, /role="switch"/u);
});
