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
/** Runs any Fetch-standard Clank app on Node's built-in HTTP server. */
export declare function serve(app: FetchApplication | ((request: Request) => Response | Promise<Response>), options?: ServeOptions): Promise<ServerHandle>;
/** Serves a directory through Fetch responses with traversal protection and streaming-friendly MIME headers. */
export declare function staticFiles(root: string, options?: StaticFilesOptions): FetchApplication;
