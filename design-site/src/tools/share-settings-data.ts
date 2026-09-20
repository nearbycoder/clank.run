import { CLANK_THEME_PRESETS, UI_COMPONENT_CATALOG } from "../../vendor/ui.js";
import { parsePreviewWidth, type PreviewWidth } from "./preview-width-data.js";

export type InspectorPanel = "anatomy" | "code" | "tokens";
export interface PreviewSettings {
  theme: string;
  width: PreviewWidth;
  grid: boolean;
  outlines: boolean;
  panel: InspectorPanel;
}

export const DEFAULT_PREVIEW_SETTINGS: Readonly<PreviewSettings> = Object.freeze({ theme: "clank", width: "responsive", grid: false, outlines: false, panel: "anatomy" });

/** URL and hydration input is a small allowlisted contract, never CSS or a remote resource. */
export function validatePreviewSettings(value: Partial<Record<keyof PreviewSettings, unknown>> = {}): PreviewSettings {
  return {
    theme: typeof value.theme === "string" && CLANK_THEME_PRESETS.some((theme) => theme.id === value.theme) ? value.theme : "clank",
    width: parsePreviewWidth(value.width) ?? "responsive",
    grid: value.grid === true,
    outlines: value.outlines === true,
    panel: value.panel === "code" || value.panel === "tokens" ? value.panel : "anatomy",
  };
}

export function parsePreviewSettings(search: string): PreviewSettings {
  if (typeof search !== "string" || search.length > 2048) return { ...DEFAULT_PREVIEW_SETTINGS };
  const params = new URLSearchParams(search);
  const single = (name: string) => { const values = params.getAll(name); return values.length === 1 ? values[0] : undefined; };
  return validatePreviewSettings({ theme: single("theme"), width: single("width"), grid: single("grid") === "1", outlines: single("outlines") === "1", panel: single("panel") });
}

export function previewSettingsQuery(value: Partial<Record<keyof PreviewSettings, unknown>>): string {
  const settings = validatePreviewSettings(value);
  const params = new URLSearchParams();
  if (settings.theme !== "clank") params.set("theme", settings.theme);
  if (settings.width !== "responsive") params.set("width", String(settings.width));
  if (settings.grid) params.set("grid", "1");
  if (settings.outlines) params.set("outlines", "1");
  if (settings.panel !== "anatomy") params.set("panel", settings.panel);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function studioViewFromPath(path: string): string {
  if (path === "/") return "overview";
  if (path === "/themes") return "themes";
  if (!path.startsWith("/components/")) return "missing";
  try {
    const slug = decodeURIComponent(path.slice(12));
    return UI_COMPONENT_CATALOG.some((entry) => entry.slug === slug) ? slug : "missing";
  } catch { return "missing"; }
}

/** Modified clicks retain ordinary browser navigation and the complete href. */
export function shouldNavigatePreview(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

export async function copyPreviewLink(link: string, clipboard?: Pick<Clipboard, "writeText">): Promise<boolean> {
  if (!clipboard) return false;
  try { await clipboard.writeText(link); return true; } catch { return false; }
}
