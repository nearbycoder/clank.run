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
    put(key: string, value: Uint8Array | ArrayBuffer, options?: {
        contentType?: string;
    }): Promise<ObjectMetadata>;
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
export declare class ObjectStoreError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/**
 * Opens an atomic, owner-only local object store. Each logical object is one
 * immutable envelope replaced with a same-directory rename, so metadata and
 * bytes cannot become different generations during concurrent reads.
 */
export declare function openLocalObjectStore(options: LocalObjectStoreOptions): Promise<ObjectStore>;
/**
 * Creates a zero-dependency S3-compatible object store using signed, hashed
 * single-chunk requests. It intentionally implements the portable object
 * subset rather than provider-specific bucket administration.
 */
export declare function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore;
