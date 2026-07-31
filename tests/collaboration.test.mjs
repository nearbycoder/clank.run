import test from "node:test";
import assert from "node:assert/strict";

import { createAuthCollaborationHub, createCollaborationClient, createCollaborationHub } from "../dist/index.js";

const origin = "https://app.test";

function testHub(overrides = {}) {
  let now = Date.parse("2026-07-31T12:00:00.000Z");
  const attempts = [];
  const hub = createCollaborationHub({
    authorize(request, attempt) {
      attempts.push(attempt);
      const id = request.headers.get("x-user");
      if (!id || attempt.room === "forbidden") return null;
      return { id, name: request.headers.get("x-name") ?? id };
    },
    verifyCsrf: (request) => request.headers.get("x-csrf") === "valid",
    now: () => now,
    ...overrides,
  });
  return { hub, attempts, advance: (milliseconds) => { now += milliseconds; } };
}

function requestHeaders(user, csrf = true) {
  return {
    origin,
    "content-type": "application/json",
    "x-user": user,
    "x-name": user === "alice" ? "Alice" : user === "bob" ? "Bob" : user,
    ...(csrf ? { "x-csrf": "valid" } : {}),
  };
}

async function post(hub, user, body, options = {}) {
  const response = await hub.handle(new Request(`${origin}/__clank/collaboration`, {
    method: "POST",
    headers: { ...requestHeaders(user, options.csrf), ...options.headers },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() };
}

async function connect(hub, user, room = "document-1", presence = {}) {
  const result = await post(hub, user, { operation: "connect", room, presence });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function stream(hub, user, room, connection) {
  const response = await hub.handle(new Request(
    `${origin}/__clank/collaboration?room=${encodeURIComponent(room)}&connection=${encodeURIComponent(connection)}`,
    { headers: { origin, "x-user": user, "x-name": user === "alice" ? "Alice" : "Bob" } },
  ));
  assert.equal(response.status, 200);
  return response.body.getReader();
}

async function event(reader) {
  const { done, value } = await reader.read();
  assert.equal(done, false);
  const source = new TextDecoder().decode(value);
  const data = source.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, source);
  return JSON.parse(data.slice(6));
}

test("collaboration hub publishes bounded room presence and ephemeral signals", async () => {
  const fixture = testHub();
  const alice = await connect(fixture.hub, "alice", "document-1", { cursor: { x: 1, y: 2 } });
  assert.equal(alice.protocol, "clank-collaboration-connect/1");
  assert.equal(alice.snapshot.participants[0].name, "Alice");
  assert.equal(Object.hasOwn(alice.snapshot.participants[0], "principalId"), false);

  const aliceStream = await stream(fixture.hub, "alice", "document-1", alice.connection);
  assert.equal((await event(aliceStream)).type, "snapshot");

  const bob = await connect(fixture.hub, "bob", "document-1", { selection: "title" });
  const joined = await event(aliceStream);
  assert.equal(joined.type, "join");
  assert.equal(joined.participant.name, "Bob");

  const bobStream = await stream(fixture.hub, "bob", "document-1", bob.connection);
  assert.equal((await event(bobStream)).participants.length, 2);

  const updated = await post(fixture.hub, "bob", {
    operation: "presence",
    room: "document-1",
    connection: bob.connection,
    presence: { cursor: { x: 20, y: 40 }, typing: true },
  });
  assert.equal(updated.response.status, 200);
  assert.equal((await event(aliceStream)).participant.data.typing, true);
  assert.equal((await event(bobStream)).type, "presence");

  const signalled = await post(fixture.hub, "alice", {
    operation: "signal",
    room: "document-1",
    connection: alice.connection,
    channel: "comment.created",
    payload: { commentId: "comment-1" },
  });
  assert.equal(signalled.body.type, "signal");
  assert.equal((await event(aliceStream)).channel, "comment.created");
  assert.equal((await event(bobStream)).participantName, "Alice");

  const disconnected = await post(fixture.hub, "bob", {
    operation: "disconnect",
    room: "document-1",
    connection: bob.connection,
  });
  assert.equal(disconnected.response.status, 200);
  assert.equal((await event(aliceStream)).type, "leave");
  assert.deepEqual(fixture.hub.diagnostics(), {
    protocol: "clank-collaboration-diagnostics/1",
    rooms: 1,
    participants: 1,
    streams: 1,
    limits: fixture.hub.diagnostics().limits,
  });
  await aliceStream.cancel();
  assert.equal(fixture.hub.diagnostics().participants, 0);
  fixture.hub.close();
  assert.ok(fixture.attempts.some((attempt) => attempt.operation === "stream"));
});

test("collaboration hub re-authorizes rooms, enforces CSRF/origin/ownership, and fails within bounds", async () => {
  const fixture = testHub({
    limits: {
      maxRooms: 2,
      maxParticipantsPerRoom: 2,
      maxConnectionsPerPrincipal: 1,
      maxPresenceBytes: 128,
      maxSignalBytes: 128,
      maxEventsPerMinute: 1,
      idleTimeoutMs: 3_000,
    },
  });
  const alice = await connect(fixture.hub, "alice");

  const csrf = await post(fixture.hub, "bob", { operation: "connect", room: "document-1", presence: {} }, { csrf: false });
  assert.equal(csrf.response.status, 403);
  assert.equal(csrf.body.error.code, "CSRF_REJECTED");

  const foreign = await post(fixture.hub, "bob", {
    operation: "presence",
    room: "document-1",
    connection: alice.connection,
    presence: {},
  });
  assert.equal(foreign.response.status, 404);

  const wrongRoom = await post(fixture.hub, "alice", {
    operation: "presence",
    room: "document-2",
    connection: alice.connection,
    presence: {},
  });
  assert.equal(wrongRoom.response.status, 404);

  const forbidden = await post(fixture.hub, "alice", { operation: "connect", room: "forbidden", presence: {} });
  assert.equal(forbidden.response.status, 401);

  const duplicate = await post(fixture.hub, "alice", { operation: "connect", room: "document-2", presence: {} });
  assert.equal(duplicate.response.status, 429);

  const first = await post(fixture.hub, "alice", {
    operation: "presence",
    room: "document-1",
    connection: alice.connection,
    presence: { cursor: 1 },
  });
  assert.equal(first.response.status, 200);
  const limited = await post(fixture.hub, "alice", {
    operation: "signal",
    room: "document-1",
    connection: alice.connection,
    channel: "cursor",
    payload: 2,
  });
  assert.equal(limited.response.status, 429);

  const huge = await post(fixture.hub, "bob", {
    operation: "connect",
    room: "document-1",
    presence: { value: "x".repeat(1_024) },
  });
  assert.equal(huge.response.status, 400);

  const crossOrigin = await fixture.hub.handle(new Request(`${origin}/__clank/collaboration`, {
    method: "POST",
    headers: { ...requestHeaders("bob"), origin: "https://attacker.test" },
    body: JSON.stringify({ operation: "connect", room: "document-1", presence: {} }),
  }));
  assert.equal(crossOrigin.status, 403);

  fixture.advance(3_001);
  const expired = await post(fixture.hub, "alice", {
    operation: "heartbeat",
    room: "document-1",
    connection: alice.connection,
  });
  assert.equal(expired.response.status, 404);
  assert.equal(fixture.hub.diagnostics().participants, 0);
  fixture.hub.close();
});

test("collaboration hub disconnects a slow stream instead of buffering room events without bound", async () => {
  const fixture = testHub();
  const alice = await connect(fixture.hub, "alice", "slow-room");
  const aliceStream = await stream(fixture.hub, "alice", "slow-room", alice.connection);
  // Leave the initial snapshot queued so the next room event meets backpressure.
  const bob = await connect(fixture.hub, "bob", "slow-room");
  assert.equal(bob.snapshot.participants.length, 1);
  assert.equal(bob.snapshot.participants[0].name, "Bob");
  assert.equal((await event(aliceStream)).type, "snapshot");
  assert.equal((await aliceStream.read()).done, true);
  assert.equal(fixture.hub.diagnostics().participants, 1);
  fixture.hub.close();
});

test("reactive collaboration client connects, applies stream events, writes, and closes", async () => {
  const hub = createCollaborationHub({
    authorize: () => ({ id: "client-user", name: "Client User" }),
    verifyCsrf: (request) => request.headers.get("x-clank-csrf") === "csrf-token",
  });
  const transport = (input, init) => hub.handle(new Request(input, init));
  const client = createCollaborationClient({
    url: `${origin}/__clank/collaboration`,
    room: "client-room",
    csrfToken: "csrf-token",
    initialPresence: { route: "/board" },
    fetch: transport,
    reconnect: false,
  });
  await client.connect();
  assert.equal(client.state.value, "connected");
  assert.equal(client.participants.value[0].data.route, "/board");

  await client.update({ route: "/board", cursor: { x: 5, y: 9 } });
  await eventually(() => client.participants.value[0]?.data.cursor?.x === 5);
  await client.signal("selection.changed", { id: "card-1" });
  await eventually(() => client.lastEvent.value?.type === "signal");
  assert.equal(client.lastEvent.value.channel, "selection.changed");

  await client.disconnect();
  assert.equal(client.state.value, "closed");
  assert.deepEqual(client.participants.value, []);
  assert.equal(hub.diagnostics().participants, 0);
  hub.close();
});

test("auth collaboration adapter reuses session and CSRF checks plus room authorization", async () => {
  let csrfChecks = 0;
  const auth = {
    async resolve(request) {
      const id = request.headers.get("x-user");
      return {
        user: id ? {
          id,
          email: `${id}@example.invalid`,
          emailVerified: true,
          role: "member",
          profile: { name: "Adapter User" },
          createdAt: 1,
          updatedAt: 1,
        } : null,
        session: id ? { id: "session", createdAt: 1, lastSeenAt: 1, expiresAt: 2 } : null,
        csrfToken: "valid",
      };
    },
    async verifyCsrf(request) {
      csrfChecks++;
      if (request.headers.get("x-csrf") !== "valid") throw new Error("bad csrf");
    },
  };
  const rooms = [];
  const hub = createAuthCollaborationHub(auth, {
    authorizeRoom(_auth, attempt) {
      rooms.push(attempt.room);
      return attempt.room === "allowed";
    },
  });
  const allowed = await post(hub, "adapter", { operation: "connect", room: "allowed", presence: {} });
  assert.equal(allowed.response.status, 201);
  assert.equal(allowed.body.snapshot.participants[0].name, "Adapter User");
  const denied = await post(hub, "adapter", { operation: "connect", room: "denied", presence: {} });
  assert.equal(denied.response.status, 401);
  assert.deepEqual(rooms, ["allowed", "denied"]);
  assert.equal(csrfChecks, 1, "room denial happens before CSRF work");
  hub.close();
});

async function eventually(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Condition was not reached.");
}
