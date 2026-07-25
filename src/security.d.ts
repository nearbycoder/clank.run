/** Shared browser/server-safe security helpers used by Clank internals. */
/** Attaches adapter-authenticated network identity without trusting request headers. */
export declare function setTrustedClientAddress(request: Request, address: string): void;
/** Returns network identity attached by a trusted server adapter, when available. */
export declare function trustedClientAddress(request: Request): string | undefined;
/** Rejects executable URL schemes before they reach DOM properties or SSR attributes. */
export declare function assertSafeAttributeValue(tag: string, name: string, value: unknown): void;
export interface RequestOriginOptions {
    allowedOrigins?: readonly string[];
    requireOrigin?: boolean;
}
/** Applies exact-origin and Fetch Metadata checks without trusting CORS as authorization. */
export declare function requestOriginAllowed(request: Request, options?: RequestOriginOptions): boolean;
export declare class RequestInputError extends Error {
    readonly status: number;
    readonly code: string;
    readonly name = "RequestInputError";
    constructor(status: number, code: string, message: string);
}
export declare class ResponseBodyLimitError extends Error {
    readonly maxBytes: number;
    readonly name = "ResponseBodyLimitError";
    constructor(maxBytes: number);
}
/** Reads a request body without buffering beyond the configured byte limit. */
export declare function readRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array>;
/** Reads a response body without buffering beyond the configured byte limit. */
export declare function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array>;
/** Reads and parses a JSON body with a hard byte limit in any Fetch runtime. */
export declare function readJsonRequest(request: Request, maxBytes?: number): Promise<unknown>;
export declare function publicValidationIssues(issues: readonly {
    path: Array<string | number>;
    message: string;
    expected?: string;
}[]): Array<{
    path: Array<string | number>;
    message: string;
    expected?: string;
}>;
