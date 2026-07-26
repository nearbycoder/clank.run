/* @clankImportSource ../vendor/dom.js */
import { computed, signal } from "../vendor/core.js";
import { For } from "../vendor/dom.js";

export interface SearchEntry {
  slug: string;
  title: string;
  description: string;
  groupTitle: string;
  headings: string[];
}

function score(entry: SearchEntry, rawQuery: string): number {
  const query = rawQuery.toLowerCase().trim();
  if (!query) return 0;
  const title = entry.title.toLowerCase();
  const description = entry.description.toLowerCase();
  const headings = entry.headings.join(" ").toLowerCase();
  let value = 0;
  if (title === query) value += 100;
  if (title.startsWith(query)) value += 50;
  if (title.includes(query)) value += 25;
  if (entry.slug.includes(query.replaceAll(" ", "-"))) value += 15;
  if (headings.includes(query)) value += 10;
  if (description.includes(query)) value += 5;
  for (const term of query.split(/\s+/u).filter((part) => part.length > 1)) {
    if (title.includes(term)) value += 6;
    if (headings.includes(term)) value += 3;
    if (description.includes(term)) value += 1;
  }
  return value;
}

export function SearchBox(props: { entries: SearchEntry[]; initialQuery?: string }) {
  const query = signal(props.initialQuery ?? "");
  const focused = signal(false);
  const results = computed(() => props.entries
    .map((entry) => ({ entry, score: score(entry, query.value) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
    .slice(0, 7)
    .map((result) => result.entry));
  const expanded = computed(() => focused.value && query.value.trim().length > 0);

  return (
    <form class="search-box" action="/search" method="get" role="search" agentId="documentation-search">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        type="search"
        name="q"
        value={query.value}
        placeholder="Search documentation"
        autocomplete="off"
        aria-label="Search documentation"
        aria-controls="quick-search-results"
        aria-expanded={expanded.value}
        onInput={(event) => {
          query.value = event.currentTarget.value;
          focused.value = true;
        }}
        onFocus={() => { focused.value = true; }}
        onBlur={() => { setTimeout(() => { focused.value = false; }, 160); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            query.value = "";
            event.currentTarget.blur();
          }
        }}
        agentLabel="Search Clank documentation"
      />
      <kbd>/</kbd>
      <div class="search-popover" id="quick-search-results" role="listbox" hidden={!expanded.value}>
        <div class="search-popover-label">Best matches</div>
        <For
          each={results.value}
          by="slug"
          fallback={<div class="search-empty">No matching guide. Press Enter for full-text search.</div>}
        >
          {(entry) => (
            <a href={`/docs/${entry.slug}`} role="option" agentLabel={`Open ${entry.title}`}>
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.groupTitle}</small>
              </span>
              <span aria-hidden="true">↗</span>
            </a>
          )}
        </For>
        <button class="search-all" type="submit">Search every guide for “{query.value}”</button>
      </div>
    </form>
  );
}
