import { matchPath } from "./router.ts";
import { createBufferedResponse } from "./security.ts";

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
  method: string;
  path: string;
  handler: RequestHandler<any, any>;
  /** Exact pathname for a parameterless route, without its optional trailing slash. */
  literal?: string;
  /** Text every match of a parameterised route must start with. */
  prefix?: string;
}

/**
 * Derive string pre-checks from a route pattern. matchPath() stays the only
 * judge of parameterised routes; these checks just skip patterns that cannot
 * match, and resolve parameterless routes without running a regular expression.
 */
function describeEndpoint(method: string, path: string, handler: RequestHandler<any, any>): Endpoint {
  const endpoint: Endpoint = { method, path, handler };
  if (path === "*") return endpoint;
  const segments = path.split("/").filter(Boolean);
  // A malformed parameter name must keep failing exactly where matchPath() reports it.
  if (segments.some((segment) => segment.startsWith(":") && !/^:[A-Za-z][A-Za-z0-9_]*\??$/.test(segment))) return endpoint;
  let literal = "";
  for (const segment of segments) {
    if (segment === "*" || segment.startsWith(":")) {
      endpoint.prefix = segment.startsWith(":") && segment.endsWith("?") ? literal : `${literal}/`;
      return endpoint;
    }
    literal += `/${segment}`;
  }
  endpoint.literal = literal;
  return endpoint;
}

function matchEndpoint(endpoint: Endpoint, pathname: string): Record<string, string> | null {
  const literal = endpoint.literal;
  if (literal !== undefined) {
    return pathname === literal || (pathname.length === literal.length + 1 && pathname.endsWith("/") && pathname.startsWith(literal))
      ? {}
      : null;
  }
  if (endpoint.prefix !== undefined && !pathname.startsWith(endpoint.prefix)) return null;
  return matchPath(endpoint.path, pathname);
}

const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";

/** Response init with a default content type, without building an intermediate Headers when none was supplied. */
function withContentType(init: ResponseInit, type: string): ResponseInit {
  const supplied = init.headers;
  if (supplied === undefined) return { ...init, headers: { "content-type": type } };
  const prototype = typeof supplied === "object" && supplied !== null ? Object.getPrototypeOf(supplied) : undefined;
  if (prototype === Object.prototype || prototype === null) {
    // A plain record converts once inside Response; only add the default when absent.
    for (const name in supplied as Record<string, string>) {
      if (name.length === 12 && name.toLowerCase() === "content-type") return init;
    }
    return { ...init, headers: { ...(supplied as Record<string, string>), "content-type": type } };
  }
  const headers = new Headers(supplied);
  if (!headers.has("content-type")) headers.set("content-type", type);
  return { ...init, headers };
}

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

export function createApp<State extends Record<string, unknown> = Record<string, unknown>>(
  options: CreateAppOptions = {},
): RequestApp<State> {
  const middleware: Middleware<State>[] = [];
  const endpoints: Endpoint[] = [];
  const app: RequestApp<State> = {
    use(entry) { middleware.push(entry); return app; },
    route(method, path, handler) { endpoints.push(describeEndpoint(method.toUpperCase(), path, handler as RequestHandler<any, any>)); return app; },
    get(path, handler) { return app.route("GET", path, handler); },
    post(path, handler) { return app.route("POST", path, handler); },
    put(path, handler) { return app.route("PUT", path, handler); },
    patch(path, handler) { return app.route("PATCH", path, handler); },
    delete(path, handler) { return app.route("DELETE", path, handler); },
    async handle(request) {
      const url = new URL(request.url);
      const context = { request, url, params: {}, state: {} as State } as RequestContext<string, State>;
      try {
        let endpoint: Endpoint | undefined;
        let params: Record<string, string> = {};
        const method = request.method, pathname = url.pathname;
        for (let position = 0; position < endpoints.length; position++) {
          const entry = endpoints[position]!;
          if (entry.method !== method && entry.method !== "*") continue;
          const matched = matchEndpoint(entry, pathname);
          if (matched) {
            endpoint = entry;
            params = matched;
            break;
          }
        }
        (context as RequestContext<string, State>).params = params;
        // Without middleware there is no chain to build: answer directly.
        if (middleware.length === 0) {
          return await (endpoint
            ? endpoint.handler(context)
            : json({ error: { code: "NOT_FOUND", message: "Route not found." } }, { status: 404 }));
        }
        const terminal = async () => endpoint
          ? endpoint.handler(context)
          : json({ error: { code: "NOT_FOUND", message: "Route not found." } }, { status: 404 });
        let index = -1;
        const dispatch = async (position: number): Promise<Response> => {
          if (position <= index) throw new Error("next() called more than once.");
          index = position;
          const entry = middleware[position];
          return entry ? entry(context, () => dispatch(position + 1)) : terminal();
        };
        return await dispatch(0);
      } catch (error) {
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
      }
    },
  };
  return app;
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  return createBufferedResponse(JSON.stringify(value), withContentType(init, JSON_TYPE));
}

export function text(value: string, init: ResponseInit = {}): Response {
  return createBufferedResponse(value, withContentType(init, TEXT_TYPE));
}

export function html(value: string, init: ResponseInit = {}): Response {
  return createBufferedResponse(value, withContentType(init, HTML_TYPE));
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
  return async (_context, next) => {
    const response = await next();
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
