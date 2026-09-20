const READING_OFFSET = 120;
const installedArticles = new WeakSet<HTMLElement>();

function fragmentId(hash: string): string | null {
  try { return decodeURIComponent(hash.slice(1)) || null; }
  catch { return null; }
}

/** Keep every section navigation variant in sync without moving focus or changing the URL. */
export function installCurrentSection(): void {
  const article = document.getElementById("docs-article-body");
  if (!article || installedArticles.has(article)) return;
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".toc a[href^='#'], .mobile-toc a[href^='#']")]
    .map((link) => ({ link, id: fragmentId(link.hash) }));
  if (!links.length) return;
  const ids = new Set(links.map(({ id }) => id));
  // Query headings once in document order; mobile and desktop links may repeat IDs.
  const headings = [...article.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id]")]
    .filter((heading) => ids.has(heading.id));
  const headingsById = new Map(headings.map((heading) => [heading.id, heading]));
  let current: string | null | undefined;
  const select = (id: string | null) => {
    if (id === current) return;
    current = id;
    for (const entry of links) {
      const active = id !== null && entry.id === id;
      entry.link.classList.toggle("active", active);
      if (active) entry.link.setAttribute("aria-current", "location");
      else entry.link.removeAttribute("aria-current");
    }
  };
  if (!headings.length) { select(null); return; }
  installedArticles.add(article);

  let frame: number | undefined;
  const update = () => {
    frame = undefined;
    // The last heading above the reading line owns the section, even between headings.
    let low = 0;
    let high = headings.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (headings[middle].getBoundingClientRect().top <= READING_OFFSET) low = middle + 1;
      else high = middle;
    }
    select(low > 0 ? headings[low - 1].id : null);
  };
  const schedule = () => {
    if (frame === undefined) frame = window.requestAnimationFrame(update);
  };
  const fromHash = () => {
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
      frame = undefined;
    }
    const id = fragmentId(window.location.hash);
    if (id && headingsById.has(id)) select(id);
    else update();
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", fromHash);
  // Focus reading, text size, and opening the mobile TOC can reflow or shift the article.
  if ("ResizeObserver" in window) new ResizeObserver(schedule).observe(article.closest(".doc-page") ?? article);
  fromHash();
}
