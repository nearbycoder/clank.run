import type { DatabaseSchema, ReadDatabase, SyncClientOptions } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
export interface CollaborativeDocument { readonly id: string; readonly text: string; readonly revision: number; readonly acceptedRevision?: number; }
export interface CollaborativeEdit { readonly documentId: string; readonly operationId: string; readonly baseRevision: number; readonly start: number; readonly deleteCount: number; readonly insert: string; }
export interface CollaborativeDocumentsOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCharacters?: number; retainedOperations?: number;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, documentId: string, operation: "read" | "create" | "edit"): boolean;
}
export interface CollaborativeDocumentsService { handle(request: Request): Promise<Response>; close(): void; }
export interface CollaborativeDocumentsClient {
  read(id: string): Promise<CollaborativeDocument>;
  create(id: string, text?: string): Promise<CollaborativeDocument>;
  edit(operation: CollaborativeEdit): Promise<CollaborativeDocument>;
  /** Polls through a fresh authorization check; cleanup cancels future deliveries. */
  subscribe(id: string, listener: (document: CollaborativeDocument | null, error?: Error) => void, intervalMs?: number): () => void;
}
export declare function textEdit(before: string, after: string): { start: number; deleteCount: number; insert: string };
export declare function openCollaborativeDocuments<Schema extends DatabaseSchema<any>>(options: CollaborativeDocumentsOptions<Schema>): Promise<CollaborativeDocumentsService>;
export declare function createCollaborativeDocumentsClient(options?: SyncClientOptions): CollaborativeDocumentsClient;
export declare function mountCollaborativeEditor(container: HTMLElement, client: CollaborativeDocumentsClient, documentId: string): () => void;
