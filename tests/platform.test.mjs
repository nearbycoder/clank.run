import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDeploymentBundle,
  deploymentDigest,
  openPlatform,
  parseDeploymentConfig,
} from "../dist/index.js";

function jsonRequest(path, { method = "GET", body, token, cookie, csrf, origin = "http://127.0.0.1:4200" } = {}) {
  return new Request(`http://127.0.0.1:4200${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", origin }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-clank-csrf": csrf } : {}),
      "x-clank-client-ip": "127.0.0.1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function payload(platform, request, expected = 200) {
  const response = await platform.handle(request);
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

async function authorizeCli(platform, email) {
  const registered = await platform.handle(jsonRequest("/__clank/auth/register", {
    method: "POST",
    body: {
      email,
      password: "correct horse battery staple",
      profile: { name: email.split("@")[0] },
    },
  }));
  assert.equal(registered.status, 201);
  const session = await registered.json();
  const cookie = registered.headers.get("set-cookie").split(";", 1)[0];
  const started = await payload(platform, jsonRequest("/api/device/start", {
    method: "POST",
    body: { clientName: "test CLI" },
  }), 201);
  await payload(platform, jsonRequest("/api/device/approve", {
    method: "POST",
    body: { code: started.userCode },
    cookie,
    csrf: session.csrfToken,
  }));
  const token = await payload(platform, jsonRequest("/api/device/token", {
    method: "POST",
    body: { deviceCode: started.deviceCode },
  }));
  return { accessToken: token.accessToken, user: session.user };
}

async function appArtifact(root, label, migrations, allowUnsafeMigrations = false) {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(join(root, "dist", "server.js"), `
    import { createServer } from "node:http";
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(request.url === "/healthz" ? "ok" : ${JSON.stringify(label)});
      if (request.url === "/crash") setImmediate(() => process.exit(17));
    });
    server.listen(Number(process.env.PORT), process.env.HOST);
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);
  for (const [name, sql] of migrations) await writeFile(join(root, "migrations", name), sql);
  const config = parseDeploymentConfig({
    version: 1,
    entry: "dist/server.js",
    include: ["dist", "migrations"],
    database: { path: "app.sqlite", migrations: "migrations", allowUnsafeMigrations },
    health: { path: "/healthz", timeoutMs: 5_000 },
    env: {},
  });
  return createDeploymentBundle(root, config, {
    frameworkVersion: "0.5.0",
    nodeVersion: process.version,
  });
}

async function deploy(platform, projectId, token, artifact, key) {
  const digest = await deploymentDigest(artifact);
  const response = await platform.handle(new Request(
    `http://127.0.0.1:4200/api/projects/${projectId}/releases`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/vnd.clank.deploy+gzip",
        "content-length": String(artifact.byteLength),
        "x-clank-content-sha256": digest,
        "x-clank-idempotency-key": key,
      },
      body: artifact,
    },
  ));
  return { response, body: await response.json() };
}

test("platform device auth, ownership, encrypted secrets, atomic deploy, migrations, and rollback work end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-"));
  const source = join(root, "source");
  const dns = new Map();
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4510,
    appPortEnd: 4520,
    signup: true,
    ingress: {
      baseDomain: "apps.example.test",
      resolveTxt: async (hostname) => dns.get(hostname) ?? [],
    },
  });
  try {
    const owner = await authorizeCli(platform, "owner@example.com");
    const other = await authorizeCli(platform, "other@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Atomic Todo", slug: "atomic-todo" },
    }), 201);
    const projectId = created.project.id;
    const isolated = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: other.accessToken,
    }));
    assert.equal(isolated.status, 404);

    const unsafeArtifact = await appArtifact(source, "unsafe", [
      ["0001_unsafe.sql", "PRAGMA journal_mode = OFF;\n"],
    ], true);
    const unsafe = await deploy(platform, projectId, owner.accessToken, unsafeArtifact, "unsafe-release-key");
    assert.equal(unsafe.response.status, 403);
    assert.equal(unsafe.body.error.code, "UNSAFE_MIGRATIONS_DISABLED");

    const secretValue = "high-entropy-platform-secret";
    await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      method: "PUT",
      token: owner.accessToken,
      body: { values: { API_SECRET: secretValue } },
    }));
    const listed = await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      token: owner.accessToken,
    }));
    assert.deepEqual(listed.secrets.map((secret) => secret.name), ["API_SECRET"]);
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(secretValue));
    const controlBytes = await readFile(join(root, "platform", "control.sqlite"));
    assert.equal(controlBytes.includes(Buffer.from(secretValue)), false);

    const firstArtifact = await appArtifact(source, "release-one", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
    ]);
    const projectDirectory = join(root, "platform", "projects", projectId);
    const dataDirectory = join(projectDirectory, "data");
    await mkdir(dataDirectory, { recursive: true });
    await symlink(join(root, "platform", "control.sqlite"), join(dataDirectory, "app.sqlite"));
    const linkedDatabase = await deploy(platform, projectId, owner.accessToken, firstArtifact, "symlink-release-key");
    assert.equal(linkedDatabase.response.status, 422);
    assert.match(linkedDatabase.body.error.message, /symbolic link|regular file/);
    await unlink(join(dataDirectory, "app.sqlite"));

    const first = await deploy(platform, projectId, owner.accessToken, firstArtifact, "first-release-key-0001");
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.equal(await fetch(first.body.release.directUrl).then((response) => response.text()), "release-one");
    const managed = await platform.handle(new Request("https://atomic-todo.apps.example.test/"));
    assert.equal(managed.status, 200);
    assert.equal(await managed.text(), "release-one");
    const customDomain = await payload(platform, jsonRequest(`/api/projects/${projectId}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "tasks.customer.test" },
    }), 201);
    dns.set(customDomain.domain.recordName, [[customDomain.domain.recordValue]]);
    await payload(platform, jsonRequest(
      `/api/projects/${projectId}/domains/${customDomain.domain.id}/verify`,
      { method: "POST", token: owner.accessToken, body: {} },
    ));
    const customIngress = await platform.handle(new Request("https://tasks.customer.test/"));
    assert.equal(customIngress.status, 200);
    assert.equal(await customIngress.text(), "release-one");
    await fetch(`${first.body.release.directUrl}/crash`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await waitFor(async () =>
      await fetch(first.body.release.directUrl).then((response) => response.text()).catch(() => "") === "release-one");

    const databasePath = join(projectDirectory, "data", "app.sqlite");
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "platform", "master.key"))).mode & 0o777, 0o600);
    let database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count, 1);
    database.prepare("INSERT INTO items (value) VALUES (?)").run("preserve me");
    database.close();

    const secondArtifact = await appArtifact(source, "release-two", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
      ["0002_add_labels.sql", "CREATE TABLE labels (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
    ]);
    const second = await deploy(platform, projectId, owner.accessToken, secondArtifact, "second-release-key-0002");
    assert.equal(second.response.status, 201, JSON.stringify(second.body));
    assert.equal(await fetch(second.body.release.directUrl).then((response) => response.text()), "release-two");
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count, 2);
    database.close();

    const backup = await payload(platform, jsonRequest(`/api/projects/${projectId}/backups`, {
      method: "POST",
      token: owner.accessToken,
      body: { reason: "before bulk import" },
    }), 201);
    const listedBackups = await payload(platform, jsonRequest(`/api/projects/${projectId}/backups`, {
      token: owner.accessToken,
    }));
    assert.equal(listedBackups.backups[0].id, backup.backup.id);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/backups/${backup.backup.id}/verify`, {
      method: "POST",
      token: owner.accessToken,
      body: {},
    }));
    database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO items (value) VALUES (?)").run("remove on restore");
    database.close();
    const wrongBackupConfirmation = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/backups/${backup.backup.id}/restore`,
      {
        method: "POST",
        token: owner.accessToken,
        body: { confirmation: "restore it" },
      },
    ));
    assert.equal(wrongBackupConfirmation.status, 400);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/backups/${backup.backup.id}/restore`, {
      method: "POST",
      token: owner.accessToken,
      body: { confirmation: `restore-backup atomic-todo ${backup.backup.id}` },
    }));
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(database.prepare("SELECT value FROM items ORDER BY id").all().map((row) => row.value), ["preserve me"]);
    database.close();

    const rolledBack = await payload(platform, jsonRequest(`/api/projects/${projectId}/rollback`, {
      method: "POST",
      token: owner.accessToken,
      body: {
        releaseId: first.body.release.id,
        restoreData: true,
        confirmation: "restore atomic-todo",
      },
    }));
    assert.equal(rolledBack.release.id, first.body.release.id);
    assert.equal(await fetch(first.body.release.directUrl).then((response) => response.text()), "release-one");
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM clank_migrations").get().count, 1);
    assert.deepEqual(database.prepare("SELECT value FROM items").all().map((row) => row.value), ["preserve me"]);
    assert.throws(() => database.prepare("SELECT * FROM labels").all(), /no such table/);
    database.close();

    const tampered = await appArtifact(source, "tampered", [
      ["0001_create_items.sql", "CREATE TABLE changed_history (id INTEGER PRIMARY KEY);\n"],
    ]);
    const rejected = await deploy(platform, projectId, owner.accessToken, tampered, "tampered-release-key");
    assert.equal(rejected.response.status, 422);
    assert.equal(rejected.body.error.code, "DEPLOYMENT_FAILED");
    assert.equal(await fetch(first.body.release.directUrl).then((response) => response.text()), "release-one");

    const audit = await payload(platform, jsonRequest(`/api/projects/${projectId}/audit`, {
      token: owner.accessToken,
    }));
    assert.ok(audit.events.some((event) => event.action === "release.activate"));
    assert.ok(audit.events.some((event) => event.action === "release.rollback"));
    assert.ok(audit.events.some((event) => event.action === "release.fail"));

    await payload(platform, jsonRequest("/api/tokens/current", {
      method: "DELETE",
      token: other.accessToken,
    }));
    const revoked = await platform.handle(jsonRequest("/api/account", { token: other.accessToken }));
    assert.equal(revoked.status, 401);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("organizations enforce RBAC, invitations, membership revocation, and project-scoped CLI credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-orgs-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4540,
    appPortEnd: 4550,
    signup: true,
  });
  try {
    const owner = await authorizeCli(platform, "org-owner@example.com");
    const admin = await authorizeCli(platform, "org-admin@example.com");
    const outsider = await authorizeCli(platform, "outsider@example.com");
    const first = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Organization Todo", slug: "organization-todo" },
    }), 201);
    const second = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Other Project", slug: "other-project" },
    }), 201);
    const projectId = first.project.id;
    const organizationId = first.project.organizationId;
    assert.equal(second.project.organizationId, organizationId);

    const invitation = await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      token: owner.accessToken,
      body: { email: "org-admin@example.com", role: "admin" },
    }), 201);
    await payload(platform, jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: admin.accessToken,
      body: { token: invitation.invitation.token },
    }));
    const replay = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: admin.accessToken,
      body: { token: invitation.invitation.token },
    }));
    assert.equal(replay.status, 400);

    const visible = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: admin.accessToken,
    }));
    assert.equal(visible.project.id, projectId);
    const hidden = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: outsider.accessToken,
    }));
    assert.equal(hidden.status, 404);

    const scoped = await payload(platform, jsonRequest(`/api/projects/${projectId}/tokens`, {
      method: "POST",
      token: admin.accessToken,
      body: {
        name: "Project deploy bot",
        permissions: ["read", "deploy"],
        expiresIn: 3600,
      },
    }), 201);
    const projectToken = scoped.token.accessToken;
    const scopedAccount = await payload(platform, jsonRequest("/api/account", { token: projectToken }));
    assert.equal(scopedAccount.token.projectId, projectId);
    assert.deepEqual(scopedAccount.token.permissions, ["read", "deploy"]);
    await payload(platform, jsonRequest(`/api/projects/${projectId}`, { token: projectToken }));
    const otherProject = await platform.handle(jsonRequest(`/api/projects/${second.project.id}`, {
      token: projectToken,
    }));
    assert.equal(otherProject.status, 404);
    const scopedSecrets = await platform.handle(jsonRequest(`/api/projects/${projectId}/secrets`, {
      token: projectToken,
    }));
    assert.equal(scopedSecrets.status, 403);
    assert.equal((await scopedSecrets.json()).error.code, "TOKEN_SCOPE_DENIED");

    const adminCannotRemoveOwner = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/members/${owner.user.id}`,
      { method: "DELETE", token: admin.accessToken, body: {} },
    ));
    assert.equal(adminCannotRemoveOwner.status, 403);
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {},
    }));
    const revokedScoped = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: projectToken,
    }));
    assert.equal(revokedScoped.status, 401);
    const revokedMembership = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: admin.accessToken,
    }));
    assert.equal(revokedMembership.status, 404);
    const adminAccountStillWorks = await platform.handle(jsonRequest("/api/account", {
      token: admin.accessToken,
    }));
    assert.equal(adminAccountStillWorks.status, 200);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform signup defaults to one-time first-account bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-bootstrap-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4530,
    appPortEnd: 4531,
  });
  try {
    const first = await platform.handle(jsonRequest("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "first@example.com",
        password: "correct horse battery staple",
        profile: { name: "first" },
      },
    }));
    assert.equal(first.status, 201);
    const signedInCookie = first.headers.get("set-cookie").split(";", 1)[0]
      .replace("clank-id", "proact-id");
    const signedInConsole = await platform.handle(jsonRequest("/", { cookie: signedInCookie }));
    assert.equal(signedInConsole.status, 200);
    const signedInHtml = await signedInConsole.text();
    assert.match(signedInHtml, /<h2 id="auth-title">Account<\/h2>/);
    assert.doesNotMatch(signedInHtml, /<h2 id="auth-title">Sign in<\/h2>/);
    const second = await platform.handle(jsonRequest("/__clank/auth/register", {
      method: "POST",
      body: {
        email: "second@example.com",
        password: "correct horse battery staple",
        profile: { name: "second" },
      },
    }));
    assert.equal(second.status, 403);
    assert.equal((await second.json()).error.code, "SIGNUP_DISABLED");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Timed out waiting for condition.");
}
