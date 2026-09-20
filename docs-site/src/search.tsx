/* @clankImportSource ../vendor/dom.js */
import { computed, signal } from "../vendor/core.js";
import { For, type Renderable } from "../vendor/dom.js";

export interface SearchEntry {
  slug: string;
  title: string;
  description: string;
  groupId?: string;
  groupTitle: string;
  headings: string[];
}

export function SearchHighlight(props: { text: string; query: string }) {
  // Return a reactive child so retained quick-search links update with the query.
  return () => {
    const terms = [...new Set(props.query.trim().slice(0, 120).split(/\s+/u).filter(Boolean))]
      .sort((left, right) => right.length - left.length);
    if (!terms.length) return props.text;
    // The bounded pattern contains literal terms only; all text is escaped by Clank.
    const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "giu");
    const parts: Renderable[] = [];
    let cursor = 0;
    for (const match of props.text.matchAll(pattern)) {
      if (match.index > cursor) parts.push(props.text.slice(cursor, match.index));
      parts.push(<mark>{match[0]}</mark>);
      cursor = match.index + match[0].length;
    }
    if (cursor < props.text.length) parts.push(props.text.slice(cursor));
    return parts;
  };
}

export function handleSearchShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
  const input = document.querySelector<HTMLInputElement>('.search-box input[type="search"]');
  if (!input) return;
  event.preventDefault();
  input.focus();
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

export function SearchBox(props: { entries: SearchEntry[]; initialQuery?: string; searchGroup?: string }) {
  const query = signal(props.initialQuery ?? "");
  const focused = signal(false);
  const results = computed(() => props.entries
    .filter((entry) => !props.searchGroup || entry.groupId === props.searchGroup)
    .map((entry) => ({ entry, score: score(entry, query.value) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
    .slice(0, 7)
    .map((result) => result.entry));
  const expanded = computed(() => focused.value && query.value.trim().length > 0);

  function navigateResults(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const form = event.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) return;
    if (event.key === "Escape" && expanded.peek()) {
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      focused.value = false;
      return;
    }
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || !query.peek().trim()) return;
    // Read the current links rather than retaining an index across query changes.
    const links = [...form.querySelectorAll<HTMLAnchorElement>(".search-popover a[href]")];
    const index = links.indexOf(event.target as HTMLAnchorElement);
    if (!links.length || (event.target !== input && index < 0)) return;
    event.preventDefault();
    focused.value = true;
    const next = event.key === "ArrowDown"
      ? (index + 1) % (links.length + 1)
      : (index + links.length) % (links.length + 1);
    (links[next] ?? input).focus();
  }

  return (
    <form
      class="search-box" action="/search" method="get" role="search" agentId="documentation-search"
      onFocusIn={() => { focused.value = true; }}
      onFocusOut={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) focused.value = false;
      }}
      onKeyDown={navigateResults}
    >
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        type="search"
        name="q"
        value={query.value}
        placeholder="Search documentation"
        autocomplete="off"
        aria-label="Search documentation"
        aria-controls="quick-search-results"
        onInput={(event) => {
          query.value = event.currentTarget.value;
          focused.value = true;
        }}
        agentLabel="Search Clank documentation"
      />
      {props.searchGroup ? <input type="hidden" name="group" value={props.searchGroup} /> : null}
      <kbd>/</kbd>
      <div class="search-popover" id="quick-search-results" role="region" aria-label="Matching guides" hidden={!expanded.value}>
        <div class="search-popover-label">Best matches</div>
        <For
          each={results.value}
          by="slug"
          fallback={<div class="search-empty">No matching guide. Press Enter for full-text search.</div>}
        >
          {(entry) => (
            <a href={`/docs/${entry.slug}`} agentLabel={`Open ${entry.title}`}>
              <span>
                <strong><SearchHighlight text={entry.title} query={query.value} /></strong>
                <small>{entry.groupTitle}</small>
              </span>
              <span aria-hidden="true">↗</span>
            </a>
          )}
        </For>
        <button class="search-all" type="submit">Search {props.searchGroup ? "this category" : "every guide"} for “{query.value}”</button>
      </div>
    </form>
  );
}
