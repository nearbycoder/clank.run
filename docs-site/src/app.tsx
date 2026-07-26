/* @clankImportSource ../vendor/dom.js */
import { effect, signal } from "../vendor/core.js";
import { hydrate } from "../vendor/dom.js";
import { readState } from "../vendor/ssr.js";
import { SearchBox, type SearchEntry } from "./search.tsx";

interface BootState {
  search: SearchEntry[];
  initialQuery: string;
}

const boot = readState<BootState>() ?? { search: [], initialQuery: "" };
document.documentElement.dataset.docsEnhanced = "true";
const searchRoot = document.getElementById("docs-search");
if (searchRoot) hydrate(searchRoot, <SearchBox entries={boot.search} initialQuery={boot.initialQuery} />);

const navOpen = signal(false);
const navToggle = document.getElementById("nav-toggle");
const navScrim = document.getElementById("nav-scrim") as HTMLButtonElement | null;
effect(() => {
  document.body.toggleAttribute("data-nav-open", navOpen.value);
  navToggle?.setAttribute("aria-expanded", String(navOpen.value));
  navToggle?.setAttribute("aria-label", navOpen.value ? "Close documentation navigation" : "Open documentation navigation");
  if (navScrim) navScrim.hidden = !navOpen.value;
});
navToggle?.addEventListener("click", () => { navOpen.value = !navOpen.peek(); });
navScrim?.addEventListener("click", () => { navOpen.value = false; });
document.querySelectorAll<HTMLAnchorElement>("#docs-sidebar a").forEach((link) => {
  link.addEventListener("click", () => { navOpen.value = false; });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navOpen.peek()) {
    navOpen.value = false;
    navToggle?.focus();
    return;
  }
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
  const search = document.querySelector<HTMLInputElement>(".search-box input");
  if (!search) return;
  event.preventDefault();
  search.focus();
});

async function copy(value: string, button: HTMLButtonElement) {
  const previous = button.textContent ?? "Copy";
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select";
  }
  setTimeout(() => { button.textContent = previous; }, 1400);
}

document.querySelectorAll<HTMLButtonElement>("[data-copy-code]").forEach((button) => {
  button.addEventListener("click", () => {
    const code = button.closest("figure")?.querySelector("code")?.textContent ?? "";
    void copy(code, button);
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-copy-text]").forEach((button) => {
  button.addEventListener("click", () => void copy(button.dataset.copyText ?? "", button));
});

const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>(".toc a[href^='#']")];
const headings = tocLinks
  .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
  .filter((heading): heading is HTMLElement => Boolean(heading));
if (headings.length && "IntersectionObserver" in window) {
  const visible = new Set<string>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id);
      else visible.delete(entry.target.id);
    }
    const active = headings.find((heading) => visible.has(heading.id))
      ?? [...headings].reverse().find((heading) => heading.getBoundingClientRect().top < 160);
    for (const link of tocLinks) link.classList.toggle("active", link.hash === `#${active?.id}`);
  }, { rootMargin: "-120px 0px -65% 0px" });
  for (const heading of headings) observer.observe(heading);
}
