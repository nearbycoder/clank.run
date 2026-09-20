export const PREVIEW_WIDTH_MIN = 280;
export const PREVIEW_WIDTH_MAX = 1600;
export const PREVIEW_WIDTH_PRESETS = Object.freeze({ responsive: null, mobile: 390, tablet: 768, desktop: 1120 });
export type PreviewWidth = keyof typeof PREVIEW_WIDTH_PRESETS | number;

/** Shared by controls and URL settings: only named presets or whole CSS pixels are valid. */
export function parsePreviewWidth(value: unknown): PreviewWidth | null {
  if (typeof value === "string" && Object.hasOwn(PREVIEW_WIDTH_PRESETS, value)) return value as keyof typeof PREVIEW_WIDTH_PRESETS;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d{3,4}$/u.test(value.trim()))) return null;
  const width = Number(value);
  return Number.isInteger(width) && width >= PREVIEW_WIDTH_MIN && width <= PREVIEW_WIDTH_MAX ? width : null;
}

export function previewWidthPixels(value: PreviewWidth): number | null {
  return typeof value === "number" ? value : PREVIEW_WIDTH_PRESETS[value];
}

export function previewWidthStyle(value: PreviewWidth): string {
  const width = previewWidthPixels(value);
  return width === null ? "100%" : `${width}px`;
}

export function previewWidthLabel(value: PreviewWidth, rendered: number | null): string {
  const requested = previewWidthPixels(value);
  const setting = requested === null ? "Fluid" : `${requested}px requested`;
  return `${setting} · ${rendered === null ? "fits available space" : `${rendered}px rendered`}`;
}

/** Measure the constrained frame after mounting and disconnect when its story route unmounts. */
export function observePreviewWidth(element: HTMLElement, onWidth: (width: number) => void): () => void {
  let active = true;
  const measure = () => {
    if (!active) return;
    const width = element.getBoundingClientRect().width;
    if (Number.isFinite(width) && width >= 0) onWidth(Math.round(width));
  };
  measure();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }
  if (typeof window !== "undefined") window.addEventListener("resize", measure);
  return () => { active = false; if (typeof window !== "undefined") window.removeEventListener("resize", measure); };
}
