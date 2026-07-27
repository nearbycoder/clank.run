export declare const MCP_PROTOCOL_VERSION = "2025-11-25";
export declare const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly ["2025-11-25", "2025-06-18", "2025-03-26"];
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
export interface McpTool<Context = unknown> {
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly annotations?: McpToolAnnotations;
    readonly requiredScope?: McpScope;
    invoke(input: unknown, context: Context, request: Request): unknown | Promise<unknown>;
}
export interface McpServerOptions<Context = unknown> {
    name: string;
    version?: string;
    title?: string;
    description?: string;
    instructions?: string;
    tools: readonly McpTool<Context>[];
    allowedOrigins?: readonly string[];
    requireOrigin?: boolean;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    authenticate?: (request: Request) => Promise<McpAuthentication<Context> | null>;
    unauthorized?: (request: Request, requiredScope: McpScope) => Response;
    forbidden?: (request: Request, requiredScope: McpScope) => Response;
}
export interface McpServer<Context = unknown> {
    readonly tools: ReadonlyMap<string, McpTool<Context>>;
    manifest(scopes?: ReadonlySet<string>): {
        protocol: "mcp";
        protocolVersion: typeof MCP_PROTOCOL_VERSION;
        server: {
            name: string;
            title?: string;
            version: string;
            description?: string;
        };
        tools: Array<{
            name: string;
            title?: string;
            description: string;
            inputSchema: Record<string, unknown>;
            outputSchema?: Record<string, unknown>;
            annotations?: McpToolAnnotations;
            requiredScope: McpScope;
        }>;
    };
    handle(request: Request): Promise<Response>;
}
export declare class McpToolError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    readonly name = "McpToolError";
    constructor(code: string, message: string, details?: unknown | undefined);
}
export declare function createMcpServer<Context = unknown>(options: McpServerOptions<Context>): McpServer<Context>;
