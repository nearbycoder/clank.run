import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  openBackend,
  s,
} from "../dist/index.js";

const jsonHeaders = {
  "content-type": "application/json",
  origin: "https://todo.test",
  "x-clank-client-ip": "127.0.0.1",
};

function request(path, { method = "GET", body, cookie, csrf, origin = "https://todo.test" } = {}) {
  return new Request(`https://todo.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { ...jsonHeaders, origin }),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-clank-csrf": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sessionFrom(response, payload) {
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrf: payload.csrfToken,
    user: payload.user,
    session: payload.session,
  };
}

async function createFixture(authOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clank-auth-"));
  const path = join(directory, "app.sqlite");
  const schema = defineDatabase({
    todos: defineTable({
      title: s.string({ min: 1, max: 200 }),
      done: s.boolean(),
    }).owned(),
  });
  const auth = defineAuth({
    password: {
      minLength: 8,
      cost: 1024,
      maxMemory: 4 * 1024 * 1024,
    },
    ...authOptions,
  });
  const backend = defineBackend({ schema, auth }).functions(({ query, mutation, publicQuery }) => ({
    status: publicQuery({
      args: {},
      handler: ({ user }) => ({ signedIn: Boolean(user) }),
    }),
    admin: query({
      args: {},
      handler: ({ auth }) => {
        auth.requireRole("admin");
        return "admin-only";
      },
    }),
    todos: {
      list: query({
        args: {},
        handler: ({ db }) => db.table("todos").collect(),
      }),
      add: mutation({
        args: { title: s.string({ min: 1, max: 200 }) },
        handler: ({ db }, { title }) => db.table("todos").insert({ title, done: false }),
      }),
    },
  }));
  const runtime = await openBackend(backend, { path, wal: false });
  return {
    path,
    runtime,
    async close() {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function register(runtime, email) {
  const response = await runtime.handle(request("/__clank/auth/register", {
    method: "POST",
    body: { email, password: "correct horse battery staple", profile: { name: email.split("@")[0] } },
  }));
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  return { response, ...sessionFrom(response, payload) };
}

test("auth issues hardened cookies, hashes credentials, and protects state-changing requests", async () => {
  const fixture = await createFixture();
  try {
    const alice = await register(fixture.runtime, "alice@example.com");
    const setCookie = alice.response.headers.get("set-cookie");
    assert.match(setCookie, /^__Host-clank-id=/);
    assert.match(setCookie, /; Path=\//);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; SameSite=Strict/);
    assert.match(setCookie, /; Secure/);

    const rawToken = alice.cookie.slice(alice.cookie.indexOf("=") + 1);
    const sqlite = new DatabaseSync(fixture.path, { readOnly: true });
    const stored = sqlite.prepare("SELECT token_hash FROM clank_auth_sessions").get();
    const user = sqlite.prepare("SELECT password_hash FROM clank_auth_users").get();
    sqlite.close();
    assert.notEqual(stored.token_hash, rawToken);
    assert.match(stored.token_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(user.password_hash, /correct horse battery staple/);
    assert.match(user.password_hash, /^scrypt\$/);

    const legacyCookie = alice.cookie.replace("__Host-clank-id", "__Host-proact-id");
    const legacySession = await fixture.runtime.handle(request("/__clank/auth/session", {
      cookie: legacyCookie,
    }));
    assert.equal(legacySession.status, 200);
    assert.equal((await legacySession.json()).user.email, "alice@example.com");

    const missingCsrf = await fixture.runtime.handle(request("/__clank/mutation/todos.add", {
      method: "POST",
      body: { title: "private" },
      cookie: alice.cookie,
    }));
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error.code, "INVALID_CSRF");

    const crossSite = await fixture.runtime.handle(request("/__clank/mutation/todos.add", {
      method: "POST",
      body: { title: "private" },
      cookie: alice.cookie,
      csrf: alice.csrf,
      origin: "https://evil.test",
    }));
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error.code, "ORIGIN_MISMATCH");
  } finally {
    await fixture.close();
  }
});

test("owned data, query caches, SSR callers, and sessions remain isolated by user", async () => {
  const fixture = await createFixture();
  try {
    const alice = await register(fixture.runtime, "alice@example.com");
    const bob = await register(fixture.runtime, "bob@example.com");

    const anonymous = await fixture.runtime.handle(request("/__clank/query/todos.list", {
      method: "POST",
      body: {},
    }));
    assert.equal(anonymous.status, 401);

    const addAlice = await fixture.runtime.handle(request("/__clank/mutation/todos.add", {
      method: "POST",
      body: { title: "Alice only" },
      cookie: alice.cookie,
      csrf: alice.csrf,
    }));
    assert.equal(addAlice.status, 200);

    const aliceList = await fixture.runtime.handle(request("/__clank/query/todos.list", {
      method: "POST",
      body: {},
      cookie: alice.cookie,
    }));
    const alicePayload = await aliceList.json();
    assert.deepEqual(alicePayload.value.map((todo) => todo.title), ["Alice only"]);
    assert.equal(alicePayload.value[0]._ownerId, alice.user.id);

    const bobList = await fixture.runtime.handle(request("/__clank/query/todos.list", {
      method: "POST",
      body: {},
      cookie: bob.cookie,
    }));
    assert.deepEqual((await bobList.json()).value, []);

    const aliceCaller = await fixture.runtime.caller(request("/", { cookie: alice.cookie }));
    const bobCaller = await fixture.runtime.caller(request("/", { cookie: bob.cookie }));
    assert.equal(aliceCaller.auth.user.id, alice.user.id);
    assert.deepEqual(aliceCaller.query("todos.list", {}).value.map((todo) => todo.title), ["Alice only"]);
    assert.deepEqual(bobCaller.query("todos.list", {}).value, []);
    const aliceSnapshots = [];
    const stopAlice = aliceCaller.subscribe("todos.list", {}, (value, version) => {
      aliceSnapshots.push({ titles: value.map((todo) => todo.title), version });
    });
    const aliceSnapshotCount = aliceSnapshots.length;
    bobCaller.mutation("todos.add", { title: "Bob only" });
    assert.equal(aliceSnapshots.length, aliceSnapshotCount);
    assert.deepEqual(aliceSnapshots.at(-1).titles, ["Alice only"]);
    assert.deepEqual(bobCaller.query("todos.list", {}).value.map((todo) => todo.title), ["Bob only"]);
    stopAlice();

    const liveAbort = new AbortController();
    const live = await fixture.runtime.handle(new Request(
      "https://todo.test/__clank/live/todos.list?args=%7B%7D",
      { headers: { cookie: alice.cookie }, signal: liveAbort.signal },
    ));
    const liveReader = live.body.getReader();
    assert.equal((await liveReader.read()).done, false);

    const logout = await fixture.runtime.handle(request("/__clank/auth/logout", {
      method: "POST",
      body: {},
      cookie: alice.cookie,
      csrf: alice.csrf,
    }));
    assert.equal(logout.status, 200);
    assert.equal((await liveReader.read()).done, true);
    const afterLogout = await fixture.runtime.caller(request("/", { cookie: alice.cookie }));
    assert.equal(afterLogout.auth.user, null);
  } finally {
    await fixture.close();
  }
});

test("auth errors avoid account lookup details and enforce request limits", async () => {
  const fixture = await createFixture();
  try {
    await register(fixture.runtime, "alice@example.com");
    const wrong = await fixture.runtime.handle(request("/__clank/auth/login", {
      method: "POST",
      body: { email: "alice@example.com", password: "not the password" },
    }));
    const missing = await fixture.runtime.handle(request("/__clank/auth/login", {
      method: "POST",
      body: { email: "missing@example.com", password: "not the password" },
    }));
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.deepEqual(await wrong.json(), await missing.json());

    const unsupported = await fixture.runtime.handle(new Request("https://todo.test/__clank/auth/login", {
      method: "POST",
      headers: { origin: "https://todo.test", "content-type": "text/plain" },
      body: "{}",
    }));
    assert.equal(unsupported.status, 415);

    const invalidProfile = await fixture.runtime.handle(request("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "profile@example.com",
        password: "correct horse battery staple",
        profile: { name: "Profile", admin: true },
      },
    }));
    assert.equal(invalidProfile.status, 422);
    assert.equal((await invalidProfile.json()).error.code, "INVALID_INPUT");

    const oversized = await fixture.runtime.handle(request("/__clank/auth/login", {
      method: "POST",
      body: { email: "a@example.com", password: "x".repeat(17_000) },
    }));
    assert.equal(oversized.status, 413);
  } finally {
    await fixture.close();
  }
});

test("cross-process auth revisions refresh callers and close stale privileged live streams", async () => {
  const fixture = await createFixture();
  let second;
  try {
    const alice = await register(fixture.runtime, "cross-process@example.com");
    fixture.runtime.auth.setRole(alice.user.id, "admin");
    second = await openBackend(fixture.runtime.definition, {
      path: fixture.path,
      wal: false,
      changePollIntervalMs: 10,
    });
    const caller = await second.caller(request("/", { cookie: alice.cookie }));
    assert.equal(caller.auth.user.role, "admin");
    assert.equal(caller.query("admin", {}).value, "admin-only");

    const controller = new AbortController();
    const live = await second.handle(new Request(
      "https://todo.test/__clank/live/admin?args=%7B%7D",
      { headers: { cookie: alice.cookie }, signal: controller.signal },
    ));
    assert.equal(live.status, 200);
    const reader = live.body.getReader();
    assert.equal((await reader.read()).done, false);

    const beforeNoOp = fixture.runtime.version;
    fixture.runtime.auth.setRole(alice.user.id, "admin");
    assert.equal(fixture.runtime.version, beforeNoOp);

    fixture.runtime.auth.setRole(alice.user.id, "user");
    const closed = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Privileged live stream did not close after role downgrade.")),
        1_000,
      )),
    ]);
    assert.equal(closed.done, true);
    assert.equal(caller.auth.user.role, "user");
    assert.throws(() => caller.query("admin", {}), /required role/);
  } finally {
    second?.close();
    await fixture.close();
  }
});

test("email verification and password recovery use expiring single-use tokens and revoke old sessions", async () => {
  const verifications = [];
  const recoveries = [];
  const fixture = await createFixture({
    emailVerification: {
      required: true,
      send: (delivery) => verifications.push(delivery),
    },
    passwordRecovery: {
      send: (delivery) => recoveries.push(delivery),
    },
  });
  try {
    const alice = await register(fixture.runtime, "verified@example.com");
    assert.equal(alice.user.emailVerified, false);
    assert.equal(verifications.length, 1);
    assert.equal(verifications[0].email, "verified@example.com");

    const blocked = await fixture.runtime.handle(request("/__clank/mutation/todos.add", {
      method: "POST",
      body: { title: "Blocked until verified" },
      cookie: alice.cookie,
      csrf: alice.csrf,
    }));
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "EMAIL_UNVERIFIED");

    const verified = await fixture.runtime.handle(request("/__clank/auth/email/verify", {
      method: "POST",
      body: { token: verifications[0].token },
    }));
    assert.equal(verified.status, 200);
    const replay = await fixture.runtime.handle(request("/__clank/auth/email/verify", {
      method: "POST",
      body: { token: verifications[0].token },
    }));
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error.code, "INVALID_TOKEN");

    const session = await fixture.runtime.handle(request("/__clank/auth/session", { cookie: alice.cookie }));
    assert.equal((await session.json()).user.emailVerified, true);
    const allowed = await fixture.runtime.handle(request("/__clank/mutation/todos.add", {
      method: "POST",
      body: { title: "Allowed after verification" },
      cookie: alice.cookie,
      csrf: alice.csrf,
    }));
    assert.equal(allowed.status, 200);

    const missingRecovery = await fixture.runtime.handle(request("/__clank/auth/password/recover", {
      method: "POST",
      body: { email: "missing@example.com" },
    }));
    const existingRecovery = await fixture.runtime.handle(request("/__clank/auth/password/recover", {
      method: "POST",
      body: { email: "verified@example.com" },
    }));
    assert.equal(missingRecovery.status, 202);
    assert.equal(existingRecovery.status, 202);
    assert.deepEqual(await missingRecovery.json(), await existingRecovery.json());
    assert.equal(recoveries.length, 1);

    const reset = await fixture.runtime.handle(request("/__clank/auth/password/reset", {
      method: "POST",
      body: { token: recoveries[0].token, password: "a completely new strong password" },
    }));
    assert.equal(reset.status, 200);
    const oldSession = await fixture.runtime.handle(request("/__clank/auth/session", { cookie: alice.cookie }));
    assert.equal((await oldSession.json()).user, null);
    const oldPassword = await fixture.runtime.handle(request("/__clank/auth/login", {
      method: "POST",
      body: { email: "verified@example.com", password: "correct horse battery staple" },
    }));
    assert.equal(oldPassword.status, 401);
    const newPassword = await fixture.runtime.handle(request("/__clank/auth/login", {
      method: "POST",
      body: { email: "verified@example.com", password: "a completely new strong password" },
    }));
    assert.equal(newPassword.status, 200);
  } finally {
    await fixture.close();
  }
});

test("MFA, bot protection, and a shared rate-limit store compose without leaking credentials", async () => {
  const codes = [];
  const limiterCalls = [];
  const fixture = await createFixture({
    mfa: {
      required: true,
      send: (delivery) => codes.push(delivery),
    },
    botProtection: {
      verify: ({ action, token }) => action === "login" ? token === "human-proof" : true,
    },
    rateLimit: {
      attempts: 3,
      windowMs: 60_000,
      store: {
        async consume(key, limit, windowMs) {
          limiterCalls.push({ key, limit, windowMs });
          return undefined;
        },
      },
    },
  });
  try {
    await register(fixture.runtime, "mfa@example.com");
    const blocked = await fixture.runtime.handle(request("/__clank/auth/login", {
      method: "POST",
      body: { email: "mfa@example.com", password: "correct horse battery staple" },
    }));
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "BOT_CHECK_FAILED");

    const started = await fixture.runtime.handle(request("/__clank/auth/login", {
      method: "POST",
      body: {
        email: "mfa@example.com",
        password: "correct horse battery staple",
        botToken: "human-proof",
      },
    }));
    assert.equal(started.status, 202);
    const startedPayload = await started.json();
    assert.equal(startedPayload.mfa.required, true);
    assert.equal(codes.length, 1);
    assert.ok(limiterCalls.some((call) => call.key.startsWith("login\n")));

    const wrong = await fixture.runtime.handle(request("/__clank/auth/mfa/verify", {
      method: "POST",
      body: { challengeId: startedPayload.mfa.challengeId, code: "000000" },
    }));
    assert.equal(wrong.status, 401);
    const completed = await fixture.runtime.handle(request("/__clank/auth/mfa/verify", {
      method: "POST",
      body: { challengeId: startedPayload.mfa.challengeId, code: codes[0].code },
    }));
    assert.equal(completed.status, 200);
    const replay = await fixture.runtime.handle(request("/__clank/auth/mfa/verify", {
      method: "POST",
      body: { challengeId: startedPayload.mfa.challengeId, code: codes[0].code },
    }));
    assert.equal(replay.status, 401);
  } finally {
    await fixture.close();
  }
});
