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
  /**
   * Stateful MCP sessions keep long-lived clients synchronized across rolling
   * deploys. A new server process does not recognize a prior process's session,
   * so compliant clients reinitialize and discover the current tool contract.
   */
  sessions?: false | {
    idleTimeoutMs?: number;
    heartbeatMs?: number;
    maxSessions?: number;
    maxStreamsPerSession?: number;
  };
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
  /** Notify connected stateful clients to refresh tools/list. */
  notifyToolsChanged(): void;
  handle(request: Request): Promise<Response>;
  close(): void;
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

interface McpSession {
  readonly id: string;
  readonly protocolVersion: string;
  readonly streams: Set<McpEventStream>;
  initialized: boolean;
  lastSeenAt: number;
  eventCursor: number;
}

interface McpEventStream {
  send(message: unknown): void;
  close(): void;
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
  const sessionOptions = options.sessions === false ? null : options.sessions ?? {};
  const sessionIdleTimeoutMs = sessionOptions
    ? positiveInteger(sessionOptions.idleTimeoutMs ?? 30 * 60 * 1_000, "sessions.idleTimeoutMs")
    : 0;
  const sessionHeartbeatMs = sessionOptions
    ? positiveInteger(sessionOptions.heartbeatMs ?? 15_000, "sessions.heartbeatMs")
    : 0;
  const maxSessions = sessionOptions
    ? positiveInteger(sessionOptions.maxSessions ?? 1_000, "sessions.maxSessions")
    : 0;
  const maxStreamsPerSession = sessionOptions
    ? positiveInteger(sessionOptions.maxStreamsPerSession ?? 2, "sessions.maxStreamsPerSession")
    : 0;
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

  const baseVersion = options.version ?? "1.0.0";
  const revision = contractRevision({
    server: {
      name: options.name,
      title: options.title,
      version: baseVersion,
      description: options.description,
      instructions: options.instructions,
    },
    tools: visibleTools().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      requiredScope: tool.requiredScope ?? "agent:read",
    })),
  });
  const serverVersion = revisionedVersion(baseVersion, revision);
  const sessions = new Map<string, McpSession>();
  let closed = false;

  const manifest = (scopes?: ReadonlySet<string>) => ({
    protocol: "mcp" as const,
    protocolVersion: MCP_PROTOCOL_VERSION,
    revision,
    server: {
      name: options.name,
      ...(options.title ? { title: options.title } : {}),
      version: serverVersion,
      baseVersion,
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

  const closeSession = (session: McpSession) => {
    sessions.delete(session.id);
    for (const stream of [...session.streams]) stream.close();
    session.streams.clear();
  };

  const pruneSessions = (now = Date.now()) => {
    for (const session of [...sessions.values()]) {
      if (session.streams.size === 0 && now - session.lastSeenAt >= sessionIdleTimeoutMs) {
        closeSession(session);
      }
    }
  };

  const createSession = (protocolVersion: string): McpSession | null => {
    pruneSessions();
    if (sessions.size >= maxSessions) return null;
    const session: McpSession = {
      id: randomSessionId(),
      protocolVersion,
      streams: new Set(),
      initialized: false,
      lastSeenAt: Date.now(),
      eventCursor: 0,
    };
    sessions.set(session.id, session);
    return session;
  };

  const sessionFrom = (request: Request): McpSession | undefined => {
    const id = request.headers.get("mcp-session-id");
    if (!id) return undefined;
    pruneSessions();
    const session = sessions.get(id);
    if (session) session.lastSeenAt = Date.now();
    return session;
  };

  const authenticate = async (
    request: Request,
    requiredScope: McpScope,
  ): Promise<McpAuthentication<Context> | Response | undefined> => {
    if (!options.authenticate) return undefined;
    const authenticated = await options.authenticate(request) ?? undefined;
    if (!authenticated) {
      return options.unauthorized?.(request, requiredScope)
        ?? defaultAuthorizationError(401, "invalid_token", "Authentication is required.");
    }
    if (!authenticated.scopes.has(requiredScope)) {
      return options.forbidden?.(request, requiredScope)
        ?? defaultAuthorizationError(403, "insufficient_scope", `Scope ${requiredScope} is required.`);
    }
    return authenticated;
  };

  const stamp = (response: Response): Response => {
    response.headers.set("x-clank-contract-revision", revision);
    return response;
  };

  const eventStream = (request: Request, session: McpSession): Response => {
    const encoder = new TextEncoder();
    let connection: McpEventStream | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const close = () => {
          if (!active) return;
          active = false;
          if (heartbeat) clearInterval(heartbeat);
          if (connection) session.streams.delete(connection);
          try { controller.close(); } catch { /* The transport already disconnected. */ }
        };
        const send = (message: unknown) => {
          if (!active) return;
          try {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              close();
              return;
            }
            session.eventCursor++;
            session.lastSeenAt = Date.now();
            controller.enqueue(encoder.encode(
              `id: ${revision}:${session.eventCursor}\ndata: ${JSON.stringify(message)}\n\n`,
            ));
          } catch {
            close();
          }
        };
        connection = { send, close };
        session.streams.add(connection);
        controller.enqueue(encoder.encode(`: clank contract ${revision}\nretry: 1000\n\n`));
        heartbeat = setInterval(() => {
          if (!active) return;
          try {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              close();
              return;
            }
            session.lastSeenAt = Date.now();
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          } catch {
            close();
          }
        }, sessionHeartbeatMs);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close();
      },
      cancel() {
        connection?.close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  };

  const server: McpServer<Context> = {
    tools: registry,
    revision,
    supportsToolListChanged: Boolean(sessionOptions),
    manifest,
    notifyToolsChanged() {
      if (!sessionOptions || closed) return;
      const notification = {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: {
          _meta: {
            "clank/contractRevision": revision,
          },
        },
      };
      for (const session of sessions.values()) {
        if (!session.initialized) continue;
        for (const stream of [...session.streams]) stream.send(notification);
      }
    },
    async handle(request) {
      if (closed) return stamp(rpcHttpError(503, null, -32603, "MCP server is closed."));
      if (!requestOriginAllowed(request, {
        allowedOrigins: options.allowedOrigins,
        requireOrigin: options.requireOrigin,
      })) {
        return stamp(rpcHttpError(403, null, -32000, "Origin is not allowed."));
      }
      if (request.method === "GET") {
        if (!sessionOptions) {
          return stamp(new Response(null, {
            status: 405,
            headers: {
              allow: "POST",
              "cache-control": "no-store",
            },
          }));
        }
        const sessionId = request.headers.get("mcp-session-id");
        if (!sessionId) {
          return stamp(rpcHttpError(400, null, -32600, "MCP-Session-Id is required."));
        }
        const authenticated = await authenticate(request, "agent:read");
        if (authenticated instanceof Response) return stamp(authenticated);
        const session = sessionFrom(request);
        if (!session) return stamp(rpcHttpError(404, null, -32001, "MCP session is no longer active."));
        if (!request.headers.get("accept")?.toLowerCase().includes("text/event-stream")) {
          return stamp(rpcHttpError(406, null, -32600, "Accept must include text/event-stream."));
        }
        if (session.streams.size >= maxStreamsPerSession) {
          return stamp(rpcHttpError(429, null, -32000, "MCP session stream limit reached."));
        }
        return stamp(eventStream(request, session));
      }
      if (request.method === "DELETE") {
        if (!sessionOptions) {
          return stamp(new Response(null, {
            status: 405,
            headers: {
              allow: "GET, POST",
              "cache-control": "no-store",
            },
          }));
        }
        const sessionId = request.headers.get("mcp-session-id");
        if (!sessionId) {
          return stamp(rpcHttpError(400, null, -32600, "MCP-Session-Id is required."));
        }
        const authenticated = await authenticate(request, "agent:read");
        if (authenticated instanceof Response) return stamp(authenticated);
        const session = sessionFrom(request);
        if (!session) return stamp(rpcHttpError(404, null, -32001, "MCP session is no longer active."));
        closeSession(session);
        return stamp(new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        }));
      }
      if (request.method !== "POST") {
        return stamp(new Response(null, {
          status: 405,
          headers: {
            allow: sessionOptions ? "GET, POST, DELETE" : "GET, POST",
            "cache-control": "no-store",
          },
        }));
      }

      let raw: unknown;
      try {
        raw = await readJsonRequest(request, maxRequestBytes);
      } catch (error) {
        if (error instanceof RequestInputError) {
          return stamp(rpcHttpError(error.status, null, -32700, error.code === "INVALID_JSON"
            ? "Parse error."
            : error.message));
        }
        return stamp(rpcHttpError(400, null, -32700, "Parse error."));
      }
      if (!isRecord(raw) || Array.isArray(raw)) {
        return stamp(rpcHttpError(400, null, -32600, "Invalid Request."));
      }
      const message = raw as JsonRpcMessage;
      const id = validId(message.id) ? message.id as JsonRpcId : null;
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || (!validId(message.id) && "id" in message)) {
        return stamp(rpcHttpError(400, id, -32600, "Invalid Request."));
      }
      const notification = !Object.hasOwn(message, "id");
      const suppliedSessionId = request.headers.get("mcp-session-id");
      if (message.method === "initialize" && suppliedSessionId) {
        return stamp(rpcHttpError(400, id, -32600, "Initialize must not include MCP-Session-Id."));
      }
      const requiredScope = requiredScopeFor(message, registry);
      const authenticated = await authenticate(request, requiredScope);
      if (authenticated instanceof Response) return stamp(authenticated);
      if (sessionOptions && message.method !== "initialize" && !suppliedSessionId) {
        return stamp(rpcHttpError(
          400,
          id,
          -32600,
          "MCP-Session-Id is required. Reinitialize the MCP connection.",
          {
            reason: "SESSION_REQUIRED",
            contractRevision: revision,
          },
        ));
      }
      const session = suppliedSessionId ? sessionFrom(request) : undefined;
      if (suppliedSessionId && !session) {
        return stamp(rpcHttpError(404, id, -32001, "MCP session is no longer active."));
      }
      const requestedProtocol = protocolFor(message, request, session?.protocolVersion);
      if (!requestedProtocol) {
        return stamp(rpcHttpError(400, id, -32600, "Unsupported MCP protocol version."));
      }
      if (session && requestedProtocol !== session.protocolVersion) {
        return stamp(rpcHttpError(400, id, -32600, "MCP protocol version does not match the active session."));
      }
      if (notification) {
        if (message.method === "notifications/initialized" && session) session.initialized = true;
        return stamp(notificationResponse(message.method));
      }

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
          Boolean(sessionOptions),
          revision,
        );
        let created: McpSession | undefined;
        if (message.method === "initialize" && sessionOptions) {
          created = createSession(requestedProtocol) ?? undefined;
          if (!created) {
            return stamp(rpcHttpError(503, id, -32000, "MCP session capacity reached."));
          }
        }
        return stamp(rpcResult(id, result, requestedProtocol, maxResponseBytes, created
          ? { "mcp-session-id": created.id }
          : undefined));
      } catch (error) {
        if (error instanceof RpcDispatchError) {
          return stamp(rpcHttpError(error.status, id, error.rpcCode, error.message, error.data));
        }
        return stamp(rpcHttpError(500, id, -32603, "Internal error."));
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const session of [...sessions.values()]) closeSession(session);
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
  listChanged = false,
  revision = manifest.revision,
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
        tools: { listChanged },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: manifest.server.name,
        ...(manifest.server.title ? { title: manifest.server.title } : {}),
        version: manifest.server.version,
        ...(manifest.server.description ? { description: manifest.server.description } : {}),
      },
      instructions: `${
        instructions
          ?? `Use tools/list to discover the application's typed server actions. ${manifest.server.description ?? ""}`.trim()
      } Contract revision: ${revision}.`,
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
    return {
      tools: visible.map(mcpToolDescriptor),
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "clank/contractRevision": revision,
      },
    };
  }
  if (method === "tools/call") {
    const input = recordParams(params);
    if (typeof input.name !== "string" || !isRecord(input.arguments ?? {})) {
      throw new RpcDispatchError(-32602, "Invalid tool call parameters.");
    }
    const tool = registry.get(input.name);
    if (!tool) {
      throw new RpcDispatchError(-32602, "Unknown tool. Refresh tools/list and retry.", 200, {
        reason: "TOOLS_CHANGED",
        contractRevision: revision,
        refreshMethod: "tools/list",
      });
    }
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
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "clank/contractRevision": revision,
      },
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
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "clank/contractRevision": revision,
      },
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

function protocolFor(
  message: JsonRpcMessage,
  request: Request,
  sessionProtocol?: string,
): string | null {
  if (message.method === "initialize" && isRecord(message.params)) {
    const requested = message.params.protocolVersion;
    if (typeof requested !== "string") return null;
    if (MCP_VERSION_SET.has(requested)) return requested;
    return MCP_PROTOCOL_VERSION;
  }
  const supplied = request.headers.get("mcp-protocol-version") ?? sessionProtocol ?? "2025-03-26";
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
  extraHeaders?: Record<string, string>,
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
      ...extraHeaders,
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

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `clank_session_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function revisionedVersion(baseVersion: string, revision: string): string {
  const suffix = `clank.${revision.slice("mcp-".length, "mcp-".length + 16)}`;
  const separator = baseVersion.includes("+") ? "." : "+";
  const available = 128 - separator.length - suffix.length;
  return `${baseVersion.slice(0, Math.max(1, available))}${separator}${suffix}`;
}

function contractRevision(value: unknown): string {
  const input = canonicalJson(value);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const parts = [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
  return `mcp-${parts.map((part) => part.toString(16).padStart(8, "0")).join("")}`;
}

function canonicalJson(value: unknown): string {
  const stack = new Set<object>();
  const normalize = (entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") return entry;
    if (stack.has(entry as object)) throw new TypeError("MCP contracts cannot contain circular data.");
    stack.add(entry as object);
    const normalized = Array.isArray(entry)
      ? entry.map(normalize)
      : Object.fromEntries(
        Object.keys(entry as Record<string, unknown>)
          .sort()
          .filter((key) => (entry as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, normalize((entry as Record<string, unknown>)[key])]),
      );
    stack.delete(entry as object);
    return normalized;
  };
  return JSON.stringify(normalize(value));
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
