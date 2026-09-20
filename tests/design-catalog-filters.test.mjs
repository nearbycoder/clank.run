import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "../scripts/compiler.mjs";
import { UI_COMPONENT_CATALOG } from "../dist/ui-catalog.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const temporary = await mkdtemp(join(tmpdir(), "clank-catalog-filters-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(join(temporary, "package.json"), '{"type":"module"}');
const runtime = new URL("../dist/", import.meta.url).href;
const sourceRoot = fileURLToPath(new URL("../design-site/src/", import.meta.url));
for (const filename of ["studio.tsx", "stories.tsx", ...(await readdir(join(sourceRoot, "tools"))).filter((name) => /\.tsx?$/u.test(name)).map((name) => `tools/${name}`)]) {
  const source = (await readFile(join(sourceRoot, filename), "utf8")).replaceAll("../../vendor/", runtime).replaceAll("../vendor/", runtime);
  const target = join(temporary, filename.replace(/\.tsx?$/u, ".js"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, compile(source, { filename, sourceMap: false }));
}
const { catalogFilterOptions, filterComponentCatalog, DEFAULT_CATALOG_FILTERS } = await import(pathToFileURL(join(temporary, "tools/catalog-filters-data.js")).href);
const { DesignStudio } = await import(pathToFileURL(join(temporary, "studio.js")).href);

test("catalog category and source options are derived from entries, unique, and readable", () => {
  const options = catalogFilterOptions(UI_COMPONENT_CATALOG);
  assert.deepEqual(options.modules.map((option) => option.value).sort(), [...new Set(UI_COMPONENT_CATALOG.map((entry) => entry.module))].sort());
  assert.deepEqual(options.sources, [{ value: "base-ui", label: "Base UI" }, { value: "clank", label: "Clank" }]);
  assert.equal(options.modules.find((option) => option.value === "legacy").label, "Navigation");
  const custom = [{ ...UI_COMPONENT_CATALOG[0], module: "experimental", source: "clank" }];
  assert.deepEqual(catalogFilterOptions(custom), { modules: [{ value: "experimental", label: "experimental" }], sources: [{ value: "clank", label: "Clank" }] });
  assert.deepEqual(catalogFilterOptions([]), { modules: [], sources: [] });
});

test("every category, form, and source combination intersects text search with accurate counts", () => {
  const modules = ["all", ...new Set(UI_COMPONENT_CATALOG.map((entry) => entry.module))];
  for (const module of modules) for (const form of ["all", "yes", "no"]) for (const source of ["all", "base-ui", "clank"]) {
    for (const query of ["", "  ", "INPUT", "popup", "component-that-does-not-exist"]) {
      const result = filterComponentCatalog(UI_COMPONENT_CATALOG, query, { module, form, source });
      const expected = UI_COMPONENT_CATALOG.filter((entry) => (module === "all" || entry.module === module) && (form === "all" || entry.formAssociated === (form === "yes")) && (source === "all" || entry.source === source) && `${entry.name} ${entry.description} ${entry.module}`.toLowerCase().includes(query.trim().toLowerCase()));
      assert.deepEqual(result.entries.map((entry) => entry.slug), expected.map((entry) => entry.slug), JSON.stringify({ module, form, source, query }));
      assert.equal(result.count, expected.length);
      assert.equal(result.total, UI_COMPONENT_CATALOG.length);
      assert.equal(result.activeCount, Number(module !== "all") + Number(form !== "all") + Number(source !== "all"));
      assert.equal(result.hasQuery, query.trim().length > 0);
    }
  }
});

test("invalid filter values recover independently, while reset restores the complete catalog", () => {
  for (const input of [null, undefined, false, "controls", [], { module: "__proto__", form: true, source: "toString" }, { module: {}, form: "true", source: [] }, { module: "unknown", form: "invalid", source: "invalid" }]) {
    const result = filterComponentCatalog(UI_COMPONENT_CATALOG, null, input);
    assert.deepEqual(result.filters, DEFAULT_CATALOG_FILTERS);
    assert.deepEqual(result.entries, UI_COMPONENT_CATALOG);
    assert.equal(result.activeCount, 0);
    assert.equal(result.hasQuery, false);
  }
  const valid = filterComponentCatalog(UI_COMPONENT_CATALOG, "", { module: "missing", form: "yes", source: "clank" });
  assert.deepEqual(valid.filters, { module: "all", form: "yes", source: "clank" });
  assert.ok(valid.entries.every((entry) => entry.formAssociated && entry.source === "clank"));
  const empty = filterComponentCatalog(UI_COMPONENT_CATALOG, "nothing matches");
  assert.equal(empty.count, 0);
  assert.equal(filterComponentCatalog(UI_COMPONENT_CATALOG, "", DEFAULT_CATALOG_FILTERS).count, UI_COMPONENT_CATALOG.length);
  assert.equal(filterComponentCatalog([], "", { module: "controls", source: "base-ui" }).count, 0);
});

test("SSR exposes labeled collapsed filters, live count, reset, current story, and shared-setting links", async () => {
  const html = (await renderToString(h(DesignStudio, { initialView: "switch", initialTheme: "midnight", initialSettings: { theme: "midnight", width: "mobile", panel: "anatomy", grid: false, outlines: false }, frameworkVersion: "test" }), { markers: false }));
  assert.match(html, /<details class="catalog-filters"><summary>Filter components /u);
  for (const name of ["module", "form", "source"]) {
    assert.match(html, new RegExp(`<label for="catalog-${name}">`));
    assert.match(html, new RegExp(`<select id="catalog-${name}"`));
  }
  assert.match(html, /role="status" aria-live="polite">39 of 39 components/u);
  assert.match(html, /<button type="button" disabled>Reset<\/button>/u);
  assert.match(html, /<h1>Switch<\/h1>/u);
  assert.match(html, /role="switch"/u);
  assert.match(html, /href="\/components\/switch\?theme=midnight&amp;width=mobile"/u);
  assert.doesNotMatch(html, /No components match|Current preview · outside results/u);
  for (const option of catalogFilterOptions(UI_COMPONENT_CATALOG).modules) assert.match(html, new RegExp(`<option value="${option.value}">${option.label}<\/option>`));
});
