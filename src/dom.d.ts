import { type Cleanup, type Computed, type ReactiveSignal } from "./core.js";
export declare const VNODE: unique symbol;
export declare const Fragment: unique symbol;
export declare const EXPRESSION: unique symbol;
export declare const KEYED: unique symbol;
export type Primitive = string | number | bigint | boolean | null | undefined;
export type Renderable = Primitive | Node | VNode | Renderable[] | ReactiveSignal<any> | Computed<any> | ReactiveExpression | KeyedBlock<any> | ((...args: any[]) => Renderable) | Promise<Renderable>;
export type Component<P extends Record<string, unknown> = Record<string, unknown>> = (props: P & {
    children: Renderable[];
}) => Renderable;
export type ElementType = string | Component<any> | typeof Fragment;
export interface VNode {
    readonly [VNODE]: true;
    type: ElementType;
    props: Record<string, unknown>;
    key?: PropertyKey;
}
export interface ReactiveExpression<T = unknown> {
    readonly [EXPRESSION]: true;
    readonly read: () => T;
}
export interface KeyedBlock<T> {
    readonly [KEYED]: true;
    readonly each: T[] | ReactiveSignal<T[]> | Computed<T[]> | ReactiveExpression<T[]> | (() => T[]);
    readonly by?: keyof T | ((item: T, index: number) => PropertyKey);
    readonly fallback?: Renderable;
    readonly renderItem: (item: T, index: () => number) => Renderable;
}
export interface ComponentEvaluation {
    output: Renderable;
    contexts: Map<symbol, unknown>;
    mounts: Array<() => void | Cleanup>;
}
export interface ClankContext<T> {
    readonly id: symbol;
    readonly defaultValue: T;
}
export declare function h(type: ElementType, props?: Record<string, unknown> | null, ...children: Renderable[]): VNode;
export declare const createElement: typeof h;
export declare const jsx: typeof h;
export declare const jsxs: typeof h;
export declare const jsxDEV: typeof h;
/** Compiler marker for an expression that should be evaluated inside a narrow reactive binding. */
export declare function expression<T>(read: () => T): ReactiveExpression<T>;
export declare function isExpression(value: unknown): value is ReactiveExpression;
export declare function isVNode(value: unknown): value is VNode;
export declare function render(root: Element | DocumentFragment, view: Renderable): Cleanup;
/** Attaches reactive bindings and events to Clank SSR markers without recreating matching DOM. */
export declare function hydrate(root: Element, view: Renderable): Cleanup;
/** @internal Evaluates one component with context/lifecycle ownership for DOM and SSR renderers. */
export declare function evaluateComponent(vnode: VNode, parentContexts: Map<symbol, unknown>): ComponentEvaluation;
export declare function onMount(callback: () => void | Cleanup): void;
export declare function createContext<T>(defaultValue: T): ClankContext<T>;
export declare function provideContext<T>(context: ClankContext<T>, value: T): void;
export declare function useContext<T>(context: ClankContext<T>): T;
export declare function Show(props: {
    when: unknown;
    fallback?: Renderable;
    children: Renderable | Renderable[];
}): Renderable;
export declare function For<T>(props: {
    each: T[] | ReactiveSignal<T[]> | Computed<T[]> | (() => T[]);
    by?: keyof T | ((item: T, index: number) => PropertyKey);
    fallback?: Renderable;
    children: ((item: T, index: () => number) => Renderable) | Array<(item: T, index: () => number) => Renderable>;
}): KeyedBlock<T>;
export declare function Match(props: {
    when: unknown;
    children: Renderable | Renderable[];
}): VNode;
export declare function Switch(props: {
    fallback?: Renderable;
    children: Renderable | Renderable[];
}): Renderable;
export declare function lazy(loader: () => Promise<{
    default: Component;
} | Component>): Component;
