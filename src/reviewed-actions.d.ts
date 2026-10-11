import type { Schema } from "./ai.js";
import type { AuthRequest, AuthRuntime } from "./auth.js";
import type { SQLiteDatabase, ReadDatabase, WriteDatabase, DatabaseSchema } from "./backend.js";
import type { McpTool } from "./mcp.js";

export interface ReviewedActionContext<DB extends DatabaseSchema<any> = any> { readonly db: ReadDatabase<DB>; readonly auth: AuthRequest<any>; }
export interface ReviewedActionWriteContext<DB extends DatabaseSchema<any> = any> { readonly db: WriteDatabase<DB>; readonly auth: AuthRequest<any>; }
export interface ReviewedRecordChange { readonly table: string; readonly id: string; readonly beforeVersion: number | null; readonly afterVersion: number | null; }
export interface ReviewedAction<Input = any, Preview = any, Output = any, DB extends DatabaseSchema<any> = any> {
  /** Change this revision whenever preview, execution, authorization, or undo semantics change. */
  readonly revision: string;
  /** Declare that all preview/authorization data dependencies use context.db. */
  readonly previewDependencies?: "records" | "database";
  readonly args: Schema<Input>;
  readonly title: string;
  readonly authorize: (context: ReviewedActionContext<DB>, input: Input) => boolean;
  readonly authorizeApproval: (context: ReviewedActionContext<DB>, plan: ReviewedActionPlan<NoInfer<Preview>>) => boolean;
  readonly preview: (context: ReviewedActionContext<DB>, input: Input) => Preview;
  readonly execute: (context: ReviewedActionWriteContext<DB>, input: Input, preview: NoInfer<Preview>) => Output;
  readonly compensate?: (context: ReviewedActionWriteContext<DB>, receipt: ReviewedActionReceipt<NoInfer<Output>>) => unknown;
}
export interface ReviewedActionPlan<Preview = unknown> {
  readonly protocol: "clank-reviewed-action/1";
  readonly id: string;
  readonly action: string;
  readonly actionRevision: string;
  readonly requestedBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly databaseRevision: number;
  readonly dependencyMode?: "records";
  readonly status: "pending" | "approved" | "denied" | "expired" | "consumed";
  readonly approvedBy: string | null;
  readonly preview: Preview;
}
export interface ReviewedActionReceipt<Output = unknown> {
  readonly protocol: "clank-action-receipt/1";
  readonly id: string;
  readonly planId: string;
  readonly action: string;
  readonly owner: string;
  readonly committedAt: number;
  readonly committedRevision: number;
  readonly changes: readonly ReviewedRecordChange[];
  readonly output: Output;
  readonly compensationAvailable: boolean;
  readonly compensatedBy: string | null;
}
export interface ReviewedApprovalEvent { readonly sequence: number; readonly planId: string; readonly actor: string; readonly transition: string; readonly at: number; }
export interface ReviewedActionsOptions {
  readonly actions: Readonly<Record<string, ReviewedAction>>;
  readonly prefix?: string;
  readonly allowedOrigins?: readonly string[];
  readonly ttlMs?: number;
  /** Hard admission bound for durable plans/receipts. Defaults to 10000. */
  readonly maxEntries?: number;
  /** Retain terminal plans, receipts and audit events for this period. Defaults to 30 days. */
  readonly retentionMs?: number;
  /** Best-effort wakeup only. Poll durable inbox/events after process restarts. */
  readonly onChange?: (event: ReviewedApprovalEvent) => void;
  /** Current server admission, repeated inside each guarded read/write transaction. */
  readonly authorizeCaller?: (current: AuthRequest<any>) => undefined;
}
export interface ReviewedActions {
  readonly tools: readonly McpTool<AuthRequest<any> | null>[];
  handles(request: Request): boolean;
  handle(request: Request): Promise<Response>;
  plan(action: string, input: unknown, auth: AuthRequest<any>): ReviewedActionPlan;
  decide(id: string, decision: "approve" | "deny", auth: AuthRequest<any>): ReviewedActionPlan;
  commit(id: string, auth: AuthRequest<any>): ReviewedActionReceipt;
  compensate(id: string, auth: AuthRequest<any>): ReviewedActionReceipt;
  inbox(auth: AuthRequest<any>): readonly ReviewedActionPlan[];
  receipt(id: string, auth: AuthRequest<any>): ReviewedActionReceipt;
  events(auth: AuthRequest<any>, after?: number): readonly ReviewedApprovalEvent[];
}

export declare function defineReviewedAction<Input, Preview, Output>(action: ReviewedAction<Input, Preview, Output>): ReviewedAction<Input, Preview, Output>;
export declare function defineReviewedAction<DB extends DatabaseSchema<any>, Input, Preview, Output>(schema: DB, action: ReviewedAction<Input, Preview, Output, DB>): ReviewedAction<Input, Preview, Output, DB>;
export declare function openReviewedActions(database: SQLiteDatabase<any>, authRuntime: AuthRuntime<any>, options: ReviewedActionsOptions): ReviewedActions;
export declare function renderApprovalInbox(plans: readonly ReviewedActionPlan[], prefix?: string, csrf?: string): string;
