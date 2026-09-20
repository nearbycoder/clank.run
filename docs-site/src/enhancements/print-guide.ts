import type { SearchEntry } from "../search.tsx";

const installedArticles = new WeakSet<HTMLElement>();

/** Printing is a local browser action and never runs during enhancement or navigation. */
export function installPrintGuide(entries: readonly SearchEntry[], currentSlug?: string): void {
  if (!currentSlug || !entries.some((entry) => entry.slug === currentSlug) || typeof window.print !== "function") return;
  const root = document.getElementById("docs-reader-tools");
  const article = document.getElementById("docs-article-body");
  if (!root || !article || installedArticles.has(article)) return;
  installedArticles.add(article);

  const button = document.createElement("button");
  button.id = "docs-print-guide";
  button.className = "reader-tool";
  button.type = "button";
  button.textContent = "Print guide";
  button.setAttribute("aria-controls", article.id);
  button.addEventListener("click", () => window.print());
  root.append(button);
}
