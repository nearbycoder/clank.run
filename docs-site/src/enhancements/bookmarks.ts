import type { SearchEntry } from "../search.tsx";
import { readLocalValue, removeLocalValue, writeLocalValue } from "./storage.ts";

export const BOOKMARKS_KEY = "clank.docs.bookmarks.v1";
export const BOOKMARK_LIMIT = 30;

/** Persist only known slugs: names and destinations come from the current guide corpus. */
export function bookmarkSlugs(value: unknown, allowedSlugs: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const slugs: string[] = [];
  for (const slug of value.slice(0, 128)) {
    if (typeof slug !== "string" || !allowedSlugs.has(slug) || slugs.includes(slug)) continue;
    slugs.push(slug);
    if (slugs.length === BOOKMARK_LIMIT) break;
  }
  return slugs;
}

export function toggleBookmark(bookmarks: readonly string[], slug: string, allowedSlugs: ReadonlySet<string>): string[] {
  const current = bookmarkSlugs(bookmarks, allowedSlugs);
  if (current.includes(slug)) return current.filter((entry) => entry !== slug);
  if (!allowedSlugs.has(slug) || current.length === BOOKMARK_LIMIT) return current;
  return [slug, ...current];
}

export function installBookmarks(entries: readonly SearchEntry[], currentSlug?: string): void {
  const root = document.getElementById("docs-bookmarks");
  if (!root) return;
  const guides = new Map(entries.map((entry) => [entry.slug, entry]));
  const allowedSlugs = new Set(guides.keys());
  const save = document.getElementById("docs-bookmark-toggle") as HTMLButtonElement | null;
  let bookmarks = bookmarkSlugs(readLocalValue(BOOKMARKS_KEY), allowedSlugs);

  const heading = document.createElement("h2");
  heading.id = "docs-bookmarks-title";
  heading.tabIndex = -1;
  heading.textContent = "Saved guides";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "reader-history-clear";
  clear.textContent = "Clear all";
  clear.setAttribute("aria-label", "Clear all saved guides");
  const header = document.createElement("div");
  header.className = "reader-history-heading";
  header.append(heading, clear);
  const list = document.createElement("div");
  list.className = "reader-history-links bookmark-links";
  const note = document.createElement("small");
  note.textContent = `Up to ${BOOKMARK_LIMIT} guides, saved only in this browser`;
  const sidebarStatus = document.createElement("span");
  sidebarStatus.className = "visually-hidden";
  sidebarStatus.setAttribute("role", "status");
  const status = document.getElementById("docs-bookmark-status") ?? sidebarStatus;
  root.setAttribute("aria-labelledby", heading.id);
  root.replaceChildren(header, list, note, sidebarStatus);

  const persist = () => {
    if (bookmarks.length) writeLocalValue(BOOKMARKS_KEY, bookmarks);
    else removeLocalValue(BOOKMARKS_KEY);
  };
  const render = (): HTMLButtonElement[] => {
    list.replaceChildren();
    const removeButtons: HTMLButtonElement[] = [];
    for (const [index, slug] of bookmarks.entries()) {
      const entry = guides.get(slug)!;
      const row = document.createElement("div");
      row.className = "bookmark-row";
      const link = document.createElement("a");
      link.href = `/docs/${encodeURIComponent(slug)}`;
      link.textContent = entry.title;
      if (slug === currentSlug) link.setAttribute("aria-current", "page");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "reader-history-clear";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${entry.title} from saved guides`);
      remove.addEventListener("click", () => {
        const restoreFocus = document.activeElement === remove;
        bookmarks = bookmarks.filter((value) => value !== slug);
        persist();
        const nextButtons = render();
        if (restoreFocus) (nextButtons[index] ?? nextButtons[index - 1] ?? heading).focus();
        status.textContent = `${entry.title} removed from saved guides.`;
      });
      removeButtons.push(remove);
      row.append(link, remove);
      list.append(row);
    }
    if (!bookmarks.length) {
      const empty = document.createElement("p");
      empty.textContent = "Use Save guide on any guide to keep it here.";
      list.append(empty);
    }
    clear.disabled = bookmarks.length === 0;
    if (save && currentSlug && allowedSlugs.has(currentSlug)) {
      const saved = bookmarks.includes(currentSlug);
      save.textContent = saved ? "Unsave guide" : "Save guide";
      save.setAttribute("aria-pressed", String(saved));
      save.hidden = false;
    }
    return removeButtons;
  };

  save?.addEventListener("click", () => {
    if (!currentSlug || !allowedSlugs.has(currentSlug)) return;
    const saved = bookmarks.includes(currentSlug);
    if (!saved && bookmarks.length === BOOKMARK_LIMIT) {
      status.textContent = `You have saved ${BOOKMARK_LIMIT} guides. Remove a saved guide before adding another.`;
      return;
    }
    bookmarks = toggleBookmark(bookmarks, currentSlug, allowedSlugs);
    persist();
    render();
    status.textContent = saved ? "Guide removed from saved guides." : "Guide saved in this browser.";
  });
  clear.addEventListener("click", () => {
    bookmarks = [];
    persist();
    render();
    status.textContent = "All saved guides cleared.";
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== BOOKMARKS_KEY && event.key !== null) return;
    bookmarks = bookmarkSlugs(readLocalValue(BOOKMARKS_KEY), allowedSlugs);
    render();
  });
  render();
  root.hidden = false;
}
