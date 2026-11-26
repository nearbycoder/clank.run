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

/**
 * Everything the native adapter attests about one Request object. One weak
 * record per request keeps the per-request cost to a single map insertion.
 */
interface NativeEvidence { address?: string; target?: CanonicalTarget; exact?: ExactProof; }
const FOREIGN_EVIDENCE = new WeakMap<Request, NativeEvidence>();
interface NativeRequests { create(url: string, init: RequestInit): Request; read(request: Request): NativeEvidence | undefined; }
let nativeRequests: NativeRequests | undefined;

/**
 * @internal The native adapter's Request. Its evidence lives in a private
 * field: handlers can neither read nor forge it, clones never carry it, and it
 * avoids the identity-hash cost of keying a WeakMap by every incoming Request.
 */
export function createNativeRequest(url: string, init: RequestInit): Request {
  if (!nativeRequests) {
    const Base = globalThis.Request;
    // Named Request so diagnostics and constructor.name read like the platform class.
    const NativeRequest = class Request extends Base {
      #evidence: NativeEvidence = { address: undefined, target: undefined, exact: undefined };
      static read(request: globalThis.Request): NativeEvidence | undefined {
        return #evidence in request ? request.#evidence : undefined;
      }
    };
    nativeRequests = { create: (url, init) => new NativeRequest(url, init), read: NativeRequest.read };
  }
  return nativeRequests.create(url, init);
}
/** Evidence already attached to a request, without creating any. */
function evidenceOf(request: Request): NativeEvidence | undefined {
  return nativeRequests?.read(request) ?? FOREIGN_EVIDENCE.get(request);
}
/** Evidence for a request; Requests built outside the adapter fall back to a weak record. */
function nativeEvidence(request: Request): NativeEvidence {
  let evidence = evidenceOf(request);
  if (!evidence) FOREIGN_EVIDENCE.set(request, evidence = { address: undefined, target: undefined, exact: undefined });
  return evidence;
}

/**
 * How an adapter asks a response for its unread text. A registered symbol,
 * not a class check: an application bundled with its own copy of the
 * framework still hands the host adapter a response it recognises. It exposes
 * nothing but the response's own body.
 */
const BUFFERED_BODY = Symbol.for("clank.buffered-body");
const BUFFERED_DEFAULTS = Symbol.for("clank.buffered-defaults");
const BUFFERED_WRITE_HEADERS = Symbol.for("clank.buffered-write-headers");
type BufferedBody = (take: boolean) => string | number | undefined;
type HeaderPair = readonly [string, string];
type OutgoingHeaderSink = { setHeader(name: string, value: string | string[]): void };

const VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALID_STATUS_TEXT = /^[\t \x21-\x7e\x80-\xff]*$/;
const validHeaderNameCache = new Map<string, string>();

function normalizeValidHeaderName(name: string): string | undefined {
  let lower = validHeaderNameCache.get(name);
  if (lower !== undefined) return lower;
  if (!VALID_HEADER_NAME.test(name)) return undefined;
  lower = name.toLowerCase();
  if (validHeaderNameCache.size < 256) validHeaderNameCache.set(name, lower);
  return lower;
}

function isValidHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0 || c === 10 || c === 13 || c > 255) return false;
  }
  return true;
}

function trimHeaderValue(value: string): string {
  const len = value.length;
  if (len === 0) return value;
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(len - 1);
  return first <= 32 || last <= 32 ? value.trim() : value;
}

let createBuffered: ((
  source: string,
  status: number,
  statusText: string,
  contentType: string | undefined,
  singleName: string | undefined,
  singleValue: string | undefined,
  extra: Array<HeaderPair> | undefined,
  materialized: Headers | undefined,
) => Response) | undefined;

/**
 * @internal A Response whose body is a string the caller already holds.
 *
 * Defers both the Fetch byte stream and WebIDL Headers construction until
 * something actually reads them (`headers`, `body`, `clone()`, `blob()`...),
 * while exposing direct socket header/body hooks for the native Node adapter.
 */
export function createBufferedResponse(source: unknown, init: ResponseInit, defaultContentType?: string): Response {
  const status = init.status ?? 200;
  const statusText = init.statusText ?? "";
  // Non-strings, null-body statuses, or invalid status/statusText keep the platform's own errors.
  if (
    typeof source !== "string"
    || (status !== 200 && (
      !Number.isInteger(status)
      || status < 200
      || status > 599
      || status === 204
      || status === 205
      || status === 304
    ))
    || (statusText !== "" && !VALID_STATUS_TEXT.test(statusText))
  ) {
    return new Response(source as BodyInit | null | undefined, init);
  }
  let singleName: string | undefined;
  let singleValue: string | undefined;
  let extra: Array<HeaderPair> | undefined;
  let materialized: Headers | undefined;
  let contentType = defaultContentType;
  const supplied = init.headers;
  if (supplied !== undefined) {
    const isPlain = typeof supplied === "object" && supplied !== null
      && ((supplied as object).constructor === Object || Object.getPrototypeOf(supplied) === null);
    if (isPlain) {
      const record = supplied as Record<string, string>;
      for (const name in record) {
        const raw = record[name];
        const value = typeof raw === "string" ? raw : String(raw);
        const lower = normalizeValidHeaderName(name);
        if (lower === undefined || !isValidHeaderValue(value)) {
          materialized = new Headers(supplied);
          singleName = undefined;
          singleValue = undefined;
          extra = undefined;
          break;
        }
        const trimmed = trimHeaderValue(value);
        if (lower === "content-type") contentType = undefined;
        if (extra !== undefined) {
          extra.push([lower, trimmed]);
        } else if (singleName === undefined) {
          singleName = lower;
          singleValue = trimmed;
        } else {
          extra = [[singleName, singleValue!], [lower, trimmed]];
          singleName = undefined;
          singleValue = undefined;
        }
      }
    } else {
      materialized = new Headers(supplied);
    }
    if (materialized !== undefined && contentType !== undefined && !materialized.has("content-type")) {
      materialized.set("content-type", contentType);
      contentType = undefined;
    }
  }
  if (!createBuffered) {
    const Base = globalThis.Response;
    class BufferedResponse {
      _source: string;
      _status: number;
      _statusText: string;
      _contentType: string | undefined;
      _hName: string | undefined;
      _hValue: string | undefined;
      _extra: Array<HeaderPair> | undefined;
      _defaults: readonly HeaderPair[] | undefined;
      _headers: Headers | undefined;
      _stream: globalThis.Response | undefined;
      _used = false;
      constructor(
        body: string,
        code: number,
        text: string,
        ct: string | undefined,
        hName: string | undefined,
        hValue: string | undefined,
        extraHeaders: Array<HeaderPair> | undefined,
        headers: Headers | undefined,
      ) {
        this._source = body;
        this._status = code;
        this._statusText = text;
        this._contentType = ct;
        this._hName = hName;
        this._hValue = hValue;
        this._extra = extraHeaders;
        this._headers = headers;
      }
      _real(): globalThis.Response {
        let stream = this._stream;
        if (!stream) {
          stream = this._stream = new Base(this._source, {
            status: this._status,
            statusText: this._statusText,
            headers: this.headers,
          });
          if (this._used) void stream.text().catch(() => undefined);
        }
        return stream;
      }
      get status(): number { return this._status; }
      get statusText(): string { return this._statusText; }
      get ok(): boolean { return this._status >= 200 && this._status < 300; }
      get type(): ResponseType { return "default"; }
      get url(): string { return ""; }
      get redirected(): boolean { return false; }
      get headers(): Headers {
        let headers = this._headers;
        if (headers === undefined) {
          headers = new Headers();
          if (this._hName !== undefined) {
            headers.append(this._hName, this._hValue!);
          } else {
            const extra = this._extra;
            if (extra !== undefined) {
              for (let i = 0; i < extra.length; i++) headers.append(extra[i]![0], extra[i]![1]);
            }
          }
          if (this._contentType !== undefined && !headers.has("content-type")) {
            headers.set("content-type", this._contentType);
          }
          const defaults = this._defaults;
          if (defaults !== undefined) {
            for (let i = 0; i < defaults.length; i++) {
              const pair = defaults[i]!;
              if (!headers.has(pair[0])) headers.set(pair[0], pair[1]);
            }
          }
          this._headers = headers;
        }
        return headers;
      }
      get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null { return this._real().body; }
      get bodyUsed(): boolean { return this._used || (this._stream !== undefined && this._stream.bodyUsed); }
      text(): Promise<string> {
        if (this._stream || this._used) return this._real().text();
        this._used = true;
        return Promise.resolve(this._source);
      }
      json(): Promise<any> {
        if (this._stream || this._used) return this._real().json();
        this._used = true;
        try { return Promise.resolve(JSON.parse(this._source)); }
        catch (error) { return Promise.reject(error); }
      }
      arrayBuffer(): Promise<ArrayBuffer> { return this._real().arrayBuffer(); }
      blob(): Promise<Blob> { return this._real().blob(); }
      formData(): Promise<FormData> { return this._real().formData(); }
      clone(): globalThis.Response {
        if (!this._stream && !this._used) {
          if (this._headers === undefined) {
            const copy = new BufferedResponse(
              this._source,
              this._status,
              this._statusText,
              this._contentType,
              this._hName,
              this._hValue,
              this._extra ? this._extra.slice() : undefined,
              undefined,
            );
            copy._defaults = this._defaults;
            return copy as unknown as globalThis.Response;
          }
          return new BufferedResponse(
            this._source,
            this._status,
            this._statusText,
            undefined,
            undefined,
            undefined,
            undefined,
            new Headers(this._headers),
          ) as unknown as globalThis.Response;
        }
        return new Base(this._real().clone().body, {
          status: this._status,
          statusText: this._statusText,
          headers: this.headers,
        });
      }
      static real(response: globalThis.Response): globalThis.Response {
        return response instanceof BufferedResponse ? response._real() : response;
      }
      [BUFFERED_BODY](take: boolean): string | number | undefined {
        if (this._stream || this._used) return undefined;
        if (!take) return this._source.length;
        this._used = true;
        return this._source;
      }
      [BUFFERED_DEFAULTS](defaults: readonly HeaderPair[]): boolean {
        if (this._headers !== undefined) {
          const headers = this._headers;
          for (let i = 0; i < defaults.length; i++) {
            const pair = defaults[i]!;
            if (!headers.has(pair[0])) headers.set(pair[0], pair[1]);
          }
          return true;
        }
        if (this._defaults === undefined) {
          this._defaults = defaults;
          return true;
        }
        const headers = this.headers;
        for (let i = 0; i < defaults.length; i++) {
          const pair = defaults[i]!;
          if (!headers.has(pair[0])) headers.set(pair[0], pair[1]);
        }
        return true;
      }
      [BUFFERED_WRITE_HEADERS](outgoing: OutgoingHeaderSink): boolean {
        if (this._headers !== undefined) return false;
        const extra = this._extra;
        const defaults = this._defaults;
        const hName = this._hName;
        if (extra === undefined && hName === undefined) {
          if (this._contentType !== undefined) outgoing.setHeader("content-type", this._contentType);
          if (defaults !== undefined) {
            for (let i = 0; i < defaults.length; i++) {
              const pair = defaults[i]!;
              if (pair[0] !== "content-type" || this._contentType === undefined) {
                outgoing.setHeader(pair[0], pair[1]);
              }
            }
          }
          return true;
        }
        if (hName !== undefined) {
          outgoing.setHeader(hName, hName === "set-cookie" ? [this._hValue!] : this._hValue!);
          if (this._contentType !== undefined && hName !== "content-type") {
            outgoing.setHeader("content-type", this._contentType);
          }
          if (defaults !== undefined) {
            for (let i = 0; i < defaults.length; i++) {
              const pair = defaults[i]!;
              if (pair[0] !== hName && (pair[0] !== "content-type" || this._contentType === undefined)) {
                outgoing.setHeader(pair[0], pair[1]);
              }
            }
          }
          return true;
        }
        let cookies: string[] | undefined;
        const seen = new Set<string>();
        for (let i = 0; i < extra!.length; i++) {
          const name = extra![i]![0];
          const value = extra![i]![1];
          if (name === "set-cookie") {
            (cookies ??= []).push(value);
          } else {
            seen.add(name);
            outgoing.setHeader(name, value);
          }
        }
        if (this._contentType !== undefined && !seen.has("content-type")) {
          seen.add("content-type");
          outgoing.setHeader("content-type", this._contentType);
        }
        if (defaults !== undefined) {
          for (let i = 0; i < defaults.length; i++) {
            const pair = defaults[i]!;
            if (!seen.has(pair[0])) outgoing.setHeader(pair[0], pair[1]);
          }
        }
        if (cookies !== undefined) outgoing.setHeader("set-cookie", cookies);
        return true;
      }
    }
    Object.setPrototypeOf(BufferedResponse.prototype, Base.prototype);
    if ("bytes" in Base.prototype) {
      Object.defineProperty(BufferedResponse.prototype, "bytes", {
        value(this: globalThis.Response) { return (BufferedResponse.real(this) as unknown as { bytes(): Promise<Uint8Array> }).bytes(); },
        writable: true, configurable: true,
      });
    }
    createBuffered = (body, code, text, ct, hName, hValue, extraHeaders, headers) =>
      new BufferedResponse(body, code, text, ct, hName, hValue, extraHeaders, headers) as unknown as Response;
  }
  return createBuffered(source, status, statusText, contentType, singleName, singleValue, extra, materialized);
}
function bufferedBody(response: Response): BufferedBody | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const read = (response as unknown as Record<symbol, unknown>)[BUFFERED_BODY];
  return typeof read === "function" ? read as BufferedBody : undefined;
}
/** @internal Character count of an unread buffered body, or undefined for any other response. */
export function bufferedBodyLength(response: Response): number | undefined {
  const length = bufferedBody(response)?.call(response, false);
  return typeof length === "number" && Number.isFinite(length) && length >= 0 ? length : undefined;
}
/** @internal Claims an unread buffered body for a direct write. The response then reports its body as used. */
export function takeBufferedBody(response: Response): string | undefined {
  const text = bufferedBody(response)?.call(response, true);
  return typeof text === "string" ? text : undefined;
}
/** @internal Attaches default response headers without forcing WebIDL Headers construction. */
export function applyBufferedDefaultHeaders(response: Response, defaults: readonly HeaderPair[]): boolean {
  if (typeof response !== "object" || response === null) return false;
  const apply = (response as unknown as Record<symbol, unknown>)[BUFFERED_DEFAULTS];
  return typeof apply === "function" ? Boolean((apply as (d: readonly HeaderPair[]) => boolean).call(response, defaults)) : false;
}
/** @internal Writes unmaterialized buffered headers directly to a Node ServerResponse. */
export function writeBufferedHeaders(response: Response, outgoing: OutgoingHeaderSink): boolean {
  if (typeof response !== "object" || response === null) return false;
  const write = (response as unknown as Record<symbol, unknown>)[BUFFERED_WRITE_HEADERS];
  return typeof write === "function" ? Boolean((write as (o: OutgoingHeaderSink) => boolean).call(response, outgoing)) : false;
}
const UNSET_ADDRESS = Symbol("unset");
let lastTrustedAddress: readonly [raw: string | typeof UNSET_ADDRESS, normalized: string] = [UNSET_ADDRESS, ""];

interface CanonicalTarget {readonly method:"POST";readonly url:string;readonly target:string;verified?:boolean}
/** @internal Separate POST target evidence; never anonymous observation or authentication. */
export function captureCanonicalRequestTarget(method: unknown, target: unknown): ((request: Request) => void) | undefined {
  try {
    if(method!=="POST" || typeof target!=="string" || target.length<1 || target.length>1024 || !target.startsWith("/")
      || /[^\x21-\x7e]|[%\\?#]|\/\//u.test(target) || target.includes("/.") && target.split("/").some(part=>part==="." || part===".."))return undefined;
    let attached=false;
    return request=>{
      if(attached)return;attached=true;
      try {
        // Snapshot the native method/URL now; parse them only if a consumer asks for the proof.
        const value=request.url;
        if(request.method!==method || typeof value!=="string" || value.length>2048)return;
        nativeEvidence(request).target={method,url:value,target,verified:undefined};
      } catch { /* Unsupported transport evidence never changes ordinary dispatch. */ }
    };
  } catch { return undefined; }
}
/** @internal Assertion-only exact native object/method/URL evidence; clones carry none. */
export function hasCanonicalRequestTarget(request: Request): boolean {
  try {
    const proof=evidenceOf(request)?.target;if(!proof)return false;
    if(proof.verified===undefined){
      // The snapshot is immutable, so this deferred check equals the attach-time check.
      let verified=false;
      try{const url=new URL(proof.url);verified=!/[^\x21-\x7e]/u.test(proof.url) && url.pathname===proof.target && !url.search && !url.hash;}catch{}
      proof.verified=verified;
    }
    return proof.verified && request.method===proof.method && request.url===proof.url;
  }
  catch {return false;}
}


/** @internal Native transport proof; never inherited by Request.clone(). */
export interface ExactRequest { readonly method: "GET" | "HEAD"; readonly path: string; readonly accept: string | null; }
interface ExactProof {
  exact?: Readonly<ExactRequest>; url: string; fingerprint?: string; digest: (value: string) => string;
  taken: boolean; registered: boolean; active: boolean; handoff?: () => undefined; detach?: () => void;
  /** Unresolved transport evidence. Cleared, leaving only the digest, on first use. */
  pending?: { method: "GET" | "HEAD"; target: string; rawHeaders: readonly unknown[]; trustProxy: boolean; injected: string | null };
}
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

/** Canonical JSON of the raw anonymous header fields, or undefined when the transport is not provable. */
function exactRawFields(rawHeaders: readonly unknown[], trustProxy: boolean): { canonical: string; accept: string | null } | undefined {
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
  return { canonical: JSON.stringify(fields.sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)), accept };
}

/**
 * @internal Called only by the native adapter, before Fetch normalization.
 *
 * Almost no request is ever asked for this proof, so capture only records the
 * transport's own evidence. Canonicalisation and hashing run on first use and
 * reach the same verdict the eager check did: the request must still mirror
 * the raw header block, and the adapter-injected address must be unchanged.
 */
export function captureExactRequest(method: unknown, target: unknown, rawHeaders: unknown, trustProxy: boolean, digest: (value: string) => string): ((request: Request) => void) | undefined {
  try {
    if (method !== "GET" && method !== "HEAD" || typeof target !== "string" || target.length > 512
      || !target.startsWith("/") || /[^\x21-\x7e]|[%\\?#]|\/\//u.test(target) || target.includes("/.") && target.split("/").some(part => part === "." || part === "..")
      || !Array.isArray(rawHeaders) || rawHeaders.length > 64 || rawHeaders.length % 2) return undefined;
    let attached = false;
    return request => {
      if (attached) return; attached = true;
      try {
        if (request.method !== method || request.body) return;
        // Until first use the proof references only the transport's own header
        // block, which the request already mirrors and outlives.
        nativeEvidence(request).exact = { exact: undefined, url: request.url, fingerprint: undefined, digest, taken: false, registered: false, active: false,
          handoff: undefined, detach: undefined,
          pending: { method, target, rawHeaders, trustProxy, injected: request.headers.get("x-clank-client-ip") } };
      } catch { /* Missing transport proof only disables observation. */ }
    };
  } catch { return undefined; }
}

/** Resolve deferred evidence once. Returns false while the request does not (or no longer) match its transport. */
function resolveExactProof(request: Request, proof: ExactProof): boolean {
  const pending = proof.pending;
  if (!pending) return true;
  const raw = exactRawFields(pending.rawHeaders, pending.trustProxy);
  if (!raw) { const evidence = evidenceOf(request); if (evidence?.exact === proof) evidence.exact = undefined; return false; }
  const url = new URL(proof.url), fields = exactHeaderFields(request.headers, false), current = exactHeaderFields(request.headers);
  if (url.pathname !== pending.target || url.search || url.hash) {
    const evidence = evidenceOf(request);
    if (evidence?.exact === proof) evidence.exact = undefined;
    return false;
  }
  if (request.url !== proof.url || request.method !== pending.method || request.body
    || fields === undefined || current === undefined || fields !== raw.canonical
    || request.headers.get("x-clank-client-ip") !== pending.injected) return false;
  // Retain no browser/referrer/forwarding values from here on: only their bounded digest.
  proof.exact = Object.freeze({ method: pending.method, path: pending.target, accept: raw.accept });
  proof.fingerprint = proof.digest(current);
  proof.pending = undefined;
  return true;
}

/** @internal Returns bounded public metadata only while the exact native request still matches. */
export function exactRequest(request: Request): Readonly<ExactRequest> | undefined {
  try {
    const proof = evidenceOf(request)?.exact; if (!proof || !resolveExactProof(request, proof)) return undefined;
    const fields = exactHeaderFields(request.headers);
    if (request.url !== proof.url || request.method !== proof.exact!.method || request.body || fields === undefined || proof.digest(fields) !== proof.fingerprint) return undefined;
    return proof.exact;
  } catch { return undefined; }
}

/** @internal Reserve one post-write notification; cancellation also detaches the primary tap. */
export function registerRequestHandoff(request: Request, callback: () => undefined): (() => void) | undefined {
  const proof = evidenceOf(request)?.exact;
  if (!proof || proof.taken || proof.registered || typeof callback !== "function" || !exactRequest(request)) return undefined;
  proof.registered = true; proof.active = true; proof.handoff = callback;
  return () => cancelRequestHandoff(request);
}
/** @internal Native adapter alone consumes this after its ordinary first write/end. */
export function takeRequestHandoff(request: Request): (() => void) | undefined {
  const proof = evidenceOf(request)?.exact; if (!proof || proof.taken) return undefined;
  proof.taken = true; const callback = proof.handoff; proof.handoff = undefined;
  if (!callback) { proof.pending = undefined; return undefined; }
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
  const proof = evidenceOf(request)?.exact;
  if (proof) { proof.active = false; proof.handoff = undefined; proof.pending = undefined; const detach = proof.detach; proof.detach = undefined; try { detach?.(); } catch {} }
}
/** @internal Controller cancellation detaches consumer-driven byte notifications. */
export function requestHandoffActive(request: Request, detach?: () => void): boolean {
  const proof = evidenceOf(request)?.exact;
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
  // Consecutive requests usually share a connection or proxy hop; revalidate only a new value.
  if (address !== lastTrustedAddress[0]) {
    const normalized = address.trim();
    if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new TypeError("Trusted client address must be a non-empty, bounded value without control characters.");
    }
    lastTrustedAddress = [address, normalized];
  }
  nativeEvidence(request).address = lastTrustedAddress[1];
}

/** Returns network identity attached by a trusted server adapter, when available. */
export function trustedClientAddress(request: Request): string | undefined {
  return evidenceOf(request)?.address;
}

/**
 * @internal True when assertSafeAttributeValue() accepts every value for this
 * attribute on every tag, so renderers may skip the per-value policy check.
 */
export function isInertAttributeName(name: string): boolean {
  const attribute = name.toLowerCase();
  return attribute !== "srcdoc" && attribute !== "innerhtml" && attribute !== "outerhtml" && attribute !== "data" && !URL_ATTRIBUTES.has(attribute);
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
  const lowerTag = tag.toLowerCase();
  if (!URL_ATTRIBUTES.has(attribute) && !(lowerTag === "object" && attribute === "data")) return;
  if (value === null || value === undefined || typeof value === "boolean") return;
  // JSON arrays and other coercible values become strings at the DOM/SSR sink.
  // Apply the URL policy to that representation too, not only primitive strings.
  const url = typeof value === "string" ? value : String(value);
  // Find the first non-ASCII-whitespace/control character: only j/v/f/d can start a forbidden scheme.
  let pos = 0;
  const len = url.length;
  while (pos < len) {
    const code = url.charCodeAt(pos);
    if (code > 32 && code !== 127) {
      const lower = code | 32;
      if (lower !== 106 && lower !== 118 && lower !== 102 && lower !== 100) return;
      break;
    }
    pos++;
  }
  if (pos >= len) return;
  const protocol = url.slice(pos).replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (protocol.startsWith("javascript:") || protocol.startsWith("vbscript:") || protocol.startsWith("file:")) {
    throw new TypeError(`Unsafe URL scheme for ${name}.`);
  }
  if (!protocol.startsWith("data:")) return;
  const imageData = (lowerTag === "img" || lowerTag === "source")
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
    declared,
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

/** One-shot decodes keep no state between calls, so a single strict decoder serves every request. */
let strictUtf8: TextDecoder | undefined;

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
    text = (strictUtf8 ??= new TextDecoder("utf-8", { fatal: true })).decode(bytes);
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
  expected?: number,
): Promise<Uint8Array> {
  // A declared length sizes the first slab exactly, so a body that honours it
  // is returned as that slab instead of being copied a second time.
  const hint = expected !== undefined && Number.isSafeInteger(expected) && expected > 0 ? expected : 0;
  const reader = stream.getReader();
  let chunks: Uint8Array[] | undefined;
  let length = 0;
  let slab: Uint8Array | undefined, used = 0;
  try {
    const first = await reader.read();
    if (first.done) return new Uint8Array(0);
    let value = first.value;
    if (!(value instanceof Uint8Array)) {
      void reader.cancel("invalid body chunk").catch(() => undefined);
      throw new TypeError("Body streams must contain byte chunks.");
    }
    if (value.byteLength > maxBytes) {
      void reader.cancel("body limit exceeded").catch(() => undefined);
      throw tooLarge();
    }
    // Single-chunk bodies are the common case for RPC JSON payloads: copy once into
    // an exact-size detached buffer before polling for EOF so reused views stay intact.
    if (value.byteLength <= 64 * 1024) {
      const firstCopy = value.byteLength === 0 ? new Uint8Array(0) : new Uint8Array(value);
      const second = await reader.read();
      if (second.done) return firstCopy;
      chunks = [];
      if (firstCopy.byteLength > 0) {
        const capacity = hint >= firstCopy.byteLength ? hint : Math.max(256, firstCopy.byteLength);
        slab = new Uint8Array(Math.min(64 * 1024, maxBytes, capacity));
        slab.set(firstCopy, 0);
        chunks.push(slab);
        used = firstCopy.byteLength;
        length = firstCopy.byteLength;
      }
      value = second.value;
    } else {
      chunks = [];
    }
    while (true) {
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
          const capacity = slab === undefined && hint > 0 ? hint : Math.max(256, value.byteLength - at, (slab?.byteLength ?? 0) * 2);
          slab = new Uint8Array(Math.min(64 * 1024, maxBytes - length, capacity));
          chunks.push(slab); used = 0;
        }
        const count = Math.min(slab.byteLength - used, value.byteLength - at);
        slab.set(value.subarray(at, at + count), used);
        at += count; used += count; length += count;
      }
      const next = await reader.read();
      if (next.done) break;
      value = next.value;
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1 && chunks[0]!.byteLength === length) return chunks[0]!;
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
