export declare const MCP_PROTOCOL_VERSION = "2026-07-28";
export declare const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
export declare const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export declare const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export declare const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
export type McpScope = "agent:read" | "agent:write";
export interface McpAuthentication<Context = unknown> {
    readonly context: Context;
    readonly scopes: ReadonlySet<string>;
}
export interface McpToolAnnotations {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}
export type McpAppVisibility = "model" | "app";
export interface McpAppCsp {
    readonly connectDomains?: readonly string[];
    readonly resourceDomains?: readonly string[];
    readonly frameDomains?: readonly string[];
    readonly baseUriDomains?: readonly string[];
}
export interface McpAppPermissions {
    readonly camera?: Readonly<Record<string, never>>;
    readonly microphone?: Readonly<Record<string, never>>;
    readonly geolocation?: Readonly<Record<string, never>>;
    readonly clipboardWrite?: Readonly<Record<string, never>>;
}
export interface McpAppDefinition {
    readonly uri: `ui://${string}`;
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly html: string;
    readonly csp?: McpAppCsp;
    readonly permissions?: McpAppPermissions;
    readonly domain?: string;
    readonly prefersBorder?: boolean;
}
export interface McpToolApp {
    readonly resourceUri: `ui://${string}`;
    readonly visibility?: readonly McpAppVisibility[];
}
export declare function defineMcpApp<const App extends McpAppDefinition>(app: App): Readonly<App>;
export interface McpTool<Context = unknown> {
    readonly name: string;
    readonly actionPath?: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly annotations?: McpToolAnnotations;
    readonly app?: McpToolApp;
    readonly requiredScope?: McpScope;
    invoke(input: unknown, context: Context, request: Request): unknown | Promise<unknown>;
}
export interface McpServerOptions<Context = unknown> {
    name: string;
    version?: string;
    title?: string;
    description?: string;
    instructions?: string;
    metadata?: Readonly<Record<string, unknown>>;
    apps?: readonly McpAppDefinition[];
    tools: readonly McpTool<Context>[];
    sessions?: false | {
        idleTimeoutMs?: number;
        heartbeatMs?: number;
        maxSessions?: number;
        maxStreamsPerSession?: number;
    };
    allowedOrigins?: readonly string[];
    requireOrigin?: boolean;
    browserCors?: boolean;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    authenticate?: (request: Request) => Promise<McpAuthentication<Context> | null>;
    unauthorized?: (request: Request, requiredScope: McpScope) => Response;
    forbidden?: (request: Request, requiredScope: McpScope) => Response;
}
export interface McpServer<Context = unknown> {
    readonly tools: ReadonlyMap<string, McpTool<Context>>;
    readonly apps: ReadonlyMap<string, McpAppDefinition>;
    readonly revision: string;
    readonly supportsToolListChanged: boolean;
    manifest(scopes?: ReadonlySet<string>): {
        protocol: "mcp";
        protocolVersion: typeof MCP_PROTOCOL_VERSION;
        revision: string;
        server: {
            name: string;
            title?: string;
            version: string;
            baseVersion: string;
            description?: string;
        };
        metadata?: Readonly<Record<string, unknown>>;
        tools: Array<{
            name: string;
            actionPath?: string;
            title?: string;
            description: string;
            inputSchema: Record<string, unknown>;
            outputSchema?: Record<string, unknown>;
            annotations?: McpToolAnnotations;
            app?: McpToolApp;
            requiredScope: McpScope;
        }>;
        apps: Array<{
            uri: `ui://${string}`;
            name: string;
            title?: string;
            description?: string;
            mimeType: typeof MCP_APP_MIME_TYPE;
            csp?: McpAppCsp;
            permissions?: McpAppPermissions;
            domain?: string;
            prefersBorder?: boolean;
        }>;
    };
    notifyToolsChanged(): void;
    handle(request: Request): Promise<Response>;
    close(): void;
}
export declare class McpToolError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    readonly name = "McpToolError";
    constructor(code: string, message: string, details?: unknown | undefined);
}
export declare function portableMcpToolNames(names: readonly string[]): readonly string[];
export declare function createMcpServer<Context = unknown>(options: McpServerOptions<Context>): McpServer<Context>;
