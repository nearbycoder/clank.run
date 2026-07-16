/** Shared browser/server-safe security helpers used by Clank internals. */
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
