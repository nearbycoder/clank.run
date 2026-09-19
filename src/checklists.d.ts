import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export interface ChecklistItem { id: string; text: string; done: boolean; }
export interface Checklist { id: string; title: string; items: readonly ChecklistItem[]; version: number; }
export interface ChecklistClient {
  list(): Promise<readonly Checklist[]>;
  save(input: { id?: string; expectedVersion?: number; title: string; items: readonly ChecklistItem[]; key?: string }): Promise<Checklist>;
  remove(id: string, expectedVersion: number): Promise<void>;
}
export interface ChecklistOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export declare function openChecklists(options: ChecklistOptions): Promise<{ handle(request: Request): Promise<Response>; close(): void }>;
export declare function createChecklistClient(options?: SyncClientOptions): ChecklistClient;
export declare function mountChecklists(container: HTMLElement, client: ChecklistClient): () => void;
