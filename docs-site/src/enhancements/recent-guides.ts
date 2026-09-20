import type { SearchEntry } from "../search.tsx";
import { readLocalValue, removeLocalValue, writeLocalValue } from "./storage.ts";

export const RECENT_GUIDES_KEY = "clank.docs.recent-guides.v1";
const HISTORY_LIMIT = 8;
const VISIBLE_LIMIT = 6;

/** Stored values contain slugs only; titles and links always come from the current corpus. */
export function recentGuideSlugs(value: unknown, allowedSlugs: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const slugs: string[] = [];
  for (const slug of value.slice(0, 64)) {
    if (typeof slug !== "string" || !allowedSlugs.has(slug) || slugs.includes(slug)) continue;
    slugs.push(slug);
    if (slugs.length === HISTORY_LIMIT) break;
  }
  return slugs;
}

export function recordGuideVisit(history: readonly string[], currentSlug: string | undefined, allowedSlugs: ReadonlySet<string>): string[] {
  return recentGuideSlugs(currentSlug && allowedSlugs.has(currentSlug)
    ? [currentSlug, ...history]
    : history, allowedSlugs);
}

export function installRecentGuides(entries: readonly SearchEntry[], currentSlug?: string): void {
  const root = document.getElementById("docs-reader-history");
  if (!root) return;
  const guides = new Map(entries.map((entry) => [entry.slug, entry]));
  const allowedSlugs = new Set(guides.keys());
  let history = recordGuideVisit(recentGuideSlugs(readLocalValue(RECENT_GUIDES_KEY), allowedSlugs), currentSlug, allowedSlugs);
  if (currentSlug && allowedSlugs.has(currentSlug)) writeLocalValue(RECENT_GUIDES_KEY, history);

  const heading = document.createElement("h2");
  heading.id = "docs-recent-guides-title";
  heading.textContent = "Recently read";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "reader-history-clear";
  clear.textContent = "Clear";
  clear.setAttribute("aria-label", "Clear recently read guides");
  const header = document.createElement("div");
  header.className = "reader-history-heading";
  header.append(heading, clear);
  const links = document.createElement("div");
  links.className = "reader-history-links";
  const note = document.createElement("small");
  note.textContent = "Saved only in this browser";
  const status = document.createElement("span");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  root.setAttribute("aria-labelledby", heading.id);
  root.replaceChildren(header, links, note, status);

  const render = () => {
    links.replaceChildren();
    for (const slug of history.filter((slug) => slug !== currentSlug).slice(0, VISIBLE_LIMIT)) {
      const entry = guides.get(slug)!;
      const link = document.createElement("a");
      link.href = `/docs/${encodeURIComponent(entry.slug)}`;
      link.textContent = entry.title;
      links.append(link);
    }
    if (!links.childElementCount) {
      const empty = document.createElement("p");
      empty.textContent = "Guides you visit will appear here.";
      links.append(empty);
    }
    clear.disabled = history.length === 0;
  };
  clear.addEventListener("click", () => {
    history = [];
    removeLocalValue(RECENT_GUIDES_KEY);
    render();
    status.textContent = "Recently read guides cleared.";
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== RECENT_GUIDES_KEY && event.key !== null) return;
    history = recentGuideSlugs(readLocalValue(RECENT_GUIDES_KEY), allowedSlugs);
    render();
  });
  render();
  root.hidden = false;
}
