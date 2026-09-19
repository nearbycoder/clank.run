import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile, utimes } from "node:fs/promises";
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

test("static files revalidate unchanged bodies with weak ETags over GET and HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-static-validators-"));
  const file = join(root, "index.html");
  const content = "x".repeat(1024 * 1024);
  await writeFile(file, content);
  const files = staticFiles(root, { cacheControl: "public, max-age=0, must-revalidate" });
  const server = await serve(files, { port: 0 });
  try {
    const first = await fetch(server.url);
    assert.equal(first.status, 200);
    assert.equal(await first.text(), content);
    const etag = first.headers.get("etag");
    assert.match(etag, /^W\/".+"$/);
    for (const method of ["GET", "HEAD"]) {
      for (const condition of [etag, etag.slice(2), `"other,tag", ${etag}`, "*"]) {
        const response = await fetch(server.url, { method, headers: { "if-none-match": condition } });
        assert.equal(response.status, 304);
        assert.equal(response.headers.get("etag"), etag);
        assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
        assert.equal(response.headers.get("content-length"), null);
        assert.equal(await response.text(), "");
      }
    }
    const head = await fetch(server.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(head.headers.get("content-length"), String(content.length));
    assert.equal(await head.text(), "");
    const miss = await fetch(server.url, { headers: { "if-none-match": '"stale"' } });
    assert.equal(miss.status, 200);
    assert.equal(await miss.text(), content);
    await writeFile(file, "updated");
    const changed = await fetch(server.url, { headers: { "if-none-match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
    assert.equal(await changed.text(), "updated");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("static validators refresh metadata and never bypass file containment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-static-validator-paths-"));
  const file = join(directory, "asset.txt");
  await writeFile(file, "first");
  const oldTime = new Date("2020-01-01T00:00:00Z");
  await utimes(file, oldTime, oldTime);
  const files = staticFiles(directory);
  const request = (path, etag) => new Request(`http://test/${path}`, {
    headers: { "if-none-match": etag },
  });
  try {
    const first = await files.handle(new Request("http://test/asset.txt"));
    const etag = first.headers.get("etag");
    assert.equal(await first.text(), "first");
    // Same-size replacements can preserve mtime. ctime/inode still invalidate.
    await rm(file);
    await writeFile(file, "other");
    await utimes(file, oldTime, oldTime);
    const replacement = await files.handle(request("asset.txt", etag));
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.headers.get("etag"), etag);
    assert.equal(await replacement.text(), "other");
    await rm(file);
    assert.equal((await files.handle(request("asset.txt", "*"))).status, 404);
    await symlink(import.meta.filename, file);
    assert.equal((await files.handle(request("asset.txt", etag))).status, 404);
    await writeFile(join(directory, ".secret"), "private");
    assert.equal((await files.handle(request(".secret", "*"))).status, 404);
    assert.equal((await files.handle(request("%2e%2e/outside.txt", "*"))).status, 404);
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

test("Node adapter cancels unused HEAD response bodies", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() { cancelled = true; },
  });
  const server = await serve(() => new Response(body), { port: 0 });
  try {
    const response = await fetch(server.url, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.equal(cancelled, true, "HEAD must release an application's unused response stream");
    assert.equal(body.locked, false);
  } finally {
    await server.close();
  }
});

test("Node adapter releases the reader when a backpressured client disconnects", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const server = await serve(() => new Response(body), { port: 0 });
  try {
    await new Promise((resolve, reject) => {
      const request = httpRequest(server.url, (response) => {
        response.pause();
        setTimeout(() => { response.destroy(); resolve(); }, 50);
      });
      request.once("error", reject);
      request.end();
    });
    const deadline = Date.now() + 2_000;
    while ((!cancelled || body.locked) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cancelled, true);
    assert.equal(body.locked, false, "a closed socket must release the pending drain wait and response reader");
  } finally {
    await server.close();
  }
});

test("Node adapter cancels responses returned after the client has already disconnected", async () => {
  let complete;
  let started;
  const waiting = new Promise((resolve) => { complete = resolve; });
  const received = new Promise((resolve) => { started = resolve; });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const server = await serve(async (request) => {
    started(request);
    await waiting;
    return new Response(body);
  }, { port: 0 });
  const client = httpRequest(server.url);
  client.on("error", () => {});
  try {
    client.end();
    const request = await received;
    client.destroy();
    if (!request.signal.aborted) {
      await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
    }
    complete();
    const deadline = Date.now() + 2_000;
    while (!cancelled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  } finally {
    complete();
    client.destroy();
    await server.close();
  }
});
