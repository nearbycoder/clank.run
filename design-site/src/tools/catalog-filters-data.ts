import type { UiCatalogEntry } from "../../vendor/ui.js";

export const catalogModuleLabels: Readonly<Record<string, string>> = Object.freeze({
  controls: "Controls", fields: "Fields", selection: "Selection", collections: "Collections",
  popups: "Popups", utilities: "Utilities", legacy: "Navigation",
});

export interface CatalogFilters {
  module: string;
  form: "all" | "yes" | "no";
  source: "all" | "base-ui" | "clank";
}

export const DEFAULT_CATALOG_FILTERS: Readonly<CatalogFilters> = Object.freeze({ module: "all", form: "all", source: "all" });

/** Options follow the catalog, including a readable fallback for new implementation modules. */
export function catalogFilterOptions(catalog: readonly UiCatalogEntry[]) {
  return {
    modules: [...new Set(catalog.map((entry) => entry.module))].map((value) => ({ value, label: catalogModuleLabels[value] ?? value })).sort((a, b) => a.label.localeCompare(b.label)),
    sources: [...new Set(catalog.map((entry) => entry.source))].sort().map((value) => ({ value, label: value === "base-ui" ? "Base UI" : "Clank" })),
  };
}

/** Invalid controls fall back independently; they cannot make a valid catalog inaccessible. */
export function filterComponentCatalog(catalog: readonly UiCatalogEntry[], query: unknown = "", input: unknown = DEFAULT_CATALOG_FILTERS) {
  const candidate = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const filters: CatalogFilters = {
    module: typeof candidate.module === "string" && catalog.some((entry) => entry.module === candidate.module) ? candidate.module : "all",
    form: candidate.form === "yes" || candidate.form === "no" ? candidate.form : "all",
    source: (candidate.source === "base-ui" || candidate.source === "clank") && catalog.some((entry) => entry.source === candidate.source) ? candidate.source : "all",
  };
  const term = typeof query === "string" ? query.trim().toLowerCase() : "";
  const entries = catalog.filter((entry) =>
    (filters.module === "all" || entry.module === filters.module) &&
    (filters.form === "all" || entry.formAssociated === (filters.form === "yes")) &&
    (filters.source === "all" || entry.source === filters.source) &&
    (!term || `${entry.name} ${entry.description} ${entry.module}`.toLowerCase().includes(term)),
  );
  return { entries, total: catalog.length, count: entries.length, filters, activeCount: Number(filters.module !== "all") + Number(filters.form !== "all") + Number(filters.source !== "all"), hasQuery: term.length > 0 };
}
