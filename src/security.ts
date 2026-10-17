/** Shared browser/server-safe security helpers used by Clank internals. */

const URL_ATTRIBUTES = new Set([
  "action",
  "cite",
  "formaction",
  "href",
  "manifest",
  "poster",
  "src",
  "xlink:href",
]);

const TRUSTED_CLIENT_ADDRESSES = new WeakMap<Request, string>();

const CANONICAL_REQUEST_TARGETS = new WeakMap<Request, Readonly<{method:"POST";url:string}>>();
/** @internal Separate POST target evidence; never anonymous observation or authentication. */
export function captureCanonicalRequestTarget(method: unknown, target: unknown): ((request: Request) => void) | undefined {
  try {
    if(method!=="POST" || typeof target!=="string" || target.length<1 || target.length>1024 || !target.startsWith("/")
      || /[^\x21-\x7e]|[%\\?#]|\/\//u.test(target) || target.split("/").some(part=>part==="." || part===".."))return undefined;
    let attached=false;
    return request=>{
      if(attached)return;attached=true;
      try {
        const value=request.url,url=new URL(value);
        if(request.method!==method || value.length>2048 || /[^\x21-\x7e]/u.test(value) || url.pathname!==target || url.search || url.hash)return;
        CANONICAL_REQUEST_TARGETS.set(request,Object.freeze({method,url:value}));
      } catch { /* Unsupported transport evidence never changes ordinary dispatch. */ }
    };
  } catch { return undefined; }
}
/** @internal Assertion-only exact native object/method/URL evidence; clones carry none. */
export function hasCanonicalRequestTarget(request: Request): boolean {
  try {const proof=CANONICAL_REQUEST_TARGETS.get(request);return Boolean(proof && request.method===proof.method && request.url===proof.url);}
  catch {return false;}
}


/** @internal Native transport proof; never inherited by Request.clone(). */
export interface ExactRequest { readonly method: "GET" | "HEAD"; readonly path: string; readonly accept: string | null; }
const EXACT_REQUESTS = new WeakMap<Request, {
  exact: Readonly<ExactRequest>; url: string; fingerprint: string; digest: (value: string) => string;
  taken: boolean; registered: boolean; active: boolean; handoff?: () => undefined; detach?: () => void;
}>();
const ANONYMOUS_HEADERS = new Set("host accept accept-encoding accept-language user-agent connection cache-control pragma dnt sec-gpc sec-fetch-dest sec-fetch-mode sec-fetch-site sec-fetch-user sec-ch-ua sec-ch-ua-mobile sec-ch-ua-platform referer".split(" "));
const PROXY_HEADERS = new Set("forwarded x-forwarded-for x-forwarded-proto x-forwarded-host x-forwarded-port".split(" "));

function exactHeaderFields(headers: Headers, injected = true): string | undefined {
  const fields: string[][] = []; let size = 0;
  for (const [name, value] of headers) {
    if (!injected && name === "x-clank-client-ip") continue;
    if (fields.length >= 33 || value.length > 2048 || (size += name.length + value.length + 4) > 8704) return undefined;
    fields.push([name, value]);
  }
  return JSON.stringify(fields.sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}

/** @internal Called only by the native adapter, before Fetch normalization. */
export function captureExactRequest(method: unknown, target: unknown, rawHeaders: unknown, trustProxy: boolean, digest: (value: string) => string): ((request: Request) => void) | undefined {
  try {
    if (method !== "GET" && method !== "HEAD" || typeof target !== "string" || target.length > 512
      || !target.startsWith("/") || /[^\x21-\x7e]|[%\\?#]|\/\//u.test(target) || target.split("/").some(part => part === "." || part === "..")
      || !Array.isArray(rawHeaders) || rawHeaders.length > 64 || rawHeaders.length % 2) return undefined;
    const fields: string[][] = [], seen = new Set<string>(); let size = 0, accept: string | null = null;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const rawName: unknown = rawHeaders[i], rawValue: unknown = rawHeaders[i + 1];
      if (typeof rawName !== "string" || typeof rawValue !== "string" || rawValue.length > 2048
        || (size += rawName.length + rawValue.length + 4) > 8192) return undefined;
      const name = rawName.toLowerCase(), value = rawValue.replace(/^[ \t]+|[ \t]+$/gu, "");
      if (seen.has(name) || !ANONYMOUS_HEADERS.has(name) && !(trustProxy && PROXY_HEADERS.has(name)) || /[^\x20-\x7e]/u.test(value)
        || name === "connection" && value.toLowerCase() !== "keep-alive" && value.toLowerCase() !== "close") return undefined;
      seen.add(name); fields.push([name, value]);
      if (name === "accept") { if (value.length > 512) return undefined; accept = value; }
    }
    const rawFingerprint = digest(JSON.stringify(fields.sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)));
    fields.length = 0; seen.clear();
    const exact = Object.freeze({ method, path: target, accept }); let attached = false;
    // Retain no browser/referrer/forwarding values: only their bounded digest.
    return request => {
      if (attached) return; attached = true;
      try {
        const url = new URL(request.url), fields = exactHeaderFields(request.headers, false), current = exactHeaderFields(request.headers);
        if (request.method !== method || request.body || url.pathname !== target || url.search || url.hash || fields === undefined || current === undefined
          || digest(fields) !== rawFingerprint) return;
        EXACT_REQUESTS.set(request, { exact, url: request.url, fingerprint: digest(current), digest, taken: false, registered: false, active: false });
      } catch { /* Missing transport proof only disables observation. */ }
    };
  } catch { return undefined; }
}

/** @internal Returns bounded public metadata only while the exact native request still matches. */
export function exactRequest(request: Request): Readonly<ExactRequest> | undefined {
  try {
    const proof = EXACT_REQUESTS.get(request); if (!proof) return undefined;
    const fields = exactHeaderFields(request.headers);
    if (request.url !== proof.url || request.method !== proof.exact.method || request.body || fields === undefined || proof.digest(fields) !== proof.fingerprint) return undefined;
    return proof.exact;
  } catch { return undefined; }
}

/** @internal Reserve one post-write notification; cancellation also detaches the primary tap. */
export function registerRequestHandoff(request: Request, callback: () => undefined): (() => void) | undefined {
  const proof = EXACT_REQUESTS.get(request);
  if (!proof || proof.taken || proof.registered || typeof callback !== "function" || !exactRequest(request)) return undefined;
  proof.registered = true; proof.active = true; proof.handoff = callback;
  return () => cancelRequestHandoff(request);
}
/** @internal Native adapter alone consumes this after its ordinary first write/end. */
export function takeRequestHandoff(request: Request): (() => void) | undefined {
  const proof = EXACT_REQUESTS.get(request); if (!proof || proof.taken) return undefined;
  proof.taken = true; const callback = proof.handoff; proof.handoff = undefined;
  if (!callback) return undefined;
  let called = false;
  return () => {
    if (called) return; called = true;
    if (!proof.active || !exactRequest(request)) { cancelRequestHandoff(request); return; }
    try { const result: unknown = callback(); if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); cancelRequestHandoff(request); } }
    catch { cancelRequestHandoff(request); }
  };
}
/** @internal Ends only shadow observation; it never cancels the primary request. */
export function cancelRequestHandoff(request: Request): void {
  const proof = EXACT_REQUESTS.get(request);
  if (proof) { proof.active = false; proof.handoff = undefined; const detach = proof.detach; proof.detach = undefined; try { detach?.(); } catch {} }
}
/** @internal Controller cancellation detaches consumer-driven byte notifications. */
export function requestHandoffActive(request: Request, detach?: () => void): boolean {
  const proof = EXACT_REQUESTS.get(request);
  if (!proof?.active) return false;
  if (detach) { if (proof.detach) return false; proof.detach = detach; }
  return true;
}

/** Capture complete bounded log lines; never expose a truncated secret fragment. */
export async function captureLogLines(stream: AsyncIterable<Uint8Array>, write: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  let discarding = false;
  const accept = (text: string) => {
    buffered += text;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      if (!discarding) write(line.length > 16_384 ? "[TRUNCATED]" : line);
      discarding = false;
      buffered = buffered.slice(newline + 1);
    }
    if (buffered.length > 16_384) {
      if (!discarding) write("[TRUNCATED]");
      discarding = true;
      buffered = "";
    }
  };
  for await (const chunk of stream) accept(decoder.decode(chunk, { stream: true }));
  accept(decoder.decode());
  if (buffered && !discarding) write(buffered);
}

/** Line-oriented logs must also redact each nonempty line of multiline secrets. */
export function redactLogSecrets(line: string, secrets: Iterable<string>): string {
  const fragments = new Set<string>();
  for (const value of secrets) {
    if (!value) continue;
    fragments.add(value);
    for (const fragment of value.split(/\r?\n/)) if (fragment) fragments.add(fragment);
  }
  let output = line;
  for (const value of [...fragments].sort((left, right) => right.length - left.length)) {
    output = output.split(value).join("[REDACTED]");
  }
  return output;
}

/** Attaches adapter-authenticated network identity without trusting request headers. */
export function setTrustedClientAddress(request: Request, address: string): void {
  const normalized = address.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Trusted client address must be a non-empty, bounded value without control characters.");
  }
  TRUSTED_CLIENT_ADDRESSES.set(request, normalized);
}

/** Returns network identity attached by a trusted server adapter, when available. */
export function trustedClientAddress(request: Request): string | undefined {
  return TRUSTED_CLIENT_ADDRESSES.get(request);
}

/** Rejects executable URL schemes before they reach DOM properties or SSR attributes. */
export function assertSafeAttributeValue(tag: string, name: string, value: unknown): void {
  const attribute = name.toLowerCase();
  if (attribute === "srcdoc") {
    throw new TypeError("iframe srcdoc is raw HTML and is not accepted as an attribute.");
  }
  if (attribute === "innerhtml" || attribute === "outerhtml") {
    throw new TypeError(`${name} is raw HTML; use dangerouslySetInnerHTML only with trusted markup.`);
  }
  if (!URL_ATTRIBUTES.has(attribute) && !(tag.toLowerCase() === "object" && attribute === "data")) return;
  if (value === null || value === undefined || typeof value === "boolean") return;
  // JSON arrays and other coercible values become strings at the DOM/SSR sink.
  // Apply the URL policy to that representation too, not only primitive strings.
  const url = String(value);
  const protocol = url.trimStart().replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (protocol.startsWith("javascript:") || protocol.startsWith("vbscript:") || protocol.startsWith("file:")) {
    throw new TypeError(`Unsafe URL scheme for ${name}.`);
  }
  if (!protocol.startsWith("data:")) return;
  const imageData = (tag === "img" || tag === "source")
    && /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(url.trim());
  if (!imageData) throw new TypeError(`Unsafe data URL for ${name}.`);
}

export interface RequestOriginOptions {
  allowedOrigins?: readonly string[];
  requireOrigin?: boolean;
}

/** Applies exact-origin and Fetch Metadata checks without trusting CORS as authorization. */
export function requestOriginAllowed(request: Request, options: RequestOriginOptions = {}): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return options.requireOrigin !== true;
  const allowed = new Set([new URL(request.url).origin, ...(options.allowedOrigins ?? [])]);
  return allowed.has(origin);
}

export class RequestInputError extends Error {
  readonly name = "RequestInputError";
  declare readonly status: number;
  declare readonly code: string;
  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.status = status; this.code = code;
  }
}

export class ResponseBodyLimitError extends Error {
  readonly name = "ResponseBodyLimitError";
  declare readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes.`);
    this.maxBytes = maxBytes;
  }
}

/** Reads a request body without buffering beyond the configured byte limit. */
export async function readRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  validateByteLimit(maxBytes);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void request.body?.cancel("body limit exceeded").catch(() => undefined);
    throw new RequestInputError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes.`);
  }
  if (!request.body) return new Uint8Array();
  return readBoundedBytes(
    request.body,
    maxBytes,
    () => new RequestInputError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes.`),
  );
}

/** Reads a response body without buffering beyond the configured byte limit. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  validateByteLimit(maxBytes);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel("body limit exceeded").catch(() => undefined);
    throw new ResponseBodyLimitError(maxBytes);
  }
  if (!response.body) return new Uint8Array();
  return readBoundedBytes(
    response.body,
    maxBytes,
    () => new ResponseBodyLimitError(maxBytes),
  );
}

/** Reads and parses a JSON body with a hard byte limit in any Fetch runtime. */
export async function readJsonRequest(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new RequestInputError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected an application/json request body.");
  }
  if (!request.body) throw new RequestInputError(400, "INVALID_JSON", "A JSON request body is required.");
  const bytes = await readRequestBytes(request, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestInputError(400, "INVALID_ENCODING", "Request body must be valid UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestInputError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let slab: Uint8Array | undefined, used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        void reader.cancel("invalid body chunk").catch(() => undefined);
        throw new TypeError("Body streams must contain byte chunks.");
      }
      if (value.byteLength > maxBytes - length) {
        // A producer's cancellation hook cannot delay the limit error.
        void reader.cancel("body limit exceeded").catch(() => undefined);
        throw tooLarge();
      }
      // Copy into bounded slabs. Retaining one view per chunk lets tiny chunks
      // retain arbitrarily large backing buffers and unbounded array overhead.
      let at = 0;
      while (at < value.byteLength) {
        if (!slab || used === slab.byteLength) {
          const capacity = Math.max(256, value.byteLength - at, (slab?.byteLength ?? 0) * 2);
          slab = new Uint8Array(Math.min(64 * 1024, maxBytes - length, capacity));
          chunks.push(slab); used = 0;
        }
        const count = Math.min(slab.byteLength - used, value.byteLength - at);
        slab.set(value.subarray(at, at + count), used);
        at += count; used += count; length += count;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.byteLength, length - offset);
    bytes.set(chunk.subarray(0, count), offset);
    offset += count;
  }
  return bytes;
}

function validateByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("Body byte limit must be a non-negative safe integer.");
  }
}

export function publicValidationIssues(issues: readonly {
  path: Array<string | number>;
  message: string;
  expected?: string;
}[]): Array<{ path: Array<string | number>; message: string; expected?: string }> {
  return issues.map(({ path, message, expected }) => ({
    path,
    message,
    ...(expected === undefined ? {} : { expected }),
  }));
}
