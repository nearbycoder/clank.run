/* @clankImportSource ../vendor/dom.js */
import { For, Show, computed, effect, onMount, signal } from "../vendor/dom.js";
import {
  CLANK_THEME_PRESETS,
  UI_COMPONENT_CATALOG,
  UI_COMPONENT_COUNT,
  clankThemeVariables,
  getClankTheme,
  type UiCatalogEntry,
} from "../vendor/ui.js";
import { ComponentStory } from "./stories.js";
import { createSpecimenReset } from "./tools/specimen-reset.js";
import { KeyboardGuide } from "./tools/keyboard-guide.js";
import { TokenInspector } from "./tools/token-inspector.js";
import { ContrastChecker } from "./tools/contrast-checker.js";
import { ThemeExport } from "./tools/theme-export.js";
import { ThemeComparison } from "./tools/theme-comparison.js";
import { ThemeSandbox } from "./tools/theme-sandbox.js";
import { PreviewWidthControls } from "./tools/preview-width.js";
import { observePreviewWidth, parsePreviewWidth, previewWidthLabel, previewWidthStyle, type PreviewWidth } from "./tools/preview-width-data.js";
import { catalogModuleLabels as moduleLabels, catalogFilterOptions, filterComponentCatalog } from "./tools/catalog-filters-data.js";
import { SharePreviewLink } from "./tools/share-settings.js";
import { parsePreviewSettings, previewSettingsQuery, shouldNavigatePreview, studioViewFromPath, validatePreviewSettings, type PreviewSettings, type InspectorPanel } from "./tools/share-settings-data.js";

export type StudioView = "overview" | "themes" | string;

export interface DesignStudioProps {
  initialView: StudioView;
  initialTheme: string;
  initialSettings?: PreviewSettings;
  frameworkVersion: string;
}


function titleFor(view: StudioView): string {
  if (view === "overview") return "Component workshop";
  if (view === "themes") return "Theme laboratory";
  return UI_COMPONENT_CATALOG.find((entry) => entry.slug === view)?.name ?? "Not found";
}

function routeFor(view: StudioView): string {
  return view === "overview" ? "/" : view === "themes" ? "/themes" : `/components/${encodeURIComponent(view)}`;
}

function Icon(props: { name: "grid" | "palette" | "search" | "menu" | "code" | "details" | "tokens" | "external" }) {
  const paths = {
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    palette: "M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 1.2-3.1 1.6 1.6 0 0 1 1.1-2.8H18A3 3 0 0 0 21 12a9 9 0 0 0-9-9ZM7.4 12.4h.1m1.6-4h.1m4.2-.8h.1m3.1 3.1h.1",
    search: "m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
    menu: "M4 7h16M4 12h16M4 17h16",
    code: "m8 9-3 3 3 3m8-6 3 3-3 3m-5-9-2 12",
    details: "M4 5h16M4 12h10M4 19h13",
    tokens: "M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 0v9m8-4.5-8 4.5-8-4.5m8 4.5v9",
    external: "M14 4h6v6m0-6-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5",
  } as const;
  return <svg class="studio-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[props.name]} /></svg>;
}

function ThemeMiniature(props: { theme: (typeof CLANK_THEME_PRESETS)[number]; active: () => boolean; onSelect?: () => void }) {
  return (
    <button
      type="button"
      class="theme-miniature"
      classList={{ active: props.active() }}
      style={clankThemeVariables(getClankTheme(props.theme.id) ?? CLANK_THEME_PRESETS[0])}
      data-scheme={props.theme.scheme}
      onClick={props.onSelect}
      aria-pressed={props.active() ? "true" : "false"}
    >
      <span class="miniature-preview"><i /><i /><i /></span>
      <span><strong>{props.theme.name}</strong><small>{props.theme.scheme}</small></span>
    </button>
  );
}

function ThemeGallery(props: { selected: () => string; onSelect: (themeId: string) => void }) {
  return (
    <section class="theme-gallery" aria-labelledby="theme-gallery-title">
      <header class="view-heading">
        <span class="view-kicker">10 complete token systems</span>
        <h1 id="theme-gallery-title">One anatomy. Ten personalities.</h1>
        <p>Every preset changes color, geometry, density, depth, type, focus, and motion through the same dependency-free contract.</p>
      </header>
      <section class="theme-tools" aria-label="Theme tools">
        <details class="theme-tool">
          <summary><strong>Token inspector</strong><span>Search the selected theme’s complete token map</span></summary>
          <div class="theme-tool-body"><TokenInspector theme={() => getClankTheme(props.selected()) ?? CLANK_THEME_PRESETS[0]} /></div>
        </details>
        <details class="theme-tool">
          <summary><strong>Contrast checker</strong><span>Compare foreground and background theme tokens</span></summary>
          <div class="theme-tool-body"><ContrastChecker theme={() => getClankTheme(props.selected()) ?? CLANK_THEME_PRESETS[0]} /></div>
        </details>
        <details class="theme-tool">
          <summary><strong>Theme export</strong><span>Copy or download the selected theme as CSS or JSON</span></summary>
          <div class="theme-tool-body"><ThemeExport theme={() => getClankTheme(props.selected()) ?? CLANK_THEME_PRESETS[0]} /></div>
        </details>
        <details class="theme-tool">
          <summary><strong>Theme comparison</strong><span>See exactly which token values differ between two presets</span></summary>
          <div class="theme-tool-body"><ThemeComparison theme={() => getClankTheme(props.selected()) ?? CLANK_THEME_PRESETS[0]} /></div>
        </details>
        <details class="theme-tool">
          <summary><strong>Token sandbox</strong><span>Try safe token overrides in a scoped live sample</span></summary>
          <div class="theme-tool-body"><ThemeSandbox theme={() => getClankTheme(props.selected()) ?? CLANK_THEME_PRESETS[0]} /></div>
        </details>
      </section>
      <div class="theme-card-grid">
        <For each={CLANK_THEME_PRESETS} by="id">
          {(theme, index) => (
            <article class="theme-card" style={clankThemeVariables(getClankTheme(theme.id) ?? CLANK_THEME_PRESETS[0])} data-scheme={theme.scheme}>
              <header><span>{String(index() + 1).padStart(2, "0")}</span><button type="button" onClick={() => props.onSelect(theme.id)}>{props.selected() === theme.id ? "Selected" : "Use theme"}</button></header>
              <div class="theme-card-canvas">
                <div class="theme-sample-nav"><i /><span /><span /></div>
                <div class="theme-sample-panel">
                  <small>Workspace</small><strong>New project</strong>
                  <input aria-label={`${theme.name} example input`} value="Design system" />
                  <div><button type="button" onClick={() => props.onSelect(theme.id)}>Apply theme</button><span class="theme-sample-switch"><i /></span></div>
                </div>
              </div>
              <div class="theme-card-copy"><div><h2>{theme.name}</h2><span>{theme.scheme}</span></div><p>{theme.description}</p><div class="theme-tags"><For each={theme.tags}>{(tag) => <span>{tag}</span>}</For></div></div>
            </article>
          )}
        </For>
      </div>
    </section>
  );
}

function Overview(props: { themeId: () => string; href: (view: StudioView) => string; onView: (view: StudioView) => void; onTheme: (id: string) => void }) {
  return (
    <div class="overview-page">
      <section class="overview-hero">
        <div class="overview-hero-copy">
          <span class="view-kicker">Clank Design · Framework {UI_COMPONENT_COUNT} / Themes 10</span>
          <h1>Inspect every state.<br /><em>Shape every surface.</em></h1>
          <p>A dependency-free component workshop built with the same Clank primitives it documents. Explore real keyboard behavior, semantic anatomy, agent metadata, and ten live token systems.</p>
          <div class="hero-actions"><button type="button" class="studio-button primary" onClick={() => props.onView(UI_COMPONENT_CATALOG[0].slug)}>Open first component <span>→</span></button><button type="button" class="studio-button" onClick={() => props.onView("themes")}>Compare themes</button></div>
        </div>
        <div class="hero-specimen" role="region" aria-label="Interactive dialog preview">
          <div class="specimen-header"><span>Live component</span><span>Dialog</span></div>
          <div class="specimen-content"><h2>Invite a teammate</h2><p>Try the modal, move through its fields with Tab, and press Escape to return.</p><ComponentStory slug="dialog" /></div>
        </div>
      </section>
      <section class="proof-row" aria-label="Design system properties"><article><strong>{UI_COMPONENT_COUNT}</strong><span>interactive families</span></article><article><strong>10</strong><span>complete themes</span></article><article><strong>32</strong><span>typed design tokens</span></article><article><strong>0</strong><span>runtime dependencies</span></article></section>
      <section class="overview-section">
        <header><div><span class="view-kicker">Theme presets</span><h2>Change the entire system in one click.</h2></div><button type="button" class="text-action" onClick={() => props.onView("themes")}>Open laboratory →</button></header>
        <div class="theme-miniature-grid"><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <ThemeMiniature theme={theme} active={() => theme.id === props.themeId()} onSelect={() => props.onTheme(theme.id)} />}</For></div>
      </section>
      <section class="overview-section">
        <header><div><span class="view-kicker">Complete catalog</span><h2>Built from real Clank controllers.</h2></div><span class="section-note">Every example is interactive</span></header>
        <div class="component-index"><For each={UI_COMPONENT_CATALOG} by="slug">{(entry, index) => <a href={props.href(entry.slug)} onClick={(event: MouseEvent) => { if (!shouldNavigatePreview(event)) return; event.preventDefault(); props.onView(entry.slug); }}><span>{String(index() + 1).padStart(2, "0")}</span><div><strong>{entry.name}</strong><small>{entry.description}</small></div><i>→</i></a>}</For></div>
      </section>
    </div>
  );
}

function ComponentView(props: { entry: UiCatalogEntry; viewport: () => PreviewWidth; panel: () => string; grid: () => boolean; outlines: () => boolean; onViewport: (value: PreviewWidth) => void; onPanel: (value: string) => void; onGrid: () => void; onOutlines: () => void }) {
  const entry = props.entry;
  const specimen = createSpecimenReset(() => <ComponentStory slug={entry.slug} />);
  const importLine = `import { ${entry.factory} } from "@clank.run/framework/ui/${entry.slug}";`;
  let previewFrame: HTMLElement | null = null;
  const renderedWidth = signal<number | null>(null);
  onMount(() => previewFrame ? observePreviewWidth(previewFrame, (width) => { renderedWidth.value = width; }) : undefined);
  return (
    <section class="component-page">
      <header class="component-heading">
        <div><span class="view-kicker">{moduleLabels[entry.module] ?? entry.module} / {entry.formAssociated ? "form associated" : "headless primitive"}</span><h1>{entry.name}</h1><p>{entry.description}</p></div>
        <div class="heading-links"><a href={entry.referenceUrl} target="_blank" rel="noreferrer">{entry.source === "clank" ? "Pattern reference" : "Anatomy reference"} <Icon name="external" /></a><a href="https://docs.clank.run/docs/ui">Framework guide <Icon name="external" /></a></div>
      </header>
      <div class="preview-toolbar" role="group" aria-label="Preview controls">
        <PreviewWidthControls value={props.viewport} onChange={props.onViewport} />
        <div class="preview-flags"><button type="button" classList={{ active: props.grid() }} aria-pressed={props.grid() ? "true" : "false"} onClick={props.onGrid}>Grid</button><button type="button" classList={{ active: props.outlines() }} aria-pressed={props.outlines() ? "true" : "false"} onClick={props.onOutlines}>Outlines</button><button type="button" onClick={specimen.reset} title="Restore the component’s initial state; keep preview settings">Reset specimen</button></div>
      </div>
      <div class="preview-stage" data-grid={props.grid() ? "" : undefined} data-outlines={props.outlines() ? "" : undefined}>
        <div class="preview-frame" ref={(element: HTMLElement | null) => { previewFrame = element; }} data-viewport={typeof props.viewport() === "number" ? "custom" : props.viewport()} style={{ "--preview-width": previewWidthStyle(props.viewport()) }}>
          <div class="preview-frame-label"><span>{entry.name} / interactive</span><span>{previewWidthLabel(props.viewport(), renderedWidth.value)}</span></div>
          <div class="story-root">{specimen.render}</div>
        </div>
      </div>
      <section class="inspector">
        <div class="inspector-tabs" role="tablist" aria-label="Component details"><button type="button" role="tab" aria-selected={props.panel() === "anatomy" ? "true" : "false"} onClick={() => props.onPanel("anatomy")}><Icon name="details" />Anatomy</button><button type="button" role="tab" aria-selected={props.panel() === "code" ? "true" : "false"} onClick={() => props.onPanel("code")}><Icon name="code" />Usage</button><button type="button" role="tab" aria-selected={props.panel() === "tokens" ? "true" : "false"} onClick={() => props.onPanel("tokens")}><Icon name="tokens" />Agent contract</button></div>
        <Show when={() => props.panel() === "anatomy"}><div class="inspector-panel"><h2>Semantic parts</h2><p>Spread each part getter onto the matching element, then style its stable state attributes.</p><div class="part-list"><For each={entry.parts}>{(part) => <code>{part}</code>}</For></div></div></Show>
        <Show when={() => props.panel() === "code"}><div class="inspector-panel"><h2>Focused package import</h2><p>The theme is visual. The controller remains unstyled, accessible, and fully typed.</p><pre tabindex="0" role="region" aria-label="Component usage example"><code>{importLine}{"\n\n"}{`const ${entry.slug.replaceAll("-", "_")} = ${entry.factory}({\n  id: "product-${entry.slug}",\n});`}</code></pre></div></Show>
        <Show when={() => props.panel() === "tokens"}><div class="inspector-panel"><h2>Machine-readable by construction</h2><p>Agents can discover this component through the public catalog API or the Design Studio MCP server.</p><dl class="contract-grid"><div><dt>Factory</dt><dd><code>{entry.factory}</code></dd></div><div><dt>Subpath</dt><dd><code>@clank.run/framework/ui/{entry.slug}</code></dd></div><div><dt>Catalog module</dt><dd>{entry.module}</dd></div><div><dt>Form projection</dt><dd>{entry.formAssociated ? "Included" : "Not required"}</dd></div></dl></div></Show>
      </section>
      <KeyboardGuide slug={entry.slug} />
    </section>
  );
}

export function DesignStudio(props: DesignStudioProps) {
  const initial = validatePreviewSettings(props.initialSettings ?? { theme: props.initialTheme });
  const view = signal<StudioView>(props.initialView);
  const themeId = signal(initial.theme);
  const query = signal("");
  const catalogModule = signal("all");
  const catalogForm = signal("all");
  const catalogSource = signal("all");
  const catalogOptions = catalogFilterOptions(UI_COMPONENT_CATALOG);
  const viewport = signal<PreviewWidth>(initial.width);
  const panel = signal<InspectorPanel>(initial.panel);
  const grid = signal(initial.grid);
  const outlines = signal(initial.outlines);
  const navOpen = signal(false);
  const currentTheme = computed(() => getClankTheme(themeId.value) ?? CLANK_THEME_PRESETS[0]);
  const filtered = computed(() => filterComponentCatalog(UI_COMPONENT_CATALOG, query.value, { module: catalogModule.value, form: catalogForm.value, source: catalogSource.value }));
  const visibleModules = computed(() => catalogOptions.modules.filter((option) => filtered.value.entries.some((entry) => entry.module === option.value)));
  const previewOutsideResults = computed(() => UI_COMPONENT_CATALOG.some((entry) => entry.slug === view.value) && !filtered.value.entries.some((entry) => entry.slug === view.value));
  function resetCatalogFilters() {
    query.value = "";
    catalogModule.value = "all";
    catalogForm.value = "all";
    catalogSource.value = "all";
  }
  const activeComponents = computed(() => UI_COMPONENT_CATALOG.filter((entry) => entry.slug === view.value));

  const settingsQuery = computed(() => previewSettingsQuery({ theme: themeId.value, width: viewport.value, panel: panel.value, grid: grid.value, outlines: outlines.value }));
  const previewHref = (next: StudioView) => `${routeFor(next)}${settingsQuery.value}`;
  function writeLocation() {
    if (typeof window === "undefined") return;
    const path = previewHref(view.peek());
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, "", path);
  }
  function selectView(next: StudioView) {
    view.value = next;
    navOpen.value = false;
    writeLocation();
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "auto" });
  }
  function selectTheme(id: string) {
    const theme = getClankTheme(id);
    if (!theme) return;
    themeId.value = theme.id;
    writeLocation();
  }
  function selectWidth(value: PreviewWidth) {
    const width = parsePreviewWidth(value);
    if (width === null) return;
    viewport.value = width;
    writeLocation();
  }
  function selectPanel(value: string) {
    if (value !== "anatomy" && value !== "code" && value !== "tokens") return;
    panel.value = value;
    writeLocation();
  }

  effect(() => {
    const theme = currentTheme.value;
    if (typeof document === "undefined") return;
    document.documentElement.dataset.clankTheme = theme.id;
    document.documentElement.style.colorScheme = theme.scheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.tokens.canvas);
    try { localStorage.setItem("clank-design-theme", theme.id); } catch {}
  });

  onMount(() => {
    const restoreLocation = () => {
      const settings = parsePreviewSettings(window.location.search);
      themeId.value = settings.theme;
      viewport.value = settings.width;
      panel.value = settings.panel;
      grid.value = settings.grid;
      outlines.value = settings.outlines;
      view.value = studioViewFromPath(window.location.pathname);
      navOpen.value = false;
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  });

  return (
    <div class="studio-shell" data-theme={themeId}>
      <a class="skip-link" href="#studio-main">Skip to component preview</a>
      <header class="studio-header">
        <button class="mobile-nav-trigger" type="button" aria-label="Open component navigation" aria-expanded={navOpen} onClick={() => { navOpen.value = !navOpen.peek(); }}><Icon name="menu" /></button>
        <a class="studio-wordmark" href={previewHref("overview")} onClick={(event: MouseEvent) => { if (!shouldNavigatePreview(event)) return; event.preventDefault(); selectView("overview"); }}><img src="/brand/clank-mark-64.png" width="25" height="25" alt="" aria-hidden="true" /><strong>Clank</strong><span>Design</span></a>
        <label class="studio-search"><Icon name="search" /><input type="search" aria-label="Search components" value={query} onInput={(event: InputEvent) => { query.value = (event.currentTarget as HTMLInputElement).value; if (window.matchMedia("(max-width: 760px)").matches) navOpen.value = true; }} placeholder={`Search ${UI_COMPONENT_COUNT} components…`} /><kbd>/</kbd></label>
        <nav class="studio-header-links" aria-label="Project"><a href="https://docs.clank.run/docs/ui">Docs</a><a href="https://github.com/nearbycoder/clank.run" target="_blank" rel="noreferrer">GitHub ↗</a></nav>
      </header>
      <aside class="studio-sidebar" classList={{ open: navOpen }}>
        <div class="sidebar-primary"><a href={previewHref("overview")} classList={{ active: view.value === "overview" }} onClick={(event: MouseEvent) => { if (!shouldNavigatePreview(event)) return; event.preventDefault(); selectView("overview"); }}><Icon name="grid" />Overview</a><a href={previewHref("themes")} classList={{ active: view.value === "themes" }} onClick={(event: MouseEvent) => { if (!shouldNavigatePreview(event)) return; event.preventDefault(); selectView("themes"); }}><Icon name="palette" />Themes <span>10</span></a></div>
        <nav class="component-nav" aria-label="Component catalog">
          <details class="catalog-filters">
            <summary>Filter components <span>{() => filtered.value.activeCount ? `(${filtered.value.activeCount})` : ""}</span></summary>
            <div class="catalog-filter-fields">
              <label for="catalog-module">Category</label>
              <select id="catalog-module" value={catalogModule} onChange={(event: Event) => { catalogModule.value = (event.currentTarget as HTMLSelectElement).value; }}><option value="all" selected={catalogModule.value === "all"}>All categories</option><For each={catalogOptions.modules} by="value">{(option) => <option value={option.value} selected={catalogModule.value === option.value}>{option.label}</option>}</For></select>
              <label for="catalog-form">Form associated</label>
              <select id="catalog-form" value={catalogForm} onChange={(event: Event) => { catalogForm.value = (event.currentTarget as HTMLSelectElement).value; }}><option value="all" selected={catalogForm.value === "all"}>All components</option><option value="yes" selected={catalogForm.value === "yes"}>Yes</option><option value="no" selected={catalogForm.value === "no"}>No</option></select>
              <label for="catalog-source">Source</label>
              <select id="catalog-source" value={catalogSource} onChange={(event: Event) => { catalogSource.value = (event.currentTarget as HTMLSelectElement).value; }}><option value="all" selected={catalogSource.value === "all"}>All sources</option><For each={catalogOptions.sources} by="value">{(option) => <option value={option.value} selected={catalogSource.value === option.value}>{option.label}</option>}</For></select>
            </div>
          </details>
          <div class="catalog-result-count"><span role="status" aria-live="polite">{() => `${filtered.value.count} of ${filtered.value.total} components`}</span><button type="button" disabled={!filtered.value.activeCount && !filtered.value.hasQuery} onClick={resetCatalogFilters}>Reset</button></div>
          <Show when={previewOutsideResults}><div class="catalog-current-preview"><span>Current preview · outside results</span><a href={previewHref(view.value)} aria-current="page" onClick={(event: MouseEvent) => { if (!shouldNavigatePreview(event)) return; event.preventDefault(); selectView(view.peek()); }}>{() => titleFor(view.value)}</a></div></Show>
          <Show when={() => filtered.value.count === 0}><div class="catalog-no-results"><strong>No components match</strong><p>Try another search or reset the filters to browse the full catalog.</p><button type="button" onClick={resetCatalogFilters}>Clear search and filters</button></div></Show>
          <For each={visibleModules} by="value">{(module) => <section><h2>{module.label}</h2><For each={() => filtered.value.entries.filter((entry) => entry.module === module.value)} by="slug">{(entry) => <a href={previewHref(entry.slug)} classList={{ active: view.value === entry.slug }} aria-current={view.value === entry.slug ? "page" : undefined} onClick={(event: MouseEvent) => { if (!shouldNavigatePreview(event)) return; event.preventDefault(); selectView(entry.slug); }}><span>{entry.name}</span><small>{entry.parts.length}</small></a>}</For></section>}</For>
        </nav>
        <div class="sidebar-footer"><span>Framework</span><strong>v{props.frameworkVersion}</strong><a href="/__clank/mcp">MCP ↗</a></div>
      </aside>
      <button type="button" class="sidebar-scrim" aria-label="Close navigation" hidden={!navOpen.value} onClick={() => { navOpen.value = false; }} />
      <main class="studio-main" id="studio-main">
        <div class="context-bar">
          <div><span>Clank Design</span><i>/</i><strong>{() => titleFor(view.value)}</strong></div>
          <label class="theme-picker"><span class="theme-dot" /><span class="theme-picker-label">Theme</span><select aria-label="Theme" value={themeId} onChange={(event: Event) => selectTheme((event.currentTarget as HTMLSelectElement).value)}><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <option value={theme.id} selected={theme.id === themeId.value}>{theme.name}</option>}</For></select></label>
        </div>
        <div class="studio-content">
          <SharePreviewLink href={() => previewHref(view.value)} />
          <Show when={() => view.value === "overview"}><Overview themeId={() => themeId.value} href={previewHref} onView={selectView} onTheme={selectTheme} /></Show>
          <Show when={() => view.value === "themes"}><ThemeGallery selected={() => themeId.value} onSelect={selectTheme} /></Show>
          <Show when={() => view.value !== "overview" && view.value !== "themes"}>
            <For
              each={activeComponents}
              by="slug"
              fallback={<section class="not-found"><span>404</span><h1>That component is not in the catalog.</h1><a href="/">Return to the workshop</a></section>}
            >
              {(entry) => <ComponentView entry={entry} viewport={() => viewport.value} panel={() => panel.value} grid={() => grid.value} outlines={() => outlines.value} onViewport={selectWidth} onPanel={selectPanel} onGrid={() => { grid.value = !grid.peek(); writeLocation(); }} onOutlines={() => { outlines.value = !outlines.peek(); writeLocation(); }} />}
            </For>
          </Show>
        </div>
      </main>
    </div>
  );
}
