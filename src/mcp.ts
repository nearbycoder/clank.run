import {
  RequestInputError,
  readJsonRequest,
  requestOriginAllowed,
} from "./security.ts";

/** Latest stable MCP protocol revision implemented by Clank. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PROTOCOL_VERSION,
  "2025-11-25",
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
  /** Original application action path when the public MCP name is normalized for client portability. */
  readonly actionPath?: string;
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
  /** Additional bounded, immutable contract data exposed by clank://actions. */
  metadata?: Readonly<Record<string, unknown>>;
  tools: readonly McpTool<Context>[];
  /**
   * Compatibility settings for initialization-based MCP revisions through
   * 2025-11-25. MCP 2026-07-28 requests are always stateless and ignore these
   * settings.
   */
  sessions?: false | {
    idleTimeoutMs?: number;
    heartbeatMs?: number;
    maxSessions?: number;
    maxStreamsPerSession?: number;
  };
  allowedOrigins?: readonly string[];
  requireOrigin?: boolean;
  /**
   * Allow credential-free browser clients to call this MCP transport from
   * another origin. Authentication still requires an explicit bearer token;
   * cookies are never enabled by this option.
   */
  browserCors?: boolean;
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
    metadata?: Readonly<Record<string, unknown>>;
    tools: Array<{
      name: string;
      actionPath?: string;
      title?: string;
      description: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      annotations?: McpToolAnnotations;
      requiredScope: McpScope;
    }>;
  };
  /** Notify connected legacy clients to refresh tools/list. */
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

interface McpHeaderBinding {
  readonly headerName: string;
  readonly path: readonly string[];
  readonly type: "string" | "integer" | "boolean";
}

const MCP_LEGACY_VERSION_SET = new Set<string>(MCP_SUPPORTED_PROTOCOL_VERSIONS.slice(1));
const MCP_HEADER_MISMATCH = -32020;
const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;
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
  const metadata = options.metadata === undefined
    ? undefined
    : normalizedContractMetadata(options.metadata);
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
  const headerBindings = new Map<string, readonly McpHeaderBinding[]>();
  const portableNames = portableMcpToolNames(options.tools.map((tool) => tool.name));
  for (const [index, tool] of options.tools.entries()) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(tool.name)) {
      throw new TypeError(`Invalid MCP tool name: ${tool.name}`);
    }
    const publicName = portableNames[index]!;
    if (registry.has(publicName)) throw new TypeError(`Duplicate MCP tool: ${tool.name}`);
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
    const registered = Object.freeze({
      ...tool,
      name: publicName,
      ...(tool.actionPath || tool.name !== publicName ? { actionPath: tool.actionPath ?? tool.name } : {}),
    });
    headerBindings.set(publicName, mcpHeaderBindings(tool.inputSchema, publicName));
    registry.set(publicName, registered);
  }

  const visibleTools = (scopes?: ReadonlySet<string>) => [...registry.values()]
    .filter((tool) => !scopes || scopes.has(tool.requiredScope ?? "agent:read"))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const baseVersion = options.version ?? "1.0.0";
  const revision = contractRevision({
    server: {
      name: options.name,
      title: options.title,
      version: baseVersion,
      description: options.description,
      instructions: options.instructions,
    },
    metadata,
    tools: visibleTools().map((tool) => ({
      name: tool.name,
      actionPath: tool.actionPath,
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
    ...(metadata ? { metadata } : {}),
    tools: visibleTools(scopes).map((tool) => ({
      name: tool.name,
      ...(tool.actionPath ? { actionPath: tool.actionPath } : {}),
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
    if (options.browserCors) {
      response.headers.set("access-control-allow-origin", "*");
      response.headers.set(
        "access-control-expose-headers",
        "mcp-protocol-version, mcp-session-id, www-authenticate, x-clank-contract-revision",
      );
    }
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
      if (options.browserCors && request.method === "OPTIONS") {
        return stamp(browserCorsPreflight(request));
      }
      if (!options.browserCors && !requestOriginAllowed(request, {
        allowedOrigins: options.allowedOrigins,
        requireOrigin: options.requireOrigin,
      })) {
        return stamp(rpcHttpError(403, null, -32000, "Origin is not allowed."));
      }
      const envelopeProtocol = request.headers.get("mcp-protocol-version");
      if (request.method === "GET") {
        if (!sessionOptions || envelopeProtocol === MCP_PROTOCOL_VERSION) {
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
        if (!sessionOptions || envelopeProtocol === MCP_PROTOCOL_VERSION) {
          return stamp(new Response(null, {
            status: 405,
            headers: {
              allow: envelopeProtocol === MCP_PROTOCOL_VERSION ? "POST" : "GET, POST",
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
      const modern = modernRequest(message, request);
      const suppliedSessionId = request.headers.get("mcp-session-id");
      let requestedProtocol: string;
      if (modern) {
        const validation = validateModernRequest(
          message,
          request,
          notification,
          headerBindings,
        );
        if (validation instanceof Response) return stamp(validation);
        requestedProtocol = validation;
      } else {
        const legacyProtocol = legacyProtocolFor(message, request, undefined);
        if (!legacyProtocol) {
          return stamp(rpcHttpError(400, id, -32600, "Unsupported MCP protocol version."));
        }
        requestedProtocol = legacyProtocol;
      }
      if (!modern && message.method === "initialize" && suppliedSessionId) {
        return stamp(rpcHttpError(400, id, -32600, "Initialize must not include MCP-Session-Id."));
      }
      const requiredScope = requiredScopeFor(message, registry);
      const authenticated = await authenticate(request, requiredScope);
      if (authenticated instanceof Response) return stamp(authenticated);
      if (!modern && sessionOptions && message.method !== "initialize" && !suppliedSessionId) {
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
      const session = !modern && suppliedSessionId ? sessionFrom(request) : undefined;
      if (!modern && suppliedSessionId && !session) {
        return stamp(rpcHttpError(404, id, -32001, "MCP session is no longer active."));
      }
      if (!modern) {
        const sessionProtocol = legacyProtocolFor(message, request, session?.protocolVersion);
        if (!sessionProtocol) {
          return stamp(rpcHttpError(400, id, -32600, "Unsupported MCP protocol version."));
        }
        requestedProtocol = sessionProtocol;
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
          modern,
        );
        let created: McpSession | undefined;
        if (!modern && message.method === "initialize" && sessionOptions) {
          created = createSession(requestedProtocol) ?? undefined;
          if (!created) {
            return stamp(rpcHttpError(503, id, -32000, "MCP session capacity reached."));
          }
        }
        const responseResult = modern
          ? modernResult(result, manifest(authenticated?.scopes))
          : result;
        return stamp(rpcResult(id, responseResult, requestedProtocol, maxResponseBytes, created
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
  modern = false,
): Promise<unknown> {
  if (modern && method === "server/discover") {
    recordParams(params);
    return {
      supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: `${
        instructions
          ?? `Use tools/list to discover the application's typed server actions. ${manifest.server.description ?? ""}`.trim()
      } Contract revision: ${revision}.`,
      ttlMs: 0,
      cacheScope: "private",
    };
  }
  if (!modern && method === "initialize") {
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
  if (!modern && method === "ping") return {};
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
    ...(tool.actionPath ? { _meta: { "clank/actionPath": tool.actionPath } } : {}),
  };
}

/**
 * Converts logical action paths into names accepted by strict MCP/model clients.
 * Readable names use underscores; overlong or colliding names receive a stable
 * contract-derived suffix while remaining within Anthropic's 64-character limit.
 */
export function portableMcpToolNames(names: readonly string[]): readonly string[] {
  const readable = names.map((name) => name.replace(/[.-]/gu, "_"));
  const counts = new Map<string, number>();
  for (const name of readable) counts.set(name, (counts.get(name) ?? 0) + 1);
  const output = names.map((source, index) => {
    const candidate = readable[index]!;
    if (candidate.length <= 64 && counts.get(candidate) === 1) return candidate;
    const suffix = contractRevision({ tool: source }).slice("mcp-".length, "mcp-".length + 16);
    return `${candidate.slice(0, 47)}_${suffix}`;
  });
  const unique = new Set(output);
  if (unique.size !== output.length) {
    throw new TypeError("MCP tool names collide after portable normalization.");
  }
  for (const name of output) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) {
      throw new TypeError(`Invalid portable MCP tool name: ${name}`);
    }
  }
  return Object.freeze(output);
}

function withJsonSchemaDialect(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.$schema ? schema : { $schema: JSON_SCHEMA_2020_12, ...schema };
}

function mcpHeaderBindings(
  schema: Record<string, unknown>,
  toolName: string,
): readonly McpHeaderBinding[] {
  const bindings: McpHeaderBinding[] = [];
  const used = new Set<string>();
  const stack = new Set<object>();
  const visit = (node: unknown, path: string[], staticallyReachable: boolean): void => {
    if (!isRecord(node)) return;
    if (stack.has(node)) throw new TypeError(`MCP tool ${toolName} has a circular input schema.`);
    stack.add(node);
    if (Object.hasOwn(node, "x-mcp-header")) {
      const suffix = node["x-mcp-header"];
      const type = node.type;
      if (
        !staticallyReachable
        || path.length === 0
        || typeof suffix !== "string"
        || !suffix
        || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(suffix)
        || (type !== "string" && type !== "integer" && type !== "boolean")
      ) {
        throw new TypeError(`MCP tool ${toolName} has an invalid x-mcp-header annotation.`);
      }
      const folded = suffix.toLowerCase();
      if (used.has(folded)) {
        throw new TypeError(`MCP tool ${toolName} has duplicate x-mcp-header annotations.`);
      }
      used.add(folded);
      bindings.push({ headerName: `mcp-param-${suffix}`, path: [...path], type });
    }
    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        visit(child, [...path, key], staticallyReachable);
      }
    }
    for (const keyword of [
      "items", "prefixItems", "contains", "oneOf", "anyOf", "allOf", "not", "if", "then", "else",
      "$defs", "definitions", "patternProperties", "additionalProperties", "dependentSchemas",
      "propertyNames", "unevaluatedItems", "unevaluatedProperties",
    ] as const) {
      const child = node[keyword];
      if (Array.isArray(child)) {
        for (const entry of child) visit(entry, path, false);
      } else {
        visit(child, path, false);
      }
    }
    stack.delete(node);
  };
  visit(schema, [], true);
  return Object.freeze(bindings);
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

function legacyProtocolFor(
  message: JsonRpcMessage,
  request: Request,
  sessionProtocol?: string,
): string | null {
  if (message.method === "initialize" && isRecord(message.params)) {
    const requested = message.params.protocolVersion;
    if (typeof requested !== "string") return null;
    if (MCP_LEGACY_VERSION_SET.has(requested)) return requested;
    return "2025-11-25";
  }
  const supplied = request.headers.get("mcp-protocol-version") ?? sessionProtocol ?? "2025-03-26";
  return MCP_LEGACY_VERSION_SET.has(supplied) ? supplied : null;
}

function modernRequest(message: JsonRpcMessage, request: Request): boolean {
  if (message.method === "server/discover") return true;
  if (request.headers.get("mcp-protocol-version") === MCP_PROTOCOL_VERSION) return true;
  if (!isRecord(message.params) || !isRecord(message.params._meta)) return false;
  return Object.hasOwn(message.params._meta, "io.modelcontextprotocol/protocolVersion");
}

function validateModernRequest(
  message: JsonRpcMessage,
  request: Request,
  notification: boolean,
  bindingsByTool: ReadonlyMap<string, readonly McpHeaderBinding[]>,
): string | Response {
  const id = validId(message.id) ? message.id as JsonRpcId : null;
  const headerProtocol = request.headers.get("mcp-protocol-version");
  if (!headerProtocol) return headerMismatch(id, "MCP-Protocol-Version header is required.");
  if (notification) {
    if (headerProtocol !== MCP_PROTOCOL_VERSION) {
      return unsupportedProtocol(id, headerProtocol);
    }
    return headerProtocol;
  }
  if (!isRecord(message.params) || !isRecord(message.params._meta)) {
    return rpcHttpError(400, id, -32602, "Request params must include _meta.");
  }
  const meta = message.params._meta;
  const bodyProtocol = meta["io.modelcontextprotocol/protocolVersion"];
  if (typeof bodyProtocol !== "string") {
    return rpcHttpError(400, id, -32602, "Request _meta must include a protocol version.");
  }
  if (bodyProtocol !== headerProtocol) {
    return headerMismatch(id, "MCP-Protocol-Version header does not match request _meta.");
  }
  if (bodyProtocol !== MCP_PROTOCOL_VERSION) return unsupportedProtocol(id, bodyProtocol);
  if (!isRecord(meta["io.modelcontextprotocol/clientCapabilities"])) {
    return rpcHttpError(400, id, -32602, "Request _meta must include client capabilities.");
  }
  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  if (
    clientInfo !== undefined
    && (!isRecord(clientInfo)
      || typeof clientInfo.name !== "string"
      || typeof clientInfo.version !== "string")
  ) {
    return rpcHttpError(400, id, -32602, "Client information must include name and version.");
  }
  const methodHeader = request.headers.get("mcp-method");
  if (!methodHeader || methodHeader !== message.method) {
    return headerMismatch(id, "Mcp-Method header does not match the request method.");
  }
  const nameSource = mcpNameSource(message);
  if (nameSource !== undefined) {
    const headerName = decodedMcpHeader(request.headers.get("mcp-name"));
    if (headerName === null || headerName !== nameSource) {
      return headerMismatch(id, "Mcp-Name header does not match the request target.");
    }
  }
  if (message.method === "tools/call" && isRecord(message.params)) {
    const toolName = message.params.name;
    if (typeof toolName === "string") {
      const headerError = validateToolHeaders(
        request,
        isRecord(message.params.arguments) ? message.params.arguments : {},
        bindingsByTool.get(toolName) ?? [],
      );
      if (headerError) return headerMismatch(id, headerError);
    }
  }
  return bodyProtocol;
}

function mcpNameSource(message: JsonRpcMessage): string | undefined {
  if (!isRecord(message.params)) return undefined;
  if (message.method === "tools/call" || message.method === "prompts/get") {
    return typeof message.params.name === "string" ? message.params.name : undefined;
  }
  if (message.method === "resources/read") {
    return typeof message.params.uri === "string" ? message.params.uri : undefined;
  }
  return undefined;
}

function headerMismatch(id: JsonRpcId, message: string): Response {
  return rpcHttpError(400, id, MCP_HEADER_MISMATCH, `Header mismatch: ${message}`);
}

function unsupportedProtocol(id: JsonRpcId, requested: string): Response {
  return rpcHttpError(
    400,
    id,
    MCP_UNSUPPORTED_PROTOCOL_VERSION,
    "Unsupported protocol version",
    { supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS], requested },
  );
}

function decodedMcpHeader(value: string | null): string | null {
  if (value === null) return null;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -2);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    return null;
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validateToolHeaders(
  request: Request,
  argumentsValue: Record<string, unknown>,
  bindings: readonly McpHeaderBinding[],
): string | null {
  for (const binding of bindings) {
    let cursor: unknown = argumentsValue;
    let present = true;
    for (const segment of binding.path) {
      if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) {
        present = false;
        break;
      }
      cursor = cursor[segment];
    }
    const supplied = request.headers.get(binding.headerName);
    if (!present || cursor === null || cursor === undefined) {
      if (supplied !== null) return `${binding.headerName} must be omitted when its argument is absent or null.`;
      continue;
    }
    const decoded = decodedMcpHeader(supplied);
    if (decoded === null) return `${binding.headerName} is required and must be validly encoded.`;
    if (binding.type === "string") {
      if (typeof cursor !== "string" || decoded !== cursor) return `${binding.headerName} does not match its string argument.`;
      continue;
    }
    if (binding.type === "boolean") {
      if (typeof cursor !== "boolean" || decoded !== String(cursor)) return `${binding.headerName} does not match its boolean argument.`;
      continue;
    }
    const numeric = Number(decoded);
    if (
      typeof cursor !== "number"
      || !Number.isSafeInteger(cursor)
      || !Number.isSafeInteger(numeric)
      || numeric !== cursor
    ) return `${binding.headerName} does not match its integer argument.`;
  }
  return null;
}

function modernResult<Context>(
  result: unknown,
  manifest: ReturnType<McpServer<Context>["manifest"]>,
): Record<string, unknown> {
  const value = isRecord(result) ? result : {};
  const meta = isRecord(value._meta) ? value._meta : {};
  return {
    ...value,
    resultType: "complete",
    _meta: {
      ...meta,
      "io.modelcontextprotocol/serverInfo": {
        name: manifest.server.name,
        ...(manifest.server.title ? { title: manifest.server.title } : {}),
        version: manifest.server.version,
      },
    },
  };
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

function browserCorsPreflight(request: Request): Response {
  const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
  if (requestedMethod && !["GET", "POST", "DELETE"].includes(requestedMethod)) {
    return new Response(null, {
      status: 405,
      headers: {
        allow: "GET, POST, DELETE, OPTIONS",
        "cache-control": "no-store",
      },
    });
  }
  const requestedHeaders = request.headers.get("access-control-request-headers") ?? "";
  if (requestedHeaders.length > 2_048) {
    return rpcHttpError(400, null, -32600, "CORS request headers are too large.");
  }
  const headers = requestedHeaders
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (headers.some((header) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(header))) {
    return rpcHttpError(400, null, -32600, "CORS request headers are invalid.");
  }
  const alwaysAllowed = [
    "accept",
    "authorization",
    "content-type",
    "last-event-id",
    "mcp-method",
    "mcp-name",
    "mcp-protocol-version",
    "mcp-session-id",
  ];
  if (headers.some((header) => !alwaysAllowed.includes(header) && !/^mcp-param-[a-z0-9-]{1,128}$/u.test(header))) {
    return rpcHttpError(400, null, -32600, "CORS request headers are not supported.");
  }
  const allowedHeaders = [...new Set([...alwaysAllowed, ...headers])];
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-headers": allowedHeaders.join(", "),
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Access-Control-Request-Headers",
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

function normalizedContractMetadata(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP contract metadata must be an object.");
  }
  const encoded = canonicalJson(value);
  if (new TextEncoder().encode(encoded).byteLength > 256 * 1024) {
    throw new TypeError("MCP contract metadata exceeds 262144 bytes.");
  }
  const freeze = (entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return Object.freeze(entry.map(freeze));
    return Object.freeze(Object.fromEntries(
      Object.entries(entry).map(([key, child]) => [key, freeze(child)]),
    ));
  };
  return freeze(JSON.parse(encoded)) as Readonly<Record<string, unknown>>;
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
