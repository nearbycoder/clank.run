/* @clankImportSource ../vendor/dom.js */
import { computed, effect, signal } from "../vendor/core.js";
import { For, Show } from "../vendor/dom.js";
import {
  CLANK_THEME_PRESETS,
  UI_COMPONENT_CATALOG,
  UI_COMPONENT_COUNT,
  clankThemeVariables,
  getClankTheme,
} from "../vendor/ui.js";
import { ComponentStory } from "./stories.js";

export type StudioView = "overview" | "themes" | string;

export interface DesignStudioProps {
  initialView: StudioView;
  initialTheme: string;
  frameworkVersion: string;
}

const moduleLabels: Readonly<Record<string, string>> = Object.freeze({
  controls: "Controls",
  fields: "Fields",
  selection: "Selection",
  collections: "Collections",
  popups: "Popups",
  utilities: "Utilities",
});

const viewportWidths = Object.freeze({ responsive: "100%", mobile: "390px", tablet: "768px", desktop: "1120px" });

function titleFor(view: StudioView): string {
  if (view === "overview") return "Component workshop";
  if (view === "themes") return "Theme laboratory";
  return UI_COMPONENT_CATALOG.find((entry) => entry.slug === view)?.name ?? "Not found";
}

function routeFor(view: StudioView): string {
  return view === "overview" ? "/" : view === "themes" ? "/themes" : `/components/${view}`;
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

function ThemeMiniature(props: { theme: (typeof CLANK_THEME_PRESETS)[number]; active?: boolean; onSelect?: () => void }) {
  return (
    <button
      type="button"
      class="theme-miniature"
      classList={{ active: Boolean(props.active) }}
      style={clankThemeVariables(getClankTheme(props.theme.id) ?? CLANK_THEME_PRESETS[0])}
      data-scheme={props.theme.scheme}
      onClick={props.onSelect}
      aria-pressed={props.active ? "true" : "false"}
    >
      <span class="miniature-preview"><i /><i /><i /></span>
      <span><strong>{props.theme.name}</strong><small>{props.theme.scheme}</small></span>
    </button>
  );
}

function ThemeGallery(props: { selected: string; onSelect: (themeId: string) => void }) {
  return (
    <section class="theme-gallery" aria-labelledby="theme-gallery-title">
      <header class="view-heading">
        <span class="view-kicker">10 complete token systems</span>
        <h1 id="theme-gallery-title">One anatomy. Ten personalities.</h1>
        <p>Every preset changes color, geometry, density, depth, type, focus, and motion through the same dependency-free contract.</p>
      </header>
      <div class="theme-card-grid">
        <For each={CLANK_THEME_PRESETS} by="id">
          {(theme, index) => (
            <article class="theme-card" style={clankThemeVariables(getClankTheme(theme.id) ?? CLANK_THEME_PRESETS[0])} data-scheme={theme.scheme}>
              <header><span>{String(index() + 1).padStart(2, "0")}</span><button type="button" onClick={() => props.onSelect(theme.id)}>{props.selected === theme.id ? "Selected" : "Use theme"}</button></header>
              <div class="theme-card-canvas">
                <div class="theme-sample-nav"><i /><span /><span /></div>
                <div class="theme-sample-panel">
                  <small>Workspace</small><strong>New project</strong>
                  <input aria-label={`${theme.name} example input`} value="Design system" />
                  <div><button type="button">Continue</button><span class="theme-sample-switch"><i /></span></div>
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

function Overview(props: { themeId: string; onView: (view: StudioView) => void; onTheme: (id: string) => void }) {
  return (
    <div class="overview-page">
      <section class="overview-hero">
        <div class="overview-hero-copy">
          <span class="view-kicker">Clank Design · Framework {UI_COMPONENT_COUNT} / Themes 10</span>
          <h1>Inspect every state.<br /><em>Shape every surface.</em></h1>
          <p>A dependency-free component workshop built with the same Clank primitives it documents. Explore real keyboard behavior, semantic anatomy, agent metadata, and ten live token systems.</p>
          <div class="hero-actions"><button type="button" class="studio-button primary" onClick={() => props.onView(UI_COMPONENT_CATALOG[0].slug)}>Open first component <span>→</span></button><button type="button" class="studio-button" onClick={() => props.onView("themes")}>Compare themes</button></div>
        </div>
        <div class="hero-specimen" aria-label="Theme specimen">
          <div class="specimen-window"><header><i /><i /><i /><span>design.clank.run</span></header><div><aside><span /><span /><span /><span /></aside><main><span class="specimen-label">Component</span><h2>Dialog</h2><div class="specimen-dialog"><small>Workspace access</small><strong>Invite a teammate</strong><p>Send a secure invitation to your project.</p><button type="button">Send invite</button></div></main></div></div>
        </div>
      </section>
      <section class="proof-row" aria-label="Design system properties"><article><strong>37</strong><span>interactive families</span></article><article><strong>10</strong><span>complete themes</span></article><article><strong>32</strong><span>typed design tokens</span></article><article><strong>0</strong><span>runtime dependencies</span></article></section>
      <section class="overview-section">
        <header><div><span class="view-kicker">Theme presets</span><h2>Change the entire system in one click.</h2></div><button type="button" class="text-action" onClick={() => props.onView("themes")}>Open laboratory →</button></header>
        <div class="theme-miniature-grid"><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <ThemeMiniature theme={theme} active={theme.id === props.themeId} onSelect={() => props.onTheme(theme.id)} />}</For></div>
      </section>
      <section class="overview-section">
        <header><div><span class="view-kicker">Complete catalog</span><h2>Built from real Clank controllers.</h2></div><span class="section-note">Every example is interactive</span></header>
        <div class="component-index"><For each={UI_COMPONENT_CATALOG} by="slug">{(entry, index) => <a href={routeFor(entry.slug)} onClick={(event: MouseEvent) => { event.preventDefault(); props.onView(entry.slug); }}><span>{String(index() + 1).padStart(2, "0")}</span><div><strong>{entry.name}</strong><small>{entry.description}</small></div><i>→</i></a>}</For></div>
      </section>
    </div>
  );
}

function ComponentView(props: { slug: string; viewport: string; panel: string; grid: boolean; outlines: boolean; onViewport: (value: string) => void; onPanel: (value: string) => void; onGrid: () => void; onOutlines: () => void }) {
  const entry = UI_COMPONENT_CATALOG.find((candidate) => candidate.slug === props.slug);
  if (!entry) return <section class="not-found"><span>404</span><h1>That component is not in the catalog.</h1><a href="/">Return to the workshop</a></section>;
  const importLine = `import { ${entry.factory} } from "@clank.run/framework/ui/${entry.slug}";`;
  return (
    <section class="component-page">
      <header class="component-heading">
        <div><span class="view-kicker">{entry.module} / {entry.formAssociated ? "form associated" : "headless primitive"}</span><h1>{entry.name}</h1><p>{entry.description}</p></div>
        <div class="heading-links"><a href={entry.referenceUrl} target="_blank" rel="noreferrer">Anatomy reference <Icon name="external" /></a><a href="https://docs.clank.run/docs/ui">Framework guide <Icon name="external" /></a></div>
      </header>
      <div class="preview-toolbar" aria-label="Preview controls">
        <div class="segmented viewport-segments"><For each={Object.keys(viewportWidths)}>{(value) => <button type="button" classList={{ active: props.viewport === value }} onClick={() => props.onViewport(value)}>{value}</button>}</For></div>
        <div class="preview-flags"><button type="button" classList={{ active: props.grid }} onClick={props.onGrid}>Grid</button><button type="button" classList={{ active: props.outlines }} onClick={props.onOutlines}>Outlines</button></div>
      </div>
      <div class="preview-stage" data-grid={props.grid ? "" : undefined} data-outlines={props.outlines ? "" : undefined}>
        <div class="preview-frame" data-viewport={props.viewport} style={{ "--preview-width": viewportWidths[props.viewport as keyof typeof viewportWidths] ?? "100%" }}>
          <div class="preview-frame-label"><span>{entry.name} / interactive</span><span>{props.viewport === "responsive" ? "Fluid" : viewportWidths[props.viewport as keyof typeof viewportWidths]}</span></div>
          <div class="story-root"><ComponentStory slug={entry.slug} /></div>
        </div>
      </div>
      <section class="inspector">
        <div class="inspector-tabs" role="tablist" aria-label="Component details"><button type="button" role="tab" aria-selected={props.panel === "anatomy" ? "true" : "false"} onClick={() => props.onPanel("anatomy")}><Icon name="details" />Anatomy</button><button type="button" role="tab" aria-selected={props.panel === "code" ? "true" : "false"} onClick={() => props.onPanel("code")}><Icon name="code" />Usage</button><button type="button" role="tab" aria-selected={props.panel === "tokens" ? "true" : "false"} onClick={() => props.onPanel("tokens")}><Icon name="tokens" />Agent contract</button></div>
        <Show when={props.panel === "anatomy"}><div class="inspector-panel"><h2>Semantic parts</h2><p>Spread each part getter onto the matching element, then style its stable state attributes.</p><div class="part-list"><For each={entry.parts}>{(part) => <code>{part}</code>}</For></div></div></Show>
        <Show when={props.panel === "code"}><div class="inspector-panel"><h2>Focused package import</h2><p>The theme is visual. The controller remains unstyled, accessible, and fully typed.</p><pre><code>{importLine}{"\n\n"}{`const ${entry.slug.replaceAll("-", "_")} = ${entry.factory}({\n  id: "product-${entry.slug}",\n});`}</code></pre></div></Show>
        <Show when={props.panel === "tokens"}><div class="inspector-panel"><h2>Machine-readable by construction</h2><p>Agents can discover this component through the public catalog API or the Design Studio MCP server.</p><dl class="contract-grid"><div><dt>Factory</dt><dd><code>{entry.factory}</code></dd></div><div><dt>Subpath</dt><dd><code>@clank.run/framework/ui/{entry.slug}</code></dd></div><div><dt>Catalog module</dt><dd>{entry.module}</dd></div><div><dt>Form projection</dt><dd>{entry.formAssociated ? "Included" : "Not required"}</dd></div></dl></div></Show>
      </section>
    </section>
  );
}

export function DesignStudio(props: DesignStudioProps) {
  const view = signal<StudioView>(props.initialView);
  const themeId = signal(getClankTheme(props.initialTheme)?.id ?? "clank");
  const query = signal("");
  const viewport = signal("responsive");
  const panel = signal("anatomy");
  const grid = signal(true);
  const outlines = signal(false);
  const navOpen = signal(false);
  const currentTheme = computed(() => getClankTheme(themeId.value) ?? CLANK_THEME_PRESETS[0]);
  const filtered = computed(() => {
    const term = query.value.trim().toLowerCase();
    return term ? UI_COMPONENT_CATALOG.filter((entry) => `${entry.name} ${entry.description} ${entry.module}`.toLowerCase().includes(term)) : UI_COMPONENT_CATALOG;
  });
  const grouped = Object.fromEntries(Object.keys(moduleLabels).map((module) => [
    module,
    computed(() => filtered.value.filter((entry) => entry.module === module)),
  ]));

  function selectView(next: StudioView, replace = false) {
    view.value = next;
    navOpen.value = false;
    if (typeof history !== "undefined") history[replace ? "replaceState" : "pushState"]({ view: next }, "", routeFor(next));
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "auto" });
  }

  effect(() => {
    const theme = currentTheme.value;
    if (typeof document === "undefined") return;
    document.documentElement.dataset.clankTheme = theme.id;
    document.documentElement.style.colorScheme = theme.scheme;
    try { localStorage.setItem("clank-design-theme", theme.id); } catch {}
  });

  if (typeof window !== "undefined") {
    window.addEventListener("popstate", () => {
      const path = window.location.pathname;
      view.value = path === "/themes" ? "themes" : path.startsWith("/components/") ? decodeURIComponent(path.slice(12)) : "overview";
    });
  }

  return (
    <div class="studio-shell" data-theme={themeId}>
      <a class="skip-link" href="#studio-main">Skip to component preview</a>
      <header class="studio-header">
        <button class="mobile-nav-trigger" type="button" aria-label="Open component navigation" aria-expanded={navOpen} onClick={() => { navOpen.value = !navOpen.peek(); }}><Icon name="menu" /></button>
        <a class="studio-wordmark" href="/" onClick={(event: MouseEvent) => { event.preventDefault(); selectView("overview"); }}><img src="/brand/clank-mark-64.png" width="25" height="25" alt="" /><strong>Clank</strong><span>Design</span></a>
        <label class="studio-search"><Icon name="search" /><input type="search" value={query} onInput={(event: InputEvent) => { query.value = (event.currentTarget as HTMLInputElement).value; }} placeholder="Search 37 components…" /><kbd>/</kbd></label>
        <nav class="studio-header-links" aria-label="Project"><a href="https://docs.clank.run/docs/ui">Docs</a><a href="https://github.com/nearbycoder/clank.run" target="_blank" rel="noreferrer">GitHub ↗</a></nav>
      </header>
      <aside class="studio-sidebar" classList={{ open: navOpen }}>
        <div class="sidebar-primary"><a href="/" classList={{ active: view.value === "overview" }} onClick={(event: MouseEvent) => { event.preventDefault(); selectView("overview"); }}><Icon name="grid" />Overview</a><a href="/themes" classList={{ active: view.value === "themes" }} onClick={(event: MouseEvent) => { event.preventDefault(); selectView("themes"); }}><Icon name="palette" />Themes <span>10</span></a></div>
        <nav class="component-nav" aria-label="Component catalog">
          <For each={Object.keys(moduleLabels)}>{(module) => <section><h2>{moduleLabels[module]}</h2><For each={grouped[module]} by="slug" fallback={<span class="nav-empty">No matches</span>}>{(entry) => <a href={routeFor(entry.slug)} classList={{ active: view.value === entry.slug }} aria-current={view.value === entry.slug ? "page" : undefined} onClick={(event: MouseEvent) => { event.preventDefault(); selectView(entry.slug); }}><span>{entry.name}</span><small>{entry.parts.length}</small></a>}</For></section>}</For>
        </nav>
        <div class="sidebar-footer"><span>Framework</span><strong>v{props.frameworkVersion}</strong><a href="/__clank/mcp">MCP ↗</a></div>
      </aside>
      <button type="button" class="sidebar-scrim" aria-label="Close navigation" hidden={!navOpen.value} onClick={() => { navOpen.value = false; }} />
      <main class="studio-main" id="studio-main">
        <div class="context-bar">
          <div><span>Clank Design</span><i>/</i><strong>{() => titleFor(view.value)}</strong></div>
          <label class="theme-picker"><span class="theme-dot" /><span class="theme-picker-label">Theme</span><select value={themeId} onChange={(event: Event) => { themeId.value = (event.currentTarget as HTMLSelectElement).value; }}><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <option value={theme.id}>{theme.name}</option>}</For></select></label>
        </div>
        <div class="studio-content">
          <Show when={() => view.value === "overview"}><Overview themeId={themeId.value} onView={selectView} onTheme={(id) => { themeId.value = id; }} /></Show>
          <Show when={() => view.value === "themes"}><ThemeGallery selected={themeId.value} onSelect={(id) => { themeId.value = id; }} /></Show>
          <Show when={() => view.value !== "overview" && view.value !== "themes"}><ComponentView slug={view.value} viewport={viewport.value} panel={panel.value} grid={grid.value} outlines={outlines.value} onViewport={(value) => { viewport.value = value; }} onPanel={(value) => { panel.value = value; }} onGrid={() => { grid.value = !grid.peek(); }} onOutlines={() => { outlines.value = !outlines.peek(); }} /></Show>
        </div>
      </main>
    </div>
  );
}
