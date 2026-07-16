type SegmentParams<Segment extends string> = Segment extends `:${infer Name}?` ? {
    [Key in Name]?: string;
} : Segment extends `:${infer Name}` ? {
    [Key in Name]: string;
} : Segment extends "*" ? {
    wildcard: string;
} : {};
export type RouteParams<Path extends string> = string extends Path ? Record<string, string> : Path extends `${infer Segment}/${infer Rest}` ? SegmentParams<Segment> & RouteParams<Rest> : SegmentParams<Path>;
export interface RequestContext<Path extends string = string, State extends Record<string, unknown> = Record<string, unknown>> {
    request: Request;
    url: URL;
    params: RouteParams<Path>;
    state: State;
}
export type RequestHandler<Path extends string = string, State extends Record<string, unknown> = Record<string, unknown>> = (context: RequestContext<Path, State>) => Response | Promise<Response>;
export type Middleware<State extends Record<string, unknown> = Record<string, unknown>> = (context: RequestContext<string, State>, next: () => Promise<Response>) => Response | Promise<Response>;
export interface CreateAppOptions {
    exposeErrors?: boolean;
    onError?: (error: unknown, context: RequestContext<string, any>) => void;
}
export interface RequestApp<State extends Record<string, unknown> = Record<string, unknown>> {
    use(middleware: Middleware<State>): RequestApp<State>;
    route<const Path extends string>(method: string, path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
    get<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
    post<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
    put<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
    patch<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
    delete<const Path extends string>(path: Path, handler: RequestHandler<Path, State>): RequestApp<State>;
    handle(request: Request): Promise<Response>;
}
export declare function createApp<State extends Record<string, unknown> = Record<string, unknown>>(options?: CreateAppOptions): RequestApp<State>;
export declare function json(value: unknown, init?: ResponseInit): Response;
export declare function text(value: string, init?: ResponseInit): Response;
export declare function html(value: string, init?: ResponseInit): Response;
export type CorsOrigin = string | readonly string[] | ((origin: string | null, request: Request) => string | null);
export declare function cors<State extends Record<string, unknown> = Record<string, unknown>>(options?: {
    origin?: CorsOrigin;
    methods?: string[];
    headers?: string[];
    credentials?: boolean;
}): Middleware<State>;
export interface SecurityHeadersOptions {
    contentSecurityPolicy?: string | false;
    crossOriginOpenerPolicy?: string | false;
    frameOptions?: string | false;
    permissionsPolicy?: string | false;
    referrerPolicy?: string | false;
}
/** Secure response defaults that generated applications can install with one middleware call. */
export declare function securityHeaders<State extends Record<string, unknown> = Record<string, unknown>>(options?: SecurityHeadersOptions): Middleware<State>;
export declare function logger<State extends Record<string, unknown> = Record<string, unknown>>(write?: (message: string) => void): Middleware<State>;
export {};
