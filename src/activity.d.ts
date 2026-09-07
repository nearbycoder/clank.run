import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export interface ActivityCursor { at: number; id: string; }
export interface ActivityItem { id: string; title: string; detail: string; kind: string; href: string | null; at: number; read: boolean; }
export interface ActivityPage { items: readonly ActivityItem[]; next: ActivityCursor | null; unread: number; kinds: readonly string[]; }
export interface ActivityClient { list(options?: { before?: ActivityCursor; kind?: string; unreadOnly?: boolean }): Promise<ActivityPage>; markRead(id: string): Promise<void>; markThrough(cursor: ActivityCursor): Promise<void>; clearThrough(cursor: ActivityCursor): Promise<void>; }
export interface ActivityOptions { path: string; auth: AuthDefinition<any>; prefix?: string; maxEntries?: number; }
export interface ActivityService { handle(request: Request): Promise<Response>; record(userId: string, event: { key: string; title: string; detail?: string; kind?: string; href?: string }): string; close(): void; }
export declare function openActivity(options:ActivityOptions):Promise<ActivityService>;
export declare function createActivityClient(options?:SyncClientOptions):ActivityClient;
export declare function mountActivity(container:HTMLElement,client:ActivityClient):()=>void;
