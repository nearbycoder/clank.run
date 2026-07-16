export interface FetchApplication {
  handle(request: Request): Response | Promise<Response>;
}

export interface ServeOptions {
  hostname?: string;
  port?: number;
  trustProxy?: boolean;
  allowedHosts?: readonly string[];
  maxBodySize?: number;
  maxHeaderSize?: number;
  headersTimeout?: number;
  requestTimeout?: number;
  keepAliveTimeout?: number;
  exposeErrors?: boolean;
  onError?: (error: unknown) => void;
}

export interface ServerHandle {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface StaticFilesOptions {
  prefix?: string;
  index?: string;
  cacheControl?: string;
  dotfiles?: "deny" | "allow";
}

interface IncomingRequest extends AsyncIterable<Uint8Array> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { encrypted?: boolean; remoteAddress?: string };
  once(event: "aborted", listener: () => void): void;
}

interface OutgoingResponse {
  statusCode: number;
  statusMessage: string;
  setHeader(name: string, value: string | string[]): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
  once(event: "close" | "drain", listener: () => void): void;
}

interface NativeServer {
  listen(port: number, hostname: string, callback: () => void): void;
  address(): { port: number } | string | null;
  close(callback: (error?: Error) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  removeListener(event: "error", listener: (error: Error) => void): void;
}

interface HttpModule {
  createServer(options: Record<string, unknown>, handler: (request: IncomingRequest, response: OutgoingResponse) => void): NativeServer;
}

class NodeRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Runs any Fetch-standard Clank app on Node's built-in HTTP server. */
export async function serve(app: FetchApplication | ((request: Request) => Response | Promise<Response>), options: ServeOptions = {}): Promise<ServerHandle> {
  const moduleName = "node:http";
  const { createServer } = await import(moduleName) as unknown as HttpModule;
  const hostname = options.hostname ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  const handler = typeof app === "function" ? app : (request: Request) => app.handle(request);
  const effectiveOptions: ServeOptions = options.allowedHosts === undefined && isLoopbackHost(hostname)
    ? { ...options, allowedHosts: ["localhost", "127.0.0.1", "::1", hostname] }
    : options;

  const server = createServer({
    maxHeaderSize: options.maxHeaderSize ?? 16 * 1024,
    headersTimeout: options.headersTimeout ?? 15_000,
    requestTimeout: options.requestTimeout ?? 30_000,
    keepAliveTimeout: options.keepAliveTimeout ?? 5_000,
  }, (incoming, outgoing) => {
    void dispatch(incoming, outgoing, handler, effectiveOptions).catch((error) => {
      effectiveOptions.onError?.(error);
      try {
        const status = error instanceof NodeRequestError ? error.status : 500;
        outgoing.statusCode = status;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
        outgoing.setHeader("cache-control", "no-store");
        outgoing.setHeader("x-content-type-options", "nosniff");
        outgoing.end(JSON.stringify({
          error: {
            code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR",
            message: status < 500 || effectiveOptions.exposeErrors
              ? error instanceof Error ? error.message : String(error)
              : "An internal server error occurred.",
          },
        }));
      } catch { /* The socket may already be closed. */ }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(requestedPort, hostname, () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Node server did not expose a TCP address.");
  const port = address.port;
  return {
    hostname,
    port,
    url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

/** Serves a directory through Fetch responses with traversal protection and streaming-friendly MIME headers. */
export function staticFiles(root: string, options: StaticFilesOptions = {}): FetchApplication {
  const prefix = `/${(options.prefix ?? "").replace(/^\/+|\/+$/g, "")}`.replace(/\/$/, "");
  let basePromise: Promise<string> | undefined;
  return {
    async handle(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      const fileSystemName = "node:fs/promises";
      const pathName = "node:path";
      const fs = await import(fileSystemName) as unknown as {
        realpath(path: string): Promise<string>;
        stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
      };
      const fsSyncName = "node:fs";
      const streamName = "node:stream";
      const { createReadStream } = await import(fsSyncName) as unknown as { createReadStream(path: string): unknown };
      const { Readable } = await import(streamName) as unknown as {
        Readable: { toWeb(stream: unknown): ReadableStream<Uint8Array> };
      };
      const path = await import(pathName) as unknown as {
        resolve(...segments: string[]): string;
        sep: string;
        extname(value: string): string;
      };
      const url = new URL(request.url);
      if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return new Response("Not found", { status: 404 });
      let relative: string;
      try { relative = decodeURIComponent(prefix ? url.pathname.slice(prefix.length) : url.pathname); }
      catch { return new Response("Invalid path", { status: 400 }); }
      if (options.dotfiles !== "allow" && relative.split("/").some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) {
        return new Response("Not found", { status: 404 });
      }
      const base = await (basePromise ??= fs.realpath(path.resolve(root)));
      let candidate = path.resolve(base, `.${relative || "/"}`);
      if (candidate !== base && !candidate.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
      try {
        let resolved = await fs.realpath(candidate);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
        let stats = await fs.stat(resolved);
        if (stats.isDirectory()) {
          candidate = path.resolve(resolved, options.index ?? "index.html");
          resolved = await fs.realpath(candidate);
          if (resolved !== base && !resolved.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
          stats = await fs.stat(resolved);
        }
        if (!stats.isFile()) return new Response("Not found", { status: 404 });
        const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(resolved));
        return new Response(body as BodyInit | null, {
          headers: {
            "content-type": MIME_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
            "cache-control": options.cacheControl ?? "no-cache",
            "content-length": String(stats.size),
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
}

async function dispatch(
  incoming: IncomingRequest,
  outgoing: OutgoingResponse,
  handler: (request: Request) => Response | Promise<Response>,
  options: ServeOptions,
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  const forwardedFor = options.trustProxy ? headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
  headers.set("x-clank-client-ip", forwardedFor || incoming.socket.remoteAddress || "unknown");
  const forwarded = options.trustProxy ? headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
  if (forwarded && forwarded !== "http" && forwarded !== "https") throw new NodeRequestError(400, "Invalid forwarded protocol.");
  const protocol = forwarded ?? (incoming.socket.encrypted ? "https" : "http");
  const host = headers.get("host") ?? "localhost";
  const parsedHost = safeHost(host);
  if (options.allowedHosts?.length) {
    const allowed = new Set(options.allowedHosts.map((entry) => entry.toLowerCase()));
    if (!allowed.has(parsedHost.host.toLowerCase()) && !allowed.has(parsedHost.hostname.toLowerCase())) {
      throw new NodeRequestError(400, "Host is not allowed.");
    }
  }
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await readBody(incoming, options.maxBodySize ?? 1024 * 1024, headers.get("content-length"));
  const abort = new AbortController();
  incoming.once("aborted", () => abort.abort(new Error("Request aborted.")));
  outgoing.once("close", () => abort.abort(new Error("Connection closed.")));
  const request = new Request(`${protocol}://${parsedHost.host}${incoming.url ?? "/"}`, {
    method,
    headers,
    body: body?.buffer as ArrayBuffer | undefined,
    signal: abort.signal,
  });
  const response = await handler(request);
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = responseHeaders.getSetCookie?.() ?? [];
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  });
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  if (!response.body || method === "HEAD") {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!outgoing.write(value)) await new Promise<void>((resolve) => outgoing.once("drain", resolve));
    }
    outgoing.end();
  } finally {
    reader.releaseLock();
  }
}

async function readBody(request: AsyncIterable<Uint8Array>, maxBytes: number, contentLength: string | null): Promise<Uint8Array> {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new NodeRequestError(413, `Request body exceeds ${maxBytes} bytes.`);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    chunks.push(chunk);
    length += chunk.byteLength;
    if (length > maxBytes) throw new NodeRequestError(413, `Request body exceeds ${maxBytes} bytes.`);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function safeHost(value: string): { host: string; hostname: string } {
  if (/[\u0000-\u0020/\\]/.test(value)) throw new NodeRequestError(400, "Invalid Host header.");
  try {
    const url = new URL(`http://${value}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") throw new Error("invalid");
    return { host: url.host, hostname: url.hostname };
  } catch {
    throw new NodeRequestError(400, "Invalid Host header.");
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};
