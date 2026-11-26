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

interface CompiledRoute {
  kind: number;
  pre: string;
  preSlash: string;
  key: string;
  firstDyn: number;
  segs: string[];
  names: Array<string | null>;
  regex?: RegExp;
}
const patternCache = new Map<string, CompiledRoute>();
const MAX_PATTERN_CACHE = 1_000;
let lastPattern = "";
let lastRoute: CompiledRoute | undefined;

function decodeSegment(raw: string): string | null {
  if (!raw.includes("%")) return raw;
  try { return decodeURIComponent(raw); } catch { return null; }
}

function compilePath(path: string): CompiledRoute {
  const cached = patternCache.get(path);
  if (cached) return cached;
  let route: CompiledRoute;
  if (path === "*") {
    route = { kind: 0, pre: "", preSlash: "", key: "wildcard", firstDyn: 0, segs: [], names: [] };
  } else {
    const segs = path.split("/").filter(Boolean);
    let optionalCount = 0, wildcardIndex = -1, firstDyn = -1, pre = "", source = "^";
    const names: Array<string | null> = [];
    const keys: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      source += "/";
      if (seg === "*") {
        if (wildcardIndex === -1) wildcardIndex = i;
        if (firstDyn === -1) firstDyn = i;
        names.push("wildcard");
        keys.push("wildcard");
        source += "(.*)";
      } else if (seg.charCodeAt(0) === 58) {
        const opt = seg.charCodeAt(seg.length - 1) === 63;
        const key = seg.slice(1, opt ? -1 : undefined);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`Invalid route parameter name: ${key}`);
        if (opt) optionalCount++;
        if (firstDyn === -1) firstDyn = i;
        names.push(key);
        keys.push(key);
        source = opt ? `${source.slice(0, -1)}(?:/([^/]+))?` : `${source}([^/]+)`;
      } else {
        if (firstDyn === -1) pre += `/${seg}`;
        names.push(null);
        source += seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    const last = segs.length - 1;
    const preSlash = `${pre}/`;
    if (firstDyn === -1) route = { kind: 1, pre, preSlash, key: "", firstDyn, segs, names };
    else if (wildcardIndex === -1 && firstDyn === last && optionalCount <= 1) route = { kind: optionalCount ? 3 : 2, pre, preSlash, key: names[last]!, firstDyn, segs, names };
    else if (optionalCount === 0 && wildcardIndex === last && firstDyn === last) route = { kind: 4, pre, preSlash, key: "wildcard", firstDyn, segs, names };
    else if (optionalCount === 0 && wildcardIndex === -1) route = { kind: 5, pre, preSlash: firstDyn > 0 ? preSlash : "/", key: "", firstDyn, segs, names };
    else route = { kind: 6, pre, preSlash, key: "", firstDyn, segs: keys, names, regex: new RegExp(`${source}/?$`) };
  }
  if (patternCache.size >= MAX_PATTERN_CACHE) patternCache.delete(patternCache.keys().next().value!);
  patternCache.set(path, route);
  return route;
}

function matchCompiled(r: CompiledRoute, p: string): Record<string, string> | null {
  const kind = r.kind;
  if (kind === 1) return p === r.pre || p === r.preSlash ? {} : null;
  if (kind >= 2 && kind <= 4) {
    if (kind === 3 && (p === r.pre || p === r.preSlash)) return {};
    const pre = r.preSlash;
    if (!p.startsWith(pre)) return null;
    const start = pre.length;
    let end = p.length;
    if (end > start && p.charCodeAt(end - 1) === 47) end--;
    if (kind !== 4) {
      if (end <= start) return null;
      const slash = p.indexOf("/", start);
      if (slash !== -1 && slash < end) return null;
    }
    const val = decodeSegment(p.slice(start, end));
    return val === null ? null : { [r.key]: val };
  }
  if (kind === 5) {
    const pre = r.preSlash;
    if (!p.startsWith(pre)) return null;
    let end = p.length;
    if (end > 1 && p.charCodeAt(end - 1) === 47) end--;
    let pos = pre.length;
    let params: Record<string, string> | undefined;
    const segs = r.segs, names = r.names;
    for (let i = r.firstDyn; i < segs.length; i++) {
      if (pos >= end) return null;
      let next = p.indexOf("/", pos);
      if (next === -1 || next > end) next = end;
      if (next === pos) return null;
      const name = names[i];
      if (name === null) {
        const seg = segs[i]!;
        if (next - pos !== seg.length || !p.startsWith(seg, pos)) return null;
      } else {
        const val = decodeSegment(p.slice(pos, next));
        if (val === null) return null;
        (params ??= {})[name] = val;
      }
      pos = next + 1;
    }
    return pos === end + 1 ? (params ?? {}) : null;
  }
  if (kind === 0) {
    const val = decodeSegment(p);
    return val === null ? null : { wildcard: val };
  }
  const matched = r.regex!.exec(p);
  if (!matched) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < r.segs.length; i++) {
    const raw = matched[i + 1];
    if (raw !== undefined) {
      const val = decodeSegment(raw);
      if (val === null) return null;
      params[r.segs[i]!] = val;
    }
  }
  return params;
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  if (pattern === lastPattern && lastRoute !== undefined) return matchCompiled(lastRoute, pathname);
  const route = compilePath(pattern);
  lastPattern = pattern;
  lastRoute = route;
  return matchCompiled(route, pathname);
}

function queryRecord(search: URLSearchParams): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of search) {
    const existing = Object.hasOwn(output, key) ? output[key] : undefined;
    if (existing === undefined) Object.defineProperty(output, key, { value, writable: true, enumerable: true, configurable: true });
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
  let navigationRevision = 0;
  let started = false;

  const resolveRoute = async (input?: string): Promise<RouteState | null> => {
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

  const resolve = (input?: string): Promise<RouteState | null> => {
    navigationRevision++;
    return resolveRoute(input);
  };

  const navigate = async (to: string, navigateOptions: NavigateOptions = {}): Promise<boolean> => {
    const base = typeof location === "undefined" ? "http://clank.local" : location.href;
    let target = new URL(to, base);
    assertNavigationProtocol(target);
    const navigation = ++navigationRevision;
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= 32; redirects++) {
      if (navigation !== navigationRevision) return false;
      assertNavigationProtocol(target);
      if (visited.has(target.href)) throw new Error("Route guard redirect cycle detected.");
      visited.add(target.href);
      if (typeof location !== "undefined" && target.origin !== location.origin) {
        controller?.abort();
        location.assign(target.href);
        return true;
      }
      const matched = matchRoutes(options.routes, target, options.base);
      if (matched?.route.guard) {
        let permitted: boolean | string;
        try { permitted = await matched.route.guard({ ...matched, from: state.peek() }); }
        catch (error) { if (navigation !== navigationRevision) return false; throw error; }
        if (navigation !== navigationRevision || permitted === false) return false;
        if (typeof permitted === "string") {
          target = new URL(permitted, base);
          navigateOptions = { replace: true };
          continue;
        }
      }
      if (typeof history !== "undefined") {
        history[navigateOptions.replace ? "replaceState" : "pushState"](navigateOptions.state, "", target);
      }
      await resolveRoute(target.href);
      return navigation === navigationRevision;
    }
    throw new Error("Route guard redirect limit exceeded.");
  };

  const start = (): (() => void) => {
    if (started || typeof window === "undefined") return () => {};
    started = true;
    const onPopState = () => { void resolve(); };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[data-clank-link]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.hasAttribute("download") || anchor.origin !== location.origin) return;
      event.preventDefault();
      void navigate(anchor.href);
    };
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick);
    void resolve();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      started = false;
      navigationRevision++;
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
