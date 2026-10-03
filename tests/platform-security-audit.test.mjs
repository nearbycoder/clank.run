import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

async function pendingWorkspaceRequest(platform, path, token, method, input) {
  let controller;
  let reached;
  const reading = new Promise((resolve) => { reached = resolve; });
  const response = platform.handle(new Request(`${origin}${path}`, {
    method,
    headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: new ReadableStream({ start(value) { controller = value; }, pull() { reached(); } }, { highWaterMark: 0 }),
    duplex: "half",
  }));
  await reading;
  return {
    response,
    finish() {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
      controller.close();
    },
  };
}

for (const transition of ["actor-demoted", "actor-removed", "target-owner", "last-owner"]) test(`workspace mutations recheck roles after ${transition} during request parsing`, { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-workspace-race-"));
  const platform = await openPlatform({ dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false } });
  const pending = [];
  try {
    const owner = await account(platform, "race-owner@example.invalid");
    const admin = await account(platform, "race-admin@example.invalid");
    const target = await account(platform, "race-target@example.invalid");
    const organization = (await call(platform, "/api/organizations", {
      token: owner.token, method: "POST", body: { name: "Race workspace", slug: "race-workspace" },
    }, 201)).payload.organization;
    const base = `/api/organizations/${organization.id}`;
    for (const [member, role] of [[admin, "admin"], [target, "developer"]]) {
      const invitation = (await call(platform, `${base}/invitations`, {
        token: owner.token, method: "POST", body: { email: member.user.email, role },
      }, 201)).payload.invitation;
      await call(platform, "/api/invitations/accept", {
        token: member.token, method: "POST", body: { token: invitation.token },
      });
    }
    pending.push(await pendingWorkspaceRequest(platform, `${base}/members/${transition === "last-owner" ? admin.user.id : target.user.id}`,
      admin.token, "PATCH", { role: "viewer" }));
    if (transition.startsWith("actor-")) {
      pending.push(await pendingWorkspaceRequest(platform, `${base}/invitations`, admin.token, "POST", {
        email: "must-not-invite@example.invalid", role: "admin",
      }));
      await call(platform, `${base}/members/${admin.user.id}`, {
        token: owner.token, method: transition === "actor-removed" ? "DELETE" : "PATCH", body: { role: "viewer" },
      });
    } else if (transition === "target-owner") {
      await call(platform, `${base}/members/${target.user.id}`, { token: owner.token, method: "PATCH", body: { role: "owner" } });
    } else {
      await call(platform, `${base}/members/${admin.user.id}`, { token: owner.token, method: "PATCH", body: { role: "owner" } });
      await call(platform, `${base}/members/${owner.user.id}`, { token: owner.token, method: "DELETE" });
    }
    for (const mutation of pending) {
      mutation.finish();
      const response = await mutation.response;
      const payload = await response.json();
      assert.equal(response.status, transition === "last-owner" ? 409 : transition === "actor-removed" ? 404 : 403, JSON.stringify(payload));
      if (transition === "last-owner") assert.equal(payload.error.code, "LAST_OWNER");
    }
    const current = (await call(platform, base, { token: transition === "last-owner" ? admin.token : owner.token })).payload;
    assert.equal(current.members.find((member) => member.id === target.user.id).role, transition === "target-owner" ? "owner" : "developer");
    assert.equal(current.invitations.length, 0);
    assert.ok(current.members.some((member) => member.role === "owner"));
  } finally {
    for (const mutation of pending) {
      try { mutation.finish(); } catch {}
    }
    await Promise.allSettled(pending.map((mutation) => mutation.response));
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const operation of ["put", "stage", "validate", "activate", "rollback"]) test(`secret ${operation} rejects token revocation during body intake`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-secret-authority-"));
  const platform = await openPlatform({ dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false } });
  let pending;
  try {
    const owner = await account(platform, "secret-owner@example.invalid");
    const project = (await call(platform, "/api/projects", {
      token: owner.token, method: "POST", body: { name: "Secret app", slug: "secret-app" },
    }, 201)).payload.project;
    const base = `/api/projects/${project.id}/secrets`;
    await call(platform, base, { token: owner.token, method: "PUT", body: { values: { PARTNER_KEY: "synthetic-old" } } });
    const rotation = (await call(platform, `${base}/rotations`, {
      token: owner.token, method: "POST", body: { name: "PARTNER_KEY", value: "synthetic-new" },
    }, 201)).payload.rotation;
    if (operation === "activate" || operation === "rollback") {
      await call(platform, `${base}/rotations/${rotation.id}/validate`, { token: owner.token, method: "POST", body: {} });
    }
    if (operation === "rollback") {
      await call(platform, `${base}/rotations/${rotation.id}/activate`, { token: owner.token, method: "POST", body: {} });
    }
    const sqlite = new DatabaseSync(join(directory, "control.sqlite"), { readOnly: true });
    try {
      const snapshot = () => ({
        secrets: sqlite.prepare("SELECT * FROM clank_platform_secrets ORDER BY name").all(),
        rotations: sqlite.prepare("SELECT * FROM clank_platform_secret_rotations ORDER BY id").all(),
      });
      const before = snapshot();
      pending = await pendingWorkspaceRequest(platform,
        operation === "put" ? base : operation === "stage" ? `${base}/rotations` : `${base}/rotations/${rotation.id}/${operation}`,
        owner.token, operation === "put" ? "PUT" : "POST",
        operation === "put" ? { values: { PARTNER_KEY: "must-not-write" } }
          : operation === "stage" ? { name: "OTHER_KEY", value: "must-not-stage" } : {});
      await call(platform, "/api/tokens/current", { token: owner.token, method: "DELETE" });
      pending.finish();
      const denied = await pending.response;
      assert.equal(denied.status, 401, await denied.text());
      assert.deepEqual(snapshot(), before);
    } finally { sqlite.close(); }
  } finally {
    try { pending?.finish(); } catch {}
    if (pending) await pending.response;
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("secret validation rechecks session revocation after the provider check", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-secret-validation-authority-"));
  let release;
  let reached;
  const paused = new Promise((resolve) => { reached = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const platform = await openPlatform({
    dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false },
    validateSecret: async () => { reached(); await barrier; return true; },
  });
  let pending;
  try {
    const owner = await account(platform, "validation-owner@example.invalid");
    const project = (await call(platform, "/api/projects", {
      token: owner.token, method: "POST", body: { name: "Validation app", slug: "validation-app" },
    }, 201)).payload.project;
    const base = `/api/projects/${project.id}/secrets/rotations`;
    const rotation = (await call(platform, base, {
      token: owner.token, method: "POST", body: { name: "PARTNER_KEY", value: "synthetic-candidate" },
    }, 201)).payload.rotation;
    pending = platform.handle(new Request(`${origin}${base}/${rotation.id}/validate`, {
      method: "POST", headers: { origin, cookie: owner.cookie, "x-clank-csrf": owner.csrf, "content-type": "application/json" }, body: "{}",
    }));
    await paused;
    await call(platform, "/__clank/auth/logout", { method: "POST", cookie: owner.cookie, csrf: owner.csrf, body: {} });
    release();
    const denied = await pending;
    assert.equal(denied.status, 401, await denied.text());
    const rotations = (await call(platform, base, { token: owner.token })).payload.rotations;
    assert.equal(rotations[0].state, "validating");
    await call(platform, `${base}/${rotation.id}/activate`, { token: owner.token, method: "POST", body: {} }, 409);
  } finally {
    release();
    if (pending) await pending;
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const operation of ["organization", "project", "runtime", "domain"]) test(`${operation} mutation rejects credentials revoked during body intake`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-mutation-authority-"));
  const platform = await openPlatform({
    dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false },
    ingress: { enabled: true, customDomainTarget: "edge.example.test", domainRecheckIntervalMs: false,
      resolveCname: async () => ["edge.example.test"], resolve4: async () => [], resolve6: async () => [] },
  });
  let pending;
  try {
    const owner = await account(platform, "mutation-owner@example.invalid");
    const project = (await call(platform, "/api/projects", {
      token: owner.token, method: "POST", body: { name: "Existing app", slug: "existing-app" },
    }, 201)).payload.project;
    const sqlite = new DatabaseSync(join(directory, "control.sqlite"), { readOnly: true });
    try {
      const snapshot = () => ({
        organizations: sqlite.prepare("SELECT id FROM clank_platform_organizations ORDER BY id").all(),
        projects: sqlite.prepare("SELECT id, runtime_policy, idle_timeout_ms FROM clank_platform_projects ORDER BY id").all(),
        domains: sqlite.prepare("SELECT id FROM clank_platform_domains ORDER BY id").all(),
      });
      const before = snapshot();
      const paths = { organization: "/api/organizations", project: "/api/projects", runtime: `/api/projects/${project.id}/runtime`, domain: `/api/projects/${project.id}/domains` };
      const bodies = { organization: { name: "Must not create", slug: "must-not-create" }, project: { name: "Must not create", slug: "must-not-create" },
        runtime: { policy: "always_on", idleTimeoutMs: 12345 }, domain: { hostname: "must-not-create.example.test" } };
      pending = await pendingWorkspaceRequest(platform, paths[operation], owner.token, operation === "runtime" ? "PUT" : "POST", bodies[operation]);
      await call(platform, "/api/tokens/current", { token: owner.token, method: "DELETE" });
      pending.finish();
      const denied = await pending.response;
      assert.equal(denied.status, 401, await denied.text());
      assert.deepEqual(snapshot(), before);
    } finally { sqlite.close(); }
  } finally {
    try { pending?.finish(); } catch {}
    if (pending) await pending.response;
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("domain verification rejects credentials revoked during DNS lookup", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-domain-authority-"));
  let release;
  let reached;
  let verificationValue;
  const paused = new Promise((resolve) => { reached = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const platform = await openPlatform({
    dataDirectory: directory, publicUrl: origin, signup: true, backups: { intervalMs: false },
    ingress: { enabled: true, customDomainTarget: "edge.example.test", domainRecheckIntervalMs: false,
      resolveTxt: async () => { reached(); await barrier; return [[verificationValue]]; },
      resolveCname: async () => ["edge.example.test"], resolve4: async () => [], resolve6: async () => [] },
  });
  let pending;
  try {
    const owner = await account(platform, "domain-owner@example.invalid");
    const project = (await call(platform, "/api/projects", {
      token: owner.token, method: "POST", body: { name: "Domain app", slug: "domain-app" },
    }, 201)).payload.project;
    const base = `/api/projects/${project.id}/domains`;
    const domain = (await call(platform, base, {
      token: owner.token, method: "POST", body: { hostname: "authority.example.test" },
    }, 201)).payload.domain;
    const sqlite = new DatabaseSync(join(directory, "control.sqlite"), { readOnly: true });
    try {
      verificationValue = sqlite.prepare("SELECT record_value FROM clank_platform_domains WHERE id = ?").get(domain.id).record_value;
      pending = platform.handle(new Request(`${origin}${base}/${domain.id}/verify`, {
        method: "POST", headers: { origin, authorization: `Bearer ${owner.token}`, "content-type": "application/json" }, body: "{}",
      }));
      await paused;
      await call(platform, "/api/tokens/current", { token: owner.token, method: "DELETE" });
      release();
      const denied = await pending;
      assert.equal(denied.status, 401, await denied.text());
      assert.equal(sqlite.prepare("SELECT status FROM clank_platform_domains WHERE id = ?").get(domain.id).status, "pending");
    } finally { sqlite.close(); }
  } finally {
    release();
    if (pending) await pending;
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});
