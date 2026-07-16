# Server primitives

Clank's server layer targets the Fetch standard, not one vendor's runtime. The same `app.handle(request)` works anywhere with Web `Request` and `Response` objects.

## Routes

```ts
const app = createApp()
  .get("/health", () => text("ok"))
  .get("/users/:id", ({ params }) => json({ id: params.id }))
  .post("/messages", async ({ request }) => {
    const input = await request.json();
    return json(await createMessage(input), { status: 201 });
  });

const response = await app.handle(request);
```

Literal route paths infer their parameter keys. In `.get("/users/:id", handler)`, `params.id` is a string; optional `:tab?` parameters are optional, and `*` exposes the wildcard value.

Methods are `route`, `get`, `post`, `put`, `patch`, and `delete`. Routes use the same parameter, optional-segment, and wildcard matcher as the client router.

## Request context

Every handler receives:

```ts
interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  state: Record<string, unknown>;
}
```

Middleware can use `state` for request IDs, authenticated users, database handles, timing, or other per-request values.

## Middleware

```ts
app.use(async (context, next) => {
  context.state.user = await authenticate(context.request);
  const response = await next();
  const headers = new Headers(response.headers);
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, { status: response.status, headers });
});
```

Middleware executes in registration order and unwinds in reverse order. Calling `next()` twice throws. Unhandled errors become a generic JSON 500 response. Use `createApp({ onError })` for private logging; enable `exposeErrors` only during controlled development.

Built-ins:

```ts
app.use(logger());
app.use(cors({ origin: "https://app.example.com", credentials: true }));
app.use(securityHeaders({
  contentSecurityPolicy: "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
}));
```

Credentialed CORS rejects wildcard origins at configuration time. Origin arrays and callbacks are available when an exact allowlist is required. CORS controls browser response access; it is not authentication or CSRF protection.

The response helpers are `json`, `text`, and `html`.

## Mount an agent bridge

The minimal adapter is a wildcard route:

```ts
app.route("*", "/api/agent/*", ({ request }) => bridge.handle(request, {
  user: authenticatedUser,
}));
```

If you want the well-known manifest at a separate path, add an explicit route to the same handler.

## Node runtime adapter

`clank/node` provides the dependency-free adapter for Node 22.13+:

```ts
import { serve, staticFiles } from "clank.run/node";

const publicFiles = staticFiles("./public", { prefix: "/assets" });
const app = createApp()
  .get("/assets/*", ({ request }) => publicFiles.handle(request))
  .get("/health", () => text("ok"));

const server = await serve(app, {
  hostname: "127.0.0.1",
  port: 3000,
  maxBodySize: 1024 * 1024,
});
await server.close();
```

`serve()` translates Node HTTP messages to Fetch objects, streams response bodies for SSE, propagates aborts, preserves multiple cookies, caps bodies and headers, configures timeouts, validates Host headers, and can trust forwarded protocol/client IP only when explicitly enabled. Loopback listeners accept loopback hosts by default; public deployments should set `allowedHosts`.

`staticFiles()` supports GET/HEAD, index files, MIME types, cache headers, dotfile denial, traversal rejection, and post-symlink containment checks.

```ts
await serve(app, {
  hostname: "0.0.0.0",
  allowedHosts: ["app.example.com"],
  trustProxy: true, // only behind a trusted, exclusive reverse proxy
});
```

Edge and worker runtimes can usually accept `app.handle` directly as their fetch handler.

For inferred query/mutation RPC, SQLite, and EventSource live queries, see [Full-stack SSR, SQLite, and live sync](full-stack.md).

For secure cookies, owned data, and reverse-proxy guidance, see [Authentication](auth.md) and [Security](security.md).
