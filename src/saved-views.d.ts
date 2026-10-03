import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export type ViewValue = string | number | boolean | null;
export interface ViewFilter { field: string; operator: "eq" | "neq" | "contains" | "gt" | "lt" | "empty"; value: ViewValue; }
export interface ViewDefinition { filters: readonly ViewFilter[]; sort: readonly { field: string; direction: "asc" | "desc" }[]; columns: readonly string[]; }
export interface SavedView { id: string; name: string; definition: ViewDefinition; revision: number; isDefault: boolean; }
export interface SavedViewsOptions { path: string; auth: AuthDefinition<any>; fields: readonly string[]; prefix?: string; maxViews?: number; }
export interface SavedViewsService { handle(request: Request): Promise<Response>; close(): void; }
export interface SavedViewsClient {
  list(): Promise<readonly SavedView[]>;
  save(input: { id?: string; expectedRevision?: number; name: string; definition: ViewDefinition }): Promise<SavedView>;
  remove(id: string, expectedRevision: number): Promise<boolean>;
  setDefault(id: string | null): Promise<void>;
}

export declare function validateView(value: unknown, allowedFields?: readonly string[]): ViewDefinition;
export declare function applySavedView<T extends Record<string, unknown>>(records: readonly T[], definition: ViewDefinition): readonly T[];
export declare function openSavedViews(options: SavedViewsOptions): Promise<SavedViewsService>;
export declare function createSavedViewsClient(options?: SyncClientOptions): SavedViewsClient;
export declare function mountSavedViews(container: HTMLElement, client: SavedViewsClient, options: { current(): ViewDefinition; apply(view: ViewDefinition): void }): () => void;

export interface SharedSavedView extends SavedView { readonly workspaceId: string; readonly ownerId: string; readonly editableBy: "owner" | "workspace"; readonly canEdit: boolean; readonly canSetDefault: boolean; }
export interface SharedViewsOptions<Schema extends import("./backend.js").DatabaseSchema<any> = import("./backend.js").DatabaseSchema<any>> extends SavedViewsOptions {
  schema?: Schema;
  authorize(context: { auth: import("./auth.js").AuthRequest<any>; db: import("./backend.js").ReadDatabase<Schema> }, workspaceId: string, operation: "read" | "publish" | "edit" | "default"): boolean;
}
export interface SharedViewsClient {
  list(): Promise<readonly SharedSavedView[]>;
  save(input: { id?: string; expectedRevision?: number; name: string; definition: ViewDefinition; editableBy?: "owner" | "workspace" }): Promise<SharedSavedView>;
  remove(id: string, expectedRevision: number): Promise<boolean>;
  setDefault(id: string | null): Promise<void>;
}
export declare function openSharedSavedViews<Schema extends import("./backend.js").DatabaseSchema<any>>(options: SharedViewsOptions<Schema>): Promise<SavedViewsService>;
export declare function createSharedViewsClient(options: SyncClientOptions & { workspaceId: string }): SharedViewsClient;
export declare function mountSharedSavedViews(container: HTMLElement, client: SharedViewsClient, options: { current(): ViewDefinition; apply(view: ViewDefinition): void }): () => void;
