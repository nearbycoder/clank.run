import type { SearchEntry } from "../search.tsx";
import { readLocalValue, writeLocalValue } from "./storage.ts";

export const TEXT_SIZE_KEY = "clank.docs.text-size.v1";
const installedArticles = new WeakSet<HTMLElement>();
type TextSize = "normal" | "large" | "extra-large";

/** Stored preferences never become arbitrary CSS or attribute values. */
export function textSizePreference(value: unknown): TextSize {
  return value === "large" || value === "extra-large" ? value : "normal";
}

export function installTextSize(entries: readonly SearchEntry[], currentSlug?: string): void {
  if (!currentSlug || !entries.some((entry) => entry.slug === currentSlug)) return;
  const root = document.getElementById("docs-reader-tools");
  const article = document.getElementById("docs-article-body");
  if (!root || !article || installedArticles.has(article)) return;
  installedArticles.add(article);

  const controls = document.createElement("span");
  controls.className = "reader-text-size";
  const label = document.createElement("label");
  label.htmlFor = "docs-text-size";
  label.textContent = "Text size";
  const select = document.createElement("select");
  select.id = label.htmlFor;
  select.className = "reader-tool";
  select.setAttribute("aria-controls", article.id);
  for (const [value, name] of [["normal", "Normal"], ["large", "Large"], ["extra-large", "Extra large"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = name;
    select.append(option);
  }
  controls.append(label, select);
  root.append(controls);

  const apply = (size: TextSize) => {
    select.value = size;
    article.setAttribute("data-docs-text-size", size);
  };
  select.addEventListener("change", () => {
    const size = textSizePreference(select.value);
    apply(size);
    writeLocalValue(TEXT_SIZE_KEY, size);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === TEXT_SIZE_KEY || event.key === null) apply(textSizePreference(readLocalValue(TEXT_SIZE_KEY, 32)));
  });
  apply(textSizePreference(readLocalValue(TEXT_SIZE_KEY, 32)));
}
