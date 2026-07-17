import { type Computed, type ReactiveSignal } from "./core.js";
import type { Component } from "./dom.js";
export interface ValidationIssue {
    path: Array<string | number>;
    message: string;
    expected?: string;
    received?: unknown;
}
export declare class ValidationError extends Error {
    readonly issues: ValidationIssue[];
    readonly name = "ValidationError";
    constructor(issues: ValidationIssue[]);
}
export interface Schema<T = unknown> {
    readonly description?: string;
    parse(input: unknown): T;
    safeParse(input: unknown): {
        success: true;
        data: T;
    } | {
        success: false;
        error: ValidationError;
    };
    toJSONSchema(): Record<string, unknown>;
}
declare const DOCUMENT_ID_TABLE: unique symbol;
export type DocumentId<Table extends string> = string & {
    readonly [DOCUMENT_ID_TABLE]: Table;
};
export type InferSchema<S> = S extends Schema<infer T> ? T : never;
export type SchemaShape = Record<string, Schema<any>>;
export type InferSchemaShape<S extends SchemaShape> = {
    [K in keyof S as undefined extends InferSchema<S[K]> ? never : K]: InferSchema<S[K]>;
} & {
    [K in keyof S as undefined extends InferSchema<S[K]> ? K : never]?: Exclude<InferSchema<S[K]>, undefined>;
};
type Infer<S> = InferSchema<S>;
type Shape = SchemaShape;
type InferShape<S extends Shape> = InferSchemaShape<S>;
export declare const s: {
    id<const Table extends string>(table: Table, description?: string): Schema<DocumentId<Table>>;
    string(options?: {
        description?: string;
        min?: number;
        max?: number;
        pattern?: RegExp;
    }): Schema<string>;
    email(options?: {
        description?: string;
        min?: number;
        max?: number;
    }): Schema<string>;
    url(options?: {
        description?: string;
        protocols?: readonly ("http" | "https")[];
    }): Schema<string>;
    date(description?: string): Schema<string>;
    datetime(description?: string): Schema<string>;
    number(options?: {
        description?: string;
        min?: number;
        max?: number;
        integer?: boolean;
    }): Schema<number>;
    boolean(description?: string): Schema<boolean>;
    literal<const T extends string | number | boolean | null>(value: T, description?: string): Schema<T>;
    enum<const T extends readonly string[]>(values: T, description?: string): Schema<T[number]>;
    unknown(description?: string): Schema<unknown>;
    array<T>(item: Schema<T>, options?: {
        description?: string;
        min?: number;
        max?: number;
    }): Schema<T[]>;
    record<T>(value: Schema<T>, options?: {
        description?: string;
        keyPattern?: RegExp;
    }): Schema<Record<string, T>>;
    object<S extends Shape>(shape: S, options?: {
        description?: string;
        strict?: boolean;
    }): Schema<InferShape<S>>;
    optional<T>(inner: Schema<T>): Schema<T | undefined>;
    nullable<T>(inner: Schema<T>): Schema<T | null>;
    default<T>(inner: Schema<T>, fallback: T): Schema<T>;
    refine<T>(inner: Schema<T>, predicate: (value: T) => boolean, message: string, description?: string): Schema<T>;
    union<T extends readonly Schema[]>(members: T, description?: string): Schema<Infer<T[number]>>;
    coerce: {
        number(options?: {
            description?: string;
            min?: number;
            max?: number;
            integer?: boolean;
        }): Schema<number>;
        boolean(description?: string): Schema<boolean>;
    };
};
export interface ActionContext {
    request?: Request;
    user?: unknown;
    signal?: AbortSignal;
    [key: string]: unknown;
}
export interface ActionDefinition<I, O> {
    name: string;
    description: string;
    input: Schema<I>;
    output?: Schema<O>;
    handler: (input: I, context: ActionContext) => O | Promise<O>;
    sideEffects?: "none" | "read" | "write" | "destructive";
    confirmation?: "never" | "write" | "always";
    authorize?: (input: I, context: ActionContext) => boolean | Promise<boolean>;
}
export interface Action<I = unknown, O = unknown> {
    (input: I, context?: ActionContext): Promise<O>;
    readonly definition: ActionDefinition<I, O>;
    readonly manifest: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        sideEffects: string;
        confirmation: string;
    };
}
export declare function defineAction<I, O>(definition: ActionDefinition<I, O>): Action<I, O>;
export declare class ActionError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details?: unknown | undefined;
    readonly name = "ActionError";
    constructor(code: string, message: string, status?: number, details?: unknown | undefined);
}
export interface AgentBridge {
    readonly actions: ReadonlyMap<string, Action<any, any>>;
    manifest(): {
        protocol: "clank-agent/1";
        actions: Action["manifest"][];
    };
    invoke(name: string, input: unknown, context?: ActionContext): Promise<unknown>;
    handle(request: Request, context?: ActionContext): Promise<Response>;
}
export interface AgentBridgeOptions {
    allowedOrigins?: readonly string[];
    requireOrigin?: boolean;
    maxRequestBytes?: number;
}
export declare function createAgentBridge(actions: Action<any, any>[], options?: AgentBridgeOptions): AgentBridge;
export interface ActionRunner<I, O> {
    pending: ReactiveSignal<boolean>;
    data: ReactiveSignal<O | undefined>;
    error: ReactiveSignal<unknown>;
    canRun: Computed<boolean>;
    run(input: I, context?: ActionContext): Promise<O | undefined>;
    reset(): void;
}
export declare function actionRunner<I, O>(action: Action<I, O>): ActionRunner<I, O>;
export interface ViewDefinition<P extends Record<string, unknown>> {
    name: string;
    description: string;
    props?: Schema<P>;
    render: Component<P>;
}
export type AgentView<P extends Record<string, unknown>> = Component<P> & {
    viewManifest: {
        name: string;
        description: string;
        propsSchema?: Record<string, unknown>;
    };
};
export declare function defineView<P extends Record<string, unknown>>(definition: ViewDefinition<P>): AgentView<P>;
export interface AgentNode {
    id?: string;
    tag: string;
    role?: string;
    label?: string;
    description?: string;
    intent?: string;
    action?: string;
    name?: string;
    type?: string;
    disabled?: boolean;
    readonly?: boolean;
    required?: boolean;
    invalid?: boolean;
    expanded?: boolean;
    checked?: boolean;
    multiple?: boolean;
    value?: string | string[];
    placeholder?: string;
    href?: string;
    children?: AgentNode[];
}
/** Produces a compact semantic UI tree so agents do not need pixels or brittle selectors. */
export declare function inspectAgentSurface(root: ParentNode): AgentNode[];
export interface AgentSurface {
    inspect(): AgentNode[];
    activate(id: string): boolean;
    input(id: string, value: string | number | boolean | readonly string[]): boolean;
}
export declare function createAgentSurface(root: ParentNode): AgentSurface;
export {};
