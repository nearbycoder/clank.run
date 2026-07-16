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

/** Rejects executable URL schemes before they reach DOM properties or SSR attributes. */
export function assertSafeAttributeValue(tag: string, name: string, value: unknown): void {
  const attribute = name.toLowerCase();
  if (attribute === "srcdoc") {
    throw new TypeError("iframe srcdoc is raw HTML and is not accepted as an attribute.");
  }
  if (!URL_ATTRIBUTES.has(attribute) || typeof value !== "string") return;
  const protocol = value.trimStart().replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (protocol.startsWith("javascript:") || protocol.startsWith("vbscript:") || protocol.startsWith("file:")) {
    throw new TypeError(`Unsafe URL scheme for ${name}.`);
  }
  if (!protocol.startsWith("data:")) return;
  const imageData = (tag === "img" || tag === "source")
    && /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(value.trim());
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
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads and parses a JSON body with a hard byte limit in any Fetch runtime. */
export async function readJsonRequest(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new RequestInputError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected an application/json request body.");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestInputError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes.`);
  }
  if (!request.body) throw new RequestInputError(400, "INVALID_JSON", "A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel();
        throw new RequestInputError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
