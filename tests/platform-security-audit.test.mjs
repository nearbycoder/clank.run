import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlatform } from "../dist/platform.js";

const origin = "http://127.0.0.1:4200";

async function call(platform, path, { method = "GET", body, token, cookie, csrf } = {}, expected = 200) {
  const response = await platform.handle(new Request(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-clank-csrf": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const payload = await response.json();
  assert.equal(response.status, expected, JSON.stringify(payload));
  return { payload, response };
}

async function account(platform, email) {
  const registration = await call(platform, "/__clank/auth/register", {
    method: "POST", body: { email, password: "correct horse battery staple" },
  }, 201);
  const cookie = registration.response.headers.get("set-cookie").split(";", 1)[0];
  const csrf = registration.payload.csrfToken;
  const device = (await call(platform, "/api/device/start", {
    method: "POST", body: { clientName: "security regression" },
  }, 201)).payload;
  await call(platform, "/api/device/approve", {
    method: "POST", cookie, csrf, body: { code: device.userCode },
  });
  const token = (await call(platform, "/api/device/token", {
    method: "POST", body: { deviceCode: device.deviceCode },
  })).payload.accessToken;
  return { cookie, csrf, token, user: registration.payload.user };
}

async function pendingTokenRequest(platform, projectId, authentication) {
  const { token, cookie, csrf } = typeof authentication === "string" ? { token: authentication } : authentication;
  let bodyController;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const body = new ReadableStream({
    start(controller) { bodyController = controller; },
    pull() { started(); },
  }, { highWaterMark: 0 });
  const response = platform.handle(new Request(`${origin}/api/projects/${projectId}/tokens`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-clank-csrf": csrf } : {}),
    },
    body,
    duplex: "half",
  }));
  await reading;
  return {
    response,
    finish() {
      bodyController.enqueue(new TextEncoder().encode(JSON.stringify({ permissions: ["read"], expiresIn: 300 })));
      bodyController.close();
    },
  };
}

test("workspace removal revokes a project's creator through account and browser credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-workspace-revocation-"));
  const platform = await openPlatform({ dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false } });
  try {
    const owner = await account(platform, "workspace-owner@example.invalid");
    const creator = await account(platform, "project-creator@example.invalid");
    const organization = (await call(platform, "/api/organizations", {
      token: owner.token, method: "POST", body: { name: "Shared workspace", slug: "shared-workspace" },
    }, 201)).payload.organization;
    const invitation = (await call(platform, `/api/organizations/${organization.id}/invitations`, {
      token: owner.token, method: "POST", body: { email: creator.user.email, role: "admin" },
    }, 201)).payload.invitation;
    await call(platform, "/api/invitations/accept", {
      token: creator.token, method: "POST", body: { token: invitation.token },
    });
    const project = (await call(platform, "/api/projects", {
      token: creator.token, method: "POST", body: { name: "Shared app", slug: "shared-app", organizationId: organization.id },
    }, 201)).payload.project;
    await call(platform, `/api/projects/${project.id}`, { token: creator.token });
    const pending = await pendingTokenRequest(platform, project.id, creator.token);
    await call(platform, `/api/organizations/${organization.id}/members/${creator.user.id}`, {
      token: owner.token, method: "DELETE", body: {},
    });
    pending.finish();
    const rejected = await pending.response;
    assert.equal(rejected.status, 404, JSON.stringify(await rejected.json()));
    for (const credentials of [{ token: creator.token }, { cookie: creator.cookie, csrf: creator.csrf }]) {
      await call(platform, `/api/projects/${project.id}`, credentials, 404);
      await call(platform, `/api/projects/${project.id}/secrets`, {
        ...credentials, method: "PUT", body: { values: { REMOVED_MEMBER_SECRET: "denied" } },
      }, 404);
      for (const path of ["/api/projects", "/api/dashboard"]) {
        const result = (await call(platform, path, credentials)).payload;
        assert.equal(result.projects.some((entry) => entry.id === project.id), false);
      }
    }
    await call(platform, `/api/projects/${project.id}`, { token: owner.token });
  } finally {
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("project token delegation cannot expand permissions or outlive its issuing token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-token-delegation-"));
  const platform = await openPlatform({ dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false } });
  try {
    const owner = await account(platform, "token-owner@example.invalid");
    const project = (await call(platform, "/api/projects", {
      token: owner.token, method: "POST", body: { name: "Token app", slug: "token-app" },
    }, 201)).payload.project;
    const endpoint = `/api/projects/${project.id}/tokens`;
    const parent = (await call(platform, endpoint, {
      token: owner.token, method: "POST", body: { permissions: ["read", "tokens"], expiresIn: 300 },
    }, 201)).payload.token;
    for (const permission of ["deploy", "secrets", "previews"]) {
      const rejected = (await call(platform, endpoint, {
        token: parent.accessToken, method: "POST", body: { permissions: [permission], expiresIn: 300 },
      }, 403)).payload;
      assert.equal(rejected.error.code, "TOKEN_SCOPE_DENIED");
    }
    const child = (await call(platform, endpoint, {
      token: parent.accessToken, method: "POST", body: { permissions: ["read"], expiresIn: 3600 },
    }, 201)).payload.token;
    assert.deepEqual(child.permissions, ["read"]);
    assert.equal(child.expiresAt, parent.expiresAt);
    await call(platform, `/api/projects/${project.id}`, { token: child.accessToken });
    await call(platform, `/api/projects/${project.id}/secrets`, { token: child.accessToken }, 403);
    const pending = await pendingTokenRequest(platform, project.id, parent.accessToken);
    await call(platform, "/api/tokens/current", { token: parent.accessToken, method: "DELETE" });
    pending.finish();
    const rejected = await pending.response;
    assert.equal(rejected.status, 401, JSON.stringify(await rejected.json()));
  } finally {
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser token issuance fails when its original session is revoked during body intake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-browser-token-revocation-"));
  const platform = await openPlatform({ dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false } });
  try {
    const owner = await account(platform, "browser-token-owner@example.invalid");
    const project = (await call(platform, "/api/projects", {
      token: owner.token, method: "POST", body: { name: "Browser token app", slug: "browser-token-app" },
    }, 201)).payload.project;
    const before = (await call(platform, "/api/tokens", { token: owner.token })).payload.tokens;
    const pending = await pendingTokenRequest(platform, project.id, { cookie: owner.cookie, csrf: owner.csrf });
    await call(platform, "/__clank/auth/logout", {
      cookie: owner.cookie, csrf: owner.csrf, method: "POST", body: {},
    });
    pending.finish();
    const rejected = await pending.response;
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, "UNAUTHENTICATED");
    const after = (await call(platform, "/api/tokens", { token: owner.token })).payload.tokens;
    assert.deepEqual(after.map((token) => token.id), before.map((token) => token.id));
  } finally {
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});
