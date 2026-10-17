export interface SearchDocument { id: string; title: string; body: string; }
export interface SearchHighlight { text: string; match: boolean; }
export interface LocalSearchHit { id: string; title: readonly SearchHighlight[]; snippet: readonly SearchHighlight[]; score: number; }
export interface LocalSearchResult { hits: readonly LocalSearchHit[]; total: number; truncated: boolean; }
export interface LocalSearchOptions { maxDocuments?: number; maxBytes?: number; }
export interface LocalSearchSettings {
  offset?: number; limit?: number; prefix?: boolean;
  mode?: "all" | "any";
  field?: "all" | "title" | "body";
  ids?: readonly string[];
  exclude?: string;
  phrase?: boolean;
  sort?: "relevance" | "title" | "id";
}
export interface LocalSearchIndex {
  upsert(document: SearchDocument): void;
  remove(id: string): boolean;
  replace(documents: readonly SearchDocument[]): void;
  search(query: string, options?: LocalSearchSettings): LocalSearchResult;
  get(id: string): Readonly<SearchDocument> | undefined;
  clear(): void;
  serialize(): string;
  restore(serialized: string): void;
  readonly size: number;
}
export declare function createLocalSearchIndex(options?: LocalSearchOptions): LocalSearchIndex;
export declare function mountLocalSearch(container: HTMLElement, index: LocalSearchIndex, open: (id: string) => void): () => void;
