export interface SearchDocument { id: string; title: string; body: string; }
export interface SearchHighlight { text: string; match: boolean; }
export interface LocalSearchHit { id: string; title: readonly SearchHighlight[]; snippet: readonly SearchHighlight[]; score: number; }
export interface LocalSearchResult { hits: readonly LocalSearchHit[]; total: number; truncated: boolean; }
export interface LocalSearchOptions { maxDocuments?: number; maxBytes?: number; }
export interface LocalSearchIndex {
  upsert(document: SearchDocument): void;
  remove(id: string): boolean;
  replace(documents: readonly SearchDocument[]): void;
  search(query: string, options?: { offset?: number; limit?: number; prefix?: boolean }): LocalSearchResult;
  serialize(): string;
  restore(serialized: string): void;
  readonly size: number;
}
const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const tokens = (text: string) => [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map(match => ({ term: normalize(match[0]), start: match.index!, end: match.index! + match[0].length }));
const encoder = new TextEncoder();

/** A bounded, browser/server inverted index. Index only records the caller is allowed to see. */
export function createLocalSearchIndex(options: LocalSearchOptions = {}): LocalSearchIndex {
  const maximum = options.maxDocuments ?? 10000, byteLimit = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50000 || !Number.isSafeInteger(byteLimit) || byteLimit < 1024 || byteLimit > 64 * 1024 * 1024) throw new TypeError("Invalid local search limits.");
  let documents = new Map<string, { document: SearchDocument; bytes: number; terms: Map<string, number> }>();
  let inverted = new Map<string, Map<string, number>>(), bytes = 0;
  const prepare = (input: SearchDocument) => {
    if (!input || typeof input.id !== "string" || !input.id || input.id.length > 200 || typeof input.title !== "string" || !input.title.trim() || input.title.length > 300 || typeof input.body !== "string" || input.body.length > 32768) throw new TypeError("A search document needs an ID, title, and bounded body.");
    const document = { id: input.id, title: input.title, body: input.body }, size = encoder.encode(JSON.stringify(document)).length;
    const terms = new Map<string, number>();
    for (const [text, weight] of [[document.title, 5], [document.body, 1]] as const) for (const token of tokens(text)) terms.set(token.term, (terms.get(token.term) ?? 0) + weight);
    // Charge both text and index entries so highly varied input remains bounded.
    return { document: Object.freeze(document), bytes: size + [...terms.keys()].reduce((sum, term) => sum + encoder.encode(term).length + 64, 0), terms };
  };
  const remove = (id: string) => {
    const existing = documents.get(id); if (!existing) return false;
    for (const term of existing.terms.keys()) { const entries = inverted.get(term)!; entries.delete(id); if (!entries.size) inverted.delete(term); }
    bytes -= existing.bytes; documents.delete(id); return true;
  };
  const upsert = (input: SearchDocument) => {
    const entry = prepare(input), previous = documents.get(entry.document.id);
    if ((!previous && documents.size >= maximum) || bytes - (previous?.bytes ?? 0) + entry.bytes > byteLimit) throw new RangeError("Local search capacity exceeded.");
    remove(entry.document.id); documents.set(entry.document.id, entry); bytes += entry.bytes;
    for (const [term, weight] of entry.terms) { let entries = inverted.get(term); if (!entries) { entries = new Map(); inverted.set(term, entries); } entries.set(entry.document.id, weight); }
  };
  const highlight = (text: string, matched: Set<string>, snippet: boolean): readonly SearchHighlight[] => {
    const all = tokens(text), first = all.find(token => matched.has(token.term));
    const start = snippet && first ? Math.max(0, first.start - 60) : 0, end = snippet ? Math.min(text.length, start + 220) : text.length;
    const parts: SearchHighlight[] = []; let at = start;
    if (start) parts.push({ text: "…", match: false });
    for (const token of all) if (token.start >= start && token.end <= end && matched.has(token.term)) {
      if (token.start > at) parts.push({ text: text.slice(at, token.start), match: false });
      parts.push({ text: text.slice(token.start, token.end), match: true }); at = token.end;
    }
    if (at < end) parts.push({ text: text.slice(at, end), match: false });
    if (end < text.length) parts.push({ text: "…", match: false }); return parts;
  };
  const index: LocalSearchIndex = {
    upsert, remove, get size() { return documents.size; },
    replace(inputs) {
      if (!Array.isArray(inputs) || inputs.length > maximum || new Set(inputs.map(input => input?.id)).size !== inputs.length) throw new TypeError("Replacement documents must have unique IDs within the limit.");
      const replacement = createLocalSearchIndex(options); for (const input of inputs) replacement.upsert(input);
      const oldDocuments = documents, oldInverted = inverted, oldBytes = bytes;
      documents = new Map(); inverted = new Map(); bytes = 0;
      try { for (const input of inputs) upsert(input); } catch (error) { documents = oldDocuments; inverted = oldInverted; bytes = oldBytes; throw error; }
    },
    search(query, settings = {}) {
      if (typeof query !== "string" || query.length > 200) throw new TypeError("Search at most 200 characters.");
      const terms = [...new Set(tokens(query).map(token => token.term))];
      if (terms.length > 12) throw new TypeError("Search at most 12 distinct terms.");
      const offset = settings.offset ?? 0, limit = settings.limit ?? 20;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid search page.");
      if (!terms.length) return { hits: [], total: 0, truncated: false };
      let candidates: Map<string, number> | undefined, truncated = false;
      const matched = new Set<string>();
      for (let position = 0; position < terms.length; position++) {
        const term = terms[position]!, expansions = [term];
        if (settings.prefix !== false && position === terms.length - 1) for (const known of [...inverted.keys()].sort()) {
          if (known !== term && known.startsWith(term)) { if (expansions.length >= 50) { truncated = true; break; } expansions.push(known); }
        }
        const matches = new Map<string, number>();
        for (const expanded of expansions) {
          matched.add(expanded); const postings = inverted.get(expanded); if (!postings) continue;
          const rarity = 1 + Math.log((documents.size + 1) / (postings.size + 1));
          for (const [id, weight] of postings) matches.set(id, (matches.get(id) ?? 0) + rarity * (1 + Math.log(weight)) * (expanded === term ? 1 : 0.7));
        }
        if (!candidates) candidates = matches;
        else for (const [id, score] of candidates) { if (matches.has(id)) candidates.set(id, score + matches.get(id)!); else candidates.delete(id); }
        if (!candidates.size) break;
      }
      const ranked = [...(candidates ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { total: ranked.length, truncated, hits: ranked.slice(offset, offset + limit).map(([id, score]) => { const document = documents.get(id)!.document; return { id, score, title: highlight(document.title, matched, false), snippet: highlight(document.body, matched, true) }; }) };
    },
    serialize() { return JSON.stringify({ version: 1, documents: [...documents.values()].map(entry => entry.document) }); },
    restore(serialized) {
      if (typeof serialized !== "string" || encoder.encode(serialized).length > byteLimit * 2) throw new RangeError("Search snapshot exceeds its limit.");
      const snapshot = JSON.parse(serialized); if (snapshot?.version !== 1 || !Array.isArray(snapshot.documents)) throw new TypeError("Unsupported search snapshot.");
      index.replace(snapshot.documents);
    },
  };
  return index;
}

/** Search field, safe highlighted results, keyboard navigation, and explicit cleanup. */
export function mountLocalSearch(container: HTMLElement, index: LocalSearchIndex, open: (id: string) => void): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), input = document.createElement("input"), status = document.createElement("p"), list = document.createElement("ul");
  panel.setAttribute("aria-label", "Search records"); input.type = "search"; input.maxLength = 200; input.setAttribute("aria-label", "Search records"); status.setAttribute("role", "status");
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const render = () => {
    if (closed) return; list.replaceChildren();
    try {
      const result = index.search(input.value); status.textContent = !input.value.trim() ? "Type to search." : `${result.total} results${result.truncated ? "; refine your prefix for complete results" : ""}.`;
      for (const hit of result.hits) {
        const item = document.createElement("li"), button = document.createElement("button"), snippet = document.createElement("p"); button.type = "button";
        for (const [target, parts] of [[button, hit.title], [snippet, hit.snippet]] as const) for (const part of parts) { const node = document.createElement(part.match ? "mark" : "span"); node.textContent = part.text; target.append(node); }
        button.addEventListener("click", () => { if (!closed) open(hit.id); }); item.append(button, snippet); list.append(item);
      }
    } catch { status.textContent = "Search is too complex. Use up to 12 words."; }
  };
  input.addEventListener("input", () => { if (timer) clearTimeout(timer); timer = setTimeout(render, 100); });
  panel.addEventListener("keydown", event => {
    const buttons = [...list.querySelectorAll("button")];
    if (event.key === "Escape") { input.value = ""; render(); input.focus(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const at = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = at + (event.key === "ArrowDown" ? 1 : -1); if (next < 0) input.focus(); else buttons[Math.min(next, buttons.length - 1)]?.focus(); }
  });
  panel.append(input, status, list); container.append(panel); render();
  return () => { closed = true; if (timer) clearTimeout(timer); panel.remove(); };
}
