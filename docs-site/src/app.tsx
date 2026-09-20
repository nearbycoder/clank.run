/* @clankImportSource ../vendor/dom.js */
import { effect, signal } from "../vendor/core.js";
import { hydrate } from "../vendor/dom.js";
import { readState } from "../vendor/ssr.js";
import { handleSearchShortcut, SearchBox, type SearchEntry } from "./search.tsx";
import { installRecentGuides } from "./enhancements/recent-guides.ts";
import { installBookmarks } from "./enhancements/bookmarks.ts";
import { installReadingResume } from "./enhancements/reading-resume.ts";
import { installReadingProgress } from "./enhancements/reading-progress.ts";
import { installFocusMode } from "./enhancements/focus-mode.ts";
import { installTextSize } from "./enhancements/text-size.ts";
import { installCodeWrap } from "./enhancements/code-wrap.ts";
import { installPrintGuide } from "./enhancements/print-guide.ts";
import { installCopyControls } from "./enhancements/clipboard.ts";
import { installCurrentSection } from "./enhancements/current-section.ts";

interface BootState {
  search: SearchEntry[];
  initialQuery: string;
  searchGroup?: string;
  activeSlug?: string;
}

const boot = readState<BootState>() ?? { search: [], initialQuery: "" };
document.documentElement.dataset.docsEnhanced = "true";
installRecentGuides(boot.search, boot.activeSlug);
installBookmarks(boot.search, boot.activeSlug);
installReadingResume(boot.search, boot.activeSlug);
installReadingProgress(boot.search, boot.activeSlug);
installTextSize(boot.search, boot.activeSlug);
installCodeWrap(boot.search, boot.activeSlug);
installPrintGuide(boot.search, boot.activeSlug);
const searchRoot = document.getElementById("docs-search");
if (searchRoot) hydrate(searchRoot, <SearchBox entries={boot.search} initialQuery={boot.initialQuery} searchGroup={boot.searchGroup} />);

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
document.getElementById("docs-sidebar")?.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a")) navOpen.value = false;
});
installFocusMode(boot.search, boot.activeSlug, () => { navOpen.value = false; });

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navOpen.peek()) {
    navOpen.value = false;
    navToggle?.focus();
    return;
  }
  handleSearchShortcut(event);
});

installCopyControls();
installCurrentSection();
