import { matchPath } from "./router.ts";
import { applyBufferedDefaultHeaders, createBufferedResponse } from "./security.ts";

type SegmentParams<Segment extends string> = Segment extends `:${infer Name}?`
  ? { [Key in Name]?: string }
  : Segment extends `:${infer Name}`
    ? { [Key in Name]: string }
    : Segment extends "*"
      ? { wildcard: string }
      : {};

export type RouteParams<Path extends string> = string extends Path
  ? Record<string, string>
  : Path extends `${infer Segment}/${infer Rest}`
    ? SegmentParams<Segment> & RouteParams<Rest>
    : SegmentParams<Path>;

export interface RequestContext<Path extends string = string, State extends Record<string, unknown> = Record<string, unknown>> {
  request: Request;
  url: URL;
  params: RouteParams<Path>;
  state: State;
}

export type RequestHandler<Path extends string = string, State extends Record<string, unknown> = Record<string, unknown>> = (context: RequestContext<Path, State>) => Response | Promise<Response>;
export type Middleware<State extends Record<string, unknown> = Record<string, unknown>> = (context: RequestContext<string, State>, next: () => Promise<Response>) => Response | Promise<Response>;

interface Endpoint {
  order: number;
  method: string;
  path: string;
  handler: RequestHandler<any, any>;
  /** Exact pathname for a parameterless route, without its optional trailing slash. */
  literal?: string;
  /** Text every match of a parameterised route must start with. */
  prefix?: string;
  /** Single trailing parameter name when the route is strictly `<prefix>/:<param>`. */
  singleParam?: string;
  /** First non-empty static prefix segment key for indexed lookup, or "" for catch-all/root-param. */
  bucket: string;
}

/**
 * Derive string pre-checks from a route pattern. matchPath() stays the only
 * judge of complex parameterised routes; these checks skip patterns that cannot
 * match and directly match static and single-trailing-parameter routes.
 */
function describeEndpoint(order: number, method: string, path: string, handler: RequestHandler<any, any>): Endpoint {
  const endpoint: Endpoint = { order, method, path, handler, bucket: "" };
  if (path === "*") return endpoint;
  const segments = path.split("/").filter(Boolean);
  // A malformed parameter name must keep failing exactly where matchPath() reports it.
  if (segments.some((segment) => segment.startsWith(":") && !/^:[A-Za-z][A-Za-z0-9_]*\??$/.test(segment))) return endpoint;
  let literal = "";
  let firstSeg = "";
  let secondSeg = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "*" || segment.startsWith(":")) {
      const isOptional = segment.startsWith(":") && segment.endsWith("?");
      endpoint.prefix = isOptional ? literal : `${literal}/`;
      endpoint.bucket = secondSeg ? `/${firstSeg}/${secondSeg}` : firstSeg ? `/${firstSeg}` : "";
      if (!isOptional && segment !== "*" && i === segments.length - 1) {
        endpoint.singleParam = segment.slice(1);
      }
      return endpoint;
    }
    if (i === 0) firstSeg = segment;
    else if (i === 1) secondSeg = segment;
    literal += `/${segment}`;
  }
  endpoint.literal = literal;
  endpoint.bucket = literal;
  return endpoint;
}

function matchEndpoint(endpoint: Endpoint, pathname: string): Record<string, string> | null {
  const literal = endpoint.literal;
  if (literal !== undefined) {
    return pathname === literal || (pathname.length === literal.length + 1 && pathname.endsWith("/") && pathname.startsWith(literal))
      ? {}
      : null;
  }
  const prefix = endpoint.prefix;
  if (prefix !== undefined && !pathname.startsWith(prefix)) return null;
  const param = endpoint.singleParam;
  if (param !== undefined) {
    const start = prefix!.length;
    let end = pathname.length;
    if (end > start && pathname.charCodeAt(end - 1) === 47) end--;
    if (end <= start) return null;
    const slash = pathname.indexOf("/", start);
    if (slash !== -1 && slash < end) return null;
    const raw = pathname.slice(start, end);
    if (!raw.includes("%")) return { [param]: raw };
    try { return { [param]: decodeURIComponent(raw) }; } catch { return null; }
  }
  return matchPath(endpoint.path, pathname);
}

/** Fast pathname extraction for canonical http(s) URLs; falls back to new URL() for unusual forms. */
function fastPathname(rawUrl: string): string | null {
  const schemeEnd = rawUrl.indexOf("://");
  if (schemeEnd === -1) return null;
  const len = rawUrl.length;
  let pathStart = -1;
  for (let i = schemeEnd + 3; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c === 47) { pathStart = i; break; }
    if (c === 63 || c === 35) return "/";
    if (c === 92) return null;
  }
  if (pathStart === -1) return "/";
  let end = len;
  for (let i = pathStart + 1; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c === 63 || c === 35) { end = i; break; }
    if (c === 92) return null;
    if (c === 46 && rawUrl.charCodeAt(i - 1) === 47) return null;
  }
  return rawUrl.slice(pathStart, end);
}

class LazyRequestContext<State extends Record<string, unknown>> implements RequestContext<string, State> {
  request: Request;
  params: Record<string, string>;
  _url: URL | undefined;
  _state: State | undefined;
  constructor(request: Request, url: URL | undefined, params: Record<string, string>) {
    this.request = request;
    this._url = url;
    this.params = params;
  }
  get url(): URL {
    return this._url ??= new URL(this.request.url);
  }
  set url(value: URL) {
    this._url = value;
  }
  get state(): State {
    return this._state ??= {} as State;
  }
  set state(value: State) {
    this._state = value;
  }
}

const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";
const EMPTY_INIT: ResponseInit = {};
const NOT_FOUND_BODY = '{"error":{"code":"NOT_FOUND","message":"Route not found."}}';
const NOT_FOUND_INIT: ResponseInit = { status: 404 };
const DIRECT_FINALIZER = Symbol("clank.direct-finalizer");
type DirectFinalizer = (response: Response) => Response;

export interface CreateAppOptions {
  onError?: (error: unknown, context: RequestContext<string, any>) => void;
}

export interface RequestApp<State extends Record<string, unknown> = Record<string, unknown>> {
  use(middleware: Middleware<State>): RequestApp<State>;
  route<const Path extends string>(method: string, path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
  get<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
  post<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
  put<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
  patch<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
  delete<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
  handle(request: Request): Promise<Response>;
}

interface RouteIndex {
  byMethodStatic: Map<string, Map<string, Endpoint>>;
  anyStatic: Map<string, Endpoint>;
  seg1Buckets: Map<string, Endpoint[]>;
  seg2Buckets: Map<string, Endpoint[]>;
  catchAll: Endpoint[];
  hasDynamic: boolean;
  hasSeg1: boolean;
  hasSeg2: boolean;
}

function buildRouteIndex(endpoints: Endpoint[]): RouteIndex {
  const byMethodStatic = new Map<string, Map<string, Endpoint>>();
  const anyStatic = new Map<string, Endpoint>();
  const seg1Buckets = new Map<string, Endpoint[]>();
  const seg2Buckets = new Map<string, Endpoint[]>();
  const catchAll: Endpoint[] = [];
  let hasDynamic = false;
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i]!;
    if (ep.literal !== undefined) {
      if (ep.method === "*") {
        if (!anyStatic.has(ep.literal)) anyStatic.set(ep.literal, ep);
      } else {
        let map = byMethodStatic.get(ep.method);
        if (map === undefined) { map = new Map(); byMethodStatic.set(ep.method, map); }
        if (!map.has(ep.literal)) map.set(ep.literal, ep);
      }
    } else {
      hasDynamic = true;
      if (ep.bucket === "") {
        catchAll.push(ep);
      } else {
        const target = ep.bucket.indexOf("/", 1) !== -1 ? seg2Buckets : seg1Buckets;
        let list = target.get(ep.bucket);
        if (list === undefined) { list = []; target.set(ep.bucket, list); }
        list.push(ep);
      }
    }
  }
  return { byMethodStatic, anyStatic, seg1Buckets, seg2Buckets, catchAll, hasDynamic, hasSeg1: seg1Buckets.size > 0, hasSeg2: seg2Buckets.size > 0 };
}

function matchBucket(
  list: Endpoint[] | undefined,
  method: string,
  pathname: string,
  bestOrder: number,
  context: LazyRequestContext<any>,
): Endpoint | undefined {
  if (list === undefined) return undefined;
  for (let i = 0; i < list.length; i++) {
    const ep = list[i]!;
    if (ep.order >= bestOrder) return undefined;
    if (ep.method !== method && ep.method !== "*") continue;
    const matched = matchEndpoint(ep, pathname);
    if (matched !== null) {
      context.params = matched;
      return ep;
    }
  }
  return undefined;
}

function lookupEndpoint(
  index: RouteIndex,
  method: string,
  pathname: string,
  context: LazyRequestContext<any>,
): Endpoint | undefined {
  const len = pathname.length;
  const key = len > 1 && pathname.charCodeAt(len - 1) === 47
    ? pathname.slice(0, -1)
    : pathname === "/" ? "" : pathname;
  let best: Endpoint | undefined;
  const mMap = index.byMethodStatic.get(method);
  const mStatic = mMap !== undefined ? mMap.get(key) : undefined;
  const wStatic = index.anyStatic.size > 0 ? index.anyStatic.get(key) : undefined;
  if (mStatic !== undefined && (wStatic === undefined || mStatic.order < wStatic.order)) best = mStatic;
  else if (wStatic !== undefined) best = wStatic;
  if (!index.hasDynamic) return best;
  let bestOrder = best !== undefined ? best.order : Infinity;

  if (len > 1 && pathname.charCodeAt(0) === 47) {
    const slash2 = pathname.indexOf("/", 1);
    if (index.hasSeg1) {
      const seg1 = slash2 === -1 ? pathname : pathname.slice(0, slash2);
      const found = matchBucket(index.seg1Buckets.get(seg1), method, pathname, bestOrder, context);
      if (found !== undefined) { best = found; bestOrder = found.order; }
    }
    if (index.hasSeg2 && slash2 !== -1 && slash2 + 1 < len) {
      const slash3 = pathname.indexOf("/", slash2 + 1);
      const seg2 = slash3 === -1 ? pathname : pathname.slice(0, slash3);
      const found = matchBucket(index.seg2Buckets.get(seg2), method, pathname, bestOrder, context);
      if (found !== undefined) { best = found; bestOrder = found.order; }
    }
  }
  if (index.catchAll.length > 0) {
    const found = matchBucket(index.catchAll, method, pathname, bestOrder, context);
    if (found !== undefined) best = found;
  }
  return best;
}

export function createApp<State extends Record<string, unknown> = Record<string, unknown>>(
  options: CreateAppOptions = {},
): RequestApp<State> {
  const middleware: Middleware<State>[] = [];
  const endpoints: Endpoint[] = [];
  let routeIndex: RouteIndex | null = null;
  const handleError = (error: unknown, context: RequestContext<string, State>): Response => {
    // Observability failures must not replace the redacted HTTP response.
    try { void Promise.resolve(options.onError?.(error, context)).catch(() => undefined); }
    catch { /* The observer can also throw synchronously. */ }
    return json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal server error occurred.",
      },
    }, {
      status: 500,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      },
    });
  };
  const app: RequestApp<State> = {
    use(entry) { middleware.push(entry); return app; },
    route(method, path, handler) {
      routeIndex = null;
      endpoints.push(describeEndpoint(endpoints.length, method.toUpperCase(), path, handler as RequestHandler<any, any>));
      return app;
    },
    get(path, handler) { return app.route("GET", path, handler); },
    post(path, handler) { return app.route("POST", path, handler); },
    put(path, handler) { return app.route("PUT", path, handler); },
    patch(path, handler) { return app.route("PATCH", path, handler); },
    delete(path, handler) { return app.route("DELETE", path, handler); },
    handle(request) {
      let parsedUrl: URL | undefined;
      let pathname = fastPathname(request.url);
      if (pathname === null) {
        parsedUrl = new URL(request.url);
        pathname = parsedUrl.pathname;
      }
      const index = routeIndex ??= buildRouteIndex(endpoints);
      const method = request.method;
      const upperMethod = method === "GET" || method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH" || method === "HEAD" || method === "OPTIONS"
        ? method
        : method.toUpperCase();
      const context = new LazyRequestContext<State>(request, parsedUrl, {});
      try {
        const endpoint = lookupEndpoint(index, upperMethod, pathname, context);
        const mwLen = middleware.length;
        // Without middleware, or with a single response-finalizing middleware (e.g. securityHeaders),
        // avoid allocating closures and extra async state machines on synchronous handlers.
        if (mwLen === 0) {
          const result = endpoint
            ? endpoint.handler(context)
            : createBufferedResponse(NOT_FOUND_BODY, NOT_FOUND_INIT, JSON_TYPE);
          return result instanceof Promise
            ? result.catch((error) => handleError(error, context))
            : Promise.resolve(result);
        }
        if (mwLen === 1) {
          const mw = middleware[0]!;
          const finalizer = (mw as unknown as Record<symbol, DirectFinalizer | undefined>)[DIRECT_FINALIZER];
          if (finalizer !== undefined) {
            const result = endpoint
              ? endpoint.handler(context)
              : createBufferedResponse(NOT_FOUND_BODY, NOT_FOUND_INIT, JSON_TYPE);
            return result instanceof Promise
              ? result.then(finalizer).catch((error) => handleError(error, context))
              : Promise.resolve(finalizer(result));
          }
          let called = false;
          const result = mw(context, () => {
            if (called) return Promise.reject(new Error("next() called more than once."));
            called = true;
            try {
              return Promise.resolve(endpoint
                ? endpoint.handler(context)
                : createBufferedResponse(NOT_FOUND_BODY, NOT_FOUND_INIT, JSON_TYPE));
            } catch (error) {
              return Promise.reject(error);
            }
          });
          return result instanceof Promise
            ? result.catch((error) => handleError(error, context))
            : Promise.resolve(result);
        }
        let positionIndex = -1;
        const dispatch = async (position: number): Promise<Response> => {
          if (position <= positionIndex) throw new Error("next() called more than once.");
          positionIndex = position;
          const entry = middleware[position];
          return entry
            ? entry(context, () => dispatch(position + 1))
            : endpoint
              ? endpoint.handler(context)
              : createBufferedResponse(NOT_FOUND_BODY, NOT_FOUND_INIT, JSON_TYPE);
        };
        return dispatch(0).catch((error) => handleError(error, context));
      } catch (error) {
        return Promise.resolve(handleError(error, context));
      }
    },
  };
  return app;
}

export function json(value: unknown, init: ResponseInit = EMPTY_INIT): Response {
  return createBufferedResponse(JSON.stringify(value), init, JSON_TYPE);
}

export function text(value: string, init: ResponseInit = EMPTY_INIT): Response {
  return createBufferedResponse(value, init, TEXT_TYPE);
}

export function html(value: string, init: ResponseInit = EMPTY_INIT): Response {
  return createBufferedResponse(value, init, HTML_TYPE);
}

export type CorsOrigin = string | readonly string[] | ((origin: string | null, request: Request) => string | null);

export function cors<State extends Record<string, unknown> = Record<string, unknown>>(options: {
  origin?: CorsOrigin;
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
} = {}): Middleware<State> {
  if (options.credentials && (options.origin === undefined || options.origin === "*")) {
    throw new TypeError("CORS credentials require an explicit origin, origin list, or origin callback.");
  }
  return async ({ request }, next) => {
    const response = request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await next();
    const headers = new Headers(response.headers);
    const incomingOrigin = request.headers.get("origin");
    const configured = options.origin ?? "*";
    const allowedOrigin = typeof configured === "function"
      ? configured(incomingOrigin, request)
      : Array.isArray(configured)
        ? incomingOrigin && configured.includes(incomingOrigin) ? incomingOrigin : null
        : configured === "*" ? "*" : incomingOrigin === configured ? configured : null;
    if (allowedOrigin) headers.set("access-control-allow-origin", allowedOrigin);
    if (configured !== "*") appendVary(headers, "Origin");
    headers.set("access-control-allow-methods", (options.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).join(", "));
    headers.set("access-control-allow-headers", (options.headers ?? ["content-type", "authorization"]).join(", "));
    if (options.credentials) headers.set("access-control-allow-credentials", "true");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  frameOptions?: string | false;
  permissionsPolicy?: string | false;
  referrerPolicy?: string | false;
}

/** Secure response defaults that generated applications can install with one middleware call. */
export function securityHeaders<State extends Record<string, unknown> = Record<string, unknown>>(
  options: SecurityHeadersOptions = {},
): Middleware<State> {
  const defaults: Array<[name: string, value: string]> = [["x-content-type-options", "nosniff"]];
  if (options.frameOptions !== false) defaults.push(["x-frame-options", options.frameOptions ?? "DENY"]);
  if (options.referrerPolicy !== false) defaults.push(["referrer-policy", options.referrerPolicy ?? "strict-origin-when-cross-origin"]);
  if (options.permissionsPolicy !== false) defaults.push(["permissions-policy", options.permissionsPolicy ?? "camera=(), microphone=(), geolocation=()"]);
  if (options.crossOriginOpenerPolicy !== false) defaults.push(["cross-origin-opener-policy", options.crossOriginOpenerPolicy ?? "same-origin"]);
  if (options.contentSecurityPolicy) defaults.push(["content-security-policy", options.contentSecurityPolicy]);
  const apply = (headers: Headers): void => {
    for (let index = 0; index < defaults.length; index++) {
      const entry = defaults[index]!;
      if (!headers.has(entry[0])) headers.set(entry[0], entry[1]);
    }
  };
  const finalize = (response: Response): Response => {
    if (applyBufferedDefaultHeaders(response, defaults)) return response;
    // These defaults are fixed and only fill gaps, so they can be written onto
    // the handler's own response. Rebuilding a Response is kept for the ones
    // whose headers are immutable (redirects, upstream fetches).
    try {
      apply(response.headers);
      return response;
    } catch {
      const headers = new Headers(response.headers);
      apply(headers);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  };
  const mw: Middleware<State> = async (_context, next) => finalize(await next());
  (mw as unknown as Record<symbol, DirectFinalizer>)[DIRECT_FINALIZER] = finalize;
  return mw;
}

export function logger<State extends Record<string, unknown> = Record<string, unknown>>(write: (message: string) => void = console.log): Middleware<State> {
  return async ({ request, url }, next) => {
    const start = performance.now();
    const response = await next();
    write(`${request.method} ${url.pathname} ${response.status} ${(performance.now() - start).toFixed(1)}ms`);
    return response;
  };
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  const values = new Set((current ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  values.add(value);
  headers.set("vary", [...values].join(", "));
}
