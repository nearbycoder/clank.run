import type { DatabaseSchema, ReadDatabase, SyncClientOptions } from "./backend.js";
import type { AuthDefinition, AuthRequest } from "./auth.js";
export interface CollaborativeDocument { readonly id: string; readonly text: string; readonly revision: number; readonly acceptedRevision?: number; }
export interface CollaborativeEdit { readonly documentId: string; readonly operationId: string; readonly baseRevision: number; readonly start: number; readonly deleteCount: number; readonly insert: string; }
export interface DocumentSelection { readonly revision: number; readonly anchor: number; readonly head: number; }
export interface DocumentCursor extends DocumentSelection { readonly id: string; readonly userId: string; readonly expiresAt: number; }
export interface DocumentBranch {
  readonly id: string; readonly documentId: string; readonly name: string; readonly authorId: string;
  readonly version: number; readonly baseRevision: number; readonly baseText: string; readonly text: string;
  readonly status: "draft" | "proposed" | "accepted" | "rejected"; readonly acceptedRevision: number | null;
}
export type DocumentBranchSummary = Omit<DocumentBranch, "baseText" | "text">;
export interface DocumentBranchPreview { readonly branch: DocumentBranch; readonly documentRevision: number; readonly before: string; readonly after: string; }
export interface CollaborativeDocumentsOptions<Schema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  path: string; auth: AuthDefinition<any>; schema?: Schema; prefix?: string; maxCharacters?: number; retainedOperations?: number; retainedReceipts?: number; maxReceipts?: number; cursorTtlMs?: number; maxCursors?: number; maxBranches?: number; maxBranchBytes?: number;
  authorize(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, documentId: string, operation: "read" | "create" | "edit"): boolean;
  authorizeBranchDecision?(context: { auth: AuthRequest<any>; db: ReadDatabase<Schema> }, branch: DocumentBranch, decision: "accept" | "reject"): boolean;
}
export interface CollaborativeDocumentsService { handle(request: Request): Promise<Response>; close(): void; }
export interface CollaborativeDocumentsClient {
  read(id: string): Promise<CollaborativeDocument>;
  create(id: string, text?: string): Promise<CollaborativeDocument>;
  edit(operation: CollaborativeEdit): Promise<CollaborativeDocument>;
  setCursor(documentId: string, selection: DocumentSelection): Promise<DocumentCursor>;
  cursors(documentId: string): Promise<readonly DocumentCursor[]>;
  clearCursor(documentId: string): Promise<void>;
  createBranch(documentId: string, id: string, name: string, baseRevision: number): Promise<DocumentBranch>;
  readBranch(documentId: string, id: string): Promise<DocumentBranch>;
  branches(documentId: string): Promise<readonly DocumentBranchSummary[]>;
  saveBranch(documentId: string, id: string, expectedVersion: number, text: string): Promise<DocumentBranch>;
  proposeBranch(documentId: string, id: string, expectedVersion: number): Promise<DocumentBranch>;
  previewBranch(documentId: string, id: string): Promise<DocumentBranchPreview>;
  decideBranch(documentId: string, id: string, expectedVersion: number, decision: "accept" | "reject", documentRevision: number): Promise<DocumentBranch>;
  /** Polls through a fresh authorization check; cleanup cancels future deliveries. */
  subscribe(id: string, listener: (document: CollaborativeDocument | null, error?: Error) => void, intervalMs?: number): () => void;
}
export declare function textEdit(before: string, after: string): { start: number; deleteCount: number; insert: string };
export declare function openCollaborativeDocuments<Schema extends DatabaseSchema<any>>(options: CollaborativeDocumentsOptions<Schema>): Promise<CollaborativeDocumentsService>;
export declare function createCollaborativeDocumentsClient(options?: SyncClientOptions): CollaborativeDocumentsClient;
export declare function mountCollaborativeEditor(container: HTMLElement, client: CollaborativeDocumentsClient, documentId: string): () => void;
/** Review an exact proposal snapshot; acceptance/rejection rechecks current permissions and versions. */
export declare function mountDocumentBranchReview(container: HTMLElement, client: CollaborativeDocumentsClient, documentId: string, branchId: string): () => void;
/** Poll session-bound selections; selection must be null for unsaved local text. Cleanup clears presence. */
export declare function mountDocumentCursorPresence(container: HTMLElement, client: CollaborativeDocumentsClient, documentId: string, selection: () => DocumentSelection | null, intervalMs?: number): () => void;
