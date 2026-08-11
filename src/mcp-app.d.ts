export type McpAppDisplayMode = "inline" | "fullscreen" | "pip";
export type McpAppTheme = "light" | "dark";
export interface McpAppContentModalities {
    readonly text?: Readonly<Record<string, never>>;
    readonly image?: Readonly<Record<string, never>>;
    readonly audio?: Readonly<Record<string, never>>;
    readonly resource?: Readonly<Record<string, never>>;
    readonly resourceLink?: Readonly<Record<string, never>>;
    readonly structuredContent?: Readonly<Record<string, never>>;
}
export interface McpAppHostContext {
    readonly [key: string]: unknown;
    readonly theme?: McpAppTheme;
    readonly toolInfo?: {
        readonly id?: string | number;
        readonly tool: Readonly<Record<string, unknown>>;
    };
    readonly displayMode?: McpAppDisplayMode;
    readonly availableDisplayModes?: readonly McpAppDisplayMode[];
    readonly locale?: string;
    readonly timeZone?: string;
    readonly userAgent?: string;
    readonly platform?: "web" | "desktop" | "mobile";
    readonly deviceCapabilities?: {
        readonly touch?: boolean;
        readonly hover?: boolean;
    };
    readonly styles?: {
        readonly variables?: Readonly<Record<string, string | undefined>>;
        readonly css?: {
            readonly fonts?: string;
        };
    };
    readonly containerDimensions?: {
        readonly width?: number;
        readonly maxWidth?: number;
        readonly height?: number;
        readonly maxHeight?: number;
    };
    readonly safeAreaInsets?: {
        readonly top: number;
        readonly right: number;
        readonly bottom: number;
        readonly left: number;
    };
}
export interface McpAppHostCapabilities {
    readonly [key: string]: unknown;
    readonly experimental?: Readonly<Record<string, object>>;
    readonly openLinks?: Readonly<Record<string, never>>;
    readonly downloadFile?: Readonly<Record<string, never>>;
    readonly serverTools?: {
        readonly listChanged?: boolean;
    };
    readonly serverResources?: {
        readonly listChanged?: boolean;
    };
    readonly logging?: Readonly<Record<string, never>>;
    readonly sandbox?: {
        readonly permissions?: Readonly<Record<string, Readonly<Record<string, never>>>>;
        readonly csp?: Readonly<Record<string, readonly string[]>>;
    };
    readonly updateModelContext?: McpAppContentModalities;
    readonly message?: McpAppContentModalities;
    readonly sampling?: {
        readonly tools?: Readonly<Record<string, never>>;
    };
}
export interface McpAppHost {
    readonly protocolVersion: string;
    readonly hostInfo: {
        readonly name: string;
        readonly version: string;
        readonly [key: string]: unknown;
    };
    readonly hostCapabilities: McpAppHostCapabilities;
    readonly hostContext: McpAppHostContext;
}
export interface McpAppClientOptions {
    readonly name: string;
    readonly version?: string;
    readonly availableDisplayModes?: readonly McpAppDisplayMode[];
    readonly requestTimeoutMs?: number;
    readonly onToolInput?: (input: Readonly<Record<string, unknown>>, partial: boolean) => void;
    readonly onToolResult?: (result: unknown) => void;
    readonly onToolCancelled?: (reason?: string) => void;
    readonly onHostContext?: (context: McpAppHostContext) => void;
    readonly onTeardown?: () => void | Promise<void>;
}
export interface McpAppMessageEvent {
    readonly data: unknown;
    readonly source?: unknown;
}
export interface McpAppMessageSource {
    addEventListener(type: "message", listener: (event: McpAppMessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: McpAppMessageEvent) => void): void;
}
export interface McpAppMessageTarget {
    postMessage(message: unknown, targetOrigin: string): void;
}
export interface McpAppClientEnvironment {
    readonly source: McpAppMessageSource;
    readonly target: McpAppMessageTarget;
}
export interface McpAppClient {
    readonly connected: boolean;
    readonly host: McpAppHost | null;
    readonly hostContext: McpAppHostContext;
    connect(): Promise<McpAppHost>;
    callTool(name: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
    readResource(uri: string): Promise<unknown>;
    openLink(url: string): Promise<unknown>;
    downloadFile(contents: readonly Readonly<Record<string, unknown>>[]): Promise<unknown>;
    sendMessage(content: string | readonly Readonly<Record<string, unknown>>[]): Promise<unknown>;
    updateModelContext(options: {
        content?: readonly Readonly<Record<string, unknown>>[];
        structuredContent?: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
    requestDisplayMode(mode: McpAppDisplayMode): Promise<McpAppDisplayMode>;
    sendSizeChanged(size: {
        width?: number;
        height?: number;
    }): void;
    requestTeardown(): void;
    close(reason?: string): void;
}
export interface McpAppDocumentOptions {
    readonly title: string;
    readonly body: string;
    readonly styles?: string;
    readonly script?: string;
    readonly language?: string;
}
export declare function createMcpAppClient(options: McpAppClientOptions, environment?: McpAppClientEnvironment): McpAppClient;
export declare function applyMcpAppTheme(context: McpAppHostContext, root?: Pick<HTMLElement, "dataset" | "style">): void;
export declare function mcpAppClientScript(): string;
export declare function createMcpAppDocument(options: McpAppDocumentOptions): string;
