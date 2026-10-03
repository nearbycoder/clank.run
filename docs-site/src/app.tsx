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

const navigation = installNavigation();
installFocusMode(boot.search, boot.activeSlug, () => { navigation.close(false); });
document.addEventListener("keydown", (event) => {
  if (!navigation.isOpen()) handleSearchShortcut(event);
});

installCopyControls();
installCurrentSection();
