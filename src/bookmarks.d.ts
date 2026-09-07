import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export interface BookmarkFolder { id: string; name: string; version: number; }
export interface Bookmark { id: string; title: string; url: string; notes: string; folderId: string | null; favorite: boolean; version: number; }
export interface BookmarkState { folders: readonly BookmarkFolder[]; bookmarks: readonly Bookmark[]; }
export interface BookmarkClient { list(): Promise<BookmarkState>; save(input: { id?: string; expectedVersion?: number; title: string; url: string; notes?: string; folderId?: string | null; favorite?: boolean }): Promise<Bookmark>; remove(id: string, expectedVersion: number): Promise<void>; saveFolder(input: { id?: string; expectedVersion?: number; name: string }): Promise<BookmarkFolder>; removeFolder(id: string, expectedVersion: number): Promise<void>; }
export interface BookmarkOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export declare function normalizeBookmarkUrl(value:string):string;
export declare function openBookmarks(options:BookmarkOptions):Promise<{handle(request:Request):Promise<Response>;close():void}>;
export declare function createBookmarkClient(options?:SyncClientOptions):BookmarkClient;
export declare function mountBookmarks(container:HTMLElement,client:BookmarkClient):()=>void;
