import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export interface Label { id: string; name: string; color: string; version: number; uses: number; }
export interface LabelState { labels: readonly Label[]; selected: readonly string[]; }
export interface LabelClient {
  list(resource?: string): Promise<LabelState>;
  save(input: { id?: string; expectedVersion?: number; name: string; color: string }): Promise<Label>;
  remove(id: string, expectedVersion: number): Promise<void>;
  assign(resource: string, id: string, selected: boolean): Promise<void>;
}
export interface LabelOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export declare function openLabels(options: LabelOptions): Promise<{ handle(request: Request): Promise<Response>; close(): void }>;
export declare function createLabelClient(options?: SyncClientOptions): LabelClient;
export declare function mountLabels(container: HTMLElement, client: LabelClient, resource: string): () => void;
