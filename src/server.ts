import { matchPath } from "./router.ts";

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
    route(method, path, handler) { endpoints.push({ method: method.toUpperCase(), path, handler: handler as RequestHandler<any, any> }); return app; },
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
        for (const entry of endpoints) {
          if (entry.method !== request.method && entry.method !== "*") continue;
          const matched = matchPath(entry.path, url.pathname);
          if (matched) {
            endpoint = entry;
            params = matched;
            break;
          }
        }
        (context as RequestContext<string, State>).params = params;
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
        options.onError?.(error, context);
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
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function text(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(value, { ...init, headers });
}

export function html(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(value, { ...init, headers });
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
  return async (_context, next) => {
    const response = await next();
    const headers = new Headers(response.headers);
    if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
    if (options.frameOptions !== false && !headers.has("x-frame-options")) headers.set("x-frame-options", options.frameOptions ?? "DENY");
    if (options.referrerPolicy !== false && !headers.has("referrer-policy")) headers.set("referrer-policy", options.referrerPolicy ?? "strict-origin-when-cross-origin");
    if (options.permissionsPolicy !== false && !headers.has("permissions-policy")) headers.set("permissions-policy", options.permissionsPolicy ?? "camera=(), microphone=(), geolocation=()");
    if (options.crossOriginOpenerPolicy !== false && !headers.has("cross-origin-opener-policy")) headers.set("cross-origin-opener-policy", options.crossOriginOpenerPolicy ?? "same-origin");
    if (options.contentSecurityPolicy && !headers.has("content-security-policy")) {
      headers.set("content-security-policy", options.contentSecurityPolicy);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
