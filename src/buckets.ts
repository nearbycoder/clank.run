import { McpToolError, type McpTool } from "./mcp.ts";
import type { ObjectMetadata, ObjectStore } from "./object-storage.ts";
import { readRequestBytes, RequestInputError } from "./security.ts";

export type BucketVisibility = "private" | "public";
export type BucketOwnership = "app" | "user";
export type BucketBrowserAccess = "authenticated" | "public" | "server";

export interface BucketImageVariant {
  readonly width: number;
  readonly height: number;
  readonly fit?: "cover" | "contain";
  readonly format?: "original" | "png" | "jpeg" | "webp" | "avif";
  readonly quality?: number;
}

export interface BucketImagePolicy {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxPixels?: number;
  readonly formats?: readonly ("png" | "jpeg" | "gif" | "webp" | "avif")[];
  readonly variants?: Readonly<Record<string, BucketImageVariant>>;
}

export interface BucketDefinitionInput {
  readonly name: string;
  readonly description?: string;
  readonly visibility?: BucketVisibility;
  readonly ownership?: BucketOwnership;
  readonly browserAccess?: BucketBrowserAccess;
  readonly allowedContentTypes?: readonly string[];
  readonly maxObjectBytes?: number;
  readonly maxObjects?: number;
  readonly maxBytes?: number;
  readonly perOwnerMaxObjects?: number;
  readonly perOwnerMaxBytes?: number;
  readonly cacheControl?: string;
  readonly resumable?: boolean;
  readonly maxChunkBytes?: number;
  readonly image?: false | BucketImagePolicy;
}

export interface BucketDefinition {
  readonly protocol: "clank-bucket/1";
  readonly name: string;
  readonly description: string;
  readonly visibility: BucketVisibility;
  readonly ownership: BucketOwnership;
  readonly browserAccess: BucketBrowserAccess;
  readonly allowedContentTypes: readonly string[];
  readonly maxObjectBytes: number;
  readonly maxObjects: number;
  readonly maxBytes: number;
  readonly perOwnerMaxObjects: number;
  readonly perOwnerMaxBytes: number;
  readonly cacheControl: string;
  readonly resumable: boolean;
  readonly maxChunkBytes: number;
  readonly image: false | Readonly<Required<Omit<BucketImagePolicy, "variants">> & {
    variants: Readonly<Record<string, Readonly<Required<BucketImageVariant>>>>;
  }>;
}

export interface BucketImageMetadata {
  readonly format: "png" | "jpeg" | "gif" | "webp" | "avif";
  readonly width: number;
  readonly height: number;
}

export interface BucketObject {
  readonly id: string;
  readonly bucket: string;
  readonly key: string;
  readonly ownerId: string | null;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly visibility: BucketVisibility;
  readonly cacheControl: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly url: string | null;
  readonly image: BucketImageMetadata | null;
  readonly variantOf: string | null;
  readonly variant: string | null;
}

export interface BucketStoredObject {
  readonly metadata: BucketObject;
  readonly bytes: Uint8Array;
}

export interface BucketUsage {
  readonly objects: number;
  readonly bytes: number;
  readonly reservedObjects: number;
  readonly reservedBytes: number;
  readonly maxObjects: number;
  readonly maxBytes: number;
}

export interface BucketListResult {
  readonly objects: readonly BucketObject[];
  readonly cursor: string | null;
  readonly usage: BucketUsage;
}

export interface BucketIdentity {
  readonly userId?: string | null;
}

export interface BucketPutOptions extends BucketIdentity {
  readonly contentType: string;
  readonly ifSha256?: string | null;
  readonly expectedSha256?: string;
  readonly variantOf?: string;
  readonly variant?: string;
}

export interface BucketListOptions extends BucketIdentity {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface BucketUploadIntentInput extends BucketIdentity {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  readonly resumable?: boolean;
  readonly expectedSha256?: string;
  readonly expiresInMs?: number;
}

export interface BucketUploadIntent {
  readonly protocol: "clank-bucket-upload/1";
  readonly bucket: string;
  readonly key: string;
  readonly method: "PUT" | "PATCH";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: number;
  readonly resumable: boolean;
  readonly offset: number;
  readonly size: number;
  readonly maxChunkBytes: number;
}

export interface BucketReadIntent {
  readonly protocol: "clank-bucket-read/1";
  readonly bucket: string;
  readonly key: string;
  readonly url: string;
  readonly expiresAt: number;
}

export interface BucketRequestContext extends BucketIdentity {
  readonly authenticated?: boolean;
  readonly verifyWrite?: () => void | Promise<void>;
}

export interface BucketImageTransformInput {
  readonly bucket: BucketDefinition;
  readonly source: BucketStoredObject;
  readonly variant: string;
  readonly spec: Readonly<Required<BucketImageVariant>>;
  readonly signal?: AbortSignal;
}

export interface BucketImageTransformOutput {
  readonly bytes: Uint8Array | ArrayBuffer;
  readonly contentType: string;
}

export type BucketImageTransformer = (
  input: BucketImageTransformInput,
) => BucketImageTransformOutput | Promise<BucketImageTransformOutput>;

export interface OpenBucketManagerOptions {
  readonly definitions: readonly BucketDefinition[] | Readonly<Record<string, BucketDefinition>>;
  readonly store: ObjectStore;
  readonly databasePath: string;
  readonly stagingDirectory: string;
  readonly signingKey: string | Uint8Array;
  readonly basePath?: string;
  readonly publicOrigin?: string;
  readonly capabilityTtlMs?: number;
  /** Optional deployment-wide cap shared by all definitions in this manager. */
  readonly maxObjects?: number;
  /** Optional deployment-wide byte cap shared by all definitions in this manager. */
  readonly maxBytes?: number;
  readonly imageTransformer?: BucketImageTransformer;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface BucketRuntime {
  readonly definition: BucketDefinition;
  put(key: string, value: Uint8Array | ArrayBuffer, options: BucketPutOptions): Promise<BucketObject>;
  get(key: string, identity?: BucketIdentity): Promise<BucketStoredObject | null>;
  stat(key: string, identity?: BucketIdentity): BucketObject | null;
  statById(id: string, identity?: BucketIdentity): BucketObject | null;
  list(options?: BucketListOptions): BucketListResult;
  usage(identity?: BucketIdentity): BucketUsage;
  delete(key: string, options?: BucketIdentity & { ifSha256?: string }): Promise<boolean>;
  createUploadIntent(input: BucketUploadIntentInput): Promise<BucketUploadIntent>;
  createReadIntent(key: string, options?: BucketIdentity & { expiresInMs?: number }): Promise<BucketReadIntent>;
  transform(key: string, variant: string, options?: BucketIdentity & { signal?: AbortSignal }): Promise<BucketObject>;
}

export interface BucketManager {
  readonly basePath: string;
  readonly definitions: ReadonlyMap<string, BucketDefinition>;
  bucket(name: string): BucketRuntime;
  manifest(): readonly BucketDefinition[];
  /** Aggregate active and reserved usage across this deployed application. */
  usage(): BucketUsage;
  handle(request: Request, context?: BucketRequestContext): Promise<Response>;
  sweep(): Promise<{ reservations: number; objects: number }>;
  close(): void;
}

export interface BucketClientOptions {
  readonly basePath?: string;
  readonly fetch?: typeof fetch;
  readonly csrfToken?: string | (() => string | undefined);
}

export interface BucketUploadOptions {
  readonly key: string;
  readonly value: Uint8Array | ArrayBuffer | Blob;
  readonly contentType?: string;
  readonly resumable?: boolean;
  readonly expectedSha256?: string;
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface BucketClient {
  list(options?: Omit<BucketListOptions, "userId">): Promise<BucketListResult>;
  stat(key: string): Promise<BucketObject | null>;
  upload(options: BucketUploadOptions): Promise<BucketObject>;
  delete(key: string, ifSha256?: string): Promise<boolean>;
  createReadIntent(key: string, expiresInMs?: number): Promise<BucketReadIntent>;
}

export interface BucketMcpOptions<Context = unknown> {
  readonly identity?: (context: Context) => BucketIdentity;
  readonly maxInlineBytes?: number;
}

export class BucketError extends Error {
  readonly name = "BucketError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~+-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const CONTENT_PATTERN = /^(?:[a-z0-9][a-z0-9!#$&^_.+-]{0,63}|\*)\/(?:[a-z0-9][a-z0-9!#$&^_.+-]{0,126}|\*)$/u;
const MAX_BYTES = 1024 * 1024 * 1024;

export function defineBucket(input: BucketDefinitionInput): BucketDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Bucket definition must be an object.");
  }
  exactKeys(input as unknown as Record<string, unknown>, [
    "name", "description", "visibility", "ownership", "browserAccess", "allowedContentTypes",
    "maxObjectBytes", "maxObjects", "maxBytes", "perOwnerMaxObjects", "perOwnerMaxBytes",
    "cacheControl", "resumable", "maxChunkBytes", "image",
  ], "bucket definition");
  const name = boundedName(input.name);
  const visibility = enumValue(input.visibility ?? "private", ["private", "public"], "visibility");
  const ownership = enumValue(input.ownership ?? "user", ["app", "user"], "ownership");
  const browserAccess = enumValue(
    input.browserAccess ?? "authenticated",
    ["authenticated", "public", "server"],
    "browserAccess",
  );
  if (browserAccess === "public" && (ownership !== "app" || visibility !== "public")) {
    throw new TypeError("Public browser buckets must use app ownership and public visibility.");
  }
  const maxObjectBytes = integer(input.maxObjectBytes ?? 25 * 1024 * 1024, "maxObjectBytes", 1, MAX_BYTES);
  const maxObjects = integer(input.maxObjects ?? 10_000, "maxObjects", 1, 1_000_000);
  const maxBytes = integer(input.maxBytes ?? MAX_BYTES, "maxBytes", maxObjectBytes, Number.MAX_SAFE_INTEGER);
  const perOwnerMaxObjects = integer(
    input.perOwnerMaxObjects ?? maxObjects,
    "perOwnerMaxObjects",
    1,
    maxObjects,
  );
  const perOwnerMaxBytes = integer(
    input.perOwnerMaxBytes ?? maxBytes,
    "perOwnerMaxBytes",
    maxObjectBytes,
    maxBytes,
  );
  const resumable = input.resumable ?? true;
  if (typeof resumable !== "boolean") throw new TypeError("resumable must be boolean.");
  const maxChunkBytes = integer(
    input.maxChunkBytes ?? Math.min(maxObjectBytes, 8 * 1024 * 1024),
    "maxChunkBytes",
    1,
    maxObjectBytes,
  );
  const allowedContentTypes = normalizeContentPatterns(
    input.allowedContentTypes ?? (input.image === false || input.image === undefined
      ? ["application/octet-stream"]
      : ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]),
  );
  const cacheControl = safeHeader(
    input.cacheControl ?? (visibility === "public"
      ? "public, max-age=300, stale-while-revalidate=86400"
      : "private, no-store"),
    "cacheControl",
  );
  const image = normalizeImagePolicy(input.image);
  const description = boundedText(
    input.description ?? `${humanize(name)} application objects.`,
    "description",
    500,
  );
  return deepFreeze({
    protocol: "clank-bucket/1" as const,
    name,
    description,
    visibility,
    ownership,
    browserAccess,
    allowedContentTypes,
    maxObjectBytes,
    maxObjects,
    maxBytes,
    perOwnerMaxObjects,
    perOwnerMaxBytes,
    cacheControl,
    resumable,
    maxChunkBytes,
    image,
  });
}

export function inspectBucketImage(
  value: Uint8Array | ArrayBuffer,
  claimedContentType?: string,
): BucketImageMetadata {
  const bytes = copyBytes(value);
  const image = pngInfo(bytes) ?? jpegInfo(bytes) ?? gifInfo(bytes) ?? webpInfo(bytes) ?? avifInfo(bytes);
  if (!image) throw new BucketError(415, "INVALID_IMAGE", "The uploaded bytes are not a supported raster image.");
  if (claimedContentType !== undefined && normalizeContentType(claimedContentType) !== imageContentType(image.format)) {
    throw new BucketError(415, "IMAGE_TYPE_MISMATCH", "The image bytes do not match the declared content type.");
  }
  return Object.freeze(image);
}

function normalizeImagePolicy(input: false | BucketImagePolicy | undefined): BucketDefinition["image"] {
  if (input === false || input === undefined) return false;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("image must be an object or false.");
  exactKeys(input as Record<string, unknown>, ["maxWidth", "maxHeight", "maxPixels", "formats", "variants"], "image policy");
  const formats = Object.freeze([...(input.formats ?? ["png", "jpeg", "gif", "webp", "avif"])]);
  if (formats.length === 0 || formats.length > 5 || new Set(formats).size !== formats.length
    || formats.some((format) => !["png", "jpeg", "gif", "webp", "avif"].includes(format))) {
    throw new TypeError("image.formats must contain unique supported raster formats.");
  }
  const maxWidth = integer(input.maxWidth ?? 12_000, "image.maxWidth", 1, 100_000);
  const maxHeight = integer(input.maxHeight ?? 12_000, "image.maxHeight", 1, 100_000);
  const maxPixels = integer(input.maxPixels ?? 40_000_000, "image.maxPixels", 1, 1_000_000_000);
  const variants: Record<string, Readonly<Required<BucketImageVariant>>> = {};
  for (const [name, raw] of Object.entries(input.variants ?? {})) {
    const variantName = boundedName(name);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`image variant ${name} must be an object.`);
    exactKeys(raw as Record<string, unknown>, ["width", "height", "fit", "format", "quality"], `image variant ${name}`);
    variants[variantName] = Object.freeze({
      width: integer(raw.width, `${name}.width`, 1, maxWidth),
      height: integer(raw.height, `${name}.height`, 1, maxHeight),
      fit: enumValue(raw.fit ?? "cover", ["cover", "contain"], `${name}.fit`),
      format: enumValue(raw.format ?? "original", ["original", "png", "jpeg", "webp", "avif"], `${name}.format`),
      quality: integer(raw.quality ?? 82, `${name}.quality`, 1, 100),
    });
  }
  return deepFreeze({ maxWidth, maxHeight, maxPixels, formats, variants });
}

function pngInfo(bytes: Uint8Array): BucketImageMetadata | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  if (ascii(bytes, 12, 16) !== "IHDR") throw new BucketError(415, "INVALID_IMAGE", "PNG image header is invalid.");
  return imageDimensions("png", u32be(bytes, 16), u32be(bytes, 20));
}

function gifInfo(bytes: Uint8Array): BucketImageMetadata | null {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return null;
  return imageDimensions("gif", u16le(bytes, 6), u16le(bytes, 8));
}

function jpegInfo(bytes: Uint8Array): BucketImageMetadata | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (frames.has(marker)) {
      if (length < 7) break;
      return imageDimensions("jpeg", u16be(bytes, offset + 5), u16be(bytes, offset + 3));
    }
    offset += length;
  }
  throw new BucketError(415, "INVALID_IMAGE", "JPEG dimensions could not be verified.");
}

function webpInfo(bytes: Uint8Array): BucketImageMetadata | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X") {
    return imageDimensions("webp", 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    const width = 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8));
    const height = 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10));
    return imageDimensions("webp", width, height);
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return imageDimensions("webp", u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  throw new BucketError(415, "INVALID_IMAGE", "WebP dimensions could not be verified.");
}

function avifInfo(bytes: Uint8Array): BucketImageMetadata | null {
  if (bytes.length < 32 || ascii(bytes, 4, 8) !== "ftyp") return null;
  const brandBytes = ascii(bytes, 8, Math.min(bytes.length, 64));
  if (!brandBytes.includes("avif") && !brandBytes.includes("avis")) return null;
  for (let offset = 4; offset + 12 <= bytes.length - 8; offset++) {
    if (ascii(bytes, offset, offset + 4) !== "ispe") continue;
    const width = u32be(bytes, offset + 8);
    const height = u32be(bytes, offset + 12);
    return imageDimensions("avif", width, height);
  }
  throw new BucketError(415, "INVALID_IMAGE", "AVIF dimensions could not be verified.");
}

function imageDimensions(
  format: BucketImageMetadata["format"],
  width: number,
  height: number,
): BucketImageMetadata {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new BucketError(415, "INVALID_IMAGE", "Image dimensions are invalid.");
  }
  return { format, width, height };
}

function imageContentType(format: BucketImageMetadata["format"]): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)) >>> 0;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let output = "";
  for (let index = start; index < end && index < bytes.length; index++) {
    output += String.fromCharCode(bytes[index]!);
  }
  return output;
}

interface NativeStatement {
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Record<string, unknown>[];
  run(...values: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface ObjectRow extends Record<string, unknown> {
  bucket: string;
  object_id: string;
  owner_id: string;
  object_key: string;
  storage_key: string;
  size: number;
  sha256: string;
  content_type: string;
  visibility: BucketVisibility;
  cache_control: string;
  created_at: number;
  updated_at: number;
  image_json: string | null;
  variant_of: string | null;
  variant_name: string | null;
}

interface ReservationRow extends Record<string, unknown> {
  reservation_id: string;
  bucket: string;
  object_id: string;
  owner_id: string;
  object_key: string;
  storage_key: string;
  size: number;
  content_type: string;
  expected_sha256: string | null;
  expires_at: number;
  resumable: number;
  received: number;
  lock_token: string | null;
  lock_expires_at: number | null;
  replaces_size: number | null;
  replaces_storage_key: string | null;
  variant_of: string | null;
  variant_name: string | null;
}

interface Capability {
  v: 1;
  b: string;
  o: "read" | "write" | "resume";
  i: string;
  u: string;
  e: number;
}

export async function openBucketManager(options: OpenBucketManagerOptions): Promise<BucketManager> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Bucket manager options must be an object.");
  }
  if (!options.store || typeof options.store.put !== "function" || typeof options.store.get !== "function"
    || typeof options.store.stat !== "function" || typeof options.store.delete !== "function") {
    throw new TypeError("Bucket manager requires an ObjectStore.");
  }
  const definitions = normalizeDefinitions(options.definitions);
  const now = options.now ?? Date.now;
  if (typeof now !== "function" || !Number.isFinite(now())) throw new TypeError("now must return a finite timestamp.");
  const capabilityTtlMs = integer(options.capabilityTtlMs ?? 15 * 60_000, "capabilityTtlMs", 1_000, 24 * 60 * 60_000);
  const projectMaxObjects = integer(options.maxObjects ?? Number.MAX_SAFE_INTEGER, "maxObjects", 1, Number.MAX_SAFE_INTEGER);
  const projectMaxBytes = integer(options.maxBytes ?? Number.MAX_SAFE_INTEGER, "maxBytes", 1, Number.MAX_SAFE_INTEGER);
  const basePath = safeBasePath(options.basePath ?? "/__clank/buckets");
  const publicOrigin = options.publicOrigin === undefined ? "" : safeOrigin(options.publicOrigin);
  const signingBytes = typeof options.signingKey === "string"
    ? new TextEncoder().encode(options.signingKey)
    : copyBytes(options.signingKey);
  if (signingBytes.byteLength < 32 || signingBytes.byteLength > 4_096) {
    throw new TypeError("Bucket signing key must contain between 32 and 4096 bytes.");
  }
  const cryptoKey = crypto.subtle.importKey(
    "raw",
    signingBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const sqliteName = "node:sqlite";
  const [fs, path, sqlite] = await Promise.all([
    import(fsName) as unknown as Promise<BucketFs>,
    import(pathName) as unknown as Promise<BucketPath>,
    import(sqliteName) as unknown as Promise<{ DatabaseSync: new(path: string) => NativeDatabase }>,
  ]);
  const stagingRoot = path.resolve(options.stagingDirectory);
  const catalogPath = path.resolve(options.databasePath);
  await preparePrivateDirectory(fs, path, stagingRoot);
  await preparePrivateDirectory(fs, path, path.dirname(catalogPath));
  await assertSafeCatalogFile(fs, catalogPath, true);
  const native = new sqlite.DatabaseSync(catalogPath);
  await assertSafeCatalogFile(fs, catalogPath, false);
  await fs.chmod(catalogPath, 0o600);
  native.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  native.exec(`CREATE TABLE IF NOT EXISTS clank_bucket_objects (
    bucket TEXT NOT NULL,
    object_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content_type TEXT NOT NULL,
    visibility TEXT NOT NULL,
    cache_control TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    image_json TEXT,
    variant_of TEXT,
    variant_name TEXT,
    PRIMARY KEY (bucket, owner_id, object_key),
    UNIQUE (bucket, object_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS clank_bucket_objects_list
    ON clank_bucket_objects (bucket, owner_id, updated_at DESC, object_id DESC);
  CREATE TABLE IF NOT EXISTS clank_bucket_reservations (
    reservation_id TEXT PRIMARY KEY,
    bucket TEXT NOT NULL,
    object_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    expected_sha256 TEXT,
    expires_at INTEGER NOT NULL,
    resumable INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    lock_token TEXT,
    lock_expires_at INTEGER,
    replaces_size INTEGER,
    replaces_storage_key TEXT,
    variant_of TEXT,
    variant_name TEXT,
    UNIQUE (bucket, owner_id, object_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS clank_bucket_reservations_expiry
    ON clank_bucket_reservations (expires_at);
  CREATE TABLE IF NOT EXISTS clank_bucket_garbage (
    storage_key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  ) STRICT;`);
  let closed = false;
  let transactionActive = false;
  const report = (error: unknown) => {
    try { options.onError?.(error); } catch { /* Diagnostics cannot alter storage behavior. */ }
  };
  const ensureOpen = () => {
    if (closed) throw new BucketError(503, "BUCKET_CLOSED", "Bucket storage is closed.");
  };
  const transaction = <Value>(handler: () => Value): Value => {
    ensureOpen();
    if (transactionActive) throw new Error("Nested bucket catalog transactions are not supported.");
    transactionActive = true;
    native.exec("BEGIN IMMEDIATE");
    try {
      const value = handler();
      native.exec("COMMIT");
      return value;
    } catch (error) {
      try { native.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    } finally {
      transactionActive = false;
    }
  };
  const statement = (sql: string) => native.prepare(sql);
  const definitionFor = (name: string): BucketDefinition => {
    const definition = definitions.get(name);
    if (!definition) throw new BucketError(404, "BUCKET_NOT_FOUND", "Bucket not found.");
    return definition;
  };
  const ownerFor = (definition: BucketDefinition, identity: BucketIdentity = {}): string => {
    if (definition.ownership === "app") return "";
    if (typeof identity.userId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(identity.userId)) {
      throw new BucketError(401, "BUCKET_AUTH_REQUIRED", "Authentication is required for this bucket.");
    }
    return identity.userId;
  };
  const publicUrl = (definition: BucketDefinition, id: string, digest: string): string | null => definition.visibility === "public"
    ? `${publicOrigin}${basePath}/${encodeURIComponent(definition.name)}/public/${encodeURIComponent(id)}/${digest}`
    : null;
  const objectFromRow = (row: ObjectRow): BucketObject => {
    const definition = definitionFor(String(row.bucket));
    const image = row.image_json === null ? null : parseStoredImage(String(row.image_json));
    return Object.freeze({
      id: String(row.object_id),
      bucket: definition.name,
      key: String(row.object_key),
      ownerId: row.owner_id === "" ? null : String(row.owner_id),
      size: safeStoredInteger(row.size, "size"),
      sha256: storedSha(row.sha256),
      contentType: normalizeContentType(String(row.content_type)),
      visibility: definition.visibility,
      cacheControl: safeHeader(String(row.cache_control), "cacheControl"),
      createdAt: safeStoredInteger(row.created_at, "createdAt"),
      updatedAt: safeStoredInteger(row.updated_at, "updatedAt"),
      url: publicUrl(definition, String(row.object_id), storedSha(row.sha256)),
      image,
      variantOf: row.variant_of === null ? null : String(row.variant_of),
      variant: row.variant_name === null ? null : String(row.variant_name),
    });
  };
  const rowForKey = (bucket: string, owner: string, key: string): ObjectRow | null => {
    const row = statement("SELECT * FROM clank_bucket_objects WHERE bucket = ? AND owner_id = ? AND object_key = ?")
      .get(bucket, owner, key);
    return row ? row as ObjectRow : null;
  };
  const rowForId = (bucket: string, owner: string | undefined, id: string): ObjectRow | null => {
    const row = owner === undefined
      ? statement("SELECT * FROM clank_bucket_objects WHERE bucket = ? AND object_id = ?").get(bucket, id)
      : statement("SELECT * FROM clank_bucket_objects WHERE bucket = ? AND owner_id = ? AND object_id = ?")
        .get(bucket, owner, id);
    return row ? row as ObjectRow : null;
  };
  const reservationRow = (id: string): ReservationRow | null => {
    const row = statement("SELECT * FROM clank_bucket_reservations WHERE reservation_id = ?").get(id);
    return row ? row as ReservationRow : null;
  };

  const usageFor = (definition: BucketDefinition, owner?: string): BucketUsage => {
    const filter = owner === undefined ? "bucket = ?" : "bucket = ? AND owner_id = ?";
    const values = owner === undefined ? [definition.name] : [definition.name, owner];
    const active = statement(`SELECT count(*) AS objects, coalesce(sum(size), 0) AS bytes
      FROM clank_bucket_objects WHERE ${filter}`).get(...values)!;
    const reserved = statement(`SELECT
        coalesce(sum(CASE WHEN replaces_size IS NULL THEN 1 ELSE 0 END), 0) AS objects,
        coalesce(sum(size - coalesce(replaces_size, 0)), 0) AS bytes
      FROM clank_bucket_reservations WHERE ${filter}`).get(...values)!;
    return Object.freeze({
      objects: safeStoredInteger(active.objects, "objects"),
      bytes: safeStoredInteger(active.bytes, "bytes"),
      reservedObjects: safeStoredInteger(reserved.objects, "reservedObjects"),
      reservedBytes: safeStoredInteger(reserved.bytes, "reservedBytes"),
      maxObjects: owner === undefined ? definition.maxObjects : definition.perOwnerMaxObjects,
      maxBytes: owner === undefined ? definition.maxBytes : definition.perOwnerMaxBytes,
    });
  };

  const removeReservation = (id: string): ReservationRow | null => transaction(() => {
    const row = reservationRow(id);
    if (!row) return null;
    statement("DELETE FROM clank_bucket_reservations WHERE reservation_id = ?").run(id);
    return row;
  });

  const queueGarbage = (storageKey: string): void => {
    statement("INSERT OR IGNORE INTO clank_bucket_garbage (storage_key, created_at) VALUES (?, ?)")
      .run(storageKey, finiteNow(now));
  };

  const collectGarbage = async (limit = 100): Promise<number> => {
    const rows = statement("SELECT storage_key FROM clank_bucket_garbage ORDER BY created_at, storage_key LIMIT ?")
      .all(limit);
    let removed = 0;
    for (const row of rows) {
      const storageKey = String(row.storage_key);
      try {
        await options.store.delete(storageKey);
        transaction(() => statement("DELETE FROM clank_bucket_garbage WHERE storage_key = ?").run(storageKey));
        removed++;
      } catch (error) {
        report(error);
      }
    }
    return removed;
  };

  const cleanupReservation = async (row: ReservationRow): Promise<void> => {
    transaction(() => queueGarbage(String(row.storage_key)));
    await fs.rm(path.join(stagingRoot, `${String(row.reservation_id)}.upload`), { force: true }).catch(report);
  };

  const sweep = async (): Promise<{ reservations: number; objects: number }> => {
    ensureOpen();
    const cutoff = finiteNow(now);
    const expired = transaction(() => {
      const rows = statement("SELECT * FROM clank_bucket_reservations WHERE expires_at <= ?")
        .all(cutoff) as ReservationRow[];
      statement("DELETE FROM clank_bucket_reservations WHERE expires_at <= ?").run(cutoff);
      return rows;
    });
    for (const row of expired) await cleanupReservation(row);
    return { reservations: expired.length, objects: await collectGarbage() };
  };

  const reserve = async (
    definition: BucketDefinition,
    keyInput: string,
    sizeInput: number,
    contentTypeInput: string,
    identity: BucketIdentity,
    reserveOptions: {
      expectedSha256?: string;
      ifSha256?: string | null;
      expiresAt: number;
      resumable: boolean;
      variantOf?: string;
      variant?: string;
    },
  ): Promise<ReservationRow> => {
    await sweep();
    const key = bucketKey(keyInput);
    const owner = ownerFor(definition, identity);
    const size = integer(sizeInput, "size", 0, definition.maxObjectBytes);
    const contentType = allowedContentType(definition, contentTypeInput);
    const expectedSha256 = reserveOptions.expectedSha256 === undefined
      ? null
      : storedSha(reserveOptions.expectedSha256);
    const expiresAt = integer(reserveOptions.expiresAt, "expiresAt", finiteNow(now) + 1, finiteNow(now) + 24 * 60 * 60_000);
    const id = randomId("bucket_reservation");
    const createdAt = finiteNow(now);
    return transaction(() => {
      const existing = rowForKey(definition.name, owner, key);
      if (reserveOptions.ifSha256 === null && existing) {
        throw new BucketError(409, "BUCKET_OBJECT_EXISTS", "Bucket object already exists.");
      }
      if (typeof reserveOptions.ifSha256 === "string"
        && (!existing || String(existing.sha256) !== storedSha(reserveOptions.ifSha256))) {
        throw new BucketError(409, "BUCKET_OBJECT_CHANGED", "Bucket object changed before this write.");
      }
      const global = usageFor(definition);
      const scoped = usageFor(definition, owner);
      const objectDelta = existing ? 0 : 1;
      const byteDelta = size - (existing ? safeStoredInteger(existing.size, "size") : 0);
      const project = statement(`SELECT
          (SELECT count(*) FROM clank_bucket_objects) AS objects,
          (SELECT coalesce(sum(size), 0) FROM clank_bucket_objects) AS bytes,
          (SELECT coalesce(sum(CASE WHEN replaces_size IS NULL THEN 1 ELSE 0 END), 0) FROM clank_bucket_reservations) AS reserved_objects,
          (SELECT coalesce(sum(size - coalesce(replaces_size, 0)), 0) FROM clank_bucket_reservations) AS reserved_bytes`)
        .get()!;
      if (safeStoredInteger(project.objects, "project objects") + safeStoredInteger(project.reserved_objects, "project reserved objects") + objectDelta > projectMaxObjects
        || safeStoredInteger(project.bytes, "project bytes") + safeStoredInteger(project.reserved_bytes, "project reserved bytes") + byteDelta > projectMaxBytes) {
        throw new BucketError(413, "PROJECT_BUCKET_QUOTA_EXCEEDED", "Project bucket quota exceeded.", {
          maxObjects: projectMaxObjects,
          maxBytes: projectMaxBytes,
        });
      }
      if (global.objects + global.reservedObjects + objectDelta > definition.maxObjects
        || global.bytes + global.reservedBytes + byteDelta > definition.maxBytes) {
        throw quotaError(definition, global, size, false);
      }
      if (scoped.objects + scoped.reservedObjects + objectDelta > definition.perOwnerMaxObjects
        || scoped.bytes + scoped.reservedBytes + byteDelta > definition.perOwnerMaxBytes) {
        throw quotaError(definition, scoped, size, true);
      }
      const objectId = existing ? String(existing.object_id) : randomId("bucket_object");
      const storageKey = `app-buckets/${definition.name}/${objectId}/${randomId("generation")}`;
      try {
        statement(`INSERT INTO clank_bucket_reservations
          (reservation_id, bucket, object_id, owner_id, object_key, storage_key, size,
            content_type, expected_sha256, expires_at, resumable, received, lock_token,
            lock_expires_at, replaces_size, replaces_storage_key, variant_of, variant_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)`)
          .run(
            id,
            definition.name,
            objectId,
            owner,
            key,
            storageKey,
            size,
            contentType,
            expectedSha256,
            expiresAt,
            reserveOptions.resumable ? 1 : 0,
            existing?.size ?? null,
            existing?.storage_key ?? null,
            reserveOptions.variantOf ?? null,
            reserveOptions.variant ?? null,
          );
      } catch (error) {
        if (safeError(error).includes("UNIQUE")) {
          throw new BucketError(409, "BUCKET_UPLOAD_IN_PROGRESS", "Another upload is already replacing this object.");
        }
        throw error;
      }
      return reservationRow(id)!;
    });
  };

  const validateImage = (definition: BucketDefinition, bytes: Uint8Array, contentType: string): BucketImageMetadata | null => {
    if (!definition.image) return null;
    const image = inspectBucketImage(bytes, contentType);
    if (!definition.image.formats.includes(image.format)) {
      throw new BucketError(415, "IMAGE_FORMAT_NOT_ALLOWED", "This image format is not allowed in the bucket.");
    }
    if (image.width > definition.image.maxWidth || image.height > definition.image.maxHeight
      || image.width * image.height > definition.image.maxPixels) {
      throw new BucketError(413, "IMAGE_DIMENSIONS_EXCEEDED", "Image dimensions exceed the bucket policy.", {
        width: image.width,
        height: image.height,
        maxWidth: definition.image.maxWidth,
        maxHeight: definition.image.maxHeight,
        maxPixels: definition.image.maxPixels,
      });
    }
    return image;
  };

  const finalize = async (reservation: ReservationRow, value: Uint8Array | ArrayBuffer): Promise<BucketObject> => {
    ensureOpen();
    const bytes = copyBytes(value);
    if (bytes.byteLength !== safeStoredInteger(reservation.size, "size")) {
      throw new BucketError(400, "UPLOAD_SIZE_MISMATCH", "Uploaded bytes do not match the declared size.");
    }
    const digest = await sha256(bytes);
    if (reservation.expected_sha256 !== null && digest !== reservation.expected_sha256) {
      throw new BucketError(422, "UPLOAD_DIGEST_MISMATCH", "Uploaded bytes do not match the declared SHA-256.");
    }
    const definition = definitionFor(String(reservation.bucket));
    const image = validateImage(definition, bytes, String(reservation.content_type));
    let stored: ObjectMetadata;
    try {
      stored = await options.store.put(String(reservation.storage_key), bytes, {
        contentType: String(reservation.content_type),
      });
    } catch (error) {
      const removed = removeReservation(String(reservation.reservation_id));
      if (removed) await cleanupReservation(removed);
      throw error;
    }
    if (stored.key !== reservation.storage_key || stored.size !== bytes.byteLength || stored.sha256 !== digest
      || normalizeContentType(stored.contentType) !== normalizeContentType(String(reservation.content_type))) {
      const removed = removeReservation(String(reservation.reservation_id));
      if (removed) await cleanupReservation(removed);
      throw new BucketError(502, "OBJECT_STORE_MISMATCH", "Object storage returned inconsistent upload metadata.");
    }
    let row: ObjectRow;
    try {
      row = transaction(() => {
        const current = reservationRow(String(reservation.reservation_id));
        if (!current || Number(current.expires_at) <= finiteNow(now)) {
          throw new BucketError(409, "UPLOAD_EXPIRED", "Upload capability expired before completion.");
        }
        const existing = rowForKey(definition.name, String(current.owner_id), String(current.object_key));
        const createdAt = existing ? safeStoredInteger(existing.created_at, "createdAt") : finiteNow(now);
        statement(`INSERT INTO clank_bucket_objects
          (bucket, object_id, owner_id, object_key, storage_key, size, sha256, content_type,
            visibility, cache_control, created_at, updated_at, image_json, variant_of, variant_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bucket, owner_id, object_key) DO UPDATE SET
            object_id = excluded.object_id,
            storage_key = excluded.storage_key,
            size = excluded.size,
            sha256 = excluded.sha256,
            content_type = excluded.content_type,
            visibility = excluded.visibility,
            cache_control = excluded.cache_control,
            updated_at = excluded.updated_at,
            image_json = excluded.image_json,
            variant_of = excluded.variant_of,
            variant_name = excluded.variant_name`)
          .run(
            definition.name,
            current.object_id,
            current.owner_id,
            current.object_key,
            current.storage_key,
            bytes.byteLength,
            digest,
            current.content_type,
            definition.visibility,
            definition.cacheControl,
            createdAt,
            finiteNow(now),
            image ? JSON.stringify(image) : null,
            current.variant_of,
            current.variant_name,
          );
        statement("DELETE FROM clank_bucket_reservations WHERE reservation_id = ?")
          .run(current.reservation_id);
        if (current.replaces_storage_key && current.replaces_storage_key !== current.storage_key) {
          queueGarbage(String(current.replaces_storage_key));
        }
        return rowForKey(definition.name, String(current.owner_id), String(current.object_key))!;
      });
    } catch (error) {
      await options.store.delete(String(reservation.storage_key)).catch(report);
      throw error;
    }
    await fs.rm(path.join(stagingRoot, `${String(reservation.reservation_id)}.upload`), { force: true });
    await collectGarbage();
    return objectFromRow(row);
  };

  const put = async (
    definition: BucketDefinition,
    key: string,
    value: Uint8Array | ArrayBuffer,
    putOptions: BucketPutOptions,
  ): Promise<BucketObject> => {
    const bytes = copyBytes(value);
    const reservation = await reserve(definition, key, bytes.byteLength, putOptions.contentType, putOptions, {
      expectedSha256: putOptions.expectedSha256,
      ifSha256: putOptions.ifSha256,
      expiresAt: finiteNow(now) + capabilityTtlMs,
      resumable: false,
      variantOf: putOptions.variantOf,
      variant: putOptions.variant,
    });
    return finalize(reservation, bytes);
  };

  const stat = (definition: BucketDefinition, keyInput: string, identity: BucketIdentity = {}): BucketObject | null => {
    ensureOpen();
    const owner = ownerFor(definition, identity);
    const row = rowForKey(definition.name, owner, bucketKey(keyInput));
    return row ? objectFromRow(row) : null;
  };

  const statById = (definition: BucketDefinition, idInput: string, identity: BucketIdentity = {}): BucketObject | null => {
    ensureOpen();
    const id = boundedId(idInput, "object id");
    const owner = definition.ownership === "app" ? "" : ownerFor(definition, identity);
    const row = rowForId(definition.name, owner, id);
    return row ? objectFromRow(row) : null;
  };

  const get = async (
    definition: BucketDefinition,
    keyInput: string,
    identity: BucketIdentity = {},
  ): Promise<BucketStoredObject | null> => {
    const metadata = stat(definition, keyInput, identity);
    if (!metadata) return null;
    const row = rowForKey(definition.name, ownerFor(definition, identity), metadata.key)!;
    const stored = await options.store.get(String(row.storage_key));
    if (!stored) throw new BucketError(500, "BUCKET_OBJECT_MISSING", "Bucket object bytes are missing.");
    if (stored.metadata.size !== metadata.size || stored.metadata.sha256 !== metadata.sha256
      || normalizeContentType(stored.metadata.contentType) !== metadata.contentType) {
      throw new BucketError(500, "BUCKET_INTEGRITY_FAILED", "Bucket object failed integrity verification.");
    }
    return Object.freeze({ metadata, bytes: new Uint8Array(stored.bytes) });
  };

  const list = (definition: BucketDefinition, listOptions: BucketListOptions = {}): BucketListResult => {
    ensureOpen();
    const owner = ownerFor(definition, listOptions);
    const prefix = listOptions.prefix === undefined ? "" : bucketPrefix(listOptions.prefix);
    const limit = integer(listOptions.limit ?? 50, "limit", 1, 100);
    const cursor = listOptions.cursor === undefined ? null : parseCursor(listOptions.cursor);
    const rows = cursor
      ? statement(`SELECT * FROM clank_bucket_objects
          WHERE bucket = ? AND owner_id = ? AND object_key LIKE ? ESCAPE '\\'
            AND (updated_at < ? OR (updated_at = ? AND object_id < ?))
          ORDER BY updated_at DESC, object_id DESC LIMIT ?`)
        .all(definition.name, owner, `${likePrefix(prefix)}%`, cursor.updatedAt, cursor.updatedAt, cursor.id, limit + 1)
      : statement(`SELECT * FROM clank_bucket_objects
          WHERE bucket = ? AND owner_id = ? AND object_key LIKE ? ESCAPE '\\'
          ORDER BY updated_at DESC, object_id DESC LIMIT ?`)
        .all(definition.name, owner, `${likePrefix(prefix)}%`, limit + 1);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit) as ObjectRow[];
    const last = selected.at(-1);
    return Object.freeze({
      objects: Object.freeze(selected.map(objectFromRow)),
      cursor: hasMore && last
        ? encodeCursor({ updatedAt: safeStoredInteger(last.updated_at, "updatedAt"), id: String(last.object_id) })
        : null,
      usage: usageFor(definition, owner),
    });
  };

  const deleteObject = async (
    definition: BucketDefinition,
    keyInput: string,
    deleteOptions: BucketIdentity & { ifSha256?: string } = {},
  ): Promise<boolean> => {
    ensureOpen();
    const owner = ownerFor(definition, deleteOptions);
    const key = bucketKey(keyInput);
    const row = transaction(() => {
      const current = rowForKey(definition.name, owner, key);
      if (!current) return null;
      if (deleteOptions.ifSha256 !== undefined && storedSha(deleteOptions.ifSha256) !== current.sha256) {
        throw new BucketError(409, "BUCKET_OBJECT_CHANGED", "Bucket object changed before deletion.");
      }
      statement("DELETE FROM clank_bucket_objects WHERE bucket = ? AND owner_id = ? AND object_key = ?")
        .run(definition.name, owner, key);
      queueGarbage(String(current.storage_key));
      return current;
    });
    if (!row) return false;
    await collectGarbage();
    return true;
  };

  const signCapability = async (capability: Capability): Promise<string> => {
    const payload = base64Url(new TextEncoder().encode(JSON.stringify(capability)));
    const signature = await crypto.subtle.sign("HMAC", await cryptoKey, new TextEncoder().encode(payload));
    return `${payload}.${base64Url(new Uint8Array(signature))}`;
  };

  const verifyCapability = async (token: string, operation: Capability["o"]): Promise<Capability> => {
    if (token.length > 2_048) throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid.");
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) {
      throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid.");
    }
    const expected = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      await cryptoKey,
      new TextEncoder().encode(payload),
    ));
    let actual: Uint8Array;
    try { actual = fromBase64Url(signature); }
    catch { throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid."); }
    if (!constantTimeEqual(expected, actual)) {
      throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(payload)));
    } catch {
      throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid.");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid.");
    }
    const raw = decoded as Record<string, unknown>;
    if (raw.v !== 1 || raw.o !== operation || typeof raw.b !== "string" || typeof raw.i !== "string"
      || typeof raw.u !== "string" || !Number.isSafeInteger(raw.e) || Number(raw.e) <= finiteNow(now)) {
      throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid or expired.");
    }
    definitionFor(raw.b);
    return raw as unknown as Capability;
  };

  const createUploadIntent = async (
    definition: BucketDefinition,
    input: BucketUploadIntentInput,
  ): Promise<BucketUploadIntent> => {
    const resumable = input.size === 0
      ? false
      : input.resumable ?? (definition.resumable && input.size > definition.maxChunkBytes);
    if (resumable && !definition.resumable) {
      throw new BucketError(400, "RESUMABLE_DISABLED", "Resumable uploads are disabled for this bucket.");
    }
    const expiresAt = finiteNow(now) + integer(
      input.expiresInMs ?? capabilityTtlMs,
      "expiresInMs",
      1_000,
      24 * 60 * 60_000,
    );
    const reservation = await reserve(definition, input.key, input.size, input.contentType, input, {
      expectedSha256: input.expectedSha256,
      expiresAt,
      resumable,
    });
    if (resumable) {
      await fs.writeFile(stagingFile(path, stagingRoot, String(reservation.reservation_id)), new Uint8Array(), {
        flag: "wx",
        mode: 0o600,
      }).catch(async (error) => {
        const removed = removeReservation(String(reservation.reservation_id));
        if (removed) await cleanupReservation(removed);
        throw error;
      });
    }
    const token = await signCapability({
      v: 1,
      b: definition.name,
      o: resumable ? "resume" : "write",
      i: String(reservation.reservation_id),
      u: String(reservation.owner_id),
      e: expiresAt,
    });
    return Object.freeze({
      protocol: "clank-bucket-upload/1" as const,
      bucket: definition.name,
      key: String(reservation.object_key),
      method: resumable ? "PATCH" as const : "PUT" as const,
      url: `${publicOrigin}${basePath}/${encodeURIComponent(definition.name)}/cap/${token}`,
      headers: Object.freeze(resumable
        ? { "upload-offset": "0", "content-type": "application/offset+octet-stream" }
        : { "content-type": String(reservation.content_type) }),
      expiresAt,
      resumable,
      offset: 0,
      size: safeStoredInteger(reservation.size, "size"),
      maxChunkBytes: definition.maxChunkBytes,
    });
  };

  const createReadIntent = async (
    definition: BucketDefinition,
    key: string,
    readOptions: BucketIdentity & { expiresInMs?: number } = {},
  ): Promise<BucketReadIntent> => {
    const owner = ownerFor(definition, readOptions);
    const row = rowForKey(definition.name, owner, bucketKey(key));
    if (!row) throw new BucketError(404, "BUCKET_OBJECT_NOT_FOUND", "Bucket object not found.");
    const expiresAt = finiteNow(now) + integer(
      readOptions.expiresInMs ?? capabilityTtlMs,
      "expiresInMs",
      1_000,
      24 * 60 * 60_000,
    );
    const token = await signCapability({
      v: 1,
      b: definition.name,
      o: "read",
      i: String(row.object_id),
      u: owner,
      e: expiresAt,
    });
    return Object.freeze({
      protocol: "clank-bucket-read/1" as const,
      bucket: definition.name,
      key: String(row.object_key),
      url: `${publicOrigin}${basePath}/${encodeURIComponent(definition.name)}/cap/${token}`,
      expiresAt,
    });
  };

  const transform = async (
    definition: BucketDefinition,
    key: string,
    transformOptions: BucketIdentity & { signal?: AbortSignal },
    variantNameInput: string,
  ): Promise<BucketObject> => {
    if (!definition.image) throw new BucketError(400, "NOT_IMAGE_BUCKET", "This bucket does not accept images.");
    if (!options.imageTransformer) {
      throw new BucketError(501, "IMAGE_TRANSFORMER_UNAVAILABLE", "No image transformer is configured.");
    }
    const variant = boundedName(variantNameInput);
    const spec = definition.image.variants[variant];
    if (!spec) throw new BucketError(404, "IMAGE_VARIANT_NOT_FOUND", "Image variant not found.");
    const source = await get(definition, key, transformOptions);
    if (!source || !source.metadata.image) throw new BucketError(404, "BUCKET_OBJECT_NOT_FOUND", "Source image not found.");
    const output = await options.imageTransformer({
      bucket: definition,
      source,
      variant,
      spec,
      signal: transformOptions.signal,
    });
    const bytes = copyBytes(output.bytes);
    const extension = spec.format === "original" ? source.metadata.image.format : spec.format;
    const variantKey = `variants/${source.metadata.id}/${variant}.${extension === "jpeg" ? "jpg" : extension}`;
    return put(definition, variantKey, bytes, {
      ...transformOptions,
      contentType: output.contentType,
      variantOf: source.metadata.id,
      variant,
    });
  };

  const storedResponse = async (row: ObjectRow, request: Request): Promise<Response> => {
    const stored = await options.store.get(String(row.storage_key));
    if (!stored) throw new BucketError(500, "BUCKET_OBJECT_MISSING", "Bucket object bytes are missing.");
    const metadata = objectFromRow(row);
    if (stored.metadata.sha256 !== metadata.sha256 || stored.metadata.size !== metadata.size) {
      throw new BucketError(500, "BUCKET_INTEGRITY_FAILED", "Bucket object failed integrity verification.");
    }
    const headers = objectHeaders(metadata);
    return new Response(request.method === "HEAD" ? null : stored.bytes, { status: 200, headers });
  };

  const handleResumable = async (request: Request, capability: Capability): Promise<Response> => {
    const reservation = reservationRow(capability.i);
    if (!reservation || reservation.bucket !== capability.b || reservation.owner_id !== capability.u
      || Number(reservation.resumable) !== 1 || Number(reservation.expires_at) <= finiteNow(now)) {
      throw new BucketError(410, "UPLOAD_EXPIRED", "Resumable upload is unavailable or expired.");
    }
    const uploadPath = stagingFile(path, stagingRoot, capability.i);
    const reconcile = async (): Promise<ReservationRow> => {
      const stats = await fs.lstat(uploadPath).catch((error) => {
        if (nodeCode(error) === "ENOENT") throw new BucketError(410, "UPLOAD_EXPIRED", "Upload staging data is missing.");
        throw error;
      });
      assertSafeStagingFile(stats);
      const actual = safeStoredInteger(stats.size, "upload size");
      if (actual > safeStoredInteger(reservation.size, "size")) {
        throw new BucketError(500, "UPLOAD_STATE_INVALID", "Resumable upload state is inconsistent.");
      }
      if (actual !== safeStoredInteger(reservation.received, "received")) {
        transaction(() => statement("UPDATE clank_bucket_reservations SET received = ? WHERE reservation_id = ?")
          .run(actual, capability.i));
      }
      return reservationRow(capability.i)!;
    };
    if (request.method === "HEAD") {
      const current = await reconcile();
      return new Response(null, { status: 204, headers: uploadHeaders(current) });
    }
    if (request.method === "DELETE") {
      const removed = removeReservation(capability.i);
      if (removed) await cleanupReservation(removed);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "PATCH") throw new BucketError(405, "METHOD_NOT_ALLOWED", "Use PATCH, HEAD, or DELETE.");
    if (normalizeContentType(request.headers.get("content-type") ?? "") !== "application/offset+octet-stream") {
      throw new BucketError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/offset+octet-stream.");
    }
    const before = await reconcile();
    const offsetHeader = request.headers.get("upload-offset");
    if (offsetHeader === null || !/^\d+$/u.test(offsetHeader)) {
      throw new BucketError(400, "UPLOAD_OFFSET_REQUIRED", "A decimal upload-offset header is required.");
    }
    const suppliedOffset = integer(Number(offsetHeader), "upload-offset", 0, Number(before.size));
    if (suppliedOffset !== Number(before.received)) {
      throw new BucketError(409, "UPLOAD_OFFSET_MISMATCH", "Upload offset does not match server state.", {
        offset: Number(before.received),
      });
    }
    const definition = definitionFor(capability.b);
    const remaining = Number(before.size) - Number(before.received);
    const chunk = await readRequestBytes(request, Math.min(definition.maxChunkBytes, remaining));
    if (chunk.byteLength === 0 && remaining > 0) throw new BucketError(400, "EMPTY_UPLOAD_CHUNK", "Upload chunk is empty.");
    if (chunk.byteLength > remaining) throw new BucketError(413, "UPLOAD_TOO_LARGE", "Upload exceeds its declared size.");
    const lock = randomId("upload_lock");
    const claimed = transaction(() => statement(`UPDATE clank_bucket_reservations SET lock_token = ?, lock_expires_at = ?
      WHERE reservation_id = ? AND received = ? AND (lock_token IS NULL OR lock_expires_at <= ?)`)
      .run(lock, finiteNow(now) + 30_000, capability.i, suppliedOffset, finiteNow(now)));
    if (Number(claimed.changes) !== 1) throw new BucketError(409, "UPLOAD_BUSY", "Another upload chunk is in progress.");
    try {
      await fs.appendFile(uploadPath, chunk, { mode: 0o600 });
      const received = suppliedOffset + chunk.byteLength;
      transaction(() => {
        const changed = statement(`UPDATE clank_bucket_reservations
          SET received = ?, lock_token = NULL, lock_expires_at = NULL
          WHERE reservation_id = ? AND lock_token = ?`).run(received, capability.i, lock);
        if (Number(changed.changes) !== 1) throw new BucketError(409, "UPLOAD_STATE_CHANGED", "Upload state changed.");
      });
      if (received < Number(before.size)) {
        return new Response(null, { status: 204, headers: uploadHeaders(reservationRow(capability.i)!) });
      }
      const bytes = new Uint8Array(await fs.readFile(uploadPath));
      const completed = await finalize(reservationRow(capability.i)!, bytes);
      return jsonResponse({ object: completed }, 201);
    } catch (error) {
      transaction(() => statement(`UPDATE clank_bucket_reservations SET lock_token = NULL, lock_expires_at = NULL
        WHERE reservation_id = ? AND lock_token = ?`).run(capability.i, lock));
      throw error;
    }
  };

  const requireBrowser = async (
    definition: BucketDefinition,
    context: BucketRequestContext,
    write: boolean,
  ): Promise<void> => {
    if (definition.browserAccess === "server") {
      throw new BucketError(403, "BUCKET_SERVER_ONLY", "This bucket is only available to server actions and agents.");
    }
    if (write || definition.browserAccess === "authenticated" || definition.ownership === "user") {
      if (context.authenticated !== true) throw new BucketError(401, "BUCKET_AUTH_REQUIRED", "Authentication is required.");
    }
    if (write) await context.verifyWrite?.();
  };

  const bucketBrowser = async (url: URL, context: BucketRequestContext): Promise<Response> => {
    if (context.authenticated !== true) {
      throw new BucketError(401, "BUCKET_AUTH_REQUIRED", "Sign in to this application to browse its files.");
    }
    const available = [...definitions.values()].filter((definition) => definition.browserAccess !== "server");
    const selectedName = url.searchParams.get("bucket") ?? available[0]?.name;
    const selected = selectedName ? available.find((definition) => definition.name === selectedName) : undefined;
    if (selectedName && !selected) throw new BucketError(404, "BUCKET_NOT_FOUND", "Bucket not found.");
    const prefix = url.searchParams.get("prefix") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const result = selected
      ? list(selected, { userId: context.userId, prefix, cursor, limit: 100 })
      : null;
    const rows = result
      ? await Promise.all(result.objects.map(async (object) => {
          const readUrl = object.url ?? (await createReadIntent(selected!, object.key, {
            userId: context.userId,
            expiresInMs: Math.min(capabilityTtlMs, 5 * 60_000),
          })).url;
          return `<tr><td><a href="${escapeHtml(readUrl)}" rel="noreferrer">${escapeHtml(object.key)}</a></td><td>${escapeHtml(object.contentType)}</td><td>${escapeHtml(formatFileSize(object.size))}</td><td><code>${escapeHtml(object.sha256.slice(0, 12))}</code></td><td>${escapeHtml(new Date(object.updatedAt).toISOString())}</td></tr>`;
        }))
      : [];
    const bucketLinks = available.map((definition) => {
      const active = definition.name === selected?.name ? " aria-current=\"page\"" : "";
      return `<a${active} href="${basePath}?bucket=${encodeURIComponent(definition.name)}">${escapeHtml(definition.name)}</a>`;
    }).join("");
    const usage = result?.usage;
    const query = selected
      ? `<form method="get" action="${basePath}"><input type="hidden" name="bucket" value="${escapeHtml(selected.name)}"><label>Key prefix <input name="prefix" value="${escapeHtml(prefix ?? "")}" maxlength="1024" placeholder="images/"></label><button>Filter</button></form>`
      : "";
    const next = selected && result?.cursor
      ? `<a class="next" href="${basePath}?bucket=${encodeURIComponent(selected.name)}${prefix === undefined ? "" : `&amp;prefix=${encodeURIComponent(prefix)}`}&amp;cursor=${encodeURIComponent(result.cursor)}">Next page →</a>`
      : "";
    const body = selected && result
      ? `<header><div><p>CLANK MANAGED STORAGE</p><h1>${escapeHtml(selected.name)}</h1><span>${escapeHtml(selected.description)}</span></div><div class="usage"><strong>${escapeHtml(formatFileSize(usage!.bytes))}</strong><span>${usage!.objects.toLocaleString("en-US")} objects · ${escapeHtml(formatFileSize(usage!.maxBytes))} limit</span></div></header>${query}<div class="table"><table><thead><tr><th>Key</th><th>Type</th><th>Size</th><th>SHA-256</th><th>Updated</th></tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="5" class="empty">No matching objects.</td></tr>`}</tbody></table></div>${next}`
      : `<div class="empty-state"><h1>No browser-accessible buckets</h1><p>This app has no buckets exposed to signed-in people.</p></div>`;
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(selected?.name ?? "Files")} · Clank storage</title><style>:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#090909;color:#f4f4f5}*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100dvh}nav{border-right:1px solid #27272a;padding:28px 18px}nav strong{display:block;margin:0 10px 22px;font-size:14px}nav a{display:block;color:#a1a1aa;text-decoration:none;padding:10px;border-radius:8px;font-size:14px;overflow-wrap:anywhere}nav a:hover,nav a[aria-current]{background:#18181b;color:#fafafa}main{padding:clamp(24px,5vw,72px);min-width:0}header{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:32px}header p{color:#86efac;font:700 11px ui-monospace,monospace;letter-spacing:.14em}h1{font-size:clamp(32px,6vw,64px);letter-spacing:-.05em;margin:4px 0}header span,.usage span{color:#a1a1aa}.usage{text-align:right}.usage strong{display:block;font-size:24px}.usage span{font-size:12px}form{display:flex;align-items:end;gap:10px;margin-bottom:18px}label{display:grid;gap:7px;color:#a1a1aa;font-size:12px;flex:1}input,button{font:inherit;color:#fafafa;background:#18181b;border:1px solid #3f3f46;border-radius:8px;min-height:42px;padding:9px 12px}button{cursor:pointer;font-weight:650}.table{overflow:auto;border:1px solid #27272a;border-radius:12px}table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:13px 15px;border-bottom:1px solid #27272a;font-size:12px}th{color:#a1a1aa;font-weight:500}td a{color:#f4f4f5}td code{color:#86efac}.empty{text-align:center;color:#71717a;padding:48px}.next{display:inline-flex;color:#f4f4f5;margin-top:18px}.empty-state{max-width:620px}.empty-state p{color:#a1a1aa}@media(max-width:700px){body{display:block}nav{border-right:0;border-bottom:1px solid #27272a;padding:14px;display:flex;gap:4px;overflow:auto}nav strong{margin:auto 8px;white-space:nowrap}nav a{white-space:nowrap}main{padding:24px 16px}header{display:grid;align-items:start}.usage{text-align:left}form{align-items:stretch;flex-direction:column}}</style></head><body><nav><strong>Storage</strong>${bucketLinks}</nav><main>${body}</main></body></html>`, {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
  };

  const handle = async (request: Request, context: BucketRequestContext = {}): Promise<Response> => {
    try {
      ensureOpen();
      const url = new URL(request.url);
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
        return new Response("Not found", { status: 404 });
      }
      if (url.pathname === basePath && request.method === "GET") return await bucketBrowser(url, context);
      const segments = url.pathname.slice(basePath.length).split("/").filter(Boolean).map((value) => decodePath(value));
      if (segments.length < 2) throw new BucketError(404, "BUCKET_ROUTE_NOT_FOUND", "Bucket route not found.");
      const [bucketName, operation, value, generation] = segments;
      const definition = definitionFor(bucketName!);
      if (operation === "public") {
        if (definition.visibility !== "public" || !value || !generation || segments.length !== 4) {
          throw new BucketError(404, "BUCKET_OBJECT_NOT_FOUND", "Bucket object not found.");
        }
        if (request.method !== "GET" && request.method !== "HEAD") throw new BucketError(405, "METHOD_NOT_ALLOWED", "Use GET or HEAD.");
        const row = rowForId(definition.name, undefined, boundedId(value, "object id"));
        if (!row || storedSha(generation) !== storedSha(row.sha256)) {
          throw new BucketError(404, "BUCKET_OBJECT_NOT_FOUND", "Bucket object not found.");
        }
        return await storedResponse(row, request);
      }
      if (operation === "cap") {
        if (!value || segments.length !== 3) throw new BucketError(404, "BUCKET_ROUTE_NOT_FOUND", "Bucket route not found.");
        if (request.method === "GET" || request.method === "HEAD") {
          const capability = await verifyCapability(value, "read");
          if (capability.b !== definition.name) throw new BucketError(401, "INVALID_CAPABILITY", "Read capability is invalid.");
          const row = rowForId(definition.name, capability.u, capability.i);
          if (!row) throw new BucketError(404, "BUCKET_OBJECT_NOT_FOUND", "Bucket object not found.");
          return await storedResponse(row, request);
        }
        const operationName = request.method === "PUT" ? "write" : "resume";
        const capability = await verifyCapability(value, operationName);
        if (capability.b !== definition.name) throw new BucketError(401, "INVALID_CAPABILITY", "Upload capability is invalid.");
        if (operationName === "resume") return await handleResumable(request, capability);
        const reservation = reservationRow(capability.i);
        if (!reservation || reservation.bucket !== capability.b || reservation.owner_id !== capability.u
          || Number(reservation.resumable) !== 0 || Number(reservation.expires_at) <= finiteNow(now)) {
          throw new BucketError(410, "UPLOAD_EXPIRED", "Upload is unavailable or expired.");
        }
        const bytes = await readRequestBytes(request, safeStoredInteger(reservation.size, "size"));
        const completed = await finalize(reservation, bytes);
        return jsonResponse({ object: completed }, 201);
      }
      if (operation === "objects" && segments.length === 2 && request.method === "GET") {
        await requireBrowser(definition, context, false);
        return jsonResponse(list(definition, {
          userId: context.userId,
          prefix: url.searchParams.get("prefix") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }));
      }
      if (operation === "object" && segments.length === 2) {
        const key = url.searchParams.get("key");
        if (key === null) throw new BucketError(400, "BUCKET_KEY_REQUIRED", "A key query parameter is required.");
        if (request.method === "GET") {
          await requireBrowser(definition, context, false);
          return jsonResponse({ object: stat(definition, key, context) });
        }
        if (request.method === "DELETE") {
          await requireBrowser(definition, context, true);
          return jsonResponse({ deleted: await deleteObject(definition, key, {
            userId: context.userId,
            ifSha256: request.headers.get("if-match")?.replace(/^"|"$/gu, ""),
          }) });
        }
      }
      if (operation === "uploads" && segments.length === 2 && request.method === "POST") {
        await requireBrowser(definition, context, true);
        const body = await readJson(request);
        exactKeys(body, ["key", "size", "contentType", "resumable", "expectedSha256", "expiresInMs"], "upload intent");
        return jsonResponse(await createUploadIntent(definition, {
          userId: context.userId,
          key: requiredString(body.key, "key"),
          size: requiredNumber(body.size, "size"),
          contentType: requiredString(body.contentType, "contentType"),
          resumable: optionalBoolean(body.resumable, "resumable"),
          expectedSha256: optionalString(body.expectedSha256, "expectedSha256"),
          expiresInMs: optionalNumber(body.expiresInMs, "expiresInMs"),
        }));
      }
      if (operation === "read-intents" && segments.length === 2 && request.method === "POST") {
        await requireBrowser(definition, context, false);
        const body = await readJson(request);
        exactKeys(body, ["key", "expiresInMs"], "read intent");
        return jsonResponse(await createReadIntent(definition, requiredString(body.key, "key"), {
          userId: context.userId,
          expiresInMs: optionalNumber(body.expiresInMs, "expiresInMs"),
        }));
      }
      throw new BucketError(404, "BUCKET_ROUTE_NOT_FOUND", "Bucket route not found.");
    } catch (error) {
      return bucketErrorResponse(error, report);
    }
  };

  const runtimes = new Map<string, BucketRuntime>();
  const runtime = (name: string): BucketRuntime => {
    const definition = definitionFor(name);
    const existing = runtimes.get(name);
    if (existing) return existing;
    const value: BucketRuntime = Object.freeze({
      definition,
      put: (key, bytes, putOptions) => put(definition, key, bytes, putOptions),
      get: (key, identity) => get(definition, key, identity),
      stat: (key, identity) => stat(definition, key, identity),
      statById: (id, identity) => statById(definition, id, identity),
      list: (listOptions) => list(definition, listOptions),
      usage: (identity = {}) => usageFor(definition, definition.ownership === "app" ? "" : ownerFor(definition, identity)),
      delete: (key, deleteOptions) => deleteObject(definition, key, deleteOptions),
      createUploadIntent: (input) => createUploadIntent(definition, input),
      createReadIntent: (key, readOptions) => createReadIntent(definition, key, readOptions),
      transform: (key, variant, transformOptions = {}) => transform(definition, key, transformOptions, variant),
    });
    runtimes.set(name, value);
    return value;
  };
  const manager: BucketManager = Object.freeze({
    basePath,
    definitions,
    bucket: runtime,
    manifest: () => Object.freeze([...definitions.values()]),
    usage: () => {
      ensureOpen();
      const row = statement(`SELECT
          (SELECT count(*) FROM clank_bucket_objects) AS objects,
          (SELECT coalesce(sum(size), 0) FROM clank_bucket_objects) AS bytes,
          (SELECT coalesce(sum(CASE WHEN replaces_size IS NULL THEN 1 ELSE 0 END), 0) FROM clank_bucket_reservations) AS reserved_objects,
          (SELECT coalesce(sum(size - coalesce(replaces_size, 0)), 0) FROM clank_bucket_reservations) AS reserved_bytes`)
        .get()!;
      return Object.freeze({
        objects: safeStoredInteger(row.objects, "project objects"),
        bytes: safeStoredInteger(row.bytes, "project bytes"),
        reservedObjects: safeStoredInteger(row.reserved_objects, "project reserved objects"),
        reservedBytes: safeStoredInteger(row.reserved_bytes, "project reserved bytes"),
        maxObjects: projectMaxObjects,
        maxBytes: projectMaxBytes,
      });
    },
    handle,
    sweep,
    close() {
      if (closed) return;
      closed = true;
      native.close();
    },
  });
  await sweep();
  return manager;
}

export function createBucketClient(nameInput: string, options: BucketClientOptions = {}): BucketClient {
  const name = boundedName(nameInput);
  const basePath = safeBasePath(options.basePath ?? "/__clank/buckets");
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== "function") throw new TypeError("A fetch implementation is required.");
  const endpoint = `${basePath}/${encodeURIComponent(name)}`;
  const csrfHeaders = (): Record<string, string> => {
    const value = typeof options.csrfToken === "function" ? options.csrfToken() : options.csrfToken;
    return value ? { "x-clank-csrf": value } : {};
  };
  const json = async <Value>(response: Response): Promise<Value> => {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = body.error as Record<string, unknown> | undefined;
      throw new BucketError(response.status, String(error?.code ?? "BUCKET_REQUEST_FAILED"), String(error?.message ?? response.statusText));
    }
    return body as Value;
  };
  return Object.freeze({
    async list(listOptions = {}) {
      const query = new URLSearchParams();
      if (listOptions.prefix !== undefined) query.set("prefix", listOptions.prefix);
      if (listOptions.cursor !== undefined) query.set("cursor", listOptions.cursor);
      if (listOptions.limit !== undefined) query.set("limit", String(listOptions.limit));
      return json<BucketListResult>(await request(`${endpoint}/objects?${query}`, { credentials: "same-origin" }));
    },
    async stat(key) {
      const result = await json<{ object: BucketObject | null }>(await request(
        `${endpoint}/object?key=${encodeURIComponent(key)}`,
        { credentials: "same-origin" },
      ));
      return result.object;
    },
    async upload(uploadOptions) {
      const bytes = uploadOptions.value instanceof Blob
        ? new Uint8Array(await uploadOptions.value.arrayBuffer())
        : copyBytes(uploadOptions.value);
      const contentType = uploadOptions.contentType
        ?? (uploadOptions.value instanceof Blob && uploadOptions.value.type ? uploadOptions.value.type : "application/octet-stream");
      const intent = await json<BucketUploadIntent>(await request(`${endpoint}/uploads`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({
          key: uploadOptions.key,
          size: bytes.byteLength,
          contentType,
          resumable: uploadOptions.resumable,
          expectedSha256: uploadOptions.expectedSha256,
        }),
      }));
      if (!intent.resumable) {
        const result = await json<{ object: BucketObject }>(await request(intent.url, {
          method: "PUT",
          headers: intent.headers,
          body: bytes,
        }));
        uploadOptions.onProgress?.(bytes.byteLength, bytes.byteLength);
        return result.object;
      }
      let offset = intent.offset;
      while (offset < bytes.byteLength) {
        const end = Math.min(bytes.byteLength, offset + intent.maxChunkBytes);
        const response = await request(intent.url, {
          method: "PATCH",
          headers: { ...intent.headers, "upload-offset": String(offset) },
          body: bytes.slice(offset, end),
        });
        if (end === bytes.byteLength) {
          const result = await json<{ object: BucketObject }>(response);
          uploadOptions.onProgress?.(end, bytes.byteLength);
          return result.object;
        }
        if (!response.ok) await json(response);
        offset = Number(response.headers.get("upload-offset"));
        uploadOptions.onProgress?.(offset, bytes.byteLength);
      }
      throw new BucketError(500, "UPLOAD_INCOMPLETE", "Upload did not complete.");
    },
    async delete(key, ifSha256) {
      const result = await json<{ deleted: boolean }>(await request(`${endpoint}/object?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { ...csrfHeaders(), ...(ifSha256 ? { "if-match": `\"${ifSha256}\"` } : {}) },
      }));
      return result.deleted;
    },
    async createReadIntent(key, expiresInMs) {
      return json<BucketReadIntent>(await request(`${endpoint}/read-intents`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, expiresInMs }),
      }));
    },
  });
}

export function createBucketMcpTools<Context = unknown>(
  manager: BucketManager,
  options: BucketMcpOptions<Context> = {},
): readonly McpTool<Context>[] {
  const identify = options.identity ?? defaultMcpIdentity;
  const maxInlineBytes = integer(options.maxInlineBytes ?? 1024 * 1024, "maxInlineBytes", 1, 10 * 1024 * 1024);
  const tools: McpTool<Context>[] = [];
  for (const definition of manager.definitions.values()) {
    const runtime = manager.bucket(definition.name);
    const prefix = `bucket_${definition.name.replaceAll("-", "_")}`;
    const identity = (context: Context) => identify(context);
    tools.push({
      name: `${prefix}_list`,
      title: `List ${definition.name} objects`,
      description: `Lists ${definition.description} Results are isolated to the authenticated owner when applicable.`,
      requiredScope: "agent:read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: objectSchema({ prefix: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      invoke(input, context) {
        const value = inputObject(input);
        return runtime.list({ ...identity(context), prefix: optionalString(value.prefix, "prefix"), cursor: optionalString(value.cursor, "cursor"), limit: optionalNumber(value.limit, "limit") });
      },
    }, {
      name: `${prefix}_read`,
      title: `Read a ${definition.name} object`,
      description: `Reads a bounded ${definition.name} object and returns base64 bytes plus verified metadata.`,
      requiredScope: "agent:read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: objectSchema({ key: { type: "string" } }, ["key"]),
      async invoke(input, context) {
        const value = inputObject(input);
        const stored = await runtime.get(requiredString(value.key, "key"), identity(context));
        if (!stored) return { object: null };
        if (stored.bytes.byteLength > maxInlineBytes) {
          return { object: stored.metadata, readIntent: await runtime.createReadIntent(stored.metadata.key, identity(context)) };
        }
        return { object: stored.metadata, base64: base64Standard(stored.bytes) };
      },
    }, {
      name: `${prefix}_put`,
      title: `Upload a ${definition.name} object`,
      description: `Creates or replaces a ${definition.name} object from base64 bytes with policy, quota, and integrity checks.`,
      requiredScope: "agent:write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: objectSchema({
        key: { type: "string" }, base64: { type: "string", maxLength: Math.ceil(maxInlineBytes * 4 / 3) + 4 },
        contentType: { type: "string" }, expectedSha256: { type: "string" }, ifSha256: { type: ["string", "null"] },
      }, ["key", "base64", "contentType"]),
      invoke(input, context) {
        const value = inputObject(input);
        const bytes = fromBase64Standard(requiredString(value.base64, "base64"), maxInlineBytes);
        return runtime.put(requiredString(value.key, "key"), bytes, {
          ...identity(context),
          contentType: requiredString(value.contentType, "contentType"),
          expectedSha256: optionalString(value.expectedSha256, "expectedSha256"),
          ifSha256: value.ifSha256 === null ? null : optionalString(value.ifSha256, "ifSha256"),
        });
      },
    }, {
      name: `${prefix}_delete`,
      title: `Delete a ${definition.name} object`,
      description: `Permanently deletes a ${definition.name} object.`,
      requiredScope: "agent:write",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: objectSchema({ key: { type: "string" }, ifSha256: { type: "string" } }, ["key"]),
      async invoke(input, context) {
        const value = inputObject(input);
        return { deleted: await runtime.delete(requiredString(value.key, "key"), {
          ...identity(context), ifSha256: optionalString(value.ifSha256, "ifSha256"),
        }) };
      },
    });
    if (definition.image && Object.keys(definition.image.variants).length > 0) {
      tools.push({
        name: `${prefix}_transform`,
        title: `Create a ${definition.name} image variant`,
        description: `Creates a declared image variant (${Object.keys(definition.image.variants).join(", ")}).`,
        requiredScope: "agent:write",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: objectSchema({ key: { type: "string" }, variant: { type: "string", enum: Object.keys(definition.image.variants) } }, ["key", "variant"]),
        invoke(input, context) {
          const value = inputObject(input);
          return runtime.transform(requiredString(value.key, "key"), requiredString(value.variant, "variant"), identity(context));
        },
      });
    }
  }
  return Object.freeze(tools.map((tool) => Object.freeze({
    ...tool,
    async invoke(input: unknown, context: Context, request: Request) {
      try {
        return await tool.invoke(input, context, request);
      } catch (error) {
        if (error instanceof BucketError) throw new McpToolError(error.code, error.message, error.details);
        throw error;
      }
    },
  })));
}

interface BucketStats {
  readonly size: number | bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface BucketFs {
  appendFile(path: string, value: Uint8Array, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<BucketStats>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  rm(path: string, options: { force: true }): Promise<void>;
  writeFile(path: string, value: Uint8Array, options: { flag: "wx"; mode: number }): Promise<void>;
}

interface BucketPath {
  dirname(path: string): string;
  join(...segments: string[]): string;
  resolve(...segments: string[]): string;
}

class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
  constructor(private readonly source: Map<Key, Value>) {}
  get size(): number { return this.source.size; }
  get(key: Key): Value | undefined { return this.source.get(key); }
  has(key: Key): boolean { return this.source.has(key); }
  entries(): MapIterator<[Key, Value]> { return this.source.entries(); }
  keys(): MapIterator<Key> { return this.source.keys(); }
  values(): MapIterator<Value> { return this.source.values(); }
  forEach(callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown): void {
    this.source.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return "ReadonlyMap"; }
}

function normalizeDefinitions(
  input: readonly BucketDefinition[] | Readonly<Record<string, BucketDefinition>>,
): ReadonlyMap<string, BucketDefinition> {
  const values = Array.isArray(input) ? input : Object.values(input ?? {});
  if (values.length === 0) throw new TypeError("At least one bucket definition is required.");
  if (values.length > 100) throw new TypeError("No more than 100 bucket definitions are allowed.");
  const map = new Map<string, BucketDefinition>();
  for (const raw of values) {
    if (!raw || typeof raw !== "object" || raw.protocol !== "clank-bucket/1") {
      throw new TypeError("Bucket definitions must be created with defineBucket().");
    }
    const definition = defineBucket({
      name: raw.name,
      description: raw.description,
      visibility: raw.visibility,
      ownership: raw.ownership,
      browserAccess: raw.browserAccess,
      allowedContentTypes: raw.allowedContentTypes,
      maxObjectBytes: raw.maxObjectBytes,
      maxObjects: raw.maxObjects,
      maxBytes: raw.maxBytes,
      perOwnerMaxObjects: raw.perOwnerMaxObjects,
      perOwnerMaxBytes: raw.perOwnerMaxBytes,
      cacheControl: raw.cacheControl,
      resumable: raw.resumable,
      maxChunkBytes: raw.maxChunkBytes,
      image: raw.image,
    });
    if (map.has(definition.name)) throw new TypeError(`Duplicate bucket definition: ${definition.name}.`);
    map.set(definition.name, definition);
  }
  return Object.freeze(new ReadonlyMapView(map));
}

function boundedName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new TypeError("Bucket names must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown) throw new TypeError(`${label} contains unknown field ${unknown}.`);
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,160}$/u.test(value)) {
    throw new BucketError(400, "INVALID_IDENTIFIER", `${label} is invalid.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} must be non-empty, bounded, and contain no control characters.`);
  }
  return normalized;
}

function enumValue<const Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as Value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function safeStoredInteger(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) throw new Error(`Stored ${label} is invalid.`);
  return Number(number);
}

function finiteNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new Error("Clock returned a non-finite timestamp.");
  return Math.floor(value);
}

function normalizeContentPatterns(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
    throw new TypeError("allowedContentTypes must contain between 1 and 100 media type patterns.");
  }
  const output = input.map((value) => {
    if (typeof value !== "string" || !CONTENT_PATTERN.test(value.toLowerCase())) {
      throw new TypeError("allowedContentTypes contains an invalid media type pattern.");
    }
    return value.toLowerCase();
  });
  if (new Set(output).size !== output.length) throw new TypeError("allowedContentTypes must be unique.");
  return Object.freeze(output);
}

function normalizeContentType(value: string): string {
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!CONTENT_TYPE.test(mediaType)) throw new BucketError(415, "INVALID_CONTENT_TYPE", "Content type is invalid.");
  return mediaType;
}

function allowedContentType(definition: BucketDefinition, value: string): string {
  const contentType = normalizeContentType(value);
  const [type, subtype] = contentType.split("/");
  const accepted = definition.allowedContentTypes.some((pattern) => {
    const [allowedType, allowedSubtype] = pattern.split("/");
    return (allowedType === "*" || allowedType === type) && (allowedSubtype === "*" || allowedSubtype === subtype);
  });
  if (!accepted) throw new BucketError(415, "CONTENT_TYPE_NOT_ALLOWED", "Content type is not allowed in this bucket.");
  return contentType;
}

function safeHeader(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is not a safe HTTP header value.`);
  }
  return value;
}

function safeBasePath(value: string): string {
  if (!/^\/[A-Za-z0-9/_-]{1,255}$/u.test(value) || value.includes("//") || value.endsWith("/")) {
    throw new TypeError("basePath must be an absolute, normalized URL path without a trailing slash.");
  }
  return value;
}

function safeOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("publicOrigin must be an absolute HTTP(S) origin."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("publicOrigin must be an absolute HTTP(S) origin without credentials or a path.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new TypeError("publicOrigin must use HTTPS outside loopback.");
  }
  return url.origin;
}

function humanize(name: string): string {
  return name.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("Object value must be a Uint8Array or ArrayBuffer.");
}

function bucketKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.startsWith("/") || value.endsWith("/")) {
    throw new BucketError(400, "INVALID_BUCKET_KEY", "Bucket key is invalid.");
  }
  const segments = value.split("/");
  if (segments.length > 32 || segments.some((segment) => !KEY_SEGMENT.test(segment) || segment === "." || segment === "..")) {
    throw new BucketError(400, "INVALID_BUCKET_KEY", "Bucket key contains an invalid path segment.");
  }
  return segments.join("/");
}

function bucketPrefix(value: unknown): string {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > 1_024 || value.startsWith("/")) {
    throw new BucketError(400, "INVALID_BUCKET_PREFIX", "Bucket prefix is invalid.");
  }
  const trailing = value.endsWith("/");
  const normalized = trailing ? value.slice(0, -1) : value;
  return `${bucketKey(normalized)}${trailing ? "/" : ""}`;
}

function likePrefix(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function storedSha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new BucketError(400, "INVALID_SHA256", "SHA-256 must be lowercase hexadecimal.");
  return value;
}

function parseStoredImage(value: string): BucketImageMetadata {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Stored image metadata is invalid."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored image metadata is invalid.");
  const raw = parsed as Record<string, unknown>;
  const format = enumValue(raw.format, ["png", "jpeg", "gif", "webp", "avif"], "stored image format");
  return Object.freeze({
    format,
    width: safeStoredInteger(raw.width, "image width"),
    height: safeStoredInteger(raw.height, "image height"),
  });
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function quotaError(definition: BucketDefinition, usage: BucketUsage, uploadBytes: number, owner: boolean): BucketError {
  return new BucketError(413, "BUCKET_QUOTA_EXCEEDED", `${owner ? "Owner" : "Bucket"} quota exceeded.`, {
    bucket: definition.name,
    uploadBytes,
    objects: usage.objects + usage.reservedObjects,
    bytes: usage.bytes + usage.reservedBytes,
    maxObjects: usage.maxObjects,
    maxBytes: usage.maxBytes,
  });
}

function encodeCursor(value: { updatedAt: number; id: string }): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function parseCursor(value: string): { updatedAt: number; id: string } {
  if (typeof value !== "string" || value.length > 512) throw new BucketError(400, "INVALID_CURSOR", "List cursor is invalid.");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(value))); }
  catch { throw new BucketError(400, "INVALID_CURSOR", "List cursor is invalid."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BucketError(400, "INVALID_CURSOR", "List cursor is invalid.");
  const raw = parsed as Record<string, unknown>;
  return { updatedAt: safeStoredInteger(raw.updatedAt, "cursor timestamp"), id: boundedId(raw.id, "cursor id") };
}

async function preparePrivateDirectory(fs: BucketFs, path: BucketPath, directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TypeError(`Unsafe bucket directory: ${directory}.`);
  await fs.chmod(directory, 0o700);
  const parent = path.dirname(directory);
  if (parent === directory) return;
}

async function assertSafeCatalogFile(fs: BucketFs, file: string, missingAllowed: boolean): Promise<void> {
  try {
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError(`Unsafe bucket catalog: ${file}.`);
  } catch (error) {
    if (missingAllowed && nodeCode(error) === "ENOENT") return;
    throw error;
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatFileSize(value: number): string {
  if (value < 1_024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1_024;
    unit = candidate;
    if (amount < 1_024) break;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
}

function stagingFile(path: BucketPath, root: string, id: string): string {
  return path.join(root, `${boundedId(id, "reservation id")}.upload`);
}

function assertSafeStagingFile(stats: BucketStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw new BucketError(500, "UPLOAD_STAGING_UNSAFE", "Upload staging file is unsafe.");
}

function nodeCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64Url(bytes: Uint8Array): string {
  return base64Standard(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url.");
  const bytes = fromBase64Standard(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4),
    16 * 1024,
  );
  // Reject alternate encodings whose unused trailing bits decode to the same
  // bytes. Capability URLs are security tokens and must have one canonical
  // representation so changing any token character always invalidates them.
  if (base64Url(bytes) !== value) throw new Error("Invalid base64url.");
  return bytes;
}

function base64Standard(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

function fromBase64Standard(value: string, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new BucketError(400, "INVALID_BASE64", "Base64 value is invalid or too large.");
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new BucketError(400, "INVALID_BASE64", "Base64 value is invalid."); }
  if (binary.length > maxBytes) throw new BucketError(413, "PAYLOAD_TOO_LARGE", "Decoded bytes exceed the inline limit.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) difference |= (left[index % Math.max(1, left.length)] ?? 0) ^ (right[index % Math.max(1, right.length)] ?? 0);
  return difference === 0;
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new BucketError(400, "INVALID_PATH", "Bucket URL path is invalid."); }
}

function objectHeaders(object: BucketObject): Headers {
  const filename = object.key.split("/").at(-1)!.replace(/[^A-Za-z0-9._+-]/gu, "_").slice(0, 128) || "download";
  return new Headers({
    "cache-control": object.cacheControl,
    "content-disposition": `${object.image ? "inline" : "attachment"}; filename=\"${filename}\"`,
    "content-length": String(object.size),
    "content-security-policy": "sandbox",
    "content-type": object.contentType,
    "etag": `\"${object.sha256}\"`,
    "x-content-type-options": "nosniff",
  });
}

function uploadHeaders(row: ReservationRow): Headers {
  return new Headers({
    "cache-control": "no-store",
    "upload-expires": new Date(safeStoredInteger(row.expires_at, "expiresAt")).toUTCString(),
    "upload-length": String(safeStoredInteger(row.size, "size")),
    "upload-offset": String(safeStoredInteger(row.received, "received")),
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function bucketErrorResponse(error: unknown, report: (error: unknown) => void): Response {
  if (error instanceof BucketError) return jsonResponse({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  if (error instanceof RequestInputError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof TypeError) return jsonResponse({ error: { code: "INVALID_INPUT", message: error.message } }, 400);
  report(error);
  return jsonResponse({ error: { code: "BUCKET_INTERNAL_ERROR", message: "Bucket request failed." } }, 500);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (normalizeContentType(request.headers.get("content-type") ?? "") !== "application/json") {
    throw new BucketError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json.");
  }
  const bytes = await readRequestBytes(request, 64 * 1024);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new BucketError(400, "INVALID_JSON", "Request body is not valid JSON."); }
  return inputObject(parsed);
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BucketError(400, "INVALID_INPUT", "Input must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new BucketError(400, "INVALID_INPUT", `${label} must be a string.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BucketError(400, "INVALID_INPUT", `${label} must be a number.`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requiredNumber(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new BucketError(400, "INVALID_INPUT", `${label} must be boolean.`);
  return value;
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

function defaultMcpIdentity(context: unknown): BucketIdentity {
  if (!context || typeof context !== "object" || Array.isArray(context)) return {};
  const raw = context as Record<string, unknown>;
  if (typeof raw.userId === "string") return { userId: raw.userId };
  if (raw.user && typeof raw.user === "object" && !Array.isArray(raw.user)
    && typeof (raw.user as Record<string, unknown>).id === "string") {
    return { userId: String((raw.user as Record<string, unknown>).id) };
  }
  return {};
}
