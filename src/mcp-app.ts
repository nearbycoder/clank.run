import { MCP_APPS_PROTOCOL_VERSION } from "./mcp.ts";

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
    readonly css?: { readonly fonts?: string };
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
  readonly serverTools?: { readonly listChanged?: boolean };
  readonly serverResources?: { readonly listChanged?: boolean };
  readonly logging?: Readonly<Record<string, never>>;
  readonly sandbox?: {
    readonly permissions?: Readonly<Record<string, Readonly<Record<string, never>>>>;
    readonly csp?: Readonly<Record<string, readonly string[]>>;
  };
  readonly updateModelContext?: McpAppContentModalities;
  readonly message?: McpAppContentModalities;
  readonly sampling?: { readonly tools?: Readonly<Record<string, never>> };
}

export interface McpAppHost {
  readonly protocolVersion: string;
  readonly hostInfo: { readonly name: string; readonly version: string; readonly [key: string]: unknown };
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
  sendSizeChanged(size: { width?: number; height?: number }): void;
  requestTeardown(): void;
  close(reason?: string): void;
}

export interface McpAppDocumentOptions {
  readonly title: string;
  /** Trusted application-authored HTML inserted into body. */
  readonly body: string;
  /** Trusted application-authored CSS inserted into an inline style element. */
  readonly styles?: string;
  /** Trusted application-authored JavaScript with globalThis.ClankMcpApp available. */
  readonly script?: string;
  readonly language?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/**
 * Dependency-free MCP Apps view runtime. It speaks JSON-RPC to the host over
 * postMessage and deliberately accepts messages only from the configured
 * parent window.
 */
export function createMcpAppClient(
  options: McpAppClientOptions,
  environment: McpAppClientEnvironment = browserMcpAppEnvironment(),
): McpAppClient {
  bounded(options.name, "MCP app client name", 128);
  const version = options.version ?? "1.0.0";
  bounded(version, "MCP app client version", 128);
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5 * 60_000) {
    throw new TypeError("MCP app requestTimeoutMs must be an integer between 100 and 300000.");
  }
  const availableDisplayModes = options.availableDisplayModes === undefined
    ? ["inline"] as const
    : normalizedDisplayModes(options.availableDisplayModes);
  let nextId = 1;
  let closed = false;
  let connected = false;
  let connecting: Promise<McpAppHost> | undefined;
  let host: McpAppHost | null = null;
  let hostContext: McpAppHostContext = Object.freeze({});
  const pending = new Map<number, PendingRequest>();

  const post = (message: unknown) => environment.target.postMessage(message, "*");
  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pending.clear();
  };
  const request = (method: string, params: Readonly<Record<string, unknown>>, allowBeforeConnect = false) => {
    if (closed) return Promise.reject(new Error("MCP app client is closed."));
    if (!allowBeforeConnect && !connected) return Promise.reject(new Error("Connect the MCP app client before making requests."));
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP app request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      post({ jsonrpc: "2.0", id, method, params });
    });
  };
  const notify = (method: string, params: Readonly<Record<string, unknown>> = {}) => {
    if (closed) return;
    post({ jsonrpc: "2.0", method, params });
  };
  const respond = (id: string | number | null, result?: unknown, error?: { code: number; message: string }) => {
    post({ jsonrpc: "2.0", id, ...(error ? { error } : { result: result ?? {} }) });
  };

  const listener = (event: McpAppMessageEvent) => {
    if (closed || (event.source !== undefined && event.source !== environment.target)) return;
    if (!record(event.data) || event.data.jsonrpc !== "2.0") return;
    const message = event.data;
    if ((typeof message.id === "number" || typeof message.id === "string") && ("result" in message || "error" in message)) {
      if (typeof message.id !== "number") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (record(message.error) && typeof message.error.message === "string") {
        entry.reject(new Error(message.error.message));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const params = record(message.params) ? message.params : {};
    if (message.method === "ui/notifications/tool-input" || message.method === "ui/notifications/tool-input-partial") {
      options.onToolInput?.(
        record(params.arguments) ? Object.freeze({ ...params.arguments }) : Object.freeze({}),
        message.method.endsWith("partial"),
      );
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      options.onToolResult?.(params);
      return;
    }
    if (message.method === "ui/notifications/tool-cancelled") {
      options.onToolCancelled?.(typeof params.reason === "string" ? params.reason : undefined);
      return;
    }
    if (message.method === "ui/notifications/host-context-changed") {
      hostContext = Object.freeze({ ...hostContext, ...params });
      options.onHostContext?.(hostContext);
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string" || message.id === null) && message.method === "ping") {
      respond(message.id, {});
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string" || message.id === null) && message.method === "ui/resource-teardown") {
      Promise.resolve(options.onTeardown?.()).then(
        () => {
          respond(message.id, {});
          client.close("MCP app resource was torn down by the host.");
        },
        () => {
          respond(message.id, undefined, { code: -32603, message: "MCP app teardown failed." });
          client.close("MCP app resource teardown failed.");
        },
      );
      return;
    }
    if (typeof message.id === "number" || typeof message.id === "string" || message.id === null) {
      respond(message.id, undefined, { code: -32601, message: "Method not found." });
    }
  };
  environment.source.addEventListener("message", listener);

  const client: McpAppClient = {
    get connected() { return connected; },
    get host() { return host; },
    get hostContext() { return hostContext; },
    connect() {
      if (connecting) return connecting;
      connecting = request("ui/initialize", {
        appInfo: { name: options.name, version },
        appCapabilities: { availableDisplayModes },
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      }, true).then((value) => {
        if (
          !record(value)
          || value.protocolVersion !== MCP_APPS_PROTOCOL_VERSION
          || !record(value.hostInfo)
          || typeof value.hostInfo.name !== "string"
          || typeof value.hostInfo.version !== "string"
          || !record(value.hostCapabilities)
          || !record(value.hostContext)
        ) {
          throw new Error("The MCP host returned an invalid or unsupported initialization result.");
        }
        hostContext = Object.freeze({ ...value.hostContext });
        host = Object.freeze({
          ...value,
          hostInfo: Object.freeze({ ...value.hostInfo }) as McpAppHost["hostInfo"],
          hostCapabilities: Object.freeze({ ...value.hostCapabilities }),
          hostContext,
        }) as McpAppHost;
        connected = true;
        notify("ui/notifications/initialized");
        options.onHostContext?.(hostContext);
        return host;
      }).catch((error) => {
        connecting = undefined;
        throw error;
      });
      return connecting;
    },
    callTool(name, args = {}) {
      bounded(name, "MCP app tool name", 128);
      if (!record(args)) return Promise.reject(new TypeError("MCP app tool arguments must be an object."));
      return request("tools/call", { name, arguments: args });
    },
    readResource(uri) {
      bounded(uri, "MCP app resource URI", 2_048);
      return request("resources/read", { uri });
    },
    openLink(url) {
      bounded(url, "MCP app link URL", 2_048);
      let parsed: URL;
      try { parsed = new URL(url); } catch { return Promise.reject(new TypeError("MCP app links must be valid URLs.")); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return Promise.reject(new TypeError("MCP app links must use http or https."));
      }
      return request("ui/open-link", { url: parsed.href });
    },
    downloadFile(contents) {
      if (!Array.isArray(contents) || contents.length === 0 || contents.some((entry) => !record(entry))) {
        return Promise.reject(new TypeError("MCP app downloads require at least one resource content object."));
      }
      return request("ui/download-file", { contents: [...contents] });
    },
    sendMessage(content) {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
      if (blocks.length === 0 || blocks.some((entry) => !record(entry))) {
        return Promise.reject(new TypeError("MCP app messages require content blocks."));
      }
      return request("ui/message", { role: "user", content: blocks });
    },
    updateModelContext(value) {
      if (!record(value)) return Promise.reject(new TypeError("MCP app model context must be an object."));
      return request("ui/update-model-context", value);
    },
    async requestDisplayMode(mode) {
      if (!(["inline", "fullscreen", "pip"] as const).includes(mode)) {
        throw new TypeError("MCP app display mode must be inline, fullscreen, or pip.");
      }
      if (!availableDisplayModes.includes(mode)) {
        throw new TypeError(`MCP app display mode ${mode} was not declared during initialization.`);
      }
      if (
        Array.isArray(hostContext.availableDisplayModes)
        && !hostContext.availableDisplayModes.includes(mode)
      ) {
        throw new Error(`MCP app display mode ${mode} is not available from this host.`);
      }
      const result = await request("ui/request-display-mode", { mode });
      if (!record(result) || !(["inline", "fullscreen", "pip"] as const).includes(result.mode)) {
        throw new Error("The MCP host returned an invalid display mode.");
      }
      return result.mode;
    },
    sendSizeChanged(size) {
      if (!record(size) || (size.width === undefined && size.height === undefined)) {
        throw new TypeError("MCP app size changes require a width or height.");
      }
      for (const value of [size.width, size.height]) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          throw new TypeError("MCP app dimensions must be finite non-negative numbers.");
        }
      }
      notify("ui/notifications/size-changed", size);
    },
    requestTeardown() {
      notify("ui/notifications/request-teardown");
    },
    close(reason = "MCP app client was closed.") {
      if (closed) return;
      closed = true;
      connected = false;
      environment.source.removeEventListener("message", listener);
      rejectPending(reason);
    },
  };
  return client;
}

/** Apply host theme tokens without allowing arbitrary non-variable CSS writes. */
export function applyMcpAppTheme(
  context: McpAppHostContext,
  root: Pick<HTMLElement, "dataset" | "style"> = document.documentElement,
): void {
  if (context.theme) root.dataset.mcpTheme = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (!/^--(?:color|font|border|shadow)-[a-z0-9-]+$/u.test(name)) continue;
    if (typeof value === "string") root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}

/**
 * Return a standalone browser runtime for raw MCP App HTML. This lets Clank
 * views remain one immutable resource without a CDN, bundler, or npm install.
 */
export function mcpAppClientScript(): string {
  return [
    `"use strict";const MCP_APPS_PROTOCOL_VERSION=${JSON.stringify(MCP_APPS_PROTOCOL_VERSION)};`,
    `${browserMcpAppEnvironment.toString()};`,
    `${normalizedDisplayModes.toString()};`,
    `${bounded.toString()};`,
    `${record.toString()};`,
    `${createMcpAppClient.toString()};`,
    `${applyMcpAppTheme.toString()};`,
    "globalThis.ClankMcpApp=Object.freeze({createMcpAppClient,applyMcpAppTheme,MCP_APPS_PROTOCOL_VERSION});",
  ].join("");
}

/** Build a complete, dependency-free HTML5 resource with the Clank view runtime inlined. */
export function createMcpAppDocument(options: McpAppDocumentOptions): string {
  bounded(options.title, "MCP app document title", 256);
  boundedSource(options.body, "MCP app document body", 2 * 1024 * 1024);
  if (options.styles !== undefined) boundedSource(options.styles, "MCP app document styles", 512 * 1024);
  if (options.script !== undefined) boundedSource(options.script, "MCP app document script", 1024 * 1024);
  const language = options.language ?? "en";
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) {
    throw new TypeError("MCP app document language must be a BCP 47 language tag.");
  }
  const style = options.styles === undefined ? "" : `<style>${safeInlineElement(options.styles, "style")}</style>`;
  const script = options.script === undefined ? "" : `<script>${safeInlineElement(options.script, "script")}</script>`;
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${htmlText(options.title)}</title>${style}</head><body>${options.body}<script>${safeInlineElement(mcpAppClientScript(), "script")}</script>${script}</body></html>`;
}

function browserMcpAppEnvironment(): McpAppClientEnvironment {
  if (typeof window === "undefined" || !window.parent) {
    throw new Error("createMcpAppClient requires a browser iframe or an explicit message environment.");
  }
  return { source: window, target: window.parent };
}

function normalizedDisplayModes(modes: readonly McpAppDisplayMode[]): readonly McpAppDisplayMode[] {
  if (
    !Array.isArray(modes)
    || modes.length === 0
    || modes.length > 3
    || modes.some((mode) => !(["inline", "fullscreen", "pip"] as const).includes(mode))
    || new Set(modes).size !== modes.length
  ) {
    throw new TypeError("MCP app availableDisplayModes must contain unique supported modes.");
  }
  return Object.freeze([...modes]);
}

function bounded(value: unknown, name: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be non-empty, bounded text without control characters.`);
  }
}

function boundedSource(value: unknown, name: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be non-empty, bounded source text without unsafe control characters.`);
  }
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function htmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeInlineElement(value: string, element: "script" | "style"): string {
  return value.replace(new RegExp(`</${element}`, "giu"), `<\\/${element}`);
}
