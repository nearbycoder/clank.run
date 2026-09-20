import type { SearchEntry } from "../search.tsx";
import { readLocalValue, writeLocalValue } from "./storage.ts";

export const FOCUS_MODE_KEY = "clank.docs.focus-mode.v1";
const installedArticles = new WeakSet<HTMLElement>();

/** Only an explicit stored boolean opts a reader into the reduced navigation layout. */
export function focusPreference(value: unknown): boolean {
  return value === true;
}

export function installFocusMode(entries: readonly SearchEntry[], currentSlug?: string, closeNavigation?: () => void): void {
  const root = document.getElementById("docs-reader-tools");
  const article = document.getElementById("docs-article-body");
  if (!currentSlug || !entries.some((entry) => entry.slug === currentSlug) || !root || !article) {
    document.body.removeAttribute("data-docs-focus");
    return;
  }
  if (installedArticles.has(article)) return;
  installedArticles.add(article);

  const toggle = document.createElement("button");
  toggle.id = "docs-focus-toggle";
  toggle.className = "reader-tool focus-toggle";
  toggle.type = "button";
  toggle.textContent = "Focus reading";
  toggle.setAttribute("aria-pressed", "false");
  toggle.setAttribute("aria-controls", "main-content");
  root.append(toggle);
  let enabled = false;

  const apply = (next: boolean) => {
    // A preference changed in another tab can hide the currently focused side rail.
    const active = document.activeElement;
    const entering = next && !enabled;
    const moveFocus = entering && active && (
      document.getElementById("docs-sidebar")?.contains(active)
      || document.querySelector(".toc")?.contains(active)
    );
    enabled = next;
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.textContent = enabled ? "Exit focus" : "Focus reading";
    if (moveFocus) toggle.focus({ preventScroll: true });
    if (entering) closeNavigation?.();
    document.body.toggleAttribute("data-docs-focus", enabled);
  };

  toggle.addEventListener("click", () => {
    apply(!enabled);
    writeLocalValue(FOCUS_MODE_KEY, enabled);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === FOCUS_MODE_KEY || event.key === null) apply(focusPreference(readLocalValue(FOCUS_MODE_KEY, 8)));
  });
  apply(focusPreference(readLocalValue(FOCUS_MODE_KEY, 8)));
}
