import { computed, type ReactiveSignal } from "./core.js";
import { type Component } from "./dom.js";
export interface RouteDefinition {
    path: string;
    component: Component;
    load?: (context: RouteLoadContext) => unknown | Promise<unknown>;
    guard?: (context: RouteGuardContext) => boolean | string | Promise<boolean | string>;
    title?: string | ((match: RouteMatch) => string);
    meta?: Record<string, unknown>;
}
export interface RouteMatch {
    route: RouteDefinition;
    path: string;
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    hash: string;
}
export interface RouteState extends RouteMatch {
    data?: unknown;
    error?: unknown;
    status: "idle" | "loading" | "ready" | "error";
}
export interface RouteLoadContext extends RouteMatch {
    signal: AbortSignal;
}
export interface RouteGuardContext extends RouteMatch {
    from: RouteState | null;
}
export interface RouterOptions {
    routes: RouteDefinition[];
    base?: string;
    fallback?: Component;
    loading?: Component;
    error?: Component<{
        error: unknown;
    }>;
}
export interface NavigateOptions {
    replace?: boolean;
    state?: unknown;
}
export interface Router {
    state: ReactiveSignal<RouteState | null>;
    current: ReturnType<typeof computed<RouteState | null>>;
    navigate(to: string, options?: NavigateOptions): Promise<boolean>;
    resolve(url?: string): Promise<RouteState | null>;
    start(): () => void;
    View: Component;
    Link: Component<Record<string, unknown> & {
        to: string;
    }>;
}
export declare function matchPath(pattern: string, pathname: string): Record<string, string> | null;
export declare function matchRoutes(routes: RouteDefinition[], input: URL | string, base?: string): RouteMatch | null;
export declare function createRouter(options: RouterOptions): Router;
export declare function redirect(to: string, status?: number): Response;
