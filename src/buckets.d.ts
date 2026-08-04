import type { McpTool } from "./mcp.js";
import type { ObjectStore } from "./object-storage.js";

export type BucketVisibility = "private" | "public";
export type BucketOwnership = "app" | "user";
export type BucketBrowserAccess = "authenticated" | "public" | "server";
export interface BucketImageVariant { readonly width: number; readonly height: number; readonly fit?: "cover" | "contain"; readonly format?: "original" | "png" | "jpeg" | "webp" | "avif"; readonly quality?: number; }
export interface BucketImagePolicy { readonly maxWidth?: number; readonly maxHeight?: number; readonly maxPixels?: number; readonly formats?: readonly ("png" | "jpeg" | "gif" | "webp" | "avif")[]; readonly variants?: Readonly<Record<string, BucketImageVariant>>; }
export interface BucketDefinitionInput {
  readonly name: string; readonly description?: string; readonly visibility?: BucketVisibility; readonly ownership?: BucketOwnership;
  readonly browserAccess?: BucketBrowserAccess; readonly allowedContentTypes?: readonly string[]; readonly maxObjectBytes?: number;
  readonly maxObjects?: number; readonly maxBytes?: number; readonly perOwnerMaxObjects?: number; readonly perOwnerMaxBytes?: number;
  readonly cacheControl?: string; readonly resumable?: boolean; readonly maxChunkBytes?: number; readonly image?: false | BucketImagePolicy;
}
export interface BucketDefinition {
  readonly protocol: "clank-bucket/1"; readonly name: string; readonly description: string; readonly visibility: BucketVisibility;
  readonly ownership: BucketOwnership; readonly browserAccess: BucketBrowserAccess; readonly allowedContentTypes: readonly string[];
  readonly maxObjectBytes: number; readonly maxObjects: number; readonly maxBytes: number; readonly perOwnerMaxObjects: number;
  readonly perOwnerMaxBytes: number; readonly cacheControl: string; readonly resumable: boolean; readonly maxChunkBytes: number;
  readonly image: false | Readonly<Required<Omit<BucketImagePolicy, "variants">> & { variants: Readonly<Record<string, Readonly<Required<BucketImageVariant>>>> }>;
}
export interface BucketImageMetadata { readonly format: "png" | "jpeg" | "gif" | "webp" | "avif"; readonly width: number; readonly height: number; }
export interface BucketObject {
  readonly id: string; readonly bucket: string; readonly key: string; readonly ownerId: string | null; readonly size: number;
  readonly sha256: string; readonly contentType: string; readonly visibility: BucketVisibility; readonly cacheControl: string;
  readonly createdAt: number; readonly updatedAt: number; readonly url: string | null; readonly image: BucketImageMetadata | null;
  readonly variantOf: string | null; readonly variant: string | null;
}
export interface BucketStoredObject { readonly metadata: BucketObject; readonly bytes: Uint8Array; }
export interface BucketUsage { readonly objects: number; readonly bytes: number; readonly reservedObjects: number; readonly reservedBytes: number; readonly maxObjects: number; readonly maxBytes: number; }
export interface BucketListResult { readonly objects: readonly BucketObject[]; readonly cursor: string | null; readonly usage: BucketUsage; }
export interface BucketIdentity { readonly userId?: string | null; }
export interface BucketPutOptions extends BucketIdentity { readonly contentType: string; readonly ifSha256?: string | null; readonly expectedSha256?: string; readonly variantOf?: string; readonly variant?: string; }
export interface BucketListOptions extends BucketIdentity { readonly prefix?: string; readonly cursor?: string; readonly limit?: number; }
export interface BucketUploadIntentInput extends BucketIdentity { readonly key: string; readonly size: number; readonly contentType: string; readonly resumable?: boolean; readonly expectedSha256?: string; readonly expiresInMs?: number; }
export interface BucketUploadIntent { readonly protocol: "clank-bucket-upload/1"; readonly bucket: string; readonly key: string; readonly method: "PUT" | "PATCH"; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly expiresAt: number; readonly resumable: boolean; readonly offset: number; readonly size: number; readonly maxChunkBytes: number; }
export interface BucketReadIntent { readonly protocol: "clank-bucket-read/1"; readonly bucket: string; readonly key: string; readonly url: string; readonly expiresAt: number; }
export interface BucketRequestContext extends BucketIdentity { readonly authenticated?: boolean; readonly verifyWrite?: () => void | Promise<void>; }
export interface BucketImageTransformInput { readonly bucket: BucketDefinition; readonly source: BucketStoredObject; readonly variant: string; readonly spec: Readonly<Required<BucketImageVariant>>; readonly signal?: AbortSignal; }
export interface BucketImageTransformOutput { readonly bytes: Uint8Array | ArrayBuffer; readonly contentType: string; }
export type BucketImageTransformer = (input: BucketImageTransformInput) => BucketImageTransformOutput | Promise<BucketImageTransformOutput>;
export interface OpenBucketManagerOptions { readonly definitions: readonly BucketDefinition[] | Readonly<Record<string, BucketDefinition>>; readonly store: ObjectStore; readonly databasePath: string; readonly stagingDirectory: string; readonly signingKey: string | Uint8Array; readonly basePath?: string; readonly publicOrigin?: string; readonly capabilityTtlMs?: number; readonly maxObjects?: number; readonly maxBytes?: number; readonly imageTransformer?: BucketImageTransformer; readonly now?: () => number; readonly onError?: (error: unknown) => void; }
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
export interface BucketManager { readonly basePath: string; readonly definitions: ReadonlyMap<string, BucketDefinition>; bucket(name: string): BucketRuntime; manifest(): readonly BucketDefinition[]; usage(): BucketUsage; handle(request: Request, context?: BucketRequestContext): Promise<Response>; sweep(): Promise<{ reservations: number; objects: number }>; close(): void; }
export interface BucketClientOptions { readonly basePath?: string; readonly fetch?: typeof fetch; readonly csrfToken?: string | (() => string | undefined); }
export interface BucketUploadOptions { readonly key: string; readonly value: Uint8Array | ArrayBuffer | Blob; readonly contentType?: string; readonly resumable?: boolean; readonly expectedSha256?: string; readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void; }
export interface BucketClient { list(options?: Omit<BucketListOptions, "userId">): Promise<BucketListResult>; stat(key: string): Promise<BucketObject | null>; upload(options: BucketUploadOptions): Promise<BucketObject>; delete(key: string, ifSha256?: string): Promise<boolean>; createReadIntent(key: string, expiresInMs?: number): Promise<BucketReadIntent>; }
export interface BucketMcpOptions<Context = unknown> { readonly identity?: (context: Context) => BucketIdentity; readonly maxInlineBytes?: number; }
export class BucketError extends Error { readonly name: "BucketError"; constructor(readonly status: number, readonly code: string, message: string, readonly details?: Readonly<Record<string, unknown>>); }
export function defineBucket(input: BucketDefinitionInput): BucketDefinition;
export function inspectBucketImage(value: Uint8Array | ArrayBuffer, claimedContentType?: string): BucketImageMetadata;
export function openBucketManager(options: OpenBucketManagerOptions): Promise<BucketManager>;
export function createBucketClient(name: string, options?: BucketClientOptions): BucketClient;
export function createBucketMcpTools<Context = unknown>(manager: BucketManager, options?: BucketMcpOptions<Context>): readonly McpTool<Context>[];
