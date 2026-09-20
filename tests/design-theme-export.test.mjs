import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { CLANK_THEME_PRESETS, createClankThemeStylesheet } from "../dist/ui-theme.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-theme-export-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
for (const filename of ["theme-export-data.ts", "theme-export.tsx"]) {
  const source = await readFile(new URL(`../design-site/src/tools/${filename}`, import.meta.url), "utf8");
  await writeFile(join(temporary, filename.replace(/\.tsx?$/u, ".js")), compile(source.replaceAll("../../vendor/", runtime), { filename, sourceMap: false }));
}
const { createThemeExport, copyThemeExport, downloadThemeExport } = await import(pathToFileURL(join(temporary, "theme-export-data.js")).href);
const { ThemeExport } = await import(pathToFileURL(join(temporary, "theme-export.js")).href);

test("theme export produces the exact framework stylesheet and parseable complete theme JSON for every preset", () => {
  for (const theme of CLANK_THEME_PRESETS) {
    const css = createThemeExport(theme.id, "css");
    assert.equal(css.contents, createClankThemeStylesheet([theme]));
    assert.equal(css.mediaType, "text/css;charset=utf-8");
    assert.equal(css.filename, `clank-theme-${theme.id}.css`);
    assert.match(css.contents, /^:root \{/u);
    assert.ok(css.contents.includes(`:root[data-clank-theme="${theme.id}"]`));
    const json = createThemeExport(theme.id, "json");
    assert.equal(json.mediaType, "application/json;charset=utf-8");
    assert.equal(json.filename, `clank-theme-${theme.id}.json`);
    assert.deepEqual(JSON.parse(json.contents), theme);
    assert.equal(json.contents, `${JSON.stringify(theme, null, 2)}\n`);
    assert.match(json.filename, /^clank-theme-[a-z][a-z0-9-]*\.json$/u);
  }
});

test("exports resolve canonical trusted metadata and reject unrecognized identifiers or formats", () => {
  assert.deepEqual(createThemeExport("  CLANK  ", "json"), createThemeExport("clank", "json"));
  for (const id of ["../../clank", "clank\nmalicious", "clank.css", '<script>alert(1)</script>', "unknown", "", null, undefined, { id: "clank", name: "Spoofed" }]) {
    assert.throws(() => createThemeExport(id, "json"), /existing theme preset/u);
  }
  for (const format of ["../json", "html", "CSS", "", undefined]) assert.throws(() => createThemeExport("clank", format), /CSS or JSON/u);
});

test("copy uses the exact displayed export and reports unavailable or rejected clipboard truthfully", async () => {
  const file = createThemeExport("clank", "json");
  let copied;
  assert.equal(await copyThemeExport(file, { async writeText(value) { copied = value; } }), `Copied ${file.filename}.`);
  assert.equal(copied, file.contents);
  assert.match(await copyThemeExport(file), /^Copy is unavailable\. Select the preview text/u);
  assert.match(await copyThemeExport(file, { async writeText() { throw new Error("Permission denied"); } }), /^Could not copy\. Select the preview text/u);
  assert.equal(file.contents, createThemeExport("clank", "json").contents);
});

test("download uses the selected content, removes its link, and revokes its object URL even when clicking fails", async (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => previousDocument ? Object.defineProperty(globalThis, "document", previousDocument) : delete globalThis.document);
  let blob;
  const revoked = [];
  const scheduled = [];
  let removed = 0;
  let clicked = 0;
  let clickFails = false;
  const links = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement(name) {
      assert.equal(name, "a");
      return { click() { clicked++; if (clickFails) throw new Error("Download blocked"); }, remove() { removed++; } };
    },
    body: { append(link) { links.push(link); } },
  } });
  t.mock.method(URL, "createObjectURL", (value) => { blob = value; return "blob:test-theme"; });
  t.mock.method(URL, "revokeObjectURL", (url) => { revoked.push(url); });
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { scheduled.push(callback); assert.equal(delay, 1000); return 0; });
  const file = createThemeExport("porcelain", "json");
  downloadThemeExport(file);
  assert.equal(blob.type, file.mediaType);
  assert.equal(await blob.text(), file.contents);
  assert.equal(links[0].download, file.filename);
  assert.equal(links[0].href, "blob:test-theme");
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  assert.deepEqual(revoked, []);
  scheduled.shift()();
  assert.deepEqual(revoked, ["blob:test-theme"]);
  clickFails = true;
  assert.throws(() => downloadThemeExport(file), /Download blocked/u);
  assert.equal(removed, 2);
  scheduled.shift()();
  assert.deepEqual(revoked, ["blob:test-theme", "blob:test-theme"]);
});

test("theme export renders selectable labeled output and updates to the selected preset", async () => {
  let selected = CLANK_THEME_PRESETS[0];
  const props = { theme: () => selected };
  const first = await renderToString(h(ThemeExport, props));
  assert.match(first, /<label[^>]*for="theme-export-format"/u);
  assert.match(first, /<select[^>]*id="theme-export-format"/u);
  assert.match(first, /<option value="css"/u);
  assert.match(first, /<option value="json"/u);
  assert.match(first, /role="status" aria-live="polite"/u);
  assert.match(first, /<pre[^>]*tabindex="0"[^>]*role="region"/u);
  assert.ok(first.includes("Copy export"));
  assert.ok(first.includes("Download file"));
  assert.ok(first.includes(`clank-theme-${selected.id}.css is ready`));
  assert.ok(first.includes(selected.tokens.accent));
  selected = CLANK_THEME_PRESETS.find((theme) => theme.id === "porcelain");
  const second = await renderToString(h(ThemeExport, props));
  assert.ok(second.includes(`${selected.name} CSS export preview`));
  assert.ok(second.includes(`clank-theme-${selected.id}.css is ready`));
  assert.ok(second.includes(selected.tokens.accent));
  assert.notEqual(first, second);
});
