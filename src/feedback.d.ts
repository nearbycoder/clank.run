import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export type FeedbackRole = "reader" | "voter" | "moderator";
export type FeedbackStatus = "proposed" | "planned" | "doing" | "done" | "declined" | "withdrawn";
export interface FeedbackIdea { id: string; title: string; body: string; status: FeedbackStatus; votes: number; voted: boolean; version: number; authorId: string; canEdit: boolean; }
export interface FeedbackBoard { ideas: readonly FeedbackIdea[]; canVote: boolean; moderator: boolean; }
export interface FeedbackClient { list(board: string): Promise<FeedbackBoard>; add(board: string, title: string, body: string, key?: string): Promise<string>; edit(board: string, id: string, title: string, body: string, expectedVersion: number): Promise<void>; vote(board: string, id: string, selected: boolean): Promise<void>; setStatus(board: string, id: string, status: FeedbackStatus, expectedVersion: number): Promise<void>; }
export interface FeedbackOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export interface FeedbackService { handle(request: Request): Promise<Response>; setAccess(board: string, userId: string, role: FeedbackRole | null): void; close(): void; }
export declare function openFeedback(options:FeedbackOptions):Promise<FeedbackService>;
export declare function createFeedbackClient(options?:SyncClientOptions):FeedbackClient;
export declare function mountFeedback(container:HTMLElement,client:FeedbackClient,board:string):()=>void;
