import {
  RequestInputError,
  readJsonRequest,
  requestOriginAllowed,
} from "./security.ts";

/** Latest stable MCP protocol revision implemented by Clank. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
] as const);

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
    server: { name: string; title?: string; version: string; description?: string };
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

export class McpToolError extends Error {
  readonly name = "McpToolError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const MCP_VERSION_SET = new Set<string>(MCP_SUPPORTED_PROTOCOL_VERSIONS);
const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export function createMcpServer<Context = unknown>(
  options: McpServerOptions<Context>,
): McpServer<Context> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(options.name)) {
    throw new TypeError("MCP server name must be a bounded programmatic identifier.");
  }
  boundedText(options.version ?? "1.0.0", "MCP server version", 128);
  if (options.title !== undefined) boundedText(options.title, "MCP server title", 256);
  if (options.description !== undefined) boundedText(options.description, "MCP server description", 16 * 1024);
  if (options.instructions !== undefined) boundedText(options.instructions, "MCP server instructions", 16 * 1024);
  const maxRequestBytes = positiveInteger(options.maxRequestBytes ?? 64 * 1024, "maxRequestBytes");
  const maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 4 * 1024 * 1024, "maxResponseBytes");
  const registry = new Map<string, McpTool<Context>>();
  for (const tool of options.tools) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(tool.name)) {
      throw new TypeError(`Invalid MCP tool name: ${tool.name}`);
    }
    if (registry.has(tool.name)) throw new TypeError(`Duplicate MCP tool: ${tool.name}`);
    if (!tool.inputSchema || tool.inputSchema.type !== "object") {
      throw new TypeError(`MCP tool ${tool.name} must use an object input schema.`);
    }
    if (tool.outputSchema && tool.outputSchema.type !== "object") {
      throw new TypeError(`MCP tool ${tool.name} must use an object output schema.`);
    }
    boundedText(tool.description, `MCP tool ${tool.name} description`, 16 * 1024);
    if (tool.title !== undefined) boundedText(tool.title, `MCP tool ${tool.name} title`, 256);
    if (tool.requiredScope !== undefined && !["agent:read", "agent:write"].includes(tool.requiredScope)) {
      throw new TypeError(`MCP tool ${tool.name} has an invalid required scope.`);
    }
    if (typeof tool.invoke !== "function") throw new TypeError(`MCP tool ${tool.name} requires an invoke function.`);
    registry.set(tool.name, Object.freeze({ ...tool }));
  }

  const visibleTools = (scopes?: ReadonlySet<string>) => [...registry.values()]
    .filter((tool) => !scopes || scopes.has(tool.requiredScope ?? "agent:read"))
    .sort((left, right) => left.name.localeCompare(right.name));

  const manifest = (scopes?: ReadonlySet<string>) => ({
    protocol: "mcp" as const,
    protocolVersion: MCP_PROTOCOL_VERSION,
    server: {
      name: options.name,
      ...(options.title ? { title: options.title } : {}),
      version: options.version ?? "1.0.0",
      ...(options.description ? { description: options.description } : {}),
    },
    tools: visibleTools(scopes).map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      requiredScope: tool.requiredScope ?? "agent:read" as McpScope,
    })),
  });

  const server: McpServer<Context> = {
    tools: registry,
    manifest,
    async handle(request) {
      if (!requestOriginAllowed(request, {
        allowedOrigins: options.allowedOrigins,
        requireOrigin: options.requireOrigin,
      })) {
        return rpcHttpError(403, null, -32000, "Origin is not allowed.");
      }
      if (request.method === "GET") {
        return new Response(null, {
          status: 405,
          headers: {
            allow: "POST",
            "cache-control": "no-store",
          },
        });
      }
      if (request.method !== "POST") {
        return new Response(null, {
          status: 405,
          headers: {
            allow: "GET, POST",
            "cache-control": "no-store",
          },
        });
      }

      let raw: unknown;
      try {
        raw = await readJsonRequest(request, maxRequestBytes);
      } catch (error) {
        if (error instanceof RequestInputError) {
          return rpcHttpError(error.status, null, -32700, error.code === "INVALID_JSON"
            ? "Parse error."
            : error.message);
        }
        return rpcHttpError(400, null, -32700, "Parse error.");
      }
      if (!isRecord(raw) || Array.isArray(raw)) {
        return rpcHttpError(400, null, -32600, "Invalid Request.");
      }
      const message = raw as JsonRpcMessage;
      const id = validId(message.id) ? message.id as JsonRpcId : null;
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || (!validId(message.id) && "id" in message)) {
        return rpcHttpError(400, id, -32600, "Invalid Request.");
      }
      const notification = !Object.hasOwn(message, "id");
      const requestedProtocol = protocolFor(message, request);
      if (!requestedProtocol) {
        return rpcHttpError(400, id, -32600, "Unsupported MCP protocol version.");
      }
      const requiredScope = requiredScopeFor(message, registry);
      let authenticated: McpAuthentication<Context> | undefined;
      if (options.authenticate) {
        authenticated = await options.authenticate(request) ?? undefined;
        if (!authenticated) {
          return options.unauthorized?.(request, requiredScope)
            ?? defaultAuthorizationError(401, "invalid_token", "Authentication is required.");
        }
        if (!authenticated.scopes.has(requiredScope)) {
          return options.forbidden?.(request, requiredScope)
            ?? defaultAuthorizationError(403, "insufficient_scope", `Scope ${requiredScope} is required.`);
        }
      }
      if (notification) return notificationResponse(message.method);

      try {
        const result = await dispatch(
          message.method,
          message.params,
          requestedProtocol,
          visibleTools(authenticated?.scopes),
          registry,
          authenticated?.context as Context,
          request,
          manifest(authenticated?.scopes),
          options.instructions,
        );
        return rpcResult(id, result, requestedProtocol, maxResponseBytes);
      } catch (error) {
        if (error instanceof RpcDispatchError) {
          return rpcHttpError(error.status, id, error.rpcCode, error.message, error.data);
        }
        return rpcHttpError(500, id, -32603, "Internal error.");
      }
    },
  };
  return server;
}

async function dispatch<Context>(
  method: string,
  params: unknown,
  protocolVersion: string,
  visible: readonly McpTool<Context>[],
  registry: ReadonlyMap<string, McpTool<Context>>,
  context: Context,
  request: Request,
  manifest: ReturnType<McpServer<Context>["manifest"]>,
  instructions?: string,
): Promise<unknown> {
  if (method === "initialize") {
    const input = recordParams(params);
    if (
      typeof input.protocolVersion !== "string"
      || !isRecord(input.capabilities)
      || !isRecord(input.clientInfo)
      || typeof input.clientInfo.name !== "string"
      || typeof input.clientInfo.version !== "string"
    ) throw new RpcDispatchError(-32602, "Invalid initialize parameters.");
    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: manifest.server.name,
        ...(manifest.server.title ? { title: manifest.server.title } : {}),
        version: manifest.server.version,
        ...(manifest.server.description ? { description: manifest.server.description } : {}),
      },
      instructions: instructions
        ?? `Use tools/list to discover the application's typed server actions. ${manifest.server.description ?? ""}`.trim(),
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") {
    if (params !== undefined) {
      const input = recordParams(params);
      if (input.cursor !== undefined && typeof input.cursor !== "string") {
        throw new RpcDispatchError(-32602, "Invalid tools/list cursor.");
      }
    }
    return { tools: visible.map(mcpToolDescriptor) };
  }
  if (method === "tools/call") {
    const input = recordParams(params);
    if (typeof input.name !== "string" || !isRecord(input.arguments ?? {})) {
      throw new RpcDispatchError(-32602, "Invalid tool call parameters.");
    }
    const tool = registry.get(input.name);
    if (!tool) throw new RpcDispatchError(-32602, "Unknown tool.");
    try {
      const output = await tool.invoke(input.arguments ?? {}, context, request);
      const structuredContent = isRecord(output)
        ? output
        : { value: output };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: false,
      };
    } catch (error) {
      const payload = error instanceof McpToolError
        ? {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          }
        : {
            ok: false,
            error: {
              code: "TOOL_FAILED",
              message: "The tool could not complete.",
            },
          };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true,
      };
    }
  }
  if (method === "resources/list") {
    return {
      resources: [{
        uri: "clank://actions",
        name: "Clank server action manifest",
        title: "Application actions",
        description: "Typed server actions, authorization requirements, and side-effect annotations.",
        mimeType: "application/json",
      }],
    };
  }
  if (method === "resources/read") {
    const input = recordParams(params);
    if (input.uri !== "clank://actions") throw new RpcDispatchError(-32602, "Unknown resource.");
    return {
      contents: [{
        uri: "clank://actions",
        mimeType: "application/json",
        text: JSON.stringify(manifest),
      }],
    };
  }
  throw new RpcDispatchError(-32601, "Method not found.", 404);
}

function mcpToolDescriptor<Context>(tool: McpTool<Context>): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: withJsonSchemaDialect(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: withJsonSchemaDialect(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

function withJsonSchemaDialect(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.$schema ? schema : { $schema: JSON_SCHEMA_2020_12, ...schema };
}

function requiredScopeFor<Context>(
  message: JsonRpcMessage,
  registry: ReadonlyMap<string, McpTool<Context>>,
): McpScope {
  if (message.method !== "tools/call" || !isRecord(message.params) || typeof message.params.name !== "string") {
    return "agent:read";
  }
  return registry.get(message.params.name)?.requiredScope ?? "agent:read";
}

function protocolFor(message: JsonRpcMessage, request: Request): string | null {
  if (message.method === "initialize" && isRecord(message.params)) {
    const requested = message.params.protocolVersion;
    if (typeof requested !== "string") return null;
    if (MCP_VERSION_SET.has(requested)) return requested;
    return MCP_PROTOCOL_VERSION;
  }
  const supplied = request.headers.get("mcp-protocol-version") ?? "2025-03-26";
  return MCP_VERSION_SET.has(supplied) ? supplied : null;
}

function notificationResponse(method: string): Response {
  if (
    method === "notifications/initialized"
    || method === "notifications/cancelled"
    || method.startsWith("notifications/")
  ) {
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}

function rpcResult(
  id: JsonRpcId,
  result: unknown,
  protocolVersion: string,
  maxBytes: number,
): Response {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    return rpcHttpError(500, id, -32603, "MCP response exceeded the configured limit.");
  }
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "mcp-protocol-version": protocolVersion,
      "x-content-type-options": "nosniff",
    },
  });
}

function rpcHttpError(
  status: number,
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function defaultAuthorizationError(status: 401 | 403, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, {
    status,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Bearer error="${error}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

function recordParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new RpcDispatchError(-32602, "Invalid parameters.");
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function boundedText(value: unknown, name: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be non-empty, bounded text without control characters.`);
  }
}

class RpcDispatchError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly status = 200,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
