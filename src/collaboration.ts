import { signal, type ReactiveSignal } from "./core.ts";
import type { AuthRequest, AuthRuntime, AuthUser } from "./auth.ts";

export type CollaborationValue = null | boolean | number | string | readonly CollaborationValue[] | {
  readonly [key: string]: CollaborationValue;
};

export interface CollaborationPrincipal {
  /** Private application identity. It is never serialized to room peers. */
  readonly id: string;
  readonly name: string;
}

export interface CollaborationParticipant {
  /** Opaque connection-scoped identity, safe to expose inside the authorized room. */
  readonly id: string;
  readonly name: string;
  readonly data: Readonly<Record<string, CollaborationValue>>;
  readonly connectedAt: string;
  readonly updatedAt: string;
}

export type CollaborationOperation = "connect" | "stream" | "presence" | "signal" | "heartbeat" | "disconnect";

export interface CollaborationAuthorizationAttempt {
  readonly room: string;
  readonly operation: CollaborationOperation;
}

export type CollaborationEvent =
  | Readonly<{
      protocol: "clank-collaboration/1";
      room: string;
      revision: number;
      type: "snapshot";
      participants: readonly CollaborationParticipant[];
      at: string;
    }>
  | Readonly<{
      protocol: "clank-collaboration/1";
      room: string;
      revision: number;
      type: "join" | "presence";
      participant: CollaborationParticipant;
      at: string;
    }>
  | Readonly<{
      protocol: "clank-collaboration/1";
      room: string;
      revision: number;
      type: "leave";
      participantId: string;
      at: string;
    }>
  | Readonly<{
      protocol: "clank-collaboration/1";
      room: string;
      revision: number;
      type: "signal";
      participantId: string;
      participantName: string;
      channel: string;
      payload: CollaborationValue;
      at: string;
    }>;

export interface CollaborationLimits {
  maxRooms?: number;
  maxParticipantsPerRoom?: number;
  maxConnectionsPerPrincipal?: number;
  maxPresenceBytes?: number;
  maxSignalBytes?: number;
  maxEventsPerMinute?: number;
  idleTimeoutMs?: number;
}

export interface CreateCollaborationHubOptions {
  /** Exact endpoint path. Defaults to /__clank/collaboration. */
  path?: string;
  /** Re-authorizes the current identity and exact room on every request. */
  authorize(
    request: Request,
    attempt: CollaborationAuthorizationAttempt,
  ): CollaborationPrincipal | null | Promise<CollaborationPrincipal | null>;
  /** Required for every state-changing request. Integrate the application's ordinary CSRF check. */
  verifyCsrf(request: Request, principal: CollaborationPrincipal): boolean | Promise<boolean>;
  limits?: CollaborationLimits;
  now?: () => number;
}

export interface CreateAuthCollaborationHubOptions<Profile extends object> {
  path?: string;
  limits?: CollaborationLimits;
  now?: () => number;
  /** Application authorization for the exact room; authentication alone is not room access. */
  authorizeRoom?(
    auth: AuthRequest<Profile>,
    attempt: CollaborationAuthorizationAttempt,
  ): boolean | Promise<boolean>;
  displayName?(user: AuthUser<Profile>): string;
}

export interface CollaborationDiagnostics {
  readonly protocol: "clank-collaboration-diagnostics/1";
  readonly rooms: number;
  readonly participants: number;
  readonly streams: number;
  readonly limits: Required<CollaborationLimits>;
}

export interface CollaborationHub {
  handle(request: Request): Promise<Response>;
  diagnostics(): CollaborationDiagnostics;
  close(): void;
}

export interface CreateCollaborationClientOptions {
  /** Relative same-origin endpoint by default. */
  url?: string;
  room: string;
  initialPresence?: Readonly<Record<string, CollaborationValue>>;
  csrfToken: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  reconnect?: boolean;
}

export type CollaborationClientState = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";

export interface CollaborationClient {
  readonly state: ReactiveSignal<CollaborationClientState>;
  readonly participants: ReactiveSignal<readonly CollaborationParticipant[]>;
  readonly lastEvent: ReactiveSignal<CollaborationEvent | null>;
  readonly error: ReactiveSignal<Error | null>;
  connect(): Promise<void>;
  update(presence: Readonly<Record<string, CollaborationValue>>): Promise<void>;
  signal(channel: string, payload: CollaborationValue): Promise<void>;
  disconnect(): Promise<void>;
}

interface RoomRecord {
  readonly id: string;
  revision: number;
  readonly connections: Map<string, ConnectionRecord>;
}

interface ConnectionRecord {
  readonly id: string;
  readonly principalId: string;
  readonly room: RoomRecord;
  participant: CollaborationParticipant;
  lastSeen: number;
  rateStartedAt: number;
  rateCount: number;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  abort?: () => void;
}

const DEFAULT_LIMITS: Required<CollaborationLimits> = Object.freeze({
  maxRooms: 1_000,
  maxParticipantsPerRoom: 50,
  maxConnectionsPerPrincipal: 8,
  maxPresenceBytes: 4 * 1024,
  maxSignalBytes: 8 * 1024,
  maxEventsPerMinute: 240,
  idleTimeoutMs: 45_000,
});

const encoder = new TextEncoder();

/** Creates an ephemeral, authenticated presence and signal hub over Fetch + SSE. */
export function createCollaborationHub(options: CreateCollaborationHubOptions): CollaborationHub {
  if (!options || typeof options !== "object") throw new TypeError("Collaboration hub options are required.");
  if (typeof options.authorize !== "function") throw new TypeError("Collaboration authorize() is required.");
  if (typeof options.verifyCsrf !== "function") throw new TypeError("Collaboration verifyCsrf() is required.");
  const endpoint = endpointPath(options.path ?? "/__clank/collaboration");
  const limits = normalizeLimits(options.limits);
  const now = options.now ?? Date.now;
  if (typeof now !== "function") throw new TypeError("Collaboration now must be a function.");
  const rooms = new Map<string, RoomRecord>();
  const connections = new Map<string, ConnectionRecord>();
  let closed = false;

  const remove = (connection: ConnectionRecord) => {
    if (!connections.delete(connection.id)) return;
    connection.abort?.();
    connection.abort = undefined;
    const stream = connection.stream;
    connection.stream = undefined;
    try { stream?.close(); } catch { /* Stream already ended. */ }
    connection.room.connections.delete(connection.id);
    broadcast(connection.room, leaveEvent(connection.room, connection.id, now()), connection.id);
    if (connection.room.connections.size === 0) rooms.delete(connection.room.id);
  };

  const prune = () => {
    const deadline = now() - limits.idleTimeoutMs;
    for (const connection of [...connections.values()]) {
      if (connection.lastSeen < deadline) remove(connection);
    }
  };

  const interval = setInterval(() => {
    prune();
    for (const connection of connections.values()) {
      if (!connection.stream) continue;
      try {
        if ((connection.stream.desiredSize ?? 1) <= 0) throw new Error("slow collaboration stream");
        connection.stream.enqueue(encoder.encode(": heartbeat\n\n"));
      }
      catch { remove(connection); }
    }
  }, Math.min(15_000, Math.max(1_000, Math.floor(limits.idleTimeoutMs / 3))));
  (interval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();

  async function handle(request: Request): Promise<Response> {
    try {
      if (closed) throw new CollaborationHttpError(503, "CLOSED", "Collaboration is unavailable.");
      if (!(request instanceof Request)) throw new CollaborationHttpError(400, "INVALID_REQUEST", "Invalid collaboration request.");
      const url = new URL(request.url);
      if (url.pathname !== endpoint) throw new CollaborationHttpError(404, "NOT_FOUND", "Collaboration endpoint not found.");
      sameOriginRequest(request, url);
      prune();
      if (request.method === "GET") return await openStream(request, url);
      if (request.method !== "POST") {
        return problem(405, "METHOD_NOT_ALLOWED", "Collaboration requires GET or POST.", { allow: "GET, POST" });
      }
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) {
        throw new CollaborationHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Collaboration writes require JSON.");
      }
      const body = await readJson(request, 32 * 1024) as Record<string, unknown>;
      const operation = operationValue(body.operation);
      if (operation === "stream") throw new CollaborationHttpError(400, "INVALID_OPERATION", "Streams use GET.");
      const roomId = roomValue(body.room);
      const principal = await authorized(options, request, roomId, operation);
      if (!await options.verifyCsrf(request, principal)) {
        throw new CollaborationHttpError(403, "CSRF_REJECTED", "Collaboration request was not verified.");
      }
      if (operation === "connect") return connect(body, roomId, principal);
      const connection = ownedConnection(body, connections, principal, roomId);
      connection.lastSeen = now();
      if (operation === "heartbeat") {
        exactKeys(body, ["operation", "room", "connection"], "heartbeat request");
        return json({ protocol: "clank-collaboration/1", ok: true });
      }
      if (operation === "disconnect") {
        exactKeys(body, ["operation", "room", "connection"], "disconnect request");
        remove(connection);
        return json({ protocol: "clank-collaboration/1", ok: true });
      }
      admitEvent(connection, limits, now());
      if (operation === "presence") {
        exactKeys(body, ["operation", "room", "connection", "presence"], "presence request");
        const presence = dataObject(body.presence, limits.maxPresenceBytes, "presence");
        connection.participant = participantSnapshot({
          ...connection.participant,
          data: presence,
          updatedAt: new Date(now()).toISOString(),
        });
        const event = presenceEvent(connection.room, connection.participant, now());
        broadcast(connection.room, event);
        return json(event);
      }
      exactKeys(body, ["operation", "room", "connection", "channel", "payload"], "signal request");
      const channel = identifier(body.channel, "signal channel", 128);
      const payload = dataValue(body.payload, limits.maxSignalBytes, "signal payload");
      const event = signalEvent(connection.room, connection.participant, channel, payload, now());
      broadcast(connection.room, event);
      return json(event);
    } catch (error) {
      if (error instanceof CollaborationHttpError) return problem(error.status, error.code, error.message);
      if (error instanceof TypeError) return problem(400, "INVALID_REQUEST", error.message.slice(0, 512));
      return problem(500, "COLLABORATION_FAILED", "Collaboration request failed.");
    }
  }

  function connect(body: Record<string, unknown>, roomId: string, principal: CollaborationPrincipal): Response {
    exactKeys(body, ["operation", "room", "presence"], "connect request");
    if (connections.size >= limits.maxRooms * limits.maxParticipantsPerRoom) {
      throw new CollaborationHttpError(503, "CAPACITY", "Collaboration capacity is unavailable.");
    }
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= limits.maxRooms) throw new CollaborationHttpError(503, "CAPACITY", "Collaboration capacity is unavailable.");
      room = { id: roomId, revision: 0, connections: new Map() };
      rooms.set(roomId, room);
    }
    if (room.connections.size >= limits.maxParticipantsPerRoom) {
      throw new CollaborationHttpError(409, "ROOM_FULL", "The collaboration room is full.");
    }
    let principalConnections = 0;
    for (const entry of connections.values()) if (entry.principalId === principal.id) principalConnections++;
    if (principalConnections >= limits.maxConnectionsPerPrincipal) {
      throw new CollaborationHttpError(429, "CONNECTION_LIMIT", "The collaboration connection limit was reached.");
    }
    const at = new Date(now()).toISOString();
    const id = randomId();
    const participant = participantSnapshot({
      id,
      name: principal.name,
      data: dataObject(body.presence ?? {}, limits.maxPresenceBytes, "presence"),
      connectedAt: at,
      updatedAt: at,
    });
    const connection: ConnectionRecord = {
      id,
      principalId: principal.id,
      room,
      participant,
      lastSeen: now(),
      rateStartedAt: now(),
      rateCount: 0,
    };
    connections.set(id, connection);
    room.connections.set(id, connection);
    broadcast(room, joinEvent(room, participant, now()));
    return json({
      protocol: "clank-collaboration-connect/1",
      connection: id,
      heartbeatMs: Math.max(1_000, Math.floor(limits.idleTimeoutMs / 3)),
      snapshot: snapshotEvent(room, now()),
    }, 201);
  }

  async function openStream(request: Request, url: URL): Promise<Response> {
    exactQuery(url, ["room", "connection"]);
    const roomId = roomValue(url.searchParams.get("room"));
    const connectionId = identifier(url.searchParams.get("connection"), "connection", 256);
    const principal = await authorized(options, request, roomId, "stream");
    const connection = connections.get(connectionId);
    if (!connection || connection.room.id !== roomId || connection.principalId !== principal.id) {
      throw new CollaborationHttpError(404, "NOT_FOUND", "Collaboration connection not found.");
    }
    if (connection.stream) throw new CollaborationHttpError(409, "STREAM_EXISTS", "The collaboration stream is already open.");
    connection.lastSeen = now();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connection.stream = controller;
        enqueue(controller, snapshotEvent(connection.room, now()));
        const abort = () => remove(connection);
        connection.abort = () => request.signal.removeEventListener("abort", abort);
        request.signal.addEventListener("abort", abort, { once: true });
      },
      cancel() { remove(connection); },
    });
    return new Response(stream, {
      headers: responseHeaders({
        "content-type": "text/event-stream; charset=utf-8",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      }),
    });
  }

  function broadcast(room: RoomRecord, event: CollaborationEvent, except?: string): void {
    for (const failed of deliver(room, event, except)) remove(failed);
  }

  return Object.freeze({
    handle,
    diagnostics() {
      let streams = 0;
      for (const connection of connections.values()) if (connection.stream) streams++;
      return Object.freeze({
        protocol: "clank-collaboration-diagnostics/1" as const,
        rooms: rooms.size,
        participants: connections.size,
        streams,
        limits,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      for (const connection of [...connections.values()]) remove(connection);
      rooms.clear();
    },
  });
}

/** Connects a collaboration hub to Clank browser sessions and their existing CSRF boundary. */
export function createAuthCollaborationHub<Profile extends object>(
  auth: Pick<AuthRuntime<Profile>, "resolve" | "verifyCsrf">,
  options: CreateAuthCollaborationHubOptions<Profile> = {},
): CollaborationHub {
  if (!auth || typeof auth.resolve !== "function" || typeof auth.verifyCsrf !== "function") {
    throw new TypeError("An auth runtime with resolve() and verifyCsrf() is required.");
  }
  const requests = new WeakMap<Request, AuthRequest<Profile>>();
  return createCollaborationHub({
    path: options.path,
    limits: options.limits,
    now: options.now,
    async authorize(request, attempt) {
      const resolved = await auth.resolve(request);
      if (!resolved.user || !resolved.session) return null;
      if (options.authorizeRoom && !await options.authorizeRoom(resolved, attempt)) return null;
      requests.set(request, resolved);
      const profileName = (resolved.user.profile as { name?: unknown }).name;
      const proposed = options.displayName?.(resolved.user)
        ?? (typeof profileName === "string" ? profileName : resolved.user.email);
      return { id: resolved.user.id, name: text(proposed, "collaborator display name", 100) };
    },
    async verifyCsrf(request) {
      const resolved = requests.get(request) ?? await auth.resolve(request);
      try {
        await auth.verifyCsrf(request, resolved);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Creates a reconnecting reactive browser client for a collaboration hub. */
export function createCollaborationClient(options: CreateCollaborationClientOptions): CollaborationClient {
  if (!options || typeof options !== "object") throw new TypeError("Collaboration client options are required.");
  const room = roomValue(options.room);
  const endpoint = clientEndpoint(options.url ?? "/__clank/collaboration");
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== "function") throw new TypeError("Collaboration client requires fetch.");
  if (typeof options.csrfToken !== "string" && typeof options.csrfToken !== "function") {
    throw new TypeError("Collaboration client requires a CSRF token or resolver.");
  }
  const initialPresence = dataObject(options.initialPresence ?? {}, DEFAULT_LIMITS.maxPresenceBytes, "initial presence");
  const state = signal<CollaborationClientState>("idle");
  const participants = signal<readonly CollaborationParticipant[]>(Object.freeze([]));
  const lastEvent = signal<CollaborationEvent | null>(null);
  const clientError = signal<Error | null>(null);
  let desired = false;
  let generation = 0;
  let connection: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let streamAbort: AbortController | undefined;
  let reconnectAttempt = 0;

  const csrf = async () => {
    const value = typeof options.csrfToken === "function" ? await options.csrfToken() : options.csrfToken;
    if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\0")) {
      throw new Error("Collaboration CSRF token is unavailable.");
    }
    return value;
  };

  const post = async (body: Record<string, unknown>): Promise<any> => {
    const response = await request(endpoint.href, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-clank-csrf": await csrf() },
      body: JSON.stringify(body),
    });
    const payload = await responseJson(response, 64 * 1024);
    if (!response.ok) throw new Error(publicClientError(payload, response.status));
    return payload;
  };

  const stopTransport = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    streamAbort?.abort();
    streamAbort = undefined;
  };

  const apply = (event: CollaborationEvent) => {
    if (!event || event.protocol !== "clank-collaboration/1" || event.room !== room) return;
    lastEvent.value = event;
    if (event.type === "snapshot") participants.value = Object.freeze([...event.participants]);
    else if (event.type === "join" || event.type === "presence") {
      participants.value = Object.freeze([
        ...participants.peek().filter((entry) => entry.id !== event.participant.id),
        event.participant,
      ]);
    } else if (event.type === "leave") {
      participants.value = Object.freeze(participants.peek().filter((entry) => entry.id !== event.participantId));
    }
  };

  const establish = async (currentGeneration: number): Promise<void> => {
    state.value = reconnectAttempt ? "reconnecting" : "connecting";
    const connected = await post({ operation: "connect", room, presence: initialPresence });
    if (!desired || generation !== currentGeneration) {
      await post({ operation: "disconnect", room, connection: connected.connection }).catch(() => undefined);
      return;
    }
    if (connected.protocol !== "clank-collaboration-connect/1" || typeof connected.connection !== "string") {
      throw new Error("Collaboration connect response is invalid.");
    }
    connection = connected.connection;
    apply(connected.snapshot);
    reconnectAttempt = 0;
    state.value = "connected";
    clientError.value = null;
    heartbeat = setInterval(() => {
      if (connection) void post({ operation: "heartbeat", room, connection }).catch(() => undefined);
    }, integer(connected.heartbeatMs, "collaboration heartbeat", 1_000, 60_000));
    const controller = new AbortController();
    streamAbort = controller;
    void consume(endpoint, room, connection, request, controller.signal, apply)
      .then(() => reconnect(currentGeneration))
      .catch((error) => {
        if (!controller.signal.aborted) clientError.value = error instanceof Error ? error : new Error(String(error));
        return reconnect(currentGeneration);
      });
  };

  const reconnect = async (currentGeneration: number) => {
    stopTransport();
    if (!desired || generation !== currentGeneration) return;
    const old = connection;
    connection = undefined;
    if (old) await post({ operation: "disconnect", room, connection: old }).catch(() => undefined);
    if (options.reconnect === false) {
      state.value = "error";
      return;
    }
    reconnectAttempt++;
    state.value = "reconnecting";
    const delay = Math.min(10_000, 250 * 2 ** Math.min(reconnectAttempt - 1, 6));
    await wait(delay);
    if (!desired || generation !== currentGeneration) return;
    try { await establish(currentGeneration); }
    catch (error) {
      clientError.value = error instanceof Error ? error : new Error(String(error));
      void reconnect(currentGeneration);
    }
  };

  return Object.freeze({
    state,
    participants,
    lastEvent,
    error: clientError,
    async connect() {
      if (desired && (state.peek() === "connecting" || state.peek() === "connected" || state.peek() === "reconnecting")) return;
      desired = true;
      const currentGeneration = ++generation;
      try { await establish(currentGeneration); }
      catch (error) {
        clientError.value = error instanceof Error ? error : new Error(String(error));
        state.value = "error";
        desired = false;
        throw error;
      }
    },
    async update(presence) {
      if (!connection || state.peek() !== "connected") throw new Error("Collaboration is not connected.");
      await post({ operation: "presence", room, connection, presence: dataObject(presence, DEFAULT_LIMITS.maxPresenceBytes, "presence") });
    },
    async signal(channel, payload) {
      if (!connection || state.peek() !== "connected") throw new Error("Collaboration is not connected.");
      await post({
        operation: "signal",
        room,
        connection,
        channel: identifier(channel, "signal channel", 128),
        payload: dataValue(payload, DEFAULT_LIMITS.maxSignalBytes, "signal payload"),
      });
    },
    async disconnect() {
      desired = false;
      generation++;
      const active = connection;
      connection = undefined;
      stopTransport();
      if (active) await post({ operation: "disconnect", room, connection: active }).catch(() => undefined);
      participants.value = Object.freeze([]);
      state.value = "closed";
    },
  });
}

async function consume(
  endpoint: URL,
  room: string,
  connection: string,
  request: typeof fetch,
  signal: AbortSignal,
  apply: (event: CollaborationEvent) => void,
): Promise<void> {
  const url = new URL(endpoint.href);
  url.searchParams.set("room", room);
  url.searchParams.set("connection", connection);
  const response = await request(url.href, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Collaboration stream failed with HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 64 * 1024) throw new Error("Collaboration stream event is too large.");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary).replace(/\r/gu, "");
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (!data) continue;
      if (data.length > 32 * 1024) throw new Error("Collaboration stream event is too large.");
      apply(JSON.parse(data));
    }
  }
}

function deliver(room: RoomRecord, event: CollaborationEvent, except?: string): ConnectionRecord[] {
  const failed: ConnectionRecord[] = [];
  for (const connection of room.connections.values()) {
    if (connection.id === except || !connection.stream) continue;
    try {
      if ((connection.stream.desiredSize ?? 1) <= 0) throw new Error("slow collaboration stream");
      enqueue(connection.stream, event);
    } catch { failed.push(connection); }
  }
  return failed;
}

function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, event: CollaborationEvent): void {
  controller.enqueue(encoder.encode(`id: ${event.revision}\nevent: collaboration\ndata: ${JSON.stringify(event)}\n\n`));
}

function snapshotEvent(room: RoomRecord, now: number): CollaborationEvent {
  return Object.freeze({
    protocol: "clank-collaboration/1" as const,
    room: room.id,
    revision: room.revision,
    type: "snapshot" as const,
    participants: Object.freeze([...room.connections.values()].map((entry) => entry.participant)),
    at: new Date(now).toISOString(),
  });
}

function joinEvent(room: RoomRecord, participant: CollaborationParticipant, now: number): CollaborationEvent {
  return Object.freeze({ protocol: "clank-collaboration/1", room: room.id, revision: ++room.revision, type: "join", participant, at: new Date(now).toISOString() });
}

function presenceEvent(room: RoomRecord, participant: CollaborationParticipant, now: number): CollaborationEvent {
  return Object.freeze({ protocol: "clank-collaboration/1", room: room.id, revision: ++room.revision, type: "presence", participant, at: new Date(now).toISOString() });
}

function leaveEvent(room: RoomRecord, participantId: string, now: number): CollaborationEvent {
  return Object.freeze({ protocol: "clank-collaboration/1", room: room.id, revision: ++room.revision, type: "leave", participantId, at: new Date(now).toISOString() });
}

function signalEvent(
  room: RoomRecord,
  participant: CollaborationParticipant,
  channel: string,
  payload: CollaborationValue,
  now: number,
): CollaborationEvent {
  return Object.freeze({
    protocol: "clank-collaboration/1",
    room: room.id,
    revision: ++room.revision,
    type: "signal",
    participantId: participant.id,
    participantName: participant.name,
    channel,
    payload,
    at: new Date(now).toISOString(),
  });
}

async function authorized(
  options: CreateCollaborationHubOptions,
  request: Request,
  room: string,
  operation: CollaborationOperation,
): Promise<CollaborationPrincipal> {
  const value = await options.authorize(request, Object.freeze({ room, operation }));
  if (!value) throw new CollaborationHttpError(401, "UNAUTHORIZED", "Collaboration authorization is required.");
  if (!value || typeof value !== "object") throw new CollaborationHttpError(403, "FORBIDDEN", "Collaboration is not authorized.");
  return Object.freeze({
    id: identifier(value.id, "principal id", 256),
    name: text(value.name, "principal name", 100),
  });
}

function ownedConnection(
  body: Record<string, unknown>,
  connections: Map<string, ConnectionRecord>,
  principal: CollaborationPrincipal,
  room: string,
): ConnectionRecord {
  const connection = connectionForBody(body, connections);
  if (connection.principalId !== principal.id || connection.room.id !== room) {
    throw new CollaborationHttpError(404, "NOT_FOUND", "Collaboration connection not found.");
  }
  return connection;
}

function connectionForBody(body: Record<string, unknown>, connections: Map<string, ConnectionRecord>): ConnectionRecord {
  const id = identifier(body.connection, "connection", 256);
  const connection = connections.get(id);
  if (!connection) throw new CollaborationHttpError(404, "NOT_FOUND", "Collaboration connection not found.");
  return connection;
}

function admitEvent(connection: ConnectionRecord, limits: Required<CollaborationLimits>, now: number): void {
  if (now - connection.rateStartedAt >= 60_000) {
    connection.rateStartedAt = now;
    connection.rateCount = 0;
  }
  connection.rateCount++;
  if (connection.rateCount > limits.maxEventsPerMinute) {
    throw new CollaborationHttpError(429, "RATE_LIMITED", "Collaboration event rate exceeded.");
  }
}

function participantSnapshot(value: CollaborationParticipant): CollaborationParticipant {
  return Object.freeze({ ...value, data: deepFreeze(value.data) });
}

function dataObject(value: unknown, maximum: number, label: string): Readonly<Record<string, CollaborationValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const normalized = normalizeData(value, label, 0) as Record<string, CollaborationValue>;
  if (encoder.encode(JSON.stringify(normalized)).byteLength > maximum) throw new TypeError(`${label} is too large.`);
  return deepFreeze(normalized);
}

function dataValue(value: unknown, maximum: number, label: string): CollaborationValue {
  const normalized = normalizeData(value, label, 0);
  if (encoder.encode(JSON.stringify(normalized)).byteLength > maximum) throw new TypeError(`${label} is too large.`);
  return deepFreeze(normalized);
}

function normalizeData(value: unknown, label: string, depth: number): CollaborationValue {
  if (depth > 5) throw new TypeError(`${label} is too deeply nested.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 1_024 && !value.includes("\0")) return value;
  if (Array.isArray(value)) {
    if (value.length > 64) throw new TypeError(`${label} contains too many items.`);
    return value.map((entry) => normalizeData(entry, label, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 64) throw new TypeError(`${label} contains too many fields.`);
    const output: Record<string, CollaborationValue> = Object.create(null);
    for (const [key, entry] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)) throw new TypeError(`${label} contains an invalid field.`);
      output[key] = normalizeData(entry, label, depth + 1);
    }
    return output;
  }
  throw new TypeError(`${label} must contain JSON values.`);
}

function normalizeLimits(input: CollaborationLimits | undefined): Required<CollaborationLimits> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new TypeError("Collaboration limits must be an object.");
  }
  exactKeys(input as Record<string, unknown> ?? {}, Object.keys(DEFAULT_LIMITS), "collaboration limits");
  return Object.freeze({
    maxRooms: integer(input?.maxRooms ?? DEFAULT_LIMITS.maxRooms, "maxRooms", 1, 10_000),
    maxParticipantsPerRoom: integer(input?.maxParticipantsPerRoom ?? DEFAULT_LIMITS.maxParticipantsPerRoom, "maxParticipantsPerRoom", 1, 500),
    maxConnectionsPerPrincipal: integer(input?.maxConnectionsPerPrincipal ?? DEFAULT_LIMITS.maxConnectionsPerPrincipal, "maxConnectionsPerPrincipal", 1, 100),
    maxPresenceBytes: integer(input?.maxPresenceBytes ?? DEFAULT_LIMITS.maxPresenceBytes, "maxPresenceBytes", 128, 64 * 1024),
    maxSignalBytes: integer(input?.maxSignalBytes ?? DEFAULT_LIMITS.maxSignalBytes, "maxSignalBytes", 128, 64 * 1024),
    maxEventsPerMinute: integer(input?.maxEventsPerMinute ?? DEFAULT_LIMITS.maxEventsPerMinute, "maxEventsPerMinute", 1, 10_000),
    idleTimeoutMs: integer(input?.idleTimeoutMs ?? DEFAULT_LIMITS.idleTimeoutMs, "idleTimeoutMs", 3_000, 10 * 60_000),
  });
}

function operationValue(value: unknown): CollaborationOperation {
  if (!["connect", "presence", "signal", "heartbeat", "disconnect"].includes(String(value))) {
    throw new CollaborationHttpError(400, "INVALID_OPERATION", "Unknown collaboration operation.");
  }
  return value as CollaborationOperation;
}

function roomValue(value: unknown): string {
  return identifier(value, "room", 128);
}

function identifier(value: unknown, label: string, maximum: number): string {
  const normalized = text(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) throw new TypeError(`${label} is invalid.`);
  return normalized;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`${label} must be bounded text.`);
  }
  return value.trim();
}

function endpointPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/u.test(value) || value.includes("//")) {
    throw new TypeError("Collaboration path must be an absolute application path.");
  }
  return value;
}

function clientEndpoint(value: string): URL {
  const location = (globalThis as { location?: Location }).location;
  const url = new URL(value, location?.href ?? "http://127.0.0.1");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Collaboration URL must use HTTP or HTTPS.");
  if (url.username || url.password || url.hash) throw new TypeError("Collaboration URL cannot contain credentials or a fragment.");
  if (location && url.origin !== location.origin) throw new TypeError("Collaboration client URL must be same-origin.");
  return url;
}

function sameOriginRequest(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if ((origin && origin !== url.origin) || site === "cross-site") {
    throw new CollaborationHttpError(403, "ORIGIN_MISMATCH", "Cross-origin collaboration request rejected.");
  }
}

function exactQuery(url: URL, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  for (const key of url.searchParams.keys()) if (!expected.has(key)) throw new CollaborationHttpError(400, "INVALID_QUERY", "Collaboration query is invalid.");
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new TypeError(`${label} contains unknown field ${key}.`);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

async function readJson(request: Request, maximum: number): Promise<unknown> {
  const bytes = await boundedBytes(request.body, request.headers.get("content-length"), maximum, "Collaboration request");
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CollaborationHttpError(400, "INVALID_JSON", "Collaboration request JSON is invalid."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CollaborationHttpError(400, "INVALID_JSON", "Collaboration request JSON must be an object.");
  return value;
}

async function responseJson(response: Response, maximum: number): Promise<any> {
  const bytes = await boundedBytes(response.body, response.headers.get("content-length"), maximum, "Collaboration response");
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("Collaboration response is invalid."); }
}

async function boundedBytes(
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  maximum: number,
  label: string,
): Promise<Uint8Array> {
  const declared = contentLength === null ? NaN : Number(contentLength);
  if (Number.isFinite(declared) && declared > maximum) throw new CollaborationHttpError(413, "BODY_TOO_LARGE", `${label} is too large.`);
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new CollaborationHttpError(413, "BODY_TOO_LARGE", `${label} is too large.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function publicClientError(value: any, status: number): string {
  return typeof value?.error?.message === "string" && value.error.message.length <= 512
    ? value.error.message
    : `Collaboration request failed with HTTP ${status}.`;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: responseHeaders() });
}

function problem(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ protocol: "clank-collaboration-error/1", error: { code, message } }, {
    status,
    headers: responseHeaders(headers),
  });
}

function responseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
}

function randomId(): string {
  return `collab_${crypto.randomUUID().replaceAll("-", "")}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CollaborationHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
