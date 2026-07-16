/** Clank's fine-grained reactive kernel. It has no platform dependencies. */
export declare const SIGNAL: unique symbol;
export declare const STORE: unique symbol;
export type Cleanup = () => void;
export type Equality<T> = false | ((previous: T, next: T) => boolean);
interface Source {
    observers: Set<Observer>;
}
interface Observer {
    dependencies: Set<Source>;
    active: boolean;
    schedule(): void;
}
export interface SignalOptions<T> {
    name?: string;
    equals?: Equality<T>;
}
export declare class ReactiveSignal<T> implements Source {
    #private;
    readonly [SIGNAL] = true;
    readonly observers: Set<Observer>;
    readonly name?: string;
    readonly equals: Equality<T>;
    constructor(value: T, options?: SignalOptions<T>);
    get value(): T;
    set value(next: T);
    get(): T;
    peek(): T;
    set(next: T | ((current: T) => T)): T;
    update(updater: (current: T) => T): T;
    subscribe(listener: (value: T, previous: T) => void, immediate?: boolean): Cleanup;
    /** @internal Restores a failed transaction without creating another journal entry. */
    _restore(value: T): void;
    toJSON(): T;
}
export declare function signal<T>(value: T, options?: SignalOptions<T>): ReactiveSignal<T>;
export declare function isSignal(value: unknown): value is ReactiveSignal<unknown> | Computed<unknown>;
export declare class Computed<T> implements Source, Observer {
    #private;
    readonly derive: () => T;
    readonly name?: string | undefined;
    readonly [SIGNAL] = true;
    readonly observers: Set<Observer>;
    readonly dependencies: Set<Source>;
    active: boolean;
    constructor(derive: () => T, name?: string | undefined);
    get value(): T;
    get(): T;
    peek(): T;
    schedule(): void;
    private evaluate;
    dispose(): void;
    toJSON(): T;
}
export declare function computed<T>(derive: () => T, options?: {
    name?: string;
}): Computed<T>;
export interface EffectOptions {
    defer?: boolean;
}
export declare function effect(callback: (onCleanup: (cleanup: Cleanup) => void) => void | Cleanup, options?: EffectOptions): Cleanup;
export declare function batch<T>(callback: () => T): T;
/** Batches writes and atomically rolls signal values back if the callback throws. */
export declare function transaction<T>(callback: () => T): T;
export declare function untrack<T>(callback: () => T): T;
export declare function onCleanup(cleanup: Cleanup): Cleanup;
export declare function createRoot<T>(callback: (dispose: Cleanup) => T): T;
export declare function getOwner(): object | null;
export declare function runWithOwner<T>(owner: object | null, callback: () => T): T;
export declare function store<T extends object>(initial: T): T;
export declare function isStore(value: unknown): boolean;
export declare function toRaw<T>(value: T): T;
export declare function snapshot<T>(value: T): T;
export type ResourceStatus = "idle" | "loading" | "ready" | "refreshing" | "error";
export interface ResourceContext<T> {
    signal: AbortSignal;
    value: T | undefined;
}
export interface Resource<T, P = void> {
    data: ReactiveSignal<T | undefined>;
    error: ReactiveSignal<unknown>;
    status: ReactiveSignal<ResourceStatus>;
    loading: Computed<boolean>;
    reload(parameter?: P): Promise<T | undefined>;
    mutate(value: T | undefined | ((current: T | undefined) => T | undefined)): void;
    abort(): void;
}
export interface ResourceOptions<T> {
    initial?: T;
    immediate?: boolean;
}
export declare function resource<T, P = void>(loader: (parameter: P | undefined, context: ResourceContext<T>) => Promise<T> | T, options?: ResourceOptions<T>): Resource<T, P>;
/** Reduces an async iterable into a live signal, useful for model-token streams. */
export declare function consumeStream<T>(iterable: AsyncIterable<T>, initial: T, reduce?: (current: T, chunk: T) => T): Promise<ReactiveSignal<T>>;
export {};
