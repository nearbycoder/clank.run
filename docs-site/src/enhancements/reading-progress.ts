import type { SearchEntry } from "../search.tsx";

const READING_OFFSET = 120;
const installedArticles = new WeakSet<HTMLElement>();

/** Completion follows the article body, excluding navigation and the page footer. */
export function readingPercentage(articleTop: number, articleHeight: number, viewportHeight: number): number {
  if (![articleTop, articleHeight, viewportHeight].every(Number.isFinite) || articleHeight <= 0 || viewportHeight <= READING_OFFSET) return 0;
  const distance = articleHeight - (viewportHeight - READING_OFFSET);
  // A guide that fits in the available viewport is already fully readable.
  if (distance <= 0) return 100;
  return Math.round(Math.max(0, Math.min(1, (READING_OFFSET - articleTop) / distance)) * 100);
}

export function installReadingProgress(entries: readonly SearchEntry[], currentSlug?: string): void {
  if (!currentSlug || !entries.some((entry) => entry.slug === currentSlug)) return;
  const root = document.getElementById("docs-reader-tools");
  const article = document.getElementById("docs-article-body");
  if (!root || !article || installedArticles.has(article)) return;
  installedArticles.add(article);

  const controls = document.createElement("span");
  controls.className = "reading-progress";
  const label = document.createElement("label");
  label.htmlFor = "docs-reading-progress";
  label.textContent = "Reading progress";
  const progress = document.createElement("progress");
  progress.id = label.htmlFor;
  progress.max = 100;
  progress.value = 0;
  const percentage = document.createElement("span");
  percentage.className = "reading-progress-value";
  percentage.setAttribute("aria-hidden", "true");
  controls.append(label, progress, percentage);
  root.append(controls);

  let frame: number | undefined;
  let previous = -1;
  const update = () => {
    frame = undefined;
    const rect = article.getBoundingClientRect();
    const value = readingPercentage(rect.top, rect.height, window.innerHeight);
    if (value === previous) return;
    previous = value;
    progress.value = value;
    progress.textContent = `${value}%`;
    percentage.textContent = `${value}%`;
  };
  const schedule = () => {
    if (frame === undefined) frame = window.requestAnimationFrame(update);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  // Reflow from fonts, images, or reader preferences can change the guide's length.
  if ("ResizeObserver" in window) new ResizeObserver(schedule).observe(article);
  update();
}
