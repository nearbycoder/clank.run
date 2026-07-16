import { batch, computed, signal, type ReactiveSignal } from "./core.ts";
import { h, type Component, type Renderable } from "./dom.ts";

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
  error?: Component<{ error: unknown }>;
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
  Link: Component<Record<string, unknown> & { to: string }>;
}

const patternCache = new Map<string, { regex: RegExp; keys: string[] }>();
const MAX_PATTERN_CACHE = 1_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePath(path: string): { regex: RegExp; keys: string[] } {
  const cached = patternCache.get(path);
  if (cached) return cached;
  const keys: string[] = [];
  if (path === "*") return { regex: /^(.*)$/, keys: ["wildcard"] };
  const segments = path.split("/").filter(Boolean);
  let source = "^";
  for (const segment of segments) {
    source += "/";
    if (segment === "*") {
      keys.push("wildcard");
      source += "(.*)";
    } else if (segment.startsWith(":")) {
      const optional = segment.endsWith("?");
      const key = segment.slice(1, optional ? -1 : undefined);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`Invalid route parameter name: ${key}`);
      keys.push(key);
      source = optional
        ? source.slice(0, -1) + "(?:/([^/]+))?"
        : source + "([^/]+)";
    } else {
      source += escapeRegExp(segment);
    }
  }
  source += segments.length === 0 ? "/?$" : "/?$";
  const compiled = { regex: new RegExp(source), keys };
  if (patternCache.size >= MAX_PATTERN_CACHE) patternCache.delete(patternCache.keys().next().value!);
  patternCache.set(path, compiled);
  return compiled;
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const { regex, keys } = compilePath(pattern);
  const matched = regex.exec(pathname);
  if (!matched) return null;
  const params: Record<string, string> = {};
  try {
    keys.forEach((key, index) => {
      if (matched[index + 1] !== undefined) params[key] = decodeURIComponent(matched[index + 1]);
    });
  } catch {
    return null;
  }
  return params;
}

function queryRecord(search: URLSearchParams): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of search) {
    const existing = output[key];
    if (existing === undefined) output[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else output[key] = [existing, value];
  }
  return output;
}

export function matchRoutes(routes: RouteDefinition[], input: URL | string, base = "/"): RouteMatch | null {
  const origin = typeof location === "undefined" ? "http://clank.local" : location.origin;
  const url = input instanceof URL ? input : new URL(input, origin);
  let path = url.pathname;
  const normalizedBase = base === "/" ? "" : `/${base.split("/").filter(Boolean).join("/")}`;
  if (normalizedBase) {
    if (path !== normalizedBase && !path.startsWith(`${normalizedBase}/`)) return null;
    path = path.slice(normalizedBase.length) || "/";
  }
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (params) {
      return {
        route,
        path: url.pathname,
        params,
        query: queryRecord(url.searchParams),
        hash: url.hash.slice(1),
      };
    }
  }
  return null;
}

export function createRouter(options: RouterOptions): Router {
  const state = signal<RouteState | null>(null, { name: "router.state" });
  const current = computed(() => state.value, { name: "router.current" });
  let controller: AbortController | undefined;
  let revision = 0;
  let started = false;

  const resolve = async (input?: string): Promise<RouteState | null> => {
    const href = input ?? (typeof location === "undefined" ? "/" : location.href);
    const matched = matchRoutes(options.routes, href, options.base);
    controller?.abort();
    controller = new AbortController();
    const run = ++revision;
    if (!matched) {
      state.value = null;
      return null;
    }
    const next: RouteState = { ...matched, status: matched.route.load ? "loading" : "ready" };
    state.value = next;
    if (typeof document !== "undefined" && matched.route.title) {
      document.title = typeof matched.route.title === "function" ? matched.route.title(matched) : matched.route.title;
    }
    if (!matched.route.load) return next;
    try {
      const data = await matched.route.load({ ...matched, signal: controller.signal });
      if (run !== revision || controller.signal.aborted) return state.peek();
      const ready: RouteState = { ...matched, data, status: "ready" };
      state.value = ready;
      return ready;
    } catch (error) {
      if (run !== revision || controller.signal.aborted) return state.peek();
      const failed: RouteState = { ...matched, error, status: "error" };
      state.value = failed;
      return failed;
    }
  };

  const navigate = async (to: string, navigateOptions: NavigateOptions = {}): Promise<boolean> => {
    const origin = typeof location === "undefined" ? "http://clank.local" : location.origin;
    const target = new URL(to, origin);
    assertNavigationProtocol(target);
    if (typeof location !== "undefined" && target.origin !== location.origin) {
      location.assign(target.href);
      return true;
    }
    const matched = matchRoutes(options.routes, target, options.base);
    if (matched?.route.guard) {
      const permitted = await matched.route.guard({ ...matched, from: state.peek() });
      if (permitted === false) return false;
      if (typeof permitted === "string") return navigate(permitted, { replace: true });
    }
    if (typeof history !== "undefined") {
      history[navigateOptions.replace ? "replaceState" : "pushState"](navigateOptions.state, "", target);
    }
    await resolve(target.href);
    return true;
  };

  const start = (): (() => void) => {
    if (started || typeof window === "undefined") return () => {};
    started = true;
    const onPopState = () => { void resolve(); };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[data-clank-link]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.download || anchor.origin !== location.origin) return;
      event.preventDefault();
      void navigate(anchor.href);
    };
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick);
    void resolve();
    return () => {
      started = false;
      controller?.abort();
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClick);
    };
  };

  const View: Component = () => () => {
    const routeState = state.value;
    if (!routeState) return options.fallback ? h(options.fallback, {}) : null;
    if (routeState.status === "loading" && options.loading) return h(options.loading, {});
    if (routeState.status === "error" && options.error) return h(options.error, { error: routeState.error });
    return h(routeState.route.component, {
      route: routeState,
      params: routeState.params,
      query: routeState.query,
      data: routeState.data,
    });
  };

  const Link: Router["Link"] = (props) => {
    const { to, children, ...rest } = props;
    return h("a", { ...rest, href: to, "data-clank-link": true }, ...children);
  };

  return { state, current, navigate, resolve, start, View, Link };
}

export function redirect(to: string, status = 302): Response {
  assertNavigationProtocol(new URL(to, "http://clank.local"));
  return new Response(null, { status, headers: { Location: to } });
}

function assertNavigationProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Unsafe navigation protocol: ${url.protocol}`);
  }
}
