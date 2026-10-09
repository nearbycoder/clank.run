import type { Schema } from "./ai.js";
import type { DatabaseSchema, ReadDatabase, SQLiteDatabase, WriteDatabase } from "./backend.js";
export interface AgentBudgetAmounts {
    readonly calls: number;
    readonly writes: number;
    readonly records: number;
    readonly externalOperations: number;
}
export interface AgentBudgetIdentity {
    readonly ownerId: string;
    readonly principalId: string;
}
export interface AgentBudgetContext<Context = unknown, DB extends DatabaseSchema<any> = any> {
    readonly caller: Context;
    readonly identity: AgentBudgetIdentity;
    readonly db: ReadDatabase<DB>;
}
export interface AgentBudgetWriteContext<Context = unknown, DB extends DatabaseSchema<any> = any> extends AgentBudgetContext<Context, DB> {
    readonly db: WriteDatabase<DB>;
    /** Stable identity for transactional outbox work and idempotent provider calls. */
    readonly operationId: string;
}
export interface AgentBudgetAction<Input = any, Output = any, Context = any, DB extends DatabaseSchema<any> = any> {
    /** Change revision when authorization, execution or external-operation costs change. */
    readonly revision: string;
    readonly args: Schema<Input>;
    readonly authorize: (context: AgentBudgetContext<Context, DB>, input: Input) => boolean;
    readonly execute: (context: AgentBudgetWriteContext<Context, DB>, input: Input) => Output;
    /** Accepted transactional outbox operations, never a cost supplied by the client. */
    readonly externalOperations?: number;
}
export interface AgentBudgetGrant {
    readonly protocol: "clank-agent-budget/1";
    readonly id: string;
    readonly ownerId: string;
    readonly principalId: string;
    readonly actions: Readonly<Record<string, string>>;
    readonly limits: AgentBudgetAmounts;
    readonly used: AgentBudgetAmounts;
    readonly remaining: AgentBudgetAmounts;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly status: "active" | "revoked" | "expired";
    readonly reason: string;
}
export interface AgentBudgetReceipt<Output = unknown> {
    readonly protocol: "clank-agent-budget-receipt/1";
    readonly grantId: string;
    readonly operationId: string;
    readonly action: string;
    readonly actionRevision: string;
    readonly acceptedAt: number;
    readonly cost: AgentBudgetAmounts;
    readonly output: Output;
}
export interface AgentBudgetGrantInput {
    readonly principalId: string;
    readonly actions: readonly string[];
    readonly limits: AgentBudgetAmounts;
    readonly expiresAt: number;
    readonly reason: string;
}
type InputOf<Action> = Action extends AgentBudgetAction<infer Input, any, any, any> ? Input : never;
type OutputOf<Action> = Action extends AgentBudgetAction<any, infer Output, any, any> ? Output : never;
export interface AgentBudgets<Context, Actions extends Record<string, AgentBudgetAction>> {
    grant(input: AgentBudgetGrantInput, caller: Context): AgentBudgetGrant;
    preview(id: string, caller: Context): AgentBudgetGrant;
    revoke(id: string, caller: Context): AgentBudgetGrant;
    execute<Name extends keyof Actions & string>(input: {
        readonly grantId: string;
        readonly operationId: string;
        readonly action: Name;
        readonly input: InputOf<Actions[Name]>;
    }, caller: Context): AgentBudgetReceipt<OutputOf<Actions[Name]>>;
    /** Retire only this owner's grants after expiry/revocation and the retention window. */
    prune(caller: Context): number;
}
export interface AgentBudgetsOptions<Context, Actions extends Record<string, AgentBudgetAction>> {
    readonly actions: Actions;
    /** Resolve CURRENT trusted credentials, including revocation, on every invocation. Never trust request IDs. */
    readonly identity: (caller: Context) => AgentBudgetIdentity | null;
    readonly authorizeManage: (context: AgentBudgetContext<Context>) => boolean;
    readonly now?: () => number;
    readonly maxGrants?: number;
    readonly maxReceipts?: number;
    readonly maxValueBytes?: number;
    readonly retentionMs?: number;
}
export type AgentBudgetErrorCode = "BUDGET_UNAUTHENTICATED" | "BUDGET_FORBIDDEN" | "BUDGET_NOT_FOUND" | "BUDGET_CLOSED" | "BUDGET_EXCEEDED" | "BUDGET_RETRY_CONFLICT" | "BUDGET_ACTION_CHANGED" | "BUDGET_CAPACITY";
export declare class AgentBudgetError extends Error {
    readonly code: AgentBudgetErrorCode;
    constructor(code: AgentBudgetErrorCode, message: string);
}
export declare function defineAgentBudgetAction<Input, Output, Context = any>(action: AgentBudgetAction<Input, Output, Context>): AgentBudgetAction<Input, Output, Context>;
export declare function defineAgentBudgetAction<DB extends DatabaseSchema<any>, Input, Output, Context = any>(schema: DB, action: AgentBudgetAction<Input, Output, Context, DB>): AgentBudgetAction<Input, Output, Context, DB>;
/** Durable budgets and local application writes share one SQLite write transaction. */
export declare function openAgentBudgets<Context, Actions extends Record<string, AgentBudgetAction>>(database: SQLiteDatabase<any>, options: AgentBudgetsOptions<Context, Actions>): Promise<AgentBudgets<Context, Actions>>;
export {};
