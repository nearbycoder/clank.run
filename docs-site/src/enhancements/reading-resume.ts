import type { SearchEntry } from "../search.tsx";
import { removeLocalValue, writeLocalValue } from "./storage.ts";

export const READING_POSITIONS_KEY = "clank.docs.reading-positions.v1";
export const READING_POSITION_LIMIT = 24;
const READING_OFFSET = 120;
const SAVE_DELAY = 250;
interface ReadingPosition { slug: string; fraction: number }

/** Positions are local hints, never URLs, selectors, or arbitrary scroll coordinates. */
export function readingPositions(value: unknown, allowedSlugs: ReadonlySet<string>): ReadingPosition[] {
  if (!Array.isArray(value)) return [];
  const positions: ReadingPosition[] = [];
  for (const item of value.slice(0, 128)) {
    if (!item || typeof item !== "object" || typeof item.slug !== "string" || !allowedSlugs.has(item.slug)
      || typeof item.fraction !== "number" || !Number.isFinite(item.fraction) || item.fraction < 0.05 || item.fraction > 0.95
      || positions.some((position) => position.slug === item.slug)) continue;
    positions.push({ slug: item.slug, fraction: Math.round(item.fraction * 1000) / 1000 });
    if (positions.length === READING_POSITION_LIMIT) break;
  }
  return positions;
}

export function articleProgress(scrollTop: number, articleTop: number, articleHeight: number, viewportHeight: number): number | undefined {
  if (![scrollTop, articleTop, articleHeight, viewportHeight].every(Number.isFinite) || viewportHeight <= READING_OFFSET) return undefined;
  const distance = articleHeight - (viewportHeight - READING_OFFSET);
  if (distance < 200) return undefined;
  return Math.max(0, Math.min(1, (scrollTop - articleTop + READING_OFFSET) / distance));
}

export function installReadingResume(entries: readonly SearchEntry[], currentSlug?: string): void {
  const allowedSlugs = new Set(entries.map((entry) => entry.slug));
  if (!currentSlug || !allowedSlugs.has(currentSlug)) return;
  const root = document.getElementById("docs-reader-tools");
  const article = document.getElementById("docs-article-body");
  if (!root || !article) return;
  const readPositions = (fallback: ReadingPosition[] = []): ReadingPosition[] => {
    // A missing key means another tab cleared it. Only unavailable storage may
    // retain this page's in-memory progress; invalid persisted values are reset.
    let raw: string | null;
    try { raw = window.localStorage.getItem(READING_POSITIONS_KEY); }
    catch { return fallback; }
    if (!raw || raw.length > 8192) return [];
    try { return readingPositions(JSON.parse(raw), allowedSlugs); }
    catch { return []; }
  };
  let positions = readPositions();
  let offered = positions.find((position) => position.slug === currentSlug);
  let offerResume = true;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controls = document.createElement("span");
  controls.className = "reading-resume-controls";
  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "reader-tool";
  resume.id = "docs-reading-resume";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "reader-tool";
  clear.textContent = "Clear position";
  clear.setAttribute("aria-label", "Clear saved reading position for this guide");
  const status = document.createElement("span");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  controls.append(resume, clear);
  root.append(controls, status);

  const render = () => {
    resume.hidden = !offered || Boolean(window.location.hash);
    resume.textContent = offered ? `Resume reading (${Math.round(offered.fraction * 100)}%)` : "Resume reading";
    clear.hidden = !positions.some((position) => position.slug === currentSlug);
    controls.hidden = resume.hidden && clear.hidden;
  };
  const persist = () => {
    if (positions.length) writeLocalValue(READING_POSITIONS_KEY, positions);
    else removeLocalValue(READING_POSITIONS_KEY);
  };
  const save = () => {
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    const rect = article.getBoundingClientRect();
    const fraction = articleProgress(window.scrollY, rect.top + window.scrollY, rect.height, window.innerHeight);
    // Keep the earlier position when returning at the top; clear it when the guide is finished.
    if (fraction === undefined || fraction < 0.05) return;
    positions = readPositions(positions).filter((position) => position.slug !== currentSlug);
    if (fraction <= 0.95) positions = readingPositions([{ slug: currentSlug, fraction }, ...positions], allowedSlugs);
    offered = undefined;
    offerResume = false;
    persist();
    render();
  };
  window.addEventListener("scroll", () => {
    dirty = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY);
  }, { passive: true });
  window.addEventListener("pagehide", () => {
    if (timer !== undefined) clearTimeout(timer);
    save();
  });
  window.addEventListener("hashchange", render);
  window.addEventListener("storage", (event) => {
    if (event.key !== READING_POSITIONS_KEY && event.key !== null) return;
    positions = readPositions(positions);
    offered = offerResume ? positions.find((position) => position.slug === currentSlug) : undefined;
    render();
  });
  resume.addEventListener("click", () => {
    // A link target always takes precedence, including a hash added after page load.
    if (window.location.hash || !offerResume) return;
    positions = readPositions(positions);
    offered = positions.find((position) => position.slug === currentSlug);
    if (!offered) { render(); return; }
    const rect = article.getBoundingClientRect();
    const distance = rect.height - (window.innerHeight - READING_OFFSET);
    if (distance < 200) return;
    const top = Math.max(0, Math.min(document.documentElement.scrollHeight - window.innerHeight,
      rect.top + window.scrollY - READING_OFFSET + offered.fraction * distance));
    article.focus({ preventScroll: true });
    window.scrollTo({ top, behavior: "instant" });
    offered = undefined;
    offerResume = false;
    status.textContent = "Resumed your saved reading position.";
    render();
  });
  clear.addEventListener("click", () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    dirty = false;
    positions = readPositions(positions).filter((position) => position.slug !== currentSlug);
    offered = undefined;
    offerResume = false;
    persist();
    render();
    status.textContent = "Saved reading position cleared.";
    document.getElementById("docs-bookmark-toggle")?.focus();
  });
  render();
}
