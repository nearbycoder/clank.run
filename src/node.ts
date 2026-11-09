import {
  bufferedBodyLength,
  captureCanonicalRequestTarget,
  captureExactRequest,
  createNativeRequest,
  setTrustedClientAddress,
  takeBufferedBody,
  takeRequestHandoff,
} from "./security.ts";

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
  /**
   * Compress text-like responses (HTML, CSS, JS, JSON, XML, SVG, plain text)
   * with Brotli or gzip when the client accepts it. Off by default so an app
   * behind another proxy does not compress twice; enable it on the listener
   * that faces clients directly.
   */
  compression?: boolean;
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
  rawHeaders: string[];
  socket: { encrypted?: boolean; remoteAddress?: string };
  once(event: "aborted", listener: () => void): void;
}

interface OutgoingResponse {
  statusCode: number;
  statusMessage: string;
  setHeader(name: string, value: string | string[]): void;
  getHeader(name: string): string | string[] | number | undefined;
  removeHeader(name: string): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
  once(event: "close" | "drain", listener: () => void): void;
  removeListener(event: "close" | "drain", listener: () => void): void;
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
  declare readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Runs any Fetch-standard Clank app on Node's built-in HTTP server. */
export async function serve(app: FetchApplication | ((request: Request) => Response | Promise<Response>), options: ServeOptions = {}): Promise<ServerHandle> {
  const moduleName = "node:http";
  const { createServer } = await import(moduleName) as unknown as HttpModule;
  const cryptoName = "node:crypto", timersName = "node:timers";
  const zlibName = "node:zlib";
  const [crypto, timers, zlib] = await Promise.all([
    import(cryptoName),
    import(timersName),
    options.compression ? import(zlibName) as Promise<unknown> as Promise<ZlibModule> : Promise.resolve(undefined),
  ]);
  const digest = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
  const hostname = options.hostname ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  const handler = typeof app === "function" ? app : (request: Request) => app.handle(request);
  const managedIngress = options.trustProxy === true
    && (globalThis as any).process?.env?.CLANK_MANAGED_INGRESS === "1";
  const effectiveOptions: ServeOptions = options.allowedHosts === undefined
    ? managedIngress
      // Clank's loopback-only managed ingress already performs exact project
      // host admission and overwrites the forwarding headers. An explicit
      // empty list keeps the adapter from restoring its direct-listener
      // loopback defaults when application code filters an empty env list.
      ? { ...options, allowedHosts: [] }
      : isLoopbackHost(hostname)
        ? { ...options, allowedHosts: ["localhost", "127.0.0.1", "::1", hostname] }
        : options
    : options;

  const allowedHosts = effectiveOptions.allowedHosts?.length
    ? new Set(effectiveOptions.allowedHosts.map((entry) => entry.toLowerCase()))
    : undefined;
  const server = createServer({
    maxHeaderSize: options.maxHeaderSize ?? 16 * 1024,
    headersTimeout: options.headersTimeout ?? 15_000,
    requestTimeout: options.requestTimeout ?? 30_000,
    keepAliveTimeout: options.keepAliveTimeout ?? 5_000,
  }, (incoming, outgoing) => {
    void dispatch(incoming, outgoing, handler, effectiveOptions, allowedHosts, digest, timers.setImmediate, zlib).catch((error) => {
      try { void Promise.resolve(effectiveOptions.onError?.(error)).catch(() => undefined); }
      catch { /* Private logging must not prevent a response from reaching the socket. */ }
      try {
        const status = error instanceof NodeRequestError ? error.status : 500;
        outgoing.statusCode = status;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
        outgoing.setHeader("cache-control", "no-store");
        outgoing.setHeader("x-content-type-options", "nosniff");
        outgoing.end(JSON.stringify({
          error: {
            code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR",
            message: status < 500
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
  const normalizedPrefix = trimBoundarySlashes(options.prefix ?? "");
  const prefix = normalizedPrefix ? `/${normalizedPrefix}` : "";
  let basePromise: Promise<string> | undefined;
  return {
    async handle(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      const fileSystemName = "node:fs/promises";
      const pathName = "node:path";
      const fs = await import(fileSystemName) as unknown as {
        realpath(path: string): Promise<string>;
        stat(path: string): Promise<{
          isDirectory(): boolean; isFile(): boolean;
          size: number; mtimeMs: number; ctimeMs: number; ino: number;
        }>;
      };
      const fsSyncName = "node:fs";
      const streamName = "node:stream";
      const { createReadStream } = await import(fsSyncName) as unknown as { createReadStream(path: string): unknown };
      const { Readable } = await import(streamName) as unknown as {
        Readable: { toWeb(stream: unknown): ReadableStream<Uint8Array> };
      };
      const path = await import(pathName) as unknown as {
        resolve(...segments: string[]): string;
        relative(from: string, to: string): string;
        sep: string;
        extname(value: string): string;
      };
      const url = new URL(request.url);
      if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return new Response("Not found", { status: 404 });
      let relative: string;
      try { relative = decodeURIComponent(prefix ? url.pathname.slice(prefix.length) : url.pathname); }
      catch { return new Response("Invalid path", { status: 400 }); }
      if (options.dotfiles !== "allow" && containsDotfile(relative)) {
        return new Response("Not found", { status: 404 });
      }
      const base = await (basePromise ??= fs.realpath(path.resolve(root)));
      let candidate = path.resolve(base, `.${relative || "/"}`);
      if (candidate !== base && !candidate.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
      try {
        let resolved = await fs.realpath(candidate);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
        if (options.dotfiles !== "allow" && containsDotfile(path.relative(base, resolved))) return new Response("Not found", { status: 404 });
        let stats = await fs.stat(resolved);
        if (stats.isDirectory()) {
          candidate = path.resolve(resolved, options.index ?? "index.html");
          resolved = await fs.realpath(candidate);
          if (resolved !== base && !resolved.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
          if (options.dotfiles !== "allow" && containsDotfile(path.relative(base, resolved))) return new Response("Not found", { status: 404 });
          stats = await fs.stat(resolved);
        }
        if (!stats.isFile()) return new Response("Not found", { status: 404 });
        // A weak metadata validator avoids reading/hashing the file body. Read
        // fresh metadata after containment checks, including for revalidation.
        const etag = `W/"${[stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino].map((value) => value.toString(16)).join("-")}"`;
        const headers = {
          "content-type": MIME_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
          "cache-control": options.cacheControl ?? "no-cache",
          etag,
          "x-content-type-options": "nosniff",
        };
        const condition = request.headers.get("if-none-match");
        if (condition !== null && (condition.trim() === "*" || condition.split(",").some((value) => (
          value.trim().replace(/^W\//, "") === etag.slice(2)
        )))) {
          return new Response(null, { status: 304, headers });
        }
        const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(resolved));
        return new Response(body as BodyInit | null, {
          headers: {
            ...headers,
            "content-length": String(stats.size),
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
}

function containsDotfile(value: string): boolean {
  return value.split(/[\\/]/u).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

function trimBoundarySlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start++;
  while (end > start && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(start, end);
}

async function dispatch(
  incoming: IncomingRequest,
  outgoing: OutgoingResponse,
  handler: (request: Request) => Response | Promise<Response>,
  options: ServeOptions,
  allowedHosts: ReadonlySet<string> | undefined,
  digest: (value: string) => string,
  afterWrite: (callback: () => void) => unknown,
  zlib?: ZlibModule,
): Promise<void> {
  const method = incoming.method ?? "GET";
  const trustProxy = options.trustProxy === true;
  const attachTarget = captureCanonicalRequestTarget(incoming.method, incoming.url);
  const attachExact = captureExactRequest(incoming.method, incoming.url, incoming.rawHeaders, trustProxy, digest);
  // Node already lower-cases and joins repeated fields, so its header record
  // feeds the Request directly. Building a Headers first would validate and
  // copy every field twice.
  const received = incoming.headers;
  const forwardedFor = trustProxy ? firstListValue(received["x-forwarded-for"]) : undefined;
  const clientAddress = forwardedFor || incoming.socket.remoteAddress || "unknown";
  const forwarded = trustProxy ? firstListValue(received["x-forwarded-proto"]) : undefined;
  if (forwarded && forwarded !== "http" && forwarded !== "https") throw new NodeRequestError(400, "Invalid forwarded protocol.");
  const protocol = forwarded ?? (incoming.socket.encrypted ? "https" : "http");
  const forwardedHost = trustProxy ? firstListValue(received["x-forwarded-host"]) : undefined;
  const parsedHost = safeHost(forwardedHost ?? headerValue(received.host) ?? "localhost");
  if (allowedHosts && !allowedHosts.has(parsedHost.host.toLowerCase()) && !allowedHosts.has(parsedHost.hostname.toLowerCase())) {
    throw new NodeRequestError(400, "Host is not allowed.");
  }
  let record: Record<string, string> | undefined = {};
  for (const name in received) {
    const value = received[name];
    if (typeof value !== "string" && value !== undefined) { record = undefined; break; }
    if (value !== undefined && name !== "x-clank-client-ip") record[name] = value;
  }
  let headers: Record<string, string> | Array<[string, string]>;
  if (record) {
    record["x-clank-client-ip"] = clientAddress;
    headers = record;
  } else {
    // Only repeated Set-Cookie fields arrive as arrays; keep each as its own field.
    const fields: Array<[string, string]> = [];
    for (const name in received) {
      const value = received[name];
      if (name === "x-clank-client-ip" || value === undefined) continue;
      if (Array.isArray(value)) for (const entry of value) fields.push([name, entry]);
      else fields.push([name, value]);
    }
    fields.push(["x-clank-client-ip", clientAddress]);
    headers = fields;
  }
  const abort = new AbortController();
  // Cancelling an unread upload can abort the request while its rejection
  // response remains writable. Track the response connection separately.
  let responseClosed = false;
  incoming.once("aborted", () => abort.abort(new Error("Request aborted.")));
  outgoing.once("close", () => {
    responseClosed = true;
    abort.abort(connectionClosed());
  });
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : boundedRequestBody(incoming, options.maxBodySize ?? 1024 * 1024, headerValue(received["content-length"]) ?? null);
  const request = createNativeRequest(`${protocol}://${parsedHost.host}${incoming.url ?? "/"}`, body
    ? { method, headers, body: body.stream, signal: abort.signal, duplex: "half" } as RequestInit
    : { method, headers, signal: abort.signal });
  setTrustedClientAddress(request, clientAddress);
  attachExact?.(request);
  attachTarget?.(request);
  let handedOff = false;
  const handoff = (): void => {
    if (handedOff || responseClosed) return; handedOff = true;
    const callback = takeRequestHandoff(request);
    if (callback) afterWrite(callback);
  };
  const response = await handler(request);
  // If an application translated the stream error into its own response, the
  // transport limit still wins. Otherwise a chunked upload could turn a 413
  // into an application-level 500 after crossing the adapter boundary.
  if (body?.state.limitExceeded) {
    throw new NodeRequestError(413, `Request body exceeds ${body.state.maximum} bytes.`);
  }
  if (request.body && !request.bodyUsed) await request.body.cancel().catch(() => undefined);
  // A buffered body is text the adapter writes in one piece; it has no stream to cancel or pump.
  const buffered = bufferedBodyLength(response);
  if (responseClosed) {
    if (buffered === undefined) await response.body?.cancel("client disconnected").catch(() => undefined);
    return;
  }
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = responseHeaders.getSetCookie?.() ?? [];
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  });
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  const encoding = zlib ? negotiateCompression(response, method, headerValue(received["accept-encoding"]) ?? null, outgoing, buffered) : null;
  if (buffered !== undefined) {
    const text = takeBufferedBody(response);
    if (text !== undefined) {
      if (method === "HEAD") outgoing.end();
      else if (encoding && zlib) {
        const compressed = await compressText(text, encoding, zlib);
        if (responseClosed) return;
        if (compressed) outgoing.end(compressed);
        else {
          // Compression failed before any byte was sent: fall back to the identity body.
          outgoing.removeHeader("content-encoding");
          outgoing.end(text);
        }
      } else outgoing.end(text);
      handoff();
      return;
    }
  }
  if (!response.body || method === "HEAD") {
    await response.body?.cancel("HEAD response has no body").catch(() => undefined);
    outgoing.end();
    handoff();
    return;
  }
  const reader = response.body.getReader();
  const cancelResponse = () => { void reader.cancel("client disconnected").catch(() => undefined); };
  outgoing.once("close", cancelResponse);
  if (encoding && zlib) {
    try {
      await pumpCompressed(reader, outgoing, encoding, zlib, () => responseClosed, handoff);
      handoff();
    } finally {
      outgoing.removeListener("close", cancelResponse);
      reader.releaseLock();
    }
    return;
  }
  try {
    while (!responseClosed) {
      const { done, value } = await reader.read();
      if (done || responseClosed) break;
      const writable = outgoing.write(value);
      handoff();
      if (!writable) {
        await new Promise<void>((resolve) => {
          const resume = () => {
            outgoing.removeListener("drain", resume);
            outgoing.removeListener("close", resume);
            resolve();
          };
          outgoing.once("drain", resume);
          outgoing.once("close", resume);
          if (responseClosed) resume();
        });
      }
    }
    outgoing.end();
    handoff();
  } finally {
    outgoing.removeListener("close", cancelResponse);
    reader.releaseLock();
  }
}

interface CompressionStreamLike {
  write(chunk: Uint8Array): boolean;
  end(): void;
  flush(kind: number, callback: () => void): void;
  destroy(): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  once(event: "end" | "error", listener: (value?: unknown) => void): void;
}

type CompressCallback = (error: Error | null, result: Uint8Array) => void;

interface ZlibModule {
  constants: Record<string, number>;
  createGzip(options: Record<string, unknown>): CompressionStreamLike;
  createBrotliCompress(options: Record<string, unknown>): CompressionStreamLike;
  gzip(input: string, options: Record<string, unknown>, callback: CompressCallback): void;
  brotliCompress(input: string, options: Record<string, unknown>, callback: CompressCallback): void;
}

function brotliOptions(zlib: ZlibModule, size?: number): Record<string, unknown> {
  const constants = zlib.constants;
  return {
    params: {
      // Quality 5 keeps per-request CPU low while landing close to gzip -9 sizes.
      [constants.BROTLI_PARAM_QUALITY!]: 5,
      [constants.BROTLI_PARAM_MODE!]: constants.BROTLI_MODE_TEXT!,
      ...(size === undefined ? {} : { [constants.BROTLI_PARAM_SIZE_HINT!]: size }),
    },
  };
}

/** Compress a whole text body off the event loop. Resolves undefined if the codec fails. */
function compressText(text: string, encoding: "br" | "gzip", zlib: ZlibModule): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const done: CompressCallback = (error, result) => resolve(error ? undefined : result);
    try {
      if (encoding === "br") zlib.brotliCompress(text, brotliOptions(zlib, text.length), done);
      else zlib.gzip(text, { level: 6 }, done);
    } catch { resolve(undefined); }
  });
}

const COMPRESSIBLE_TYPES = new Set([
  "text/html",
  "text/css",
  "text/plain",
  "text/markdown",
  "text/javascript",
  "text/xml",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "application/xml",
  "image/svg+xml",
]);
const COMPRESSION_MIN_BYTES = 1024;

/**
 * Choose a response encoding and rewrite headers for it. Returns null and
 * leaves the response untouched when compression does not apply.
 */
function negotiateCompression(
  response: Response,
  method: string,
  acceptEncoding: string | null,
  outgoing: OutgoingResponse,
  buffered: number | undefined,
): "br" | "gzip" | null {
  if (method === "HEAD" || (buffered === undefined ? !response.body : buffered < COMPRESSION_MIN_BYTES)) return null;
  if (response.status < 200 || response.status === 204 || response.status === 206 || response.status === 304) return null;
  if (response.headers.has("content-encoding") || response.headers.has("content-range")) return null;
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!type || !COMPRESSIBLE_TYPES.has(type)) return null;
  if (/(?:^|,)\s*no-transform\s*(?:,|$)/iu.test(response.headers.get("cache-control") ?? "")) return null;
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) < COMPRESSION_MIN_BYTES) return null;
  // The representation now depends on Accept-Encoding even when this client
  // receives identity bytes, so shared caches must key on it.
  const vary = String(outgoing.getHeader("vary") ?? "");
  if (!/(?:^|,)\s*(?:\*|accept-encoding)\s*(?:,|$)/iu.test(vary)) {
    outgoing.setHeader("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  }
  const encoding = preferredEncoding(acceptEncoding);
  if (!encoding) return null;
  outgoing.setHeader("content-encoding", encoding);
  outgoing.removeHeader("content-length");
  const etag = outgoing.getHeader("etag");
  if (typeof etag === "string" && etag.startsWith("\"")) outgoing.setHeader("etag", `W/${etag}`);
  return encoding;
}

function preferredEncoding(header: string | null): "br" | "gzip" | null {
  if (!header) return null;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = parameters.map((value) => value.trim()).find((value) => value.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const weight = (name: string) => weights.get(name) ?? weights.get("*") ?? 0;
  if (weight("br") > 0) return "br";
  if (weight("gzip") > 0) return "gzip";
  return null;
}

/** Stream a response body through a compressor, flushing after each chunk so streamed responses stay incremental. */
async function pumpCompressed(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  outgoing: OutgoingResponse,
  encoding: "br" | "gzip",
  zlib: ZlibModule,
  isClosed: () => boolean,
  afterChunk: () => void,
): Promise<void> {
  const constants = zlib.constants;
  const compressor = encoding === "br"
    ? zlib.createBrotliCompress(brotliOptions(zlib))
    : zlib.createGzip({ level: 6 });
  const flushKind = encoding === "br" ? constants.BROTLI_OPERATION_FLUSH! : constants.Z_SYNC_FLUSH!;
  let failure: unknown;
  let drained: Promise<void> | null = null;
  compressor.once("error", (error) => { failure = error; });
  compressor.on("data", (chunk) => {
    if (isClosed()) return;
    if (!outgoing.write(chunk) && !drained) {
      drained = new Promise<void>((resolve) => {
        const resume = () => {
          outgoing.removeListener("drain", resume);
          outgoing.removeListener("close", resume);
          drained = null;
          resolve();
        };
        outgoing.once("drain", resume);
        outgoing.once("close", resume);
      });
    }
  });
  try {
    while (!isClosed()) {
      const { done, value } = await reader.read();
      if (done || isClosed()) break;
      compressor.write(value);
      await new Promise<void>((resolve) => compressor.flush(flushKind, resolve));
      if (failure) throw failure;
      afterChunk();
      if (drained) await drained;
    }
    if (isClosed()) return;
    await new Promise<void>((resolve, reject) => {
      compressor.once("end", () => resolve());
      compressor.once("error", reject);
      compressor.end();
    });
    if (failure) throw failure;
    outgoing.end();
  } finally {
    compressor.destroy();
  }
}

function boundedRequestBody(
  request: AsyncIterable<Uint8Array>,
  maxBytes: number,
  contentLength: string | null,
): {
  stream: ReadableStream<Uint8Array>;
  state: { limitExceeded: boolean; maximum: number };
} {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new NodeRequestError(413, `Request body exceeds ${maxBytes} bytes.`);
  }
  const iterator = request[Symbol.asyncIterator]();
  const state = { limitExceeded: false, maximum: maxBytes };
  let length = 0;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const result = await iterator.next();
        if (result.done) {
          finished = true;
          controller.close();
          return;
        }
        length += result.value.byteLength;
        if (length > maxBytes) {
          finished = true;
          state.limitExceeded = true;
          await iterator.return?.();
          controller.error(new NodeRequestError(413, `Request body exceeds ${maxBytes} bytes.`));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel() {
      if (finished) return;
      finished = true;
      await iterator.return?.();
    },
  });
  return { stream, state };
}

/** First comma-separated entry of a forwarding header, as a trusted proxy wrote it. */
function firstListValue(value: string | string[] | undefined): string | undefined {
  const text = headerValue(value);
  if (text === undefined) return undefined;
  const comma = text.indexOf(",");
  return (comma === -1 ? text : text.slice(0, comma)).trim();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * A closed connection aborts every request, including the ones that finished
 * normally, so the reason is built without walking the stack: the trace would
 * only ever name this adapter's own event listener.
 */
function connectionClosed(): Error {
  const errors = Error as unknown as { stackTraceLimit?: number };
  const limit = errors.stackTraceLimit;
  try { errors.stackTraceLimit = 0; } catch { return new Error("Connection closed."); }
  try { return new Error("Connection closed."); }
  finally { errors.stackTraceLimit = limit; }
}

// Host values repeat for the life of a deployment; remember the few that parsed.
const parsedHosts = new Map<string, { host: string; hostname: string }>();

function safeHost(value: string): { host: string; hostname: string } {
  const known = parsedHosts.get(value);
  if (known) return known;
  if (/[\u0000-\u0020/\\]/.test(value)) throw new NodeRequestError(400, "Invalid Host header.");
  try {
    const url = new URL(`http://${value}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") throw new Error("invalid");
    const parsed = { host: url.host, hostname: url.hostname };
    if (value.length <= 255) {
      if (parsedHosts.size >= 256) parsedHosts.clear();
      parsedHosts.set(value, parsed);
    }
    return parsed;
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
