export interface ObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredObject {
  readonly metadata: ObjectMetadata;
  readonly bytes: Uint8Array;
}

/**
 * Small provider-neutral object contract used by platform artifacts, encrypted
 * backups, and application file services. Implementations must verify the
 * returned size and SHA-256 rather than trusting provider metadata alone.
 */
export interface ObjectStore {
  /** Stable adapter identifier. Built-in values are "local" and "s3". */
  readonly kind: string;
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { contentType?: string },
  ): Promise<ObjectMetadata>;
  get(key: string): Promise<StoredObject | null>;
  stat(key: string): Promise<ObjectMetadata | null>;
  delete(key: string): Promise<boolean>;
}

export interface LocalObjectStoreOptions {
  directory: string;
  /** Defaults to 100 MiB. */
  maxObjectBytes?: number;
}

export interface S3ObjectStoreOptions {
  /** S3-compatible API endpoint. HTTPS is required outside loopback. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials require their session token to be signed. */
  sessionToken?: string;
  /** Defaults to virtual-hosted style. Enable for older S3-compatible servers. */
  pathStyle?: boolean;
  /** Optional private namespace prepended to every logical object key. */
  prefix?: string;
  fetch?: typeof fetch;
  /** Per-attempt request and response-body deadline. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Retries idempotent exact requests after network/429/5xx failures. Defaults to 2. */
  retries?: number;
  /** Defaults to 100 MiB. */
  maxObjectBytes?: number;
  /** Maximum provider error body read before cancellation. Defaults to 16 KiB. */
  maxErrorBytes?: number;
  /** Test hook for deterministic Signature Version 4 timestamps. */
  now?: () => Date;
}

export class ObjectStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

const LOCAL_MAGIC = new TextEncoder().encode("CLNKOBJ1\n");
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Opens an atomic, owner-only local object store. Each logical object is one
 * immutable envelope replaced with a same-directory rename, so metadata and
 * bytes cannot become different generations during concurrent reads.
 */
export async function openLocalObjectStore(
  options: LocalObjectStoreOptions,
): Promise<ObjectStore> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const nodeFsName = "node:fs";
  const [fs, path, nodeFs] = await Promise.all([
    import(fsName) as unknown as Promise<{
      chmod(path: string, mode: number): Promise<void>;
      mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
      open(path: string, flags: number): Promise<{
        stat(): Promise<LocalStats>;
        readFile(): Promise<Uint8Array>;
        close(): Promise<void>;
      }>;
      lstat(path: string): Promise<LocalStats>;
      rename(source: string, destination: string): Promise<void>;
      rm(path: string, options: { force: true }): Promise<void>;
      writeFile(
        path: string,
        value: Uint8Array,
        options: { flag: "wx"; mode: number },
      ): Promise<void>;
    }>,
    import(pathName) as unknown as Promise<{
      dirname(path: string): string;
      join(...segments: string[]): string;
      resolve(...segments: string[]): string;
    }>,
    import(nodeFsName) as unknown as Promise<{
      constants: { O_RDONLY: number; O_NOFOLLOW?: number };
    }>,
  ]);
  const root = path.resolve(options.directory);
  const objects = path.join(root, "objects");
  const maxObjectBytes = integer(
    options.maxObjectBytes ?? 100 * 1024 * 1024,
    "maxObjectBytes",
    1,
    1024 * 1024 * 1024,
  );
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  assertSafeLocalDirectory(await fs.lstat(root));
  await fs.chmod(root, 0o700);
  await fs.mkdir(objects, { recursive: false, mode: 0o700 }).catch(async (error) => {
    if (nodeCode(error) !== "EEXIST") throw error;
  });
  assertSafeLocalDirectory(await fs.lstat(objects));
  await fs.chmod(objects, 0o700);

  const location = async (keyInput: string): Promise<{ key: string; path: string }> => {
    const key = objectKey(keyInput);
    const digest = await sha256(new TextEncoder().encode(key));
    return {
      key,
      path: path.join(objects, digest.slice(0, 2), `${digest}.object`),
    };
  };

  const read = async (
    keyInput: string,
    includeBytes: boolean,
  ): Promise<StoredObject | ObjectMetadata | null> => {
    const target = await location(keyInput);
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(
        target.path,
        nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return null;
      throw error;
    }
    try {
      const [stats, pathStats] = await Promise.all([handle.stat(), fs.lstat(target.path)]);
      assertSafeLocalObject(stats, pathStats, maxObjectBytes);
      const envelope = new Uint8Array(await handle.readFile());
      const parsed = parseLocalEnvelope(envelope, target.key, maxObjectBytes);
      if (includeBytes && await sha256(parsed.bytes) !== parsed.metadata.sha256) {
        throw new ObjectStoreError(
          500,
          "OBJECT_INTEGRITY_FAILED",
          "Local object failed integrity verification.",
        );
      }
      return includeBytes ? parsed : parsed.metadata;
    } finally {
      await handle.close();
    }
  };

  return Object.freeze({
    kind: "local" as const,
    async put(keyInput, value, putOptions = {}) {
      const target = await location(keyInput);
      const bytes = copyBytes(value);
      if (bytes.byteLength > maxObjectBytes) {
        throw new ObjectStoreError(413, "OBJECT_TOO_LARGE", `Object exceeds ${maxObjectBytes} bytes.`);
      }
      const current = await read(target.key, false) as ObjectMetadata | null;
      const now = Date.now();
      const metadata = Object.freeze({
        key: target.key,
        size: bytes.byteLength,
        sha256: await sha256(bytes),
        contentType: mediaType(putOptions.contentType),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      const envelope = localEnvelope(metadata, bytes);
      const shard = path.dirname(target.path);
      await fs.mkdir(shard, { recursive: false, mode: 0o700 }).catch(async (error) => {
        if (nodeCode(error) !== "EEXIST") throw error;
      });
      assertSafeLocalDirectory(await fs.lstat(shard));
      await fs.chmod(shard, 0o700);
      const temporary = `${target.path}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, envelope, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, target.path);
        await fs.chmod(target.path, 0o600);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return metadata;
    },
    async get(key) {
      return await read(key, true) as StoredObject | null;
    },
    async stat(key) {
      return await read(key, false) as ObjectMetadata | null;
    },
    async delete(keyInput) {
      const target = await location(keyInput);
      const current = await read(target.key, false);
      if (!current) return false;
      await fs.rm(target.path, { force: true });
      return true;
    },
  });
}

/**
 * Creates a zero-dependency S3-compatible object store using signed, hashed
 * single-chunk requests. It intentionally implements the portable object
 * subset rather than provider-specific bucket administration.
 */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const endpoint = s3Endpoint(options.endpoint);
  const region = bounded(options.region, "region", 1, 100, /^[A-Za-z0-9_-]+$/u);
  const bucket = s3Bucket(options.bucket);
  if (!options.pathStyle && bucket.includes(".")) {
    throw new TypeError("Dotted S3 bucket names require pathStyle to avoid TLS hostname ambiguity.");
  }
  const accessKeyId = bounded(
    options.accessKeyId,
    "accessKeyId",
    3,
    512,
    /^[A-Za-z0-9._-]+$/u,
  );
  const secretAccessKey = bounded(options.secretAccessKey, "secretAccessKey", 8, 2_048);
  const sessionToken = options.sessionToken === undefined
    ? undefined
    : bounded(options.sessionToken, "sessionToken", 8, 8_192, /^[\x21-\x7e]+$/u);
  const pathStyle = options.pathStyle === true;
  const prefix = objectPrefix(options.prefix);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new TypeError("fetch is unavailable.");
  const timeoutMs = integer(options.timeoutMs ?? 30_000, "timeoutMs", 100, 10 * 60_000);
  const retries = integer(options.retries ?? 2, "retries", 0, 10);
  const maxObjectBytes = integer(
    options.maxObjectBytes ?? 100 * 1024 * 1024,
    "maxObjectBytes",
    1,
    1024 * 1024 * 1024,
  );
  const maxErrorBytes = integer(
    options.maxErrorBytes ?? 16 * 1024,
    "maxErrorBytes",
    256,
    1024 * 1024,
  );
  const clock = options.now ?? (() => new Date());

  const storageKey = (key: string): string => {
    const normalized = objectKey(key);
    return prefix ? `${prefix}/${normalized}` : normalized;
  };

  const objectUrl = (key: string): URL => {
    const url = new URL(endpoint.href);
    const encodedKey = encodePath(storageKey(key));
    if (pathStyle) {
      url.pathname = `/${encodeRfc3986(bucket)}/${encodedKey}`;
    } else {
      url.hostname = `${bucket}.${url.hostname}`;
      url.pathname = `/${encodedKey}`;
    }
    return url;
  };

  const send = async (
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    key: string,
    headersInput: Record<string, string> = {},
    body?: Uint8Array,
  ): Promise<{ response: Response; release(): void }> => {
    const url = objectUrl(key);
    const signedAt = clock();
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const payloadHash = body ? await sha256(body) : EMPTY_SHA256;
        const headers = await signedS3Headers({
          method,
          url,
          region,
          accessKeyId,
          secretAccessKey,
          sessionToken,
          payloadHash,
          now: signedAt,
          headers: headersInput,
        });
        const response = await fetcher(url, {
          method,
          headers,
          redirect: "error",
          signal: controller.signal,
          ...(body ? { body } : {}),
        });
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await response.body?.cancel().catch(() => undefined);
          clearTimeout(timer);
          await retryDelay(attempt);
          continue;
        }
        return {
          response,
          release() {
            clearTimeout(timer);
          },
        };
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (attempt >= retries) {
          if (controller.signal.aborted) {
            throw new ObjectStoreError(504, "OBJECT_STORE_TIMEOUT", "Object storage request timed out.");
          }
          throw new ObjectStoreError(502, "OBJECT_STORE_UNAVAILABLE", "Object storage is unavailable.");
        }
        await retryDelay(attempt);
      }
    }
    throw lastError;
  };

  const requireSuccess = async (
    response: Response,
    accepted: readonly number[],
  ): Promise<void> => {
    if (accepted.includes(response.status)) return;
    await readBounded(response.body, maxErrorBytes).catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new ObjectStoreError(502, "OBJECT_STORE_DENIED", "Object storage denied the request.");
    }
    if (response.status === 429) {
      throw new ObjectStoreError(503, "OBJECT_STORE_BUSY", "Object storage is temporarily busy.");
    }
    throw new ObjectStoreError(502, "OBJECT_STORE_FAILED", "Object storage request failed.");
  };

  const stat = async (key: string): Promise<ObjectMetadata | null> => {
    const flight = await send("HEAD", key);
    try {
      if (flight.response.status === 404) {
        await flight.response.body?.cancel().catch(() => undefined);
        return null;
      }
      await requireSuccess(flight.response, [200]);
      return s3Metadata(key, flight.response.headers, maxObjectBytes);
    } finally {
      flight.release();
    }
  };

  return Object.freeze({
    kind: "s3" as const,
    async put(keyInput, value, putOptions = {}) {
      const key = objectKey(keyInput);
      const bytes = copyBytes(value);
      if (bytes.byteLength > maxObjectBytes) {
        throw new ObjectStoreError(413, "OBJECT_TOO_LARGE", `Object exceeds ${maxObjectBytes} bytes.`);
      }
      const current = await stat(key);
      const now = Date.now();
      const metadata = Object.freeze({
        key,
        size: bytes.byteLength,
        sha256: await sha256(bytes),
        contentType: mediaType(putOptions.contentType),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      const flight = await send("PUT", key, {
        "content-type": metadata.contentType,
        "x-amz-meta-clank-created-at": String(metadata.createdAt),
        "x-amz-meta-clank-sha256": metadata.sha256,
        "x-amz-meta-clank-updated-at": String(metadata.updatedAt),
      }, bytes);
      try {
        await requireSuccess(flight.response, [200, 201, 204]);
        await flight.response.body?.cancel().catch(() => undefined);
        return metadata;
      } finally {
        flight.release();
      }
    },
    async get(keyInput) {
      const key = objectKey(keyInput);
      const flight = await send("GET", key);
      try {
        if (flight.response.status === 404) {
          await flight.response.body?.cancel().catch(() => undefined);
          return null;
        }
        await requireSuccess(flight.response, [200]);
        const metadata = s3Metadata(key, flight.response.headers, maxObjectBytes);
        const bytes = await readBounded(flight.response.body, maxObjectBytes);
        if (bytes.byteLength !== metadata.size || await sha256(bytes) !== metadata.sha256) {
          throw new ObjectStoreError(
            502,
            "OBJECT_INTEGRITY_FAILED",
            "Stored object failed integrity verification.",
          );
        }
        return Object.freeze({ metadata, bytes });
      } finally {
        flight.release();
      }
    },
    stat,
    async delete(keyInput) {
      const key = objectKey(keyInput);
      if (!await stat(key)) return false;
      const flight = await send("DELETE", key);
      try {
        await requireSuccess(flight.response, [200, 202, 204]);
        await flight.response.body?.cancel().catch(() => undefined);
        return true;
      } finally {
        flight.release();
      }
    },
  });
}

interface LocalStats {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function assertSafeLocalDirectory(stats: LocalStats): void {
  const getUid = (globalThis as any).process?.getuid;
  const currentUid = typeof getUid === "function"
    ? Number(getUid.call((globalThis as any).process))
    : null;
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || (currentUid !== null && stats.uid !== currentUid)
  ) {
    throw new ObjectStoreError(
      500,
      "UNSAFE_LOCAL_OBJECT",
      "Local object storage directory is unsafe.",
    );
  }
}

function assertSafeLocalObject(
  stats: LocalStats,
  pathStats: LocalStats,
  maxObjectBytes: number,
): void {
  const getUid = (globalThis as any).process?.getuid;
  const currentUid = typeof getUid === "function"
    ? Number(getUid.call((globalThis as any).process))
    : null;
  if (
    pathStats.isSymbolicLink()
    || pathStats.dev !== stats.dev
    || pathStats.ino !== stats.ino
    || !stats.isFile()
    || stats.size < LOCAL_MAGIC.byteLength + 4
    || stats.size > maxObjectBytes + 64 * 1024
    || (stats.mode & 0o077) !== 0
    || (currentUid !== null && stats.uid !== currentUid)
  ) {
    throw new ObjectStoreError(500, "UNSAFE_LOCAL_OBJECT", "Local object storage is unsafe.");
  }
}

function localEnvelope(metadata: ObjectMetadata, bytes: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  if (encoded.byteLength > 16 * 1024) throw new TypeError("Object metadata is too large.");
  const output = new Uint8Array(LOCAL_MAGIC.byteLength + 4 + encoded.byteLength + bytes.byteLength);
  output.set(LOCAL_MAGIC);
  new DataView(output.buffer).setUint32(LOCAL_MAGIC.byteLength, encoded.byteLength);
  output.set(encoded, LOCAL_MAGIC.byteLength + 4);
  output.set(bytes, LOCAL_MAGIC.byteLength + 4 + encoded.byteLength);
  return output;
}

function parseLocalEnvelope(
  envelope: Uint8Array,
  expectedKey: string,
  maxObjectBytes: number,
): StoredObject {
  if (
    envelope.byteLength < LOCAL_MAGIC.byteLength + 4
    || !equalBytes(envelope.slice(0, LOCAL_MAGIC.byteLength), LOCAL_MAGIC)
  ) {
    throw new ObjectStoreError(500, "OBJECT_INTEGRITY_FAILED", "Local object envelope is invalid.");
  }
  const metadataBytes = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(LOCAL_MAGIC.byteLength);
  const dataOffset = LOCAL_MAGIC.byteLength + 4 + metadataBytes;
  if (metadataBytes < 2 || metadataBytes > 16 * 1024 || dataOffset > envelope.byteLength) {
    throw new ObjectStoreError(500, "OBJECT_INTEGRITY_FAILED", "Local object metadata is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      envelope.slice(LOCAL_MAGIC.byteLength + 4, dataOffset),
    ));
  } catch {
    throw new ObjectStoreError(500, "OBJECT_INTEGRITY_FAILED", "Local object metadata is invalid.");
  }
  const metadata = objectMetadata(value, expectedKey, maxObjectBytes);
  const bytes = envelope.slice(dataOffset);
  if (bytes.byteLength !== metadata.size) {
    throw new ObjectStoreError(500, "OBJECT_INTEGRITY_FAILED", "Local object size is invalid.");
  }
  return Object.freeze({ metadata, bytes });
}

function s3Metadata(
  key: string,
  headers: Headers,
  maxObjectBytes: number,
): ObjectMetadata {
  const lengthHeader = headers.get("content-length");
  const size = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  const sha256Value = headers.get("x-amz-meta-clank-sha256");
  const createdAt = Number(headers.get("x-amz-meta-clank-created-at"));
  const updatedAt = Number(headers.get("x-amz-meta-clank-updated-at"));
  return objectMetadata({
    key,
    size,
    sha256: sha256Value,
    contentType: headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
    createdAt,
    updatedAt,
  }, key, maxObjectBytes);
}

function objectMetadata(
  value: unknown,
  expectedKey: string,
  maxObjectBytes: number,
): ObjectMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObjectStoreError(500, "OBJECT_INTEGRITY_FAILED", "Object metadata is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.key !== expectedKey
    || !Number.isSafeInteger(record.size)
    || Number(record.size) < 0
    || Number(record.size) > maxObjectBytes
    || typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.sha256)
    || !Number.isSafeInteger(record.createdAt)
    || Number(record.createdAt) < 0
    || !Number.isSafeInteger(record.updatedAt)
    || Number(record.updatedAt) < Number(record.createdAt)
  ) {
    throw new ObjectStoreError(500, "OBJECT_INTEGRITY_FAILED", "Object metadata is invalid.");
  }
  return Object.freeze({
    key: expectedKey,
    size: Number(record.size),
    sha256: record.sha256,
    contentType: mediaType(typeof record.contentType === "string" ? record.contentType : undefined),
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
  });
}

async function signedS3Headers(input: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  payloadHash: string;
  now: Date;
  headers: Record<string, string>;
}): Promise<Headers> {
  if (Number.isNaN(input.now.valueOf())) throw new TypeError("S3 signing clock returned an invalid date.");
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = amzDate.slice(0, 8);
  const headers = new Headers({
    ...input.headers,
    host: input.url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {}),
  });
  const signedNames = [...headers.keys()].map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = signedNames
    .map((name) => `${name}:${canonicalHeader(headers.get(name) ?? "")}\n`)
    .join("");
  const signedHeaders = signedNames.join(";");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");
  const dateKey = await hmacBytes(
    new TextEncoder().encode(date),
    new TextEncoder().encode(`AWS4${input.secretAccessKey}`),
  );
  const regionKey = await hmacBytes(new TextEncoder().encode(input.region), dateKey);
  const serviceKey = await hmacBytes(new TextEncoder().encode("s3"), regionKey);
  const signingKey = await hmacBytes(new TextEncoder().encode("aws4_request"), serviceKey);
  const signature = hex(await hmacBytes(new TextEncoder().encode(stringToSign), signingKey));
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  // Fetch implementations set Host from the URL. Keeping it in the Headers
  // object would be rejected by browser-compatible transports.
  headers.delete("host");
  // Keep transport compression disabled without signing this hop-sensitive
  // header; some compatible providers reject it in SignedHeaders.
  headers.set("accept-encoding", "identity");
  return headers;
}

function canonicalQuery(parameters: URLSearchParams): string {
  return [...parameters.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalHeader(value: string): string {
  return value.trim().replace(/[ \t]+/gu, " ");
}

function encodePath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function s3Endpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.username
    || url.password
    || url.hash
    || url.search
    || (url.pathname !== "" && url.pathname !== "/")
    || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))
  ) {
    throw new TypeError("S3 endpoint must be an HTTPS origin or a loopback HTTP origin.");
  }
  url.pathname = "/";
  return url;
}

function s3Bucket(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value)
    || value.includes("..")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)
  ) {
    throw new TypeError("S3 bucket name is invalid.");
  }
  return value;
}

function objectPrefix(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return objectKey(value.replace(/\/+$/u, ""));
}

function objectKey(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new TypeError("Object key is invalid.");
  }
  const segments = value.split("/");
  if (segments.some((segment) =>
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment)
    || segment === "."
    || segment === "..")) {
    throw new TypeError("Object key is invalid.");
  }
  return segments.join("/");
}

function mediaType(value?: string): string {
  if (!value) return "application/octet-stream";
  const normalized = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(normalized)) {
    throw new TypeError("Object content type is invalid.");
  }
  return normalized;
}

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array
    ? new Uint8Array(value)
    : new Uint8Array(value.slice(0));
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new ObjectStoreError(502, "OBJECT_TOO_LARGE", "Object storage response is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function retryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 50 * 2 ** attempt)));
}

async function sha256(value: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function hmacBytes(value: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, value));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function bounded(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || value.includes("\0")
    || /[\r\n]/u.test(value)
    || (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${name} must contain ${minimum} to ${maximum} valid characters.`);
  }
  return value;
}

function integer(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function nodeCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}
