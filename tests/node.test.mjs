import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  defineBackend,
  defineDatabase,
  defineTable,
  json,
  openBackend,
  s,
  serve,
  staticFiles,
} from "../dist/index.js";
import { requestOriginAllowed } from "../dist/security.js";

test("Node adapter serves Fetch apps and streams live SQLite updates over HTTP", async () => {
  const schema = defineDatabase({ counters: defineTable({ value: s.number({ integer: true }) }) });
  const definition = defineBackend({ schema }).functions(({ query, mutation }) => ({
    counters: {
      current: query({ args: {}, handler: ({ db }) => db.table("counters").query().first()?.value ?? 0 }),
      increment: mutation({
        args: {},
        handler: ({ db }) => {
          const current = db.table("counters").query().first();
          if (!current) return db.table("counters").insert({ value: 1 });
          db.table("counters").patch(current._id, { value: current.value + 1 });
          return current._id;
        },
      }),
    },
  }));
  const backend = await openBackend(definition, { path: ":memory:", heartbeat: 60_000 });
  const app = createApp()
    .post("/echo/:id", async ({ request, params }) => json({ id: params.id, body: await request.json() }))
    .route("*", "*", ({ request }) => backend.handle(request));
  const server = await serve(app, { port: 0 });

  const echo = await fetch(`${server.url}/echo/7`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ working: true }),
  });
  assert.deepEqual(await echo.json(), { id: "7", body: { working: true } });

  const live = await fetch(`${server.url}/__clank/live/counters.current?args=%7B%7D`);
  const reader = live.body.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  assert.match(initial, /"value":0/);

  const mutation = await fetch(`${server.url}/__clank/mutation/counters.increment`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url },
    body: "{}",
  });
  assert.equal(mutation.status, 200);
  const updated = decoder.decode((await reader.read()).value);
  assert.match(updated, /"value":1/);

  await reader.cancel();
  backend.close();
  await server.close();
});

test("Node adapter reconstructs only explicitly trusted forwarded origins", async () => {
  const handler = (request) => json({
    url: request.url,
    originAllowed: requestOriginAllowed(request),
  });
  const trusted = await serve(handler, {
    port: 0,
    trustProxy: true,
    allowedHosts: ["todo.apps.example.test"],
  });
  try {
    const response = await fetch(`${trusted.url}/__clank/auth/register`, {
      headers: {
        origin: "https://todo.apps.example.test",
        "x-forwarded-host": "todo.apps.example.test",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: "https://todo.apps.example.test/__clank/auth/register",
      originAllowed: true,
    });
  } finally {
    await trusted.close();
  }

  const untrusted = await serve(handler, { port: 0 });
  try {
    const response = await fetch(`${untrusted.url}/__clank/auth/register`, {
      headers: {
        origin: "https://attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(new URL(body.url).origin, untrusted.url);
    assert.equal(body.originAllowed, false);
  } finally {
    await untrusted.close();
  }
});

test("Node adapter recognizes the platform-controlled managed ingress boundary", async () => {
  const previous = process.env.CLANK_MANAGED_INGRESS;
  process.env.CLANK_MANAGED_INGRESS = "1";
  const handler = (request) => json({
    url: request.url,
    originAllowed: requestOriginAllowed(request),
  });
  const server = await serve(handler, {
    port: 0,
    trustProxy: true,
  });
  try {
    const response = await fetch(`${server.url}/__clank/auth/register`, {
      headers: {
        origin: "https://todo.apps.example.test",
        "x-forwarded-host": "todo.apps.example.test",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: "https://todo.apps.example.test/__clank/auth/register",
      originAllowed: true,
    });
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.CLANK_MANAGED_INGRESS;
    else process.env.CLANK_MANAGED_INGRESS = previous;
  }
});

test("Node adapter enforces Host/body limits and static files contain symlinks and dotfiles", async () => {
  const server = await serve(async (request) => new Response(await request.text()), {
    port: 0,
    maxBodySize: 8,
  });
  try {
    const badHostStatus = await new Promise((resolve, reject) => {
      const url = new URL(server.url);
      const outgoing = httpRequest({
        hostname: url.hostname,
        port: Number(url.port),
        path: "/",
        headers: { host: "evil.test" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(badHostStatus, 400);

    const oversized = await fetch(server.url, {
      method: "POST",
      body: "123456789",
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("x-content-type-options"), "nosniff");

    const chunkedStatus = await new Promise((resolve, reject) => {
      const url = new URL(server.url);
      const outgoing = httpRequest({
        method: "POST",
        hostname: url.hostname,
        port: Number(url.port),
        path: "/",
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      outgoing.once("error", reject);
      outgoing.write("1234");
      outgoing.end("56789");
    });
    assert.equal(chunkedStatus, 413);
  } finally {
    await server.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "clank-static-"));
  const root = join(directory, "public");
  const outside = join(directory, "secret.txt");
  const fs = await import("node:fs/promises");
  await fs.mkdir(root);
  await writeFile(outside, "private");
  await writeFile(join(root, ".env"), "SECRET=true");
  await symlink(outside, join(root, "leak.txt"));
  const paddedPrefix = `${"/".repeat(100_000)}assets${"/".repeat(100_000)}`;
  const files = staticFiles(root, { prefix: paddedPrefix });
  try {
    assert.equal((await files.handle(new Request("http://test/assets/.env"))).status, 404);
    assert.equal((await files.handle(new Request("http://test/assets/leak.txt"))).status, 404);
    assert.equal((await files.handle(new Request("http://test/assets/%2e%2e/secret.txt"))).status, 404);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node adapter cancels a streamed Fetch response when the client disconnects", async () => {
  let cancelled = false;
  const server = await serve(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("first chunk")); },
    cancel() { cancelled = true; },
  })), { port: 0 });
  try {
    await new Promise((resolve, reject) => {
      const url = new URL(server.url);
      const outgoing = httpRequest({
        hostname: url.hostname,
        port: Number(url.port),
        path: "/stream",
      }, (response) => {
        response.once("data", () => outgoing.destroy());
        response.once("close", resolve);
      });
      outgoing.once("error", (error) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      outgoing.end();
    });
    const deadline = Date.now() + 1_000;
    while (!cancelled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
  } finally {
    await server.close();
  }
});
