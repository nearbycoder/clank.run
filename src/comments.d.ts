import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export type CommentRole = "reader" | "commenter" | "moderator";
export interface CommentItem { id: string; authorId: string; body: string; parentId: string | null; rootId: string; depth: number; version: number; createdAt: number; editedAt: number | null; deleted: boolean; resolved: boolean; canManage: boolean; }
export interface CommentPage { items: readonly CommentItem[]; next: { at: number; id: string } | null; canComment: boolean; }
export interface CommentServiceOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export interface CommentService { handle(request: Request): Promise<Response>; setAccess(resource: string, userId: string, role: CommentRole | null): void; close(): void; }
export interface CommentClient {
  list(resource: string, before?: { at: number; id: string }): Promise<CommentPage>;
  thread(resource: string, rootId: string): Promise<readonly CommentItem[]>;
  add(resource: string, body: string, options?: { parentId?: string; key?: string }): Promise<CommentItem>;
  edit(resource: string, id: string, body: string, expectedVersion: number): Promise<CommentItem>;
  remove(resource: string, id: string, expectedVersion: number): Promise<void>;
  resolve(resource: string, id: string, resolved: boolean, expectedVersion: number): Promise<void>;
}
export declare function openComments(options: CommentServiceOptions): Promise<CommentService>;
export declare function createCommentClient(options?: SyncClientOptions): CommentClient;
export declare function mountComments(container: HTMLElement, client: CommentClient, resource: string): () => void;
