import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
  return { accessToken: token.accessToken, user: session.user, cookie, csrfToken: session.csrfToken };
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
    if (process.env.AUDIT_SHORT_SECRET) console.log("secret=" + process.env.AUDIT_SHORT_SECRET);
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

test("browser project management enforces organization and custom-domain quotas transactionally", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-quota-"));
  const dns = new Map();
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4590,
    appPortEnd: 4595,
    signup: true,
    maxArtifactBytes: 64,
    limits: {
      organizationsPerAccount: 2,
      projectsPerAccount: 2,
      projectsPerOrganization: 1,
      domainsPerProject: 1,
      metricRetentionDays: 7,
    },
    ingress: {
      enabled: true,
      customDomainTarget: "edge.example.test",
      tlsAskToken: "quota-test-tls-token",
      resolveTxt: async (hostname) => dns.get(hostname) ?? [],
      resolveCname: async () => ["edge.example.test"],
      resolve4: async () => [],
      resolve6: async () => [],
    },
  });
  try {
    const owner = await authorizeCli(platform, "quota@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", { cookie: owner.cookie }));
    assert.equal(dashboard.limits.organizationsPerAccount, 2);
    assert.equal(dashboard.limits.projectsPerAccount, 2);
    assert.deepEqual(dashboard.account.usage, { organizations: 1, projects: 0 });
    const organizationId = dashboard.organizations[0].id;
    const refreshedPage = await platform.handle(new Request("http://127.0.0.1:4200/", {
      headers: { cookie: owner.cookie },
    }));
    const refreshedHtml = await refreshedPage.text();
    assert.match(refreshedHtml, /const initial=\{"authenticated":true,/);
    assert.match(refreshedHtml, /"email":"quota@example\.com"/);

    const missingCsrf = await platform.handle(jsonRequest("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "No CSRF", slug: "no-csrf", organizationId },
    }));
    assert.equal(missingCsrf.status, 403);

    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { name: "Only Site", slug: "only-site", organizationId },
    }), 201);
    const overLimit = await platform.handle(jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Second Site", slug: "second-site", organizationId },
    }));
    assert.equal(overLimit.status, 409);
    assert.equal((await overLimit.json()).error.code, "PROJECT_LIMIT_REACHED");

    let artifactCancelled = false;
    const oversizedArtifact = await platform.handle(new Request(
      `http://127.0.0.1:4200/api/projects/${created.project.id}/releases`,
      {
        method: "POST",
        duplex: "half",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/vnd.clank.deploy+gzip",
          "x-clank-content-sha256": "0".repeat(64),
          "x-clank-idempotency-key": "bounded-artifact-test",
        },
        body: new ReadableStream({
          pull(controller) { controller.enqueue(new Uint8Array(40)); },
          cancel() { artifactCancelled = true; },
        }),
      },
    ));
    assert.equal(oversizedArtifact.status, 413);
    assert.equal((await oversizedArtifact.json()).error.code, "ARTIFACT_TOO_LARGE");
    assert.equal(artifactCancelled, true);

    const reservedDomain = await platform.handle(jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { hostname: "edge.example.test" },
    }));
    assert.equal(reservedDomain.status, 409);
    assert.equal((await reservedDomain.json()).error.code, "DOMAIN_RESERVED");

    const firstDomain = await payload(platform, jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { hostname: "one.customer.test" },
    }), 201);
    dns.set(firstDomain.domain.recordName, [[firstDomain.domain.recordValue]]);
    const verified = await payload(platform, jsonRequest(
      `/api/projects/${created.project.id}/domains/${firstDomain.domain.id}/verify`,
      { method: "POST", cookie: owner.cookie, csrf: owner.csrfToken, body: {} },
    ));
    assert.equal(verified.domain.ownership.status, "verified");
    assert.equal(verified.domain.routing.status, "ready");
    assert.equal((await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=quota-test-tls-token&domain=one.customer.test",
    ))).status, 403, "sites without a deployed release cannot allocate a certificate");
    const domainOverLimit = await platform.handle(jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "two.customer.test" },
    }));
    assert.equal(domainOverLimit.status, 409);
    assert.equal((await domainOverLimit.json()).error.code, "DOMAIN_LIMIT_REACHED");
    const domains = await payload(platform, jsonRequest(`/api/projects/${created.project.id}/domains`, {
      token: owner.accessToken,
    }));
    assert.equal(domains.domains.length, 1, "a rejected domain must never survive rollback");
    const control = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
    assert.equal(control.prepare(
      "SELECT count(*) AS count FROM clank_platform_domains WHERE project_id = ?",
    ).get(created.project.id).count, 1);
    control.close();
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("custom-domain routing is reconciled automatically with durable bounded claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-domain-recheck-"));
  let routeReady = false;
  let hangRouting = false;
  let routingLookups = 0;
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4560,
    appPortEnd: 4565,
    signup: true,
    ingress: {
      enabled: true,
      customDomainTarget: "edge.example.test",
      domainRecheckIntervalMs: 1_000,
      domainRecheckBatchSize: 1,
      domainRecheckTimeoutMs: 500,
      resolveTxt: async () => [],
      resolveCname: async () => {
        routingLookups++;
        if (hangRouting) return new Promise(() => {});
        return routeReady ? ["edge.example.test"] : ["elsewhere.example.test"];
      },
      resolve4: async () => [],
      resolve6: async () => [],
    },
  });
  try {
    const owner = await authorizeCli(platform, "domain-recheck@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", { token: owner.accessToken }));
    assert.equal(dashboard.domains.automation.enabled, true);
    assert.equal(dashboard.domains.automation.intervalMs, 1_000);
    assert.equal(dashboard.domains.automation.batchSize, 1);
    assert.equal(dashboard.domains.automation.timeoutMs, 500);
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Automatic DNS",
        slug: "automatic-dns",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const domain = await payload(platform, jsonRequest(`/api/projects/${project.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "automatic.customer.test" },
    }), 201);
    assert.equal(domain.domain.routing.status, "misconfigured");
    const initialLookups = routingLookups;
    routeReady = true;

    let reconciled;
    await waitFor(async () => {
      const result = await payload(platform, jsonRequest(
        `/api/projects/${project.project.id}/domains`,
        { token: owner.accessToken },
      ));
      reconciled = result;
      return result.domains[0].routing.status === "ready";
    });
    assert.ok(routingLookups > initialLookups);
    assert.equal(reconciled.automation.lastChecked, 1);
    assert.equal(reconciled.automation.lastFailed, 0);
    assert.equal(reconciled.automation.pending, 0);
    assert.ok(reconciled.automation.lastCompletedAt >= reconciled.automation.lastStartedAt);

    const control = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
    const row = control.prepare(`SELECT next_check_at, check_lease_token, check_lease_until
      FROM clank_platform_domains WHERE id = ?`).get(domain.domain.id);
    assert.ok(row.next_check_at > reconciled.domains[0].routing.checkedAt);
    assert.equal(row.check_lease_token, null);
    assert.equal(row.check_lease_until, null);
    control.close();

    const writable = new DatabaseSync(join(root, "platform", "control.sqlite"));
    writable.exec("UPDATE clank_platform_domains SET next_check_at = 0");
    writable.close();
    hangRouting = true;
    await waitFor(async () => {
      const result = await payload(platform, jsonRequest(
        `/api/projects/${project.project.id}/domains`,
        { token: owner.accessToken },
      ));
      return result.domains[0].routing.status === "error"
        && result.automation.lastFailed === 1;
    }, 4_000);
    const manualStartedAt = Date.now();
    const manual = await payload(platform, jsonRequest(
      `/api/projects/${project.project.id}/domains/${domain.domain.id}/check`,
      { method: "POST", token: owner.accessToken, body: {} },
    ));
    assert.equal(manual.domain.routing.status, "error");
    assert.ok(Date.now() - manualStartedAt < 1_500, "manual DNS checks must use the same finite deadline");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple control planes do not reconcile the same domain lease concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-domain-lease-"));
  let background = false;
  let backgroundLookups = 0;
  let releaseLookup;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  const ingress = {
    enabled: true,
    customDomainTarget: "edge.example.test",
    domainRecheckIntervalMs: 1_000,
    domainRecheckBatchSize: 1,
    domainRecheckTimeoutMs: 5_000,
    resolveTxt: async () => [],
    resolveCname: async () => {
      if (background) {
        backgroundLookups++;
        await lookupGate;
      }
      return ["edge.example.test"];
    },
    resolve4: async () => [],
    resolve6: async () => [],
  };
  const options = {
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4550,
    appPortEnd: 4555,
    signup: true,
    ingress,
  };
  const first = await openPlatform(options);
  const second = await openPlatform(options);
  try {
    const owner = await authorizeCli(first, "domain-lease@example.com");
    const dashboard = await payload(first, jsonRequest("/api/dashboard", { token: owner.accessToken }));
    const project = await payload(first, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Leased DNS",
        slug: "leased-dns",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    await payload(first, jsonRequest(`/api/projects/${project.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "leased.customer.test" },
    }), 201);
    const control = new DatabaseSync(join(root, "platform", "control.sqlite"));
    control.exec("UPDATE clank_platform_domains SET next_check_at = 0");
    control.close();
    background = true;

    await waitFor(() => backgroundLookups === 1, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(backgroundLookups, 1, "a second control plane must respect the durable DNS lease");
    releaseLookup();
    await waitFor(() => {
      const database = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
      const row = database.prepare("SELECT check_lease_token FROM clank_platform_domains").get();
      database.close();
      return row.check_lease_token === null;
    });
  } finally {
    releaseLookup();
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("account quotas prevent multiplying organizations to bypass hosted site limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-account-quota-"));
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4570,
    appPortEnd: 4575,
    signup: true,
    limits: {
      organizationsPerAccount: 2,
      projectsPerAccount: 1,
      projectsPerOrganization: 1,
      domainsPerProject: 1,
    },
  });
  try {
    const owner = await authorizeCli(platform, "account-quota@example.com");
    const missingCsrf = await platform.handle(jsonRequest("/api/organizations", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "No CSRF workspace", slug: "no-csrf-workspace" },
    }));
    assert.equal(missingCsrf.status, 403);
    const firstOrganization = await payload(platform, jsonRequest("/api/organizations", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { name: "First workspace", slug: "first-workspace" },
    }), 201);
    const firstProject = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "First site", slug: "first-account-site", organizationId: firstOrganization.organization.id },
    }), 201);
    assert.ok(firstProject.project.id);
    const secondOrganization = await payload(platform, jsonRequest("/api/organizations", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Second workspace", slug: "second-workspace" },
    }), 201);
    const secondProject = await platform.handle(jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Bypass site", slug: "bypass-site", organizationId: secondOrganization.organization.id },
    }));
    assert.equal(secondProject.status, 409);
    assert.equal((await secondProject.json()).error.code, "ACCOUNT_PROJECT_LIMIT_REACHED");
    const thirdOrganization = await platform.handle(jsonRequest("/api/organizations", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Third workspace", slug: "third-workspace" },
    }));
    assert.equal(thirdOrganization.status, 409);
    assert.equal((await thirdOrganization.json()).error.code, "ORGANIZATION_LIMIT_REACHED");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker runner passes secret names in arguments and secret values only through its environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-docker-argv-"));
  const source = join(root, "source");
  const runnerPath = join(root, "fake-docker.mjs");
  const invocationPath = join(root, "docker-invocation.json");
  await writeFile(runnerPath, `#!/usr/bin/env node
    import { spawn } from "node:child_process";
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const arguments_ = process.argv.slice(2);
    await writeFile(${JSON.stringify(invocationPath)}, JSON.stringify({
      arguments_,
      secretPresent: process.env.DOCKER_TEST_SECRET === "abc",
    }));
    const mount = arguments_.find((value) => value.endsWith(":/app:ro"));
    if (!mount) throw new Error("Missing application mount.");
    const applicationRoot = mount.slice(0, -":/app:ro".length);
    const child = spawn(process.execPath, [join(applicationRoot, arguments_.at(-1))], {
      env: { ...process.env, HOST: "127.0.0.1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    process.once("SIGTERM", () => child.kill("SIGTERM"));
    process.once("SIGINT", () => child.kill("SIGINT"));
    child.once("exit", (code) => process.exit(code ?? 1));
  `, { mode: 0o700 });
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4580,
    appPortEnd: 4585,
    signup: true,
    runner: { kind: "docker", executable: runnerPath, image: "fake-image" },
  });
  try {
    const owner = await authorizeCli(platform, "docker-argv@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Docker arguments", slug: "docker-arguments" },
    }), 201);
    await payload(platform, jsonRequest(`/api/projects/${created.project.id}/secrets`, {
      method: "PUT",
      token: owner.accessToken,
      body: { values: { DOCKER_TEST_SECRET: "abc" } },
    }));
    const artifact = await appArtifact(source, "docker-release", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"],
    ]);
    const deployed = await deploy(
      platform,
      created.project.id,
      owner.accessToken,
      artifact,
      "docker-argument-release-key",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    const invocation = JSON.parse(await readFile(invocationPath, "utf8"));
    assert.equal(invocation.secretPresent, true);
    assert.equal(invocation.arguments_.includes("DOCKER_TEST_SECRET"), true);
    assert.equal(invocation.arguments_.some((argument) => argument.includes("abc")), false);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform device auth, ownership, encrypted secrets, atomic deploy, migrations, and rollback work end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-"));
  const source = join(root, "source");
  const dns = new Map();
  const cnames = new Map();
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4510,
    appPortEnd: 4520,
    signup: true,
    ingress: {
      baseDomain: "apps.example.test",
      customDomainTarget: "edge.example.test",
      tlsAskToken: "test-only-tls-ask-token",
      resolveTxt: async (hostname) => dns.get(hostname) ?? [],
      resolveCname: async (hostname) => cnames.get(hostname) ?? [],
      resolve4: async () => [],
      resolve6: async () => [],
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
      body: { values: { API_SECRET: secretValue, AUDIT_SHORT_SECRET: "abc" } },
    }));
    const listed = await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      token: owner.accessToken,
    }));
    assert.deepEqual(listed.secrets.map((secret) => secret.name), ["API_SECRET", "AUDIT_SHORT_SECRET"]);
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
    await waitFor(async () => {
      const logs = await payload(platform, jsonRequest(`/api/projects/${projectId}/logs`, { token: owner.accessToken }));
      return logs.logs.some((entry) => entry.message.includes("secret=[REDACTED]"));
    });
    const redactedLogs = await payload(platform, jsonRequest(`/api/projects/${projectId}/logs`, { token: owner.accessToken }));
    assert.equal(redactedLogs.logs.some((entry) => entry.message.includes("abc")), false);
    const managed = await platform.handle(new Request("https://atomic-todo.apps.example.test/"));
    assert.equal(managed.status, 200);
    assert.equal(await managed.text(), "release-one");
    assert.equal((await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=test-only-tls-ask-token&domain=atomic-todo.apps.example.test",
    ))).status, 200, "deployed built-in site hostnames are eligible for edge certificates");
    const customDomain = await payload(platform, jsonRequest(`/api/projects/${projectId}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "tasks.customer.test" },
    }), 201);
    dns.set(customDomain.domain.recordName, [[customDomain.domain.recordValue]]);
    cnames.set(customDomain.domain.hostname, ["edge.example.test"]);
    await payload(platform, jsonRequest(
      `/api/projects/${projectId}/domains/${customDomain.domain.id}/verify`,
      { method: "POST", token: owner.accessToken, body: {} },
    ));
    const customIngress = await platform.handle(new Request("https://tasks.customer.test/"));
    assert.equal(customIngress.status, 200);
    assert.equal(await customIngress.text(), "release-one");
    const tlsAllowed = await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=test-only-tls-ask-token&domain=tasks.customer.test",
    ));
    assert.equal(tlsAllowed.status, 200);
    assert.equal((await platform.handle(new Request(
      "http://localhost:4200/_clank/tls/ask?token=test-only-tls-ask-token&domain=tasks.customer.test",
    ))).status, 200, "the private TLS endpoint is reachable through a loopback Host before ingress dispatch");
    assert.equal((await platform.handle(new Request(
      "http://127.0.0.1:4200/_clank/tls/ask?token=wrong-token-value&domain=tasks.customer.test",
    ))).status, 404);
    const metrics = await payload(platform, jsonRequest(`/api/projects/${projectId}/metrics?range=24h`, {
      token: owner.accessToken,
    }));
    assert.ok(metrics.summary.requests >= 2);
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      cookie: owner.cookie,
    }));
    assert.equal(dashboard.projects[0].id, projectId);
    assert.equal(dashboard.projects[0].runtimeStatus, "online");
    assert.ok(dashboard.projects[0].metrics.requests >= 2);
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

    const invitationWithoutCsrf = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { email: "org-admin@example.com", role: "admin" },
      },
    ));
    assert.equal(invitationWithoutCsrf.status, 403);
    const supersededInvitation = await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { email: "org-admin@example.com", role: "admin" },
    }), 201);
    const invitation = await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      token: owner.accessToken,
      body: { email: "org-admin@example.com", role: "admin" },
    }), 201);
    const organizationBeforeAcceptance = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(organizationBeforeAcceptance.organization.access, {
      canManageMembers: true,
      canGrantOwner: true,
      canLeave: false,
    });
    assert.equal(organizationBeforeAcceptance.limits.pendingInvitations, 100);
    assert.equal(organizationBeforeAcceptance.invitations.length, 1);
    assert.deepEqual(
      Object.keys(organizationBeforeAcceptance.invitations[0]).sort(),
      ["createdAt", "email", "expiresAt", "id", "invitedBy", "role"],
    );
    assert.equal(organizationBeforeAcceptance.invitations[0].id, invitation.invitation.id);
    assert.equal(organizationBeforeAcceptance.invitations[0].invitedBy.email, "org-owner@example.com");
    const superseded = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: admin.accessToken,
      body: { token: supersededInvitation.invitation.token },
    }));
    assert.equal(superseded.status, 400);
    const wrongAccount = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: outsider.accessToken,
      body: { token: invitation.invitation.token },
    }));
    assert.equal(wrongAccount.status, 400);
    assert.equal((await wrongAccount.json()).error.code, "INVALID_INVITATION");
    await payload(platform, jsonRequest("/api/invitations/accept", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrfToken,
      body: { token: invitation.invitation.token },
    }));
    const replay = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: admin.accessToken,
      body: { token: invitation.invitation.token },
    }));
    assert.equal(replay.status, 400);
    const organizationAfterAcceptance = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: admin.accessToken },
    ));
    assert.deepEqual(organizationAfterAcceptance.organization.access, {
      canManageMembers: true,
      canGrantOwner: false,
      canLeave: true,
    });
    assert.equal(organizationAfterAcceptance.invitations.length, 0);
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "PATCH",
      token: owner.accessToken,
      body: { role: "owner" },
    }));
    const sharedOwnership = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: owner.accessToken },
    ));
    assert.equal(sharedOwnership.organization.access.canLeave, true);
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "PATCH",
      token: owner.accessToken,
      body: { role: "admin" },
    }));

    const alreadyMember = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        token: admin.accessToken,
        body: { email: "org-owner@example.com", role: "viewer" },
      },
    ));
    assert.equal(alreadyMember.status, 409);
    assert.equal((await alreadyMember.json()).error.code, "ALREADY_MEMBER");
    const revocableInvitation = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        token: admin.accessToken,
        body: { email: "outsider@example.com", role: "viewer" },
      },
    ), 201);
    await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/invitations/${revocableInvitation.invitation.id}`,
      { method: "DELETE", token: admin.accessToken, body: {} },
    ));
    const revokedInvitation = await platform.handle(jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: outsider.accessToken,
      body: { token: revocableInvitation.invitation.token },
    }));
    assert.equal(revokedInvitation.status, 400);
    const revokeReplay = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations/${revocableInvitation.invitation.id}`,
      { method: "DELETE", token: admin.accessToken, body: {} },
    ));
    assert.equal(revokeReplay.status, 404);

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
    const scopedDashboard = await payload(platform, jsonRequest("/api/dashboard", { token: projectToken }));
    assert.deepEqual(scopedDashboard.projects.map((project) => project.id), [projectId]);
    assert.deepEqual(scopedDashboard.organizations.map((organization) => organization.id), [organizationId]);
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

    for (let index = 0; index < 100; index++) {
      await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
        method: "POST",
        token: owner.accessToken,
        body: { email: `pending-${index}@example.com`, role: "developer" },
      }), 201);
    }
    const invitationLimit = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        token: owner.accessToken,
        body: { email: "pending-overflow@example.com", role: "viewer" },
      },
    ));
    assert.equal(invitationLimit.status, 409);
    assert.equal((await invitationLimit.json()).error.code, "INVITATION_LIMIT_REACHED");
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      token: owner.accessToken,
      body: { email: "pending-0@example.com", role: "viewer" },
    }), 201);
    const ownerAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=200`,
      { token: owner.accessToken },
    ));
    assert.ok(ownerAudit.events.some(
      (event) => event.action === "invitation.create"
        && event.metadata.email === "pending-0@example.com",
    ));
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "PATCH",
      token: owner.accessToken,
      body: { role: "viewer" },
    }));
    const viewerOrganization = await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}`,
      { token: admin.accessToken },
    ));
    assert.deepEqual(viewerOrganization.organization.access, {
      canManageMembers: false,
      canGrantOwner: false,
      canLeave: true,
    });
    assert.deepEqual(viewerOrganization.invitations, []);

    const adminCannotRemoveOwner = await platform.handle(jsonRequest(
      `/api/organizations/${organizationId}/members/${owner.user.id}`,
      { method: "DELETE", token: admin.accessToken, body: {} },
    ));
    assert.equal(adminCannotRemoveOwner.status, 403);
    await payload(platform, jsonRequest(`/api/organizations/${organizationId}/members/${admin.user.id}`, {
      method: "DELETE",
      token: admin.accessToken,
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

test("site deletion is admin-only, path-safe, auditable, and releases every managed resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-site-delete-"));
  const dataDirectory = join(root, "platform");
  const platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4551,
    appPortEnd: 4553,
    signup: true,
    backups: { intervalMs: false },
    limits: {
      projectsPerAccount: 2,
      projectsPerOrganization: 2,
      domainsPerProject: 2,
    },
    ingress: {
      enabled: true,
      customDomainTarget: "edge.example.test",
      tlsAskToken: "site-delete-tls-token",
      resolveTxt: async () => [],
      resolveCname: async () => [],
      resolve4: async () => [],
      resolve6: async () => [],
    },
  });
  try {
    const owner = await authorizeCli(platform, "site-delete-owner@example.com");
    const developer = await authorizeCli(platform, "site-delete-developer@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const organizationId = dashboard.organizations[0].id;
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Disposable Tasks",
        slug: "disposable-tasks",
        organizationId,
      },
    }), 201);
    const projectId = created.project.id;
    const unsafe = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Path Safety",
        slug: "path-safety",
        organizationId,
      },
    }), 201);

    const invitation = await payload(platform, jsonRequest(`/api/organizations/${organizationId}/invitations`, {
      method: "POST",
      token: owner.accessToken,
      body: { email: "site-delete-developer@example.com", role: "developer" },
    }), 201);
    await payload(platform, jsonRequest("/api/invitations/accept", {
      method: "POST",
      token: developer.accessToken,
      body: { token: invitation.invitation.token },
    }));
    const ownerDetail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: owner.accessToken,
    }));
    const developerDetail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: developer.accessToken,
    }));
    assert.deepEqual(ownerDetail.access, { role: "owner", canDelete: true });
    assert.deepEqual(developerDetail.access, { role: "developer", canDelete: false });

    const developerDenied = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: developer.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(developerDenied.status, 403);
    assert.equal((await developerDenied.json()).error.code, "ROLE_DENIED");
    const developerAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=5`,
      { token: developer.accessToken },
    ));
    assert.ok(developerAudit.events.length > 0);
    assert.ok(developerAudit.events.every((event) => event.organization.id === organizationId));
    const developerInvitationEvent = developerAudit.events.find(
      (event) => event.action === "invitation.create",
    );
    assert.ok(developerInvitationEvent);
    assert.equal("email" in developerInvitationEvent.metadata, false);
    await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/members/${developer.user.id}`,
      {
        method: "PATCH",
        token: owner.accessToken,
        body: { role: "admin" },
      },
    ));
    const adminDetail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: developer.accessToken,
    }));
    assert.deepEqual(adminDetail.access, { role: "admin", canDelete: true });
    const missingCsrf = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error.code, "INVALID_CSRF");
    const wrongConfirmation = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site another-project",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(wrongConfirmation.status, 400);
    assert.equal((await wrongConfirmation.json()).error.code, "CONFIRMATION_REQUIRED");
    const missingAcknowledgement = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: false,
      },
    }));
    assert.equal(missingAcknowledgement.status, 400);
    assert.equal((await missingAcknowledgement.json()).error.code, "DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED");

    const scoped = await payload(platform, jsonRequest(`/api/projects/${projectId}/tokens`, {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Deletion must reject this token",
        permissions: ["read", "tokens", "audit"],
        expiresIn: 3600,
      },
    }), 201);
    const scopedAudit = await payload(platform, jsonRequest("/api/audit?limit=2", {
      token: scoped.token.accessToken,
    }));
    assert.ok(scopedAudit.events.length > 0);
    assert.ok(scopedAudit.events.every((event) => event.project.id === projectId));
    const scopedOrganizationAudit = await platform.handle(jsonRequest(
      `/api/audit?organizationId=${organizationId}`,
      { token: scoped.token.accessToken },
    ));
    assert.equal(scopedOrganizationAudit.status, 403);
    assert.equal((await scopedOrganizationAudit.json()).error.code, "TOKEN_SCOPE_DENIED");
    const scopedDenied = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: scoped.token.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(scopedDenied.status, 403);
    assert.equal((await scopedDenied.json()).error.code, "TOKEN_SCOPE_DENIED");

    const sentinelDirectory = join(root, "outside-project-storage");
    const sentinelFile = join(sentinelDirectory, "keep.txt");
    await mkdir(sentinelDirectory);
    await writeFile(sentinelFile, "do not remove");
    const unsafeProjectRoot = join(dataDirectory, "projects", unsafe.project.id);
    await symlink(sentinelDirectory, unsafeProjectRoot, "dir");
    const unsafeDeletion = await platform.handle(jsonRequest(`/api/projects/${unsafe.project.id}`, {
      method: "DELETE",
      token: developer.accessToken,
      body: {
        confirmation: "delete-site path-safety",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(unsafeDeletion.status, 409);
    assert.equal((await unsafeDeletion.json()).error.code, "PROJECT_STORAGE_UNSAFE");
    assert.equal(await readFile(sentinelFile, "utf8"), "do not remove");
    await payload(platform, jsonRequest(`/api/projects/${unsafe.project.id}`, {
      token: owner.accessToken,
    }));
    await unlink(unsafeProjectRoot);
    await payload(platform, jsonRequest(`/api/projects/${unsafe.project.id}`, {
      method: "DELETE",
      token: developer.accessToken,
      body: {
        confirmation: "delete-site path-safety",
        acknowledgeDataLoss: true,
      },
    }));
    const capacityReplacement = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Capacity Reclaimed",
        slug: "capacity-reclaimed",
        organizationId,
      },
    }), 201);
    await payload(platform, jsonRequest(
      `/api/organizations/${organizationId}/members/${developer.user.id}`,
      {
        method: "PATCH",
        token: owner.accessToken,
        body: { role: "viewer" },
      },
    ));
    const viewerAudit = await platform.handle(jsonRequest(`/api/audit?organizationId=${organizationId}`, {
      token: developer.accessToken,
    }));
    assert.equal(viewerAudit.status, 403);
    assert.equal((await viewerAudit.json()).error.code, "ROLE_DENIED");
    const viewerUnfilteredAudit = await payload(platform, jsonRequest("/api/audit", {
      token: developer.accessToken,
    }));
    assert.deepEqual(viewerUnfilteredAudit.events, []);

    await payload(platform, jsonRequest(`/api/projects/${projectId}/secrets`, {
      method: "PUT",
      token: owner.accessToken,
      body: { values: { AUDIT_SHORT_SECRET: "abc" } },
    }));
    const deployed = await deploy(
      platform,
      projectId,
      owner.accessToken,
      await appArtifact(join(root, "source"), "before-deletion", [
        ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
      ]),
      "site-delete-release-key",
    );
    assert.equal(deployed.response.status, 201, JSON.stringify(deployed.body));
    assert.equal(await fetch(deployed.body.release.directUrl).then((response) => response.text()), "before-deletion");
    await payload(platform, jsonRequest(`/api/projects/${projectId}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "reusable.customer.test" },
    }), 201);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/backups`, {
      method: "POST",
      token: owner.accessToken,
      body: { reason: "pre-deletion evidence" },
    }), 201);

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.prepare(`INSERT INTO clank_platform_metrics
      (project_id, bucket_started_at, request_count, status_2xx)
      VALUES (?, ?, 1, 1)`).run(projectId, Date.now());
    control.prepare(`INSERT INTO clank_platform_logs
      (project_id, release_id, stream, message, created_at)
      VALUES (?, ?, 'stdout', 'deletion evidence', ?)`)
      .run(projectId, deployed.body.release.id, Date.now());
    control.prepare(`INSERT INTO clank_deployment_placements
      (project_id, desired_release_id, desired_state, assigned_node_id, region, generation,
       observed_release_id, observed_state, observed_generation, updated_at)
      VALUES (?, ?, 'running', NULL, NULL, 1, ?, 'running', 1, ?)`)
      .run(projectId, deployed.body.release.id, deployed.body.release.id, Date.now());
    control.prepare(`INSERT INTO clank_deployment_operations
      (id, project_id, action, payload, state, node_id, attempts, max_attempts, fence,
       lease_token_hash, lease_expires_at, next_attempt_at, idempotency_key, result, error,
       created_at, updated_at)
      VALUES (?, ?, 'deploy', '{}', 'succeeded', NULL, 1, 3, 0,
       NULL, NULL, ?, ?, '{}', NULL, ?, ?)`)
      .run(
        "operation_site_delete_test",
        projectId,
        Date.now(),
        "operation-site-delete-test",
        Date.now(),
        Date.now(),
      );
    assert.equal(control.prepare(
      "SELECT count(*) AS count FROM clank_deployment_placements WHERE project_id = ?",
    ).get(projectId).count, 1);
    assert.equal(control.prepare(
      "SELECT count(*) AS count FROM clank_platform_backup_schedules WHERE project_id = ?",
    ).get(projectId).count, 1);
    control.close();

    const deleted = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: "delete-site disposable-tasks",
        acknowledgeDataLoss: true,
      },
    }));
    assert.equal(deleted.project.id, projectId);
    assert.equal(deleted.project.revokedTokens, 1);
    assert.equal(deleted.project.domains, 1);
    assert.equal(deleted.project.releases, 1);
    assert.equal(deleted.project.secrets, 1);
    assert.ok(deleted.project.logs >= 1);
    assert.equal(deleted.project.metrics, 1);
    assert.equal(deleted.project.backupSchedules, 1);
    await assert.rejects(
      stat(join(dataDirectory, "projects", projectId)),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      fetch(deployed.body.release.directUrl, { signal: AbortSignal.timeout(1_000) }),
    );
    const scopedRevoked = await platform.handle(jsonRequest("/api/account", {
      token: scoped.token.accessToken,
    }));
    assert.equal(scopedRevoked.status, 401);
    const deletedProject = await platform.handle(jsonRequest(`/api/projects/${projectId}`, {
      token: owner.accessToken,
    }));
    assert.equal(deletedProject.status, 404);
    const workspaceAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=2`,
      { token: owner.accessToken },
    ));
    assert.equal(workspaceAudit.events.length, 2);
    assert.ok(workspaceAudit.nextBefore);
    const deletionEvent = workspaceAudit.events.find((event) => event.action === "project.delete");
    assert.ok(deletionEvent, "workspace activity must expose deletion after the project row is gone");
    assert.equal(deletionEvent.organization.id, organizationId);
    assert.deepEqual(deletionEvent.project, {
      id: projectId,
      name: "Disposable Tasks",
      slug: "disposable-tasks",
      deleted: true,
    });
    assert.equal(deletionEvent.actor.email, "site-delete-owner@example.com");
    const completeWorkspaceAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=200`,
      { token: owner.accessToken },
    ));
    const deletedReleaseEvent = completeWorkspaceAudit.events.find((event) => (
      event.action === "release.activate" && event.project?.id === projectId
    ));
    assert.ok(deletedReleaseEvent);
    assert.equal(deletedReleaseEvent.project.name, "Disposable Tasks");
    assert.equal(deletedReleaseEvent.project.slug, "disposable-tasks");
    assert.equal(deletedReleaseEvent.project.deleted, true);
    const olderAudit = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}&limit=2&before=${workspaceAudit.nextBefore}`,
      { token: owner.accessToken },
    ));
    assert.ok(olderAudit.events.length > 0);
    assert.equal(
      olderAudit.events.some((event) => workspaceAudit.events.some((current) => current.id === event.id)),
      false,
    );
    const invalidAuditCursor = await platform.handle(jsonRequest("/api/audit?before=1e2", {
      token: owner.accessToken,
    }));
    assert.equal(invalidAuditCursor.status, 422);

    const finalControl = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    for (const [table, column] of [
      ["clank_platform_projects", "id"],
      ["clank_platform_domains", "project_id"],
      ["clank_platform_releases", "project_id"],
      ["clank_platform_secrets", "project_id"],
      ["clank_platform_logs", "project_id"],
      ["clank_platform_metrics", "project_id"],
      ["clank_platform_backup_schedules", "project_id"],
      ["clank_deployment_placements", "project_id"],
      ["clank_deployment_operations", "project_id"],
    ]) {
      assert.equal(
        finalControl.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`).get(projectId).count,
        0,
        `${table} must not retain project state`,
      );
    }
    assert.ok(finalControl.prepare(
      "SELECT revoked_at FROM clank_platform_tokens WHERE id = ?",
    ).get(scoped.token.id).revoked_at);
    const deletionAudit = finalControl.prepare(`SELECT metadata
      FROM clank_platform_audit WHERE project_id = ? AND action = 'project.delete'
      ORDER BY id DESC LIMIT 1`).get(projectId);
    assert.ok(deletionAudit, "deletion audit history must outlive project metadata");
    assert.equal(JSON.parse(deletionAudit.metadata).slug, "disposable-tasks");
    finalControl.close();

    const recreated = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Disposable Tasks Recreated",
        slug: "disposable-tasks",
        organizationId,
      },
    }), 201);
    assert.equal(recreated.project.port, created.project.port, "deletion must release the application port");
    await payload(platform, jsonRequest(`/api/projects/${recreated.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "reusable.customer.test" },
    }), 201);
    const redeployed = await deploy(
      platform,
      recreated.project.id,
      owner.accessToken,
      await appArtifact(join(root, "recreated-source"), "after-deletion", [
        ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY);\n"],
      ]),
      "site-delete-recreated-release-key",
    );
    assert.equal(redeployed.response.status, 201, JSON.stringify(redeployed.body));
    assert.equal(await fetch(redeployed.body.release.directUrl).then((response) => response.text()), "after-deletion");
    assert.notEqual(capacityReplacement.project.id, recreated.project.id);
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy audit rows gain workspace attribution without losing their history", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-audit-upgrade-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4554,
    appPortEnd: 4556,
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "audit-upgrade@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const organizationId = dashboard.organizations[0].id;
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Audit Upgrade",
        slug: "audit-upgrade",
        organizationId,
      },
    }), 201);
    await platform.close();

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.prepare("DELETE FROM clank_platform_projects WHERE id = ?").run(project.project.id);
    control.exec(`
      ALTER TABLE clank_platform_audit RENAME TO clank_platform_audit_with_organization;
      CREATE TABLE clank_platform_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT NOT NULL,
        actor_token_id TEXT,
        project_id TEXT,
        action TEXT NOT NULL,
        metadata TEXT NOT NULL CHECK (json_valid(metadata)),
        created_at INTEGER NOT NULL
      );
      INSERT INTO clank_platform_audit
        (id, actor_user_id, actor_token_id, project_id, action, metadata, created_at)
      SELECT id, actor_user_id, actor_token_id, project_id, action, metadata, created_at
      FROM clank_platform_audit_with_organization;
      DROP TABLE clank_platform_audit_with_organization;
    `);
    control.close();

    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      appPortStart: 4554,
      appPortEnd: 4556,
      signup: true,
      backups: { intervalMs: false },
    });
    const upgraded = await payload(platform, jsonRequest(
      `/api/audit?organizationId=${organizationId}`,
      { token: owner.accessToken },
    ));
    const projectEvent = upgraded.events.find((event) => event.action === "project.create");
    assert.ok(projectEvent);
    assert.equal(projectEvent.organization.id, organizationId);
    assert.equal(projectEvent.project.id, project.project.id);
    assert.equal(projectEvent.project.deleted, true);
    const upgradedControl = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    assert.ok(upgradedControl.prepare(
      "PRAGMA table_info(clank_platform_audit)",
    ).all().some((column) => column.name === "organization_id"));
    assert.equal(upgradedControl.prepare(
      "SELECT organization_id FROM clank_platform_audit WHERE action = 'project.create'",
    ).get().organization_id, organizationId);
    upgradedControl.close();
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("release storage quotas are enforced and cleanup preserves authorization and rollback safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-release-storage-"));
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4570,
    appPortEnd: 4575,
    signup: true,
    backups: { intervalMs: false },
    limits: {
      releasesPerProject: 3,
      releaseStorageBytesPerProject: 1024 * 1024 * 1024,
    },
  });
  try {
    const owner = await authorizeCli(platform, "release-storage@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    assert.equal(dashboard.limits.releasesPerProject, 3);
    assert.equal(dashboard.limits.releaseStorageBytesPerProject, 1024 * 1024 * 1024);
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Bounded Releases",
        slug: "bounded-releases",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const projectId = project.project.id;
    const source = join(root, "source");
    const artifacts = [];
    for (const label of ["one", "two", "three", "four"]) {
      artifacts.push(await appArtifact(source, `release-${label}`, [
        ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
      ]));
    }
    const first = await deploy(platform, projectId, owner.accessToken, artifacts[0], "storage-release-key-0001");
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    const second = await deploy(platform, projectId, owner.accessToken, artifacts[1], "storage-release-key-0002");
    assert.equal(second.response.status, 201, JSON.stringify(second.body));
    const third = await deploy(platform, projectId, owner.accessToken, artifacts[2], "storage-release-key-0003");
    assert.equal(third.response.status, 201, JSON.stringify(third.body));

    let releases = await payload(platform, jsonRequest(`/api/projects/${projectId}/releases`, {
      token: owner.accessToken,
    }));
    assert.deepEqual(releases.usage, {
      releases: 3,
      storageBytes: releases.releases.reduce((total, release) => total + release.storageBytes, 0),
    });
    assert.deepEqual(releases.limits, {
      releases: 3,
      storageBytes: 1024 * 1024 * 1024,
    });
    const storedSecond = releases.releases.find((release) => release.id === second.body.release.id);
    assert.ok(
      storedSecond.storageBytes > storedSecond.artifactBytes,
      "release storage must include the pre-deploy SQLite snapshot, not only the upload",
    );
    assert.equal(releases.releases.find((release) => release.id === third.body.release.id).cleanup.allowed, false);
    assert.equal(storedSecond.cleanup.rollbackProtected, true);

    const overCount = await deploy(platform, projectId, owner.accessToken, artifacts[3], "storage-release-key-0004");
    assert.equal(overCount.response.status, 409);
    assert.equal(overCount.body.error.code, "RELEASE_LIMIT_REACHED");

    const deployToken = await payload(platform, jsonRequest(`/api/projects/${projectId}/tokens`, {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Deploy-only automation",
        permissions: ["read", "deploy"],
        expiresIn: 3600,
      },
    }), 201);
    const deniedCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${first.body.release.id}`,
      {
        method: "DELETE",
        token: deployToken.token.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${first.body.release.id}`,
          allowRollbackLoss: false,
        },
      },
    ));
    assert.equal(deniedCleanup.status, 403);
    assert.equal((await deniedCleanup.json()).error.code, "TOKEN_SCOPE_DENIED");

    const wrongConfirmation = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${first.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: { confirmation: "delete it", allowRollbackLoss: false },
      },
    ));
    assert.equal(wrongConfirmation.status, 400);

    const sentinelDirectory = join(root, "outside-release-storage");
    const sentinelFile = join(sentinelDirectory, "keep.txt");
    await mkdir(sentinelDirectory);
    await writeFile(sentinelFile, "do not remove");
    const control = new DatabaseSync(join(root, "platform", "control.sqlite"));
    control.prepare(`UPDATE clank_platform_releases
      SET directory = ?, backup_path = ? WHERE id = ?`)
      .run(sentinelDirectory, sentinelFile, first.body.release.id);
    control.close();

    const backupDirectory = join(root, "platform", "projects", projectId, "backups");
    const realBackupDirectory = `${backupDirectory}-real`;
    await rename(backupDirectory, realBackupDirectory);
    await symlink(sentinelDirectory, backupDirectory, "dir");
    const symlinkedParentCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${first.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${first.body.release.id}`,
          allowRollbackLoss: false,
        },
      },
    ));
    assert.equal(symlinkedParentCleanup.status, 500);
    assert.equal((await symlinkedParentCleanup.json()).error.code, "PLATFORM_ERROR");
    assert.equal(await readFile(sentinelFile, "utf8"), "do not remove");
    assert.ok((await stat(
      join(root, "platform", "projects", projectId, "releases", first.body.release.id),
    )).isDirectory());
    await unlink(backupDirectory);
    await rename(realBackupDirectory, backupDirectory);

    await payload(platform, jsonRequest(`/api/projects/${projectId}/releases/${first.body.release.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: `delete-release bounded-releases ${first.body.release.id}`,
        allowRollbackLoss: false,
      },
    }));
    await assert.rejects(
      stat(join(root, "platform", "projects", projectId, "releases", first.body.release.id)),
      (error) => error.code === "ENOENT",
    );
    assert.equal(
      await readFile(sentinelFile, "utf8"),
      "do not remove",
      "cleanup must derive paths instead of trusting mutable database path columns",
    );
    const repeatedCleanup = await payload(
      platform,
      jsonRequest(`/api/projects/${projectId}/releases/${first.body.release.id}`, {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${first.body.release.id}`,
          allowRollbackLoss: false,
        },
      }),
    );
    assert.equal(repeatedCleanup.release.artifactAvailable, false);

    const fourth = await deploy(platform, projectId, owner.accessToken, artifacts[3], "storage-release-key-0004");
    assert.equal(fourth.response.status, 201, JSON.stringify(fourth.body));
    const activeCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${fourth.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${fourth.body.release.id}`,
          allowRollbackLoss: true,
        },
      },
    ));
    assert.equal(activeCleanup.status, 409);
    assert.equal((await activeCleanup.json()).error.code, "ACTIVE_RELEASE_PROTECTED");

    const secondBackup = join(
      root,
      "platform",
      "projects",
      projectId,
      "backups",
      `${second.body.release.id}.sqlite`,
    );
    assert.ok((await stat(secondBackup)).size > 0);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/releases/${second.body.release.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: `delete-release bounded-releases ${second.body.release.id}`,
        allowRollbackLoss: false,
      },
    }));
    await assert.rejects(stat(secondBackup), (error) => error.code === "ENOENT");

    const protectedCleanup = await platform.handle(jsonRequest(
      `/api/projects/${projectId}/releases/${third.body.release.id}`,
      {
        method: "DELETE",
        token: owner.accessToken,
        body: {
          confirmation: `delete-release bounded-releases ${third.body.release.id}`,
          allowRollbackLoss: false,
        },
      },
    ));
    assert.equal(protectedCleanup.status, 409);
    assert.equal((await protectedCleanup.json()).error.code, "RELEASE_ROLLBACK_PROTECTED");
    const fourthBackup = join(
      root,
      "platform",
      "projects",
      projectId,
      "backups",
      `${fourth.body.release.id}.sqlite`,
    );
    assert.ok((await stat(fourthBackup)).size > 0);
    await payload(platform, jsonRequest(`/api/projects/${projectId}/releases/${third.body.release.id}`, {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        confirmation: `delete-release bounded-releases ${third.body.release.id}`,
        allowRollbackLoss: true,
      },
    }));
    await assert.rejects(
      stat(fourthBackup),
      (error) => error.code === "ENOENT",
      "accepting rollback loss must remove the active release's now-unusable matching snapshot",
    );
    const removedRollback = await platform.handle(jsonRequest(`/api/projects/${projectId}/rollback`, {
      method: "POST",
      token: owner.accessToken,
      body: { releaseId: third.body.release.id, restoreData: false },
    }));
    assert.equal(removedRollback.status, 409);
    assert.equal((await removedRollback.json()).error.code, "RELEASE_ARTIFACT_UNAVAILABLE");

    releases = await payload(platform, jsonRequest(`/api/projects/${projectId}/releases`, {
      token: owner.accessToken,
    }));
    assert.equal(releases.releases.length, 4, "cleanup must preserve release history");
    assert.equal(releases.usage.releases, 1);
    assert.equal(releases.releases.find((release) => release.id === second.body.release.id).artifactAvailable, false);
    assert.equal(releases.releases.find((release) => release.id === second.body.release.id).storageBytes, 0);
    const detail = await payload(platform, jsonRequest(`/api/projects/${projectId}`, {
      token: owner.accessToken,
    }));
    assert.equal(detail.usage.releases, 1);
    assert.equal(detail.usage.storageBytes, releases.usage.storageBytes);
    const finalControl = new DatabaseSync(join(root, "platform", "control.sqlite"), { readOnly: true });
    const activeStorage = finalControl.prepare(`SELECT runtime_bytes, snapshot_bytes, storage_bytes, backup_path
      FROM clank_platform_releases WHERE id = ?`).get(fourth.body.release.id);
    finalControl.close();
    assert.equal(activeStorage.snapshot_bytes, 0);
    assert.equal(activeStorage.storage_bytes, activeStorage.runtime_bytes);
    assert.equal(activeStorage.backup_path, null);
    const audit = await payload(platform, jsonRequest(`/api/projects/${projectId}/audit`, {
      token: owner.accessToken,
    }));
    const cleanupEvents = audit.events.filter((event) => event.action === "release.cleanup");
    assert.equal(cleanupEvents.length, 3);
    assert.ok(cleanupEvents.some((event) => (
      event.metadata.releaseId === third.body.release.id
      && event.metadata.rollbackProtected === true
      && event.metadata.activeSnapshotBytes > 0
    )));
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("release byte quotas reject storage before creating a release directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-release-byte-limit-"));
  const platform = await openPlatform({
    dataDirectory: join(root, "platform"),
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4580,
    appPortEnd: 4582,
    signup: true,
    backups: { intervalMs: false },
    limits: {
      releasesPerProject: 3,
      releaseStorageBytesPerProject: 1,
    },
  });
  try {
    const owner = await authorizeCli(platform, "release-byte-limit@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Tiny Release Storage",
        slug: "tiny-release-storage",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    const artifact = await appArtifact(join(root, "source"), "too-large", [
      ["0001_create_items.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n"],
    ]);
    const rejected = await deploy(
      platform,
      project.project.id,
      owner.accessToken,
      artifact,
      "release-byte-limit-key",
    );
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.error.code, "RELEASE_STORAGE_LIMIT_REACHED");
    const releases = await payload(platform, jsonRequest(
      `/api/projects/${project.project.id}/releases`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(releases.usage, { releases: 0, storageBytes: 0 });
    await assert.rejects(
      stat(join(root, "platform", "projects", project.project.id, "releases")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy release rows upgrade to conservative storage accounting in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-release-upgrade-"));
  const dataDirectory = join(root, "platform");
  let platform = await openPlatform({
    dataDirectory,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4583,
    appPortEnd: 4584,
    signup: true,
    backups: { intervalMs: false },
  });
  try {
    const owner = await authorizeCli(platform, "release-upgrade@example.com");
    const dashboard = await payload(platform, jsonRequest("/api/dashboard", {
      token: owner.accessToken,
    }));
    const project = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: {
        name: "Legacy Releases",
        slug: "legacy-releases",
        organizationId: dashboard.organizations[0].id,
      },
    }), 201);
    await platform.close();

    const control = new DatabaseSync(join(dataDirectory, "control.sqlite"));
    control.exec("DROP TABLE clank_platform_releases");
    control.exec(`CREATE TABLE clank_platform_releases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
      previous_release_id TEXT,
      status TEXT NOT NULL,
      digest TEXT NOT NULL,
      artifact_bytes INTEGER NOT NULL,
      framework_version TEXT NOT NULL,
      node_version TEXT NOT NULL,
      config TEXT NOT NULL CHECK (json_valid(config)),
      directory TEXT NOT NULL,
      backup_path TEXT,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      failure TEXT,
      UNIQUE(project_id, idempotency_key)
    )`);
    const legacyReleaseId = "legacy_release_001";
    control.prepare(`INSERT INTO clank_platform_releases
      (id, project_id, previous_release_id, status, digest, artifact_bytes,
       framework_version, node_version, config, directory, backup_path,
       idempotency_key, created_at)
      VALUES (?, ?, NULL, 'inactive', ?, 321, '0.6.0', ?, ?, ?, NULL, ?, ?)`)
      .run(
        legacyReleaseId,
        project.project.id,
        "b".repeat(64),
        process.version,
        JSON.stringify({
          version: 1,
          entry: "server.js",
          include: ["server.js"],
          database: { path: "app.sqlite", migrations: "migrations", allowUnsafeMigrations: false },
          health: { path: "/healthz", timeoutMs: 5000 },
          env: {},
        }),
        join(dataDirectory, "projects", project.project.id, "releases", legacyReleaseId),
        "legacy-release-key-001",
        Date.now(),
      );
    control.close();

    platform = await openPlatform({
      dataDirectory,
      publicUrl: "http://127.0.0.1:4200",
      appPortStart: 4583,
      appPortEnd: 4584,
      signup: true,
      backups: { intervalMs: false },
    });
    const releases = await payload(platform, jsonRequest(
      `/api/projects/${project.project.id}/releases`,
      { token: owner.accessToken },
    ));
    assert.deepEqual(releases.usage, { releases: 1, storageBytes: 321 });
    assert.equal(releases.releases[0].id, legacyReleaseId);
    assert.equal(releases.releases[0].artifactAvailable, true);
    assert.equal(releases.releases[0].artifactBytes, 321);
    assert.equal(releases.releases[0].storageBytes, 321);

    const upgraded = new DatabaseSync(join(dataDirectory, "control.sqlite"), { readOnly: true });
    const row = upgraded.prepare(`SELECT runtime_bytes, snapshot_bytes, storage_bytes, artifact_available
      FROM clank_platform_releases WHERE id = ?`).get(legacyReleaseId);
    upgraded.close();
    assert.deepEqual({ ...row }, {
      runtime_bytes: 321,
      snapshot_bytes: 0,
      storage_bytes: 321,
      artifact_available: 1,
    });
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
    assert.deepEqual(await payload(platform, jsonRequest("/livez")), {
      ok: true,
      status: "alive",
    });
    const favicon = await platform.handle(jsonRequest("/favicon.ico"));
    assert.equal(favicon.status, 204);
    assert.equal(await favicon.text(), "");
    const ready = await payload(platform, jsonRequest("/healthz"));
    assert.deepEqual(ready, {
      ok: true,
      status: "ready",
      checks: {
        database: "ok",
      },
    });
    assert.deepEqual(await payload(platform, jsonRequest("/readyz")), ready);
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
    assert.match(signedInHtml, /"authenticated":true/);
    assert.match(signedInHtml, /<section class="app-shell" id="app-view" hidden>/);
    assert.match(signedInHtml, /Ship fast\./);
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
    await platform.close();
    const closed = await platform.handle(jsonRequest("/healthz"));
    assert.equal(closed.status, 503);
    assert.equal((await closed.json()).error.code, "PLATFORM_CLOSED");
  } finally {
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("platform reports unexpected failures privately without exposing exception text", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-platform-errors-"));
  const privateMessage = "internal resolver credential: operator-secret";
  const observed = [];
  const platform = await openPlatform({
    dataDirectory: root,
    publicUrl: "http://127.0.0.1:4200",
    appPortStart: 4560,
    appPortEnd: 4561,
    signup: true,
    ingress: {
      baseDomain: "apps.example.test",
      resolveTxt: async () => {
        throw new Error(privateMessage);
      },
    },
    onError(error) {
      observed.push(error);
    },
  });
  try {
    const owner = await authorizeCli(platform, "error-owner@example.com");
    const created = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.accessToken,
      body: { name: "Error Boundary", slug: "error-boundary" },
    }), 201);
    const domain = await payload(platform, jsonRequest(`/api/projects/${created.project.id}/domains`, {
      method: "POST",
      token: owner.accessToken,
      body: { hostname: "errors.example.test" },
    }), 201);
    const response = await platform.handle(jsonRequest(
      `/api/projects/${created.project.id}/domains/${domain.domain.id}/verify`,
      { method: "POST", token: owner.accessToken, body: {} },
    ));
    const result = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "PLATFORM_ERROR",
        message: "The platform operation failed.",
      },
    });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].message, privateMessage);
    assert.doesNotMatch(JSON.stringify(result), /operator-secret/);
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
