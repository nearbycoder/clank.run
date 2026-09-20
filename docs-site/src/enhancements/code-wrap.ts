import type { SearchEntry } from "../search.tsx";
import { readLocalValue, writeLocalValue } from "./storage.ts";

export const CODE_WRAP_KEY = "clank.docs.code-wrap.v1";
const installedArticles = new WeakSet<HTMLElement>();

/** Unknown or malformed preferences keep the original horizontal scrolling layout. */
export function codeWrapPreference(value: unknown): boolean {
  return value === true;
}

export function installCodeWrap(entries: readonly SearchEntry[], currentSlug?: string): void {
  if (!currentSlug || !entries.some((entry) => entry.slug === currentSlug)) return;
  const root = document.getElementById("docs-reader-tools");
  const article = document.getElementById("docs-article-body");
  if (!root || !article || !article.querySelector(".code-block pre > code") || installedArticles.has(article)) return;
  installedArticles.add(article);

  const toggle = document.createElement("button");
  toggle.id = "docs-code-wrap-toggle";
  toggle.className = "reader-tool code-wrap-toggle";
  toggle.type = "button";
  toggle.textContent = "Wrap code";
  toggle.setAttribute("aria-controls", article.id);
  root.append(toggle);
  let enabled = false;

  const apply = (next: boolean) => {
    enabled = next;
    toggle.setAttribute("aria-pressed", String(enabled));
    // Presentation only: original code text, copy controls, and scroll focus targets stay intact.
    article.toggleAttribute("data-docs-code-wrap", enabled);
  };
  toggle.addEventListener("click", () => {
    apply(!enabled);
    writeLocalValue(CODE_WRAP_KEY, enabled);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === CODE_WRAP_KEY || event.key === null) apply(codeWrapPreference(readLocalValue(CODE_WRAP_KEY, 8)));
  });
  apply(codeWrapPreference(readLocalValue(CODE_WRAP_KEY, 8)));
}
