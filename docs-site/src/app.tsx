/* @clankImportSource ../vendor/dom.js */
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
import { installNavigation } from "./enhancements/navigation.ts";

interface BootState {
  /** Inline index (legacy pages). */
  search?: SearchEntry[];
  /** Content-addressed index URL; preferred so pages do not repeat it. */
  searchIndex?: string;
  initialQuery: string;
  searchGroup?: string;
  activeSlug?: string;
}

async function loadSearchIndex(state: BootState): Promise<SearchEntry[]> {
  if (state.search) return state.search;
  if (!state.searchIndex || !state.searchIndex.startsWith("/assets/")) return [];
  try {
    const response = await fetch(state.searchIndex, { credentials: "same-origin" });
    if (!response.ok) return [];
    const entries: unknown = await response.json();
    return Array.isArray(entries) ? entries as SearchEntry[] : [];
  } catch {
    return [];
  }
}

const boot = readState<BootState>() ?? { initialQuery: "" };
const search = await loadSearchIndex(boot);
document.documentElement.dataset.docsEnhanced = "true";
installRecentGuides(search, boot.activeSlug);
installBookmarks(search, boot.activeSlug);
installReadingResume(search, boot.activeSlug);
installReadingProgress(search, boot.activeSlug);
installTextSize(search, boot.activeSlug);
installCodeWrap(search, boot.activeSlug);
installPrintGuide(search, boot.activeSlug);
const searchRoot = document.getElementById("docs-search");
if (searchRoot) hydrate(searchRoot, <SearchBox entries={search} initialQuery={boot.initialQuery} searchGroup={boot.searchGroup} />);

const navigation = installNavigation();
installFocusMode(search, boot.activeSlug, () => { navigation.close(false); });
document.addEventListener("keydown", (event) => {
  if (!navigation.isOpen()) handleSearchShortcut(event);
});

installCopyControls();
installCurrentSection();
