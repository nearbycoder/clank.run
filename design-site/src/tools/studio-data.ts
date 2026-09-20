import { createTabs, type UiCatalogEntry, type ClankTheme } from "../../vendor/ui.js";
import { effect } from "../../vendor/dom.js";
import type { InspectorPanel } from "./share-settings-data.js";

export const INSPECTOR_PANELS = [
  { value: "anatomy", textValue: "Anatomy", icon: "details" },
  { value: "code", textValue: "Usage", icon: "code" },
  { value: "tokens", textValue: "Agent contract", icon: "tokens" },
] as const;

export function createInspectorTabs(slug: string, value: () => InspectorPanel, onChange: (value: InspectorPanel) => void) {
  const tabs = createTabs<InspectorPanel>({ id: `inspector-${slug}`, items: INSPECTOR_PANELS, value,
    activationMode: "automatic", onValueChange: (next) => { if (next) onChange(next); } });
  const stop = effect(() => { tabs.select(value()); });
  return { ...tabs, dispose: () => { stop(); tabs.dispose(); } };
}

export function componentUsage(entry: Pick<UiCatalogEntry, "slug" | "factory">): string {
  return `import { ${entry.factory} } from "@clank.run/framework/ui/${entry.slug}";\n\nconst ${entry.slug.replaceAll("-", "_")} = ${entry.factory}({\n  id: "product-${entry.slug}",\n});`;
}

export const FAVORITES_KEY = "clank.design.favorites.v1";
type Catalog = readonly Pick<UiCatalogEntry, "slug">[];
export function favoriteComponentIds(value: unknown, catalog: Catalog): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const stored = value as { version?: unknown; ids?: unknown };
  if (stored.version !== 1 || !Array.isArray(stored.ids)) return [];
  const allowed = new Set(catalog.map((entry) => entry.slug));
  const ids: string[] = [];
  for (const id of stored.ids.slice(0, 128)) {
    if (typeof id === "string" && allowed.has(id) && !ids.includes(id)) ids.push(id);
    if (ids.length === allowed.size) break;
  }
  return ids;
}

export function readFavoriteComponents(catalog: Catalog, fallback: readonly string[] = []): string[] {
  let raw: string | null;
  try { raw = localStorage.getItem(FAVORITES_KEY); }
  catch { return favoriteComponentIds({ version: 1, ids: fallback }, catalog); }
  if (!raw || raw.length > 8192) return [];
  try { return favoriteComponentIds(JSON.parse(raw), catalog); } catch { return []; }
}

export function toggleFavoriteComponent(catalog: Catalog, current: readonly string[], id: string): string[] {
  const ids = favoriteComponentIds({ version: 1, ids: current }, catalog);
  if (!catalog.some((entry) => entry.slug === id)) return ids;
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [id, ...ids];
}

export function saveFavoriteComponents(catalog: Catalog, ids: readonly string[]): boolean {
  const checked = favoriteComponentIds({ version: 1, ids }, catalog);
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify({ version: 1, ids: checked })); return true; }
  catch { return false; }
}

export function filterThemeGallery(themes: readonly ClankTheme[], query: unknown, scheme: unknown) {
  const text = typeof query === "string" ? query.trim().toLowerCase().slice(0, 160) : "";
  const mode = scheme === "light" || scheme === "dark" ? scheme : "all";
  const entries = themes.filter((theme) => (mode === "all" || theme.scheme === mode)
    && `${theme.name} ${theme.description} ${theme.tags.join(" ")}`.toLowerCase().includes(text));
  return { entries, count: entries.length, total: themes.length, active: Boolean(text) || mode !== "all" };
}
