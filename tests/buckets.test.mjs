import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  BucketError,
  createBucketClient,
  createBucketMcpTools,
  defineBucket,
  inspectBucketImage,
  openBucketManager,
} from "../dist/buckets.js";
import { openLocalObjectStore } from "../dist/object-storage.js";
import { defineBackend, defineDatabase, defineTable, openBackend } from "../dist/backend.js";
import { s } from "../dist/ai.js";

const encoder = new TextEncoder();
const text = (value) => encoder.encode(value);

function barrier() {
  let resolve;
  const promise = new Promise((ready) => { resolve = ready; });
  return { promise, resolve };
}

async function fixture(definitions, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-buckets-"));
  const localStore = await openLocalObjectStore({ directory: join(root, "objects"), maxObjectBytes: 1024 * 1024 });
  const { wrapStore, ...managerOptions } = options;
  const store = wrapStore ? wrapStore(localStore) : localStore;
  const manager = await openBucketManager({
    definitions,
    store,
    databasePath: join(root, "catalog.sqlite"),
    stagingDirectory: join(root, "staging"),
    signingKey: "01234567890123456789012345678901",
    publicOrigin: "https://app.example",
    ...managerOptions,
  });
  return {
    root,
    store,
    manager,
    async close() {
      manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function png(width = 2, height = 3) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("bucket definitions are immutable, policy-complete, and verify image signatures", () => {
  const bucket = defineBucket({
    name: "avatars",
    description: "Verified account avatars.",
    visibility: "public",
    ownership: "app",
    browserAccess: "public",
    maxObjectBytes: 1024,
    maxBytes: 4096,
    image: { maxWidth: 100, maxHeight: 100, variants: { thumb: { width: 32, height: 32 } } },
  });
  assert.equal(bucket.protocol, "clank-bucket/1");
  assert.deepEqual(bucket.allowedContentTypes, ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
  assert.ok(Object.isFrozen(bucket));
  assert.ok(Object.isFrozen(bucket.image.variants.thumb));
  assert.deepEqual(inspectBucketImage(png(), "image/png"), { format: "png", width: 2, height: 3 });
  assert.throws(() => inspectBucketImage(png(), "image/jpeg"), (error) => error.code === "IMAGE_TYPE_MISMATCH");
  assert.throws(() => inspectBucketImage(text("not an image")), (error) => error.code === "INVALID_IMAGE");
  assert.throws(() => defineBucket({ name: "private-files", ownership: "user", browserAccess: "public" }), /app ownership and public visibility/u);
  assert.throws(() => defineBucket({ name: "private-app", ownership: "app", visibility: "private", browserAccess: "public" }), /public visibility/u);
  assert.throws(() => defineBucket({ name: "../bad" }), /Bucket names/u);
  assert.throws(() => defineBucket({ name: "files", surprise: true }), /unknown field surprise/u);
});

test("managed buckets isolate owners and atomically enforce object, byte, and deployment quotas", async () => {
  const files = defineBucket({
    name: "files",
    ownership: "user",
    allowedContentTypes: ["text/plain"],
    maxObjectBytes: 10,
    maxObjects: 3,
    maxBytes: 20,
    perOwnerMaxObjects: 2,
    perOwnerMaxBytes: 12,
  });
  const environment = await fixture([files], { maxObjects: 3, maxBytes: 16 });
  try {
    const bucket = environment.manager.bucket("files");
    const alice = await bucket.put("notes/a.txt", text("alice"), { userId: "alice", contentType: "text/plain" });
    await bucket.put("notes/b.txt", text("second"), { userId: "alice", contentType: "text/plain" });
    await bucket.put("notes/a.txt", text("bob"), { userId: "bob", contentType: "text/plain" });
    assert.equal(bucket.stat("notes/a.txt", { userId: "alice" }).sha256, alice.sha256);
    assert.equal(new TextDecoder().decode((await bucket.get("notes/a.txt", { userId: "bob" })).bytes), "bob");
    assert.deepEqual(bucket.list({ userId: "alice", prefix: "notes/", limit: 1 }).objects.map((item) => item.ownerId), ["alice"]);
    await assert.rejects(
      bucket.put("notes/c.txt", text("x"), { userId: "alice", contentType: "text/plain" }),
      (error) => error.code === "PROJECT_BUCKET_QUOTA_EXCEEDED" || error.code === "BUCKET_QUOTA_EXCEEDED",
    );
    await assert.rejects(
      bucket.put("bad.bin", text("x"), { userId: "bob", contentType: "application/octet-stream" }),
      (error) => error.code === "CONTENT_TYPE_NOT_ALLOWED",
    );
    await assert.rejects(
      bucket.put("notes/a.txt", text("changed"), { userId: "alice", contentType: "text/plain", ifSha256: "0".repeat(64) }),
      (error) => error.code === "BUCKET_OBJECT_CHANGED",
    );
    assert.equal(await bucket.delete("notes/a.txt", { userId: "alice", ifSha256: alice.sha256 }), true);
    assert.equal(bucket.stat("notes/a.txt", { userId: "alice" }), null);
    assert.ok(bucket.stat("notes/a.txt", { userId: "bob" }));
    assert.deepEqual(environment.manager.usage(), {
      objects: 2, bytes: 9, reservedObjects: 0, reservedBytes: 0, maxObjects: 3, maxBytes: 16,
    });
    assert.throws(() => bucket.list(), (error) => error.code === "BUCKET_AUTH_REQUIRED");
  } finally {
    await environment.close();
  }
});

test("signed direct and resumable capabilities are bound, expiring, offset-safe, and publicly cacheable", async () => {
  let now = 1_800_000_000_000;
  const assets = defineBucket({
    name: "assets",
    visibility: "public",
    ownership: "app",
    browserAccess: "public",
    allowedContentTypes: ["text/plain"],
    maxObjectBytes: 20,
    maxChunkBytes: 3,
    cacheControl: "public, max-age=3600, immutable",
  });
  const environment = await fixture([assets], { now: () => now });
  try {
    const bucket = environment.manager.bucket("assets");
    const direct = await bucket.createUploadIntent({ key: "direct.txt", size: 2, contentType: "text/plain", resumable: false });
    let response = await environment.manager.handle(new Request(direct.url, { method: "PUT", headers: direct.headers, body: text("ok") }));
    assert.equal(response.status, 201);

    const resumable = await bucket.createUploadIntent({ key: "large.txt", size: 6, contentType: "text/plain", resumable: true });
    response = await environment.manager.handle(new Request(resumable.url, {
      method: "PATCH", headers: { ...resumable.headers, "upload-offset": "1" }, body: text("abc"),
    }));
    assert.equal(response.status, 409);
    response = await environment.manager.handle(new Request(resumable.url, {
      method: "PATCH", headers: { ...resumable.headers, "upload-offset": "0" }, body: text("abc"),
    }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("upload-offset"), "3");
    response = await environment.manager.handle(new Request(resumable.url, {
      method: "PATCH", headers: { ...resumable.headers, "upload-offset": "3" }, body: text("def"),
    }));
    assert.equal(response.status, 201);

    const object = bucket.stat("large.txt");
    response = await environment.manager.handle(new Request(object.url));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "abcdef");
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600, immutable");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("etag"), `"${object.sha256}"`);
    const priorUrl = object.url;
    const replaced = await bucket.put("large.txt", text("ghijkl"), { contentType: "text/plain" });
    assert.notEqual(replaced.url, priorUrl);
    assert.equal((await environment.manager.handle(new Request(priorUrl))).status, 404);
    assert.equal(await (await environment.manager.handle(new Request(replaced.url))).text(), "ghijkl");

    const read = await bucket.createReadIntent("large.txt");
    const tampered = `${read.url.slice(0, -1)}${read.url.endsWith("a") ? "b" : "a"}`;
    assert.equal((await environment.manager.handle(new Request(tampered))).status, 401);
    now += 16 * 60_000;
    assert.equal((await environment.manager.handle(new Request(read.url))).status, 401);
  } finally {
    await environment.close();
  }
});

test("browser uploads use authenticated CSRF-gated management and exact server capabilities", async () => {
  const files = defineBucket({ name: "files", ownership: "user", allowedContentTypes: ["text/plain"], maxObjectBytes: 32, maxChunkBytes: 2 });
  const environment = await fixture([files]);
  let verified = 0;
  try {
    const client = createBucketClient("files", {
      csrfToken: "csrf",
      fetch: async (input, init) => {
        const request = new Request(new URL(String(input), "https://app.example"), init);
        const capability = new URL(request.url).pathname.includes("/cap/");
        return environment.manager.handle(request, capability ? {} : {
          authenticated: true,
          userId: "user-one",
          verifyWrite() {
            assert.equal(request.headers.get("x-clank-csrf"), "csrf");
            verified++;
          },
        });
      },
    });
    const progress = [];
    const stored = await client.upload({ key: "hello.txt", value: text("hello"), contentType: "text/plain", resumable: true, onProgress: (...entry) => progress.push(entry) });
    assert.equal(stored.ownerId, "user-one");
    await environment.manager.bucket("files").put("other.txt", text("private"), {
      userId: "user-two",
      contentType: "text/plain",
    });
    assert.deepEqual(progress, [[2, 5], [4, 5], [5, 5]]);
    assert.equal((await client.list()).objects.length, 1);
    assert.equal((await client.stat("hello.txt")).sha256, stored.sha256);
    const read = await client.createReadIntent("hello.txt");
    assert.match(read.url, /\/cap\//u);
    const deniedBrowser = await environment.manager.handle(new Request("https://app.example/__clank/buckets"));
    assert.equal(deniedBrowser.status, 401);
    const browser = await environment.manager.handle(new Request("https://app.example/__clank/buckets?bucket=files"), {
      authenticated: true,
      userId: "user-one",
    });
    assert.equal(browser.status, 200);
    assert.match(browser.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
    assert.equal(browser.headers.get("cache-control"), "no-store");
    const browserHtml = await browser.text();
    assert.match(browserHtml, /hello\.txt/u);
    assert.doesNotMatch(browserHtml, /other\.txt/u);
    assert.equal(await client.delete("hello.txt", stored.sha256), true);
    assert.equal(verified, 2);
  } finally {
    await environment.close();
  }
});

test("image variants and MCP tools share current bucket policy and owner isolation", async () => {
  const avatars = defineBucket({
    name: "avatars",
    ownership: "user",
    maxObjectBytes: 1024,
    maxBytes: 4096,
    image: { maxWidth: 100, maxHeight: 100, variants: { thumb: { width: 1, height: 1, format: "png" } } },
  });
  const environment = await fixture([avatars], {
    imageTransformer({ source, variant, spec }) {
      assert.equal(source.metadata.image.width, 2);
      assert.equal(variant, "thumb");
      assert.equal(spec.width, 1);
      return { bytes: png(1, 1), contentType: "image/png" };
    },
  });
  try {
    const tools = createBucketMcpTools(environment.manager, { identity: (context) => ({ userId: context.userId }) });
    assert.deepEqual(tools.map((tool) => tool.name), [
      "bucket_avatars_list", "bucket_avatars_read", "bucket_avatars_put", "bucket_avatars_delete", "bucket_avatars_transform",
    ]);
    const put = tools.find((tool) => tool.name.endsWith("_put"));
    const uploaded = await put.invoke({ key: "me.png", base64: btoa(String.fromCharCode(...png())), contentType: "image/png" }, { userId: "alice" }, new Request("https://app.example/mcp"));
    assert.equal(uploaded.ownerId, "alice");
    const transform = tools.find((tool) => tool.name.endsWith("_transform"));
    const variant = await transform.invoke({ key: "me.png", variant: "thumb" }, { userId: "alice" }, new Request("https://app.example/mcp"));
    assert.equal(variant.image.width, 1);
    assert.equal(variant.variant, "thumb");
    const list = tools.find((tool) => tool.name.endsWith("_list"));
    assert.equal((await list.invoke({}, { userId: "bob" }, new Request("https://app.example/mcp"))).objects.length, 0);
    await assert.rejects(
      put.invoke({ key: "fake.png", base64: btoa("not png"), contentType: "image/png" }, { userId: "alice" }, new Request("https://app.example/mcp")),
      (error) => error.code === "INVALID_IMAGE",
    );
  } finally {
    await environment.close();
  }
});

test("expired reservations are swept and release their quota and staged bytes", async () => {
  let now = 2_000_000_000_000;
  const files = defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"], maxObjectBytes: 10, maxObjects: 1, maxBytes: 10 });
  const environment = await fixture([files], { now: () => now, capabilityTtlMs: 1000 });
  try {
    const bucket = environment.manager.bucket("files");
    await bucket.createUploadIntent({ key: "abandoned.txt", size: 10, contentType: "text/plain", resumable: true, expiresInMs: 1000 });
    assert.equal(bucket.usage().reservedObjects, 1);
    now += 1001;
    assert.deepEqual(await environment.manager.sweep(), { reservations: 1, objects: 1 });
    assert.equal(bucket.usage().reservedObjects, 0);
    await bucket.put("replacement.txt", text("ok"), { contentType: "text/plain" });
  } finally {
    await environment.close();
  }
});

test("provider deletion failures remain durably retryable without restoring catalog visibility", async () => {
  let failDelete = true;
  let deletedKey;
  const files = defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"] });
  const environment = await fixture([files], {
    wrapStore: (store) => ({
      ...store,
      async delete(key) {
        deletedKey = key;
        if (failDelete) throw new Error("provider unavailable");
        return store.delete(key);
      },
    }),
  });
  try {
    const bucket = environment.manager.bucket("files");
    await bucket.put("remove.txt", text("remove me"), { contentType: "text/plain" });
    assert.equal(await bucket.delete("remove.txt"), true);
    assert.equal(bucket.stat("remove.txt"), null);
    assert.equal((await environment.store.stat(deletedKey)).size, 9);
    failDelete = false;
    assert.deepEqual(await environment.manager.sweep(), { reservations: 0, objects: 1 });
    assert.equal(await environment.store.stat(deletedKey), null);
  } finally {
    await environment.close();
  }
});

test("openBackend publishes bucket policy and invokes the same live bucket through MCP", async () => {
  const assets = defineBucket({ name: "assets", ownership: "app", allowedContentTypes: ["text/plain"], maxObjectBytes: 100 });
  const environment = await fixture([assets]);
  const schema = defineDatabase({ records: defineTable({ value: s.string() }) });
  const definition = defineBackend({ schema }).functions(() => ({}));
  const runtime = await openBackend(definition, { path: ":memory:", buckets: environment.manager });
  try {
    const manifestResponse = await runtime.handle(new Request("https://app.example/__clank/manifest"));
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.deepEqual(manifest.buckets.map((bucket) => bucket.name), ["assets"]);
    assert.ok(runtime.contractRevision);
    assert.equal(runtime.buckets, environment.manager);

    const initialized = await runtime.handle(new Request("https://app.example/__clank/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bucket-test", version: "1" } },
      }),
    }));
    const session = initialized.headers.get("mcp-session-id");
    assert.equal(initialized.status, 200);
    assert.ok(session);
    const called = await runtime.handle(new Request("https://app.example/__clank/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25", "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "bucket_assets_put", arguments: { key: "agent.txt", base64: btoa("agent"), contentType: "text/plain" } },
      }),
    }));
    const payload = await called.json();
    assert.equal(payload.result.isError, false);
    assert.equal(environment.manager.bucket("assets").stat("agent.txt").size, 5);
  } finally {
    runtime.close();
    await environment.close();
  }
});

test("smaller pending replacements keep owner, bucket, and project usage readable without lending future capacity", async (t) => {
  for (const completion of ["commit", "cancel", "expire"]) {
    await t.test(completion, async () => {
      let now = 2_000_000_000_000;
      const files = defineBucket({ name: "files", ownership: "user", allowedContentTypes: ["text/plain"], maxBytes: 10, maxObjectBytes: 8, perOwnerMaxBytes: 9 });
      const other = defineBucket({ name: "other", ownership: "user", allowedContentTypes: ["text/plain"], maxObjectBytes: 10 });
      const environment = await fixture([files, other], { maxBytes: 12, now: () => now, capabilityTtlMs: 1000 });
      try {
        const bucket = environment.manager.bucket("files");
        await bucket.put("large", text("12345678"), { userId: "alice", contentType: "text/plain" });
        const intent = await bucket.createUploadIntent({ key: "large", size: 1, userId: "alice", contentType: "text/plain", resumable: true });
        assert.equal(bucket.usage({ userId: "alice" }).reservedBytes, 0);
        assert.equal(bucket.list({ userId: "alice" }).usage.bytes, 8);
        assert.equal(environment.manager.usage().reservedBytes, 0);
        await bucket.put("alice", text("a"), { userId: "alice", contentType: "text/plain" });
        await assert.rejects(bucket.put("owner-over", text("a"), { userId: "alice", contentType: "text/plain" }),
          (error) => error.code === "BUCKET_QUOTA_EXCEEDED");
        await bucket.put("bob", text("b"), { userId: "bob", contentType: "text/plain" });
        await assert.rejects(bucket.put("bucket-over", text("b"), { userId: "bob", contentType: "text/plain" }),
          (error) => error.code === "BUCKET_QUOTA_EXCEEDED");
        await environment.manager.bucket("other").put("other", text("cc"), { userId: "carol", contentType: "text/plain" });
        await assert.rejects(environment.manager.bucket("other").put("project-over", text("c"), { userId: "carol", contentType: "text/plain" }),
          (error) => error.code === "PROJECT_BUCKET_QUOTA_EXCEEDED");
        if (completion === "commit") {
          const response = await environment.manager.handle(new Request(intent.url, {
            method: "PATCH", headers: intent.headers, body: text("x"),
          }));
          assert.equal(response.status, 201);
        } else if (completion === "cancel") {
          assert.equal((await environment.manager.handle(new Request(intent.url, { method: "DELETE" }))).status, 204);
        } else {
          now += 1001;
          await environment.manager.sweep();
        }
        assert.equal(environment.manager.usage().bytes, completion === "commit" ? 5 : 12);
        assert.equal(environment.manager.usage().reservedBytes, 0);
        assert.equal(bucket.usage({ userId: "alice" }).bytes, completion === "commit" ? 2 : 9);
      } finally {
        await environment.close();
      }
    });
  }
});

test("a direct capability has one provider writer, including duplicate and conflicting payloads", async (t) => {
  for (const loserValue of ["winner", "loserr"]) {
    await t.test(loserValue, async () => {
      const entered = barrier();
      const release = barrier();
      let writes = 0;
      const environment = await fixture([defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"] })], {
        wrapStore: (store) => ({
          ...store,
          async put(...args) {
            writes++;
            if (writes === 1) { entered.resolve(); await release.promise; }
            return store.put(...args);
          },
        }),
      });
      let winning;
      try {
        const bucket = environment.manager.bucket("files");
        const intent = await bucket.createUploadIntent({ key: "same", size: 6, contentType: "text/plain", resumable: false });
        const request = (value) => environment.manager.handle(new Request(intent.url, { method: "PUT", headers: intent.headers, body: text(value) }));
        winning = request("winner");
        await entered.promise;
        const losing = await request(loserValue);
        assert.equal(losing.status, 409);
        assert.equal((await losing.json()).error.code, "UPLOAD_BUSY");
        assert.equal(writes, 1);
        release.resolve();
        assert.equal((await winning).status, 201);
        assert.equal((await request(loserValue)).status, 410);
        assert.equal(new TextDecoder().decode((await bucket.get("same")).bytes), "winner");
        assert.equal(bucket.usage().objects, 1);
        assert.equal(bucket.usage().reservedObjects, 0);
      } finally {
        release.resolve();
        await winning;
        await environment.close();
      }
    });
  }
});

test("deletion cancels equal and growing pending replacements before releasing quota", async (t) => {
  for (const size of [4, 6]) {
    await t.test(String(size), async () => {
      const files = defineBucket({ name: "files", ownership: "user", allowedContentTypes: ["text/plain"], maxObjects: 1, maxBytes: 6, perOwnerMaxObjects: 1, perOwnerMaxBytes: 6, maxObjectBytes: 6 });
      const environment = await fixture([files], { maxObjects: 1, maxBytes: 6 });
      try {
        const bucket = environment.manager.bucket("files");
        await bucket.put("same", text("old!"), { userId: "alice", contentType: "text/plain" });
        const intent = await bucket.createUploadIntent({ key: "same", size, userId: "alice", contentType: "text/plain", resumable: false });
        assert.equal(await bucket.delete("same", { userId: "alice" }), true);
        assert.deepEqual(environment.manager.usage(), { objects: 0, bytes: 0, reservedObjects: 0, reservedBytes: 0, maxObjects: 1, maxBytes: 6 });
        await bucket.put("next", text("filled"), { userId: "alice", contentType: "text/plain" });
        assert.equal((await environment.manager.handle(new Request(intent.url, { method: "PUT", headers: intent.headers, body: text("x".repeat(size)) }))).status, 410);
        assert.equal(bucket.stat("same", { userId: "alice" }), null);
        assert.equal(bucket.usage({ userId: "alice" }).bytes, 6);
        assert.equal(environment.manager.usage().objects, 1);
      } finally {
        await environment.close();
      }
    });
  }
});

test("deletion fences an in-flight replacement and reclaims its late provider write", async () => {
  const entered = barrier();
  const release = barrier();
  let writes = 0;
  let canceledKey;
  const environment = await fixture([defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"], maxObjects: 1, maxBytes: 6, maxObjectBytes: 6 })], {
    maxObjects: 1,
    maxBytes: 6,
    wrapStore: (store) => ({
      ...store,
      async put(...args) {
        writes++;
        if (writes === 2) { canceledKey = args[0]; entered.resolve(); await release.promise; }
        return store.put(...args);
      },
    }),
  });
  let canceled;
  try {
    const bucket = environment.manager.bucket("files");
    await bucket.put("same", text("old!"), { contentType: "text/plain" });
    const intent = await bucket.createUploadIntent({ key: "same", size: 6, contentType: "text/plain", resumable: false });
    canceled = environment.manager.handle(new Request(intent.url, { method: "PUT", headers: intent.headers, body: text("cancel") }));
    await entered.promise;
    assert.equal(await bucket.delete("same"), true);
    await bucket.put("same", text("winner"), { contentType: "text/plain" });
    release.resolve();
    assert.equal((await canceled).status, 409);
    assert.equal(new TextDecoder().decode((await bucket.get("same")).bytes), "winner");
    assert.equal(await environment.store.stat(canceledKey), null);
    assert.deepEqual(environment.manager.usage(), { objects: 1, bytes: 6, reservedObjects: 0, reservedBytes: 0, maxObjects: 1, maxBytes: 6 });
  } finally {
    release.resolve();
    await canceled;
    await environment.close();
  }
});

test("a failed bucket BEGIN leaves the manager usable and does not attempt rollback", async (t) => {
  const environment = await fixture([defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"] })]);
  const original = DatabaseSync.prototype.exec;
  let failBegin = true;
  let rollbacks = 0;
  const mocked = t.mock.method(DatabaseSync.prototype, "exec", function(sql) {
    if (sql === "BEGIN IMMEDIATE" && failBegin) {
      failBegin = false;
      throw new Error("injected BEGIN failure");
    }
    if (sql === "ROLLBACK") rollbacks++;
    return original.call(this, sql);
  });
  try {
    const bucket = environment.manager.bucket("files");
    await assert.rejects(bucket.put("failed", text("no"), { contentType: "text/plain" }), /injected BEGIN failure/u);
    assert.equal(rollbacks, 0);
    await bucket.put("works", text("yes"), { contentType: "text/plain" });
    assert.equal(bucket.stat("works").size, 3);
  } finally {
    mocked.mock.restore();
    await environment.close();
  }
});

test("failed server put validation releases reservations immediately", async () => {
  const avatars = defineBucket({ name: "avatars", ownership: "app", maxObjects: 1, maxBytes: 24, maxObjectBytes: 24, image: { maxWidth: 10, maxHeight: 10 } });
  const environment = await fixture([avatars], { maxObjects: 1, maxBytes: 24 });
  try {
    const bucket = environment.manager.bucket("avatars");
    for (const invalid of [
      { bytes: text("not png"), code: "INVALID_IMAGE" },
      { bytes: png(), code: "UPLOAD_DIGEST_MISMATCH", expectedSha256: "0".repeat(64) },
    ]) {
      await assert.rejects(bucket.put("avatar", invalid.bytes, { contentType: "image/png", expectedSha256: invalid.expectedSha256 }),
        (error) => error.code === invalid.code);
      assert.equal(environment.manager.usage().reservedObjects, 0);
      assert.equal(environment.manager.usage().reservedBytes, 0);
    }
    assert.equal((await bucket.put("avatar", png(), { contentType: "image/png" })).size, 24);
  } finally {
    await environment.close();
  }
});

test("provider failures release finalizer claims and preserve retryable cleanup", async (t) => {
  for (const failure of ["throw", "metadata"]) {
    await t.test(failure, async () => {
      let fail = true;
      let failedKey;
      const environment = await fixture([defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"], maxObjects: 1 })], {
        wrapStore: (store) => ({
          ...store,
          async put(...args) {
            const result = await store.put(...args);
            if (!fail) return result;
            failedKey = args[0];
            if (failure === "throw") throw new Error("provider failed after write");
            return { ...result, sha256: "0".repeat(64) };
          },
        }),
      });
      try {
        const bucket = environment.manager.bucket("files");
        const intent = await bucket.createUploadIntent({ key: "same", size: 4, contentType: "text/plain", resumable: false });
        const response = await environment.manager.handle(new Request(intent.url, { method: "PUT", headers: intent.headers, body: text("fail") }));
        assert.equal(response.status, failure === "throw" ? 500 : 502);
        assert.equal(bucket.stat("same"), null);
        assert.equal(environment.manager.usage().reservedObjects, 0);
        assert.equal(await environment.store.stat(failedKey), null);
        fail = false;
        await bucket.put("same", text("next"), { contentType: "text/plain" });
        assert.equal(new TextDecoder().decode((await bucket.get("same")).bytes), "next");
      } finally {
        await environment.close();
      }
    });
  }
});

test("an older garbage collector cannot acknowledge cleanup requeued by a canceled provider write", async () => {
  const writing = barrier();
  const releaseWrite = barrier();
  const deleting = barrier();
  const releaseDelete = barrier();
  let storageKey;
  let deletes = 0;
  let failRetry = true;
  const environment = await fixture([defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"] })], {
    wrapStore: (store) => ({
      ...store,
      async put(...args) {
        storageKey = args[0];
        writing.resolve();
        await releaseWrite.promise;
        return store.put(...args);
      },
      async delete(key) {
        if (key !== storageKey) return store.delete(key);
        deletes++;
        if (deletes === 1) {
          const result = await store.delete(key);
          deleting.resolve();
          await releaseDelete.promise;
          return result;
        }
        if (failRetry) throw new Error("cleanup temporarily unavailable");
        return store.delete(key);
      },
    }),
  });
  let upload;
  let deletion;
  try {
    const bucket = environment.manager.bucket("files");
    const intent = await bucket.createUploadIntent({ key: "pending", size: 4, contentType: "text/plain", resumable: false });
    upload = environment.manager.handle(new Request(intent.url, { method: "PUT", headers: intent.headers, body: text("late") }));
    await writing.promise;
    deletion = bucket.delete("pending");
    await deleting.promise;
    releaseWrite.resolve();
    assert.equal((await upload).status, 409);
    assert.ok(await environment.store.stat(storageKey));
    releaseDelete.resolve();
    assert.equal(await deletion, false);
    failRetry = false;
    assert.equal((await environment.manager.sweep()).objects, 1);
    assert.equal(await environment.store.stat(storageKey), null);
  } finally {
    releaseWrite.resolve();
    releaseDelete.resolve();
    await Promise.all([upload, deletion]);
    await environment.close();
  }
});

test("bucket cleanup preserves full-range SQLite rowids without changing numeric catalog reads", async (t) => {
  const prepare = DatabaseSync.prototype.prepare;
  let garbageStatements = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    if (sql.includes("INSERT INTO clank_bucket_garbage (rowid, storage_key, created_at)")) {
      // Make SQLite's random() boundary deterministic: this value cannot be
      // represented as a JS number, and remains lastInsertRowid after DELETE.
      sql = sql.replace("random()", String(9223372036854775806n - BigInt(garbageStatements++)));
    }
    return prepare.call(this, sql);
  });
  let failDelete = true;
  const environment = await fixture([defineBucket({ name: "files", ownership: "app", allowedContentTypes: ["text/plain"] })], {
    wrapStore: store => ({ ...store, async delete(key) {
      if (failDelete) throw new Error("Provider cleanup is temporarily unavailable.");
      return store.delete(key);
    } }),
  });
  try {
    const bucket = environment.manager.bucket("files");
    await bucket.put("first", text("first"), { contentType: "text/plain" });
    assert.equal(await bucket.delete("first"), true);
    assert.equal(garbageStatements, 1);
    const catalog = new DatabaseSync(join(environment.root, "catalog.sqlite"));
    try {
      assert.equal(catalog.prepare("SELECT CAST(rowid AS TEXT) AS id FROM clank_bucket_garbage").get().id, "9223372036854775806");
    } finally { catalog.close(); }
    failDelete = false;
    assert.deepEqual(await environment.manager.sweep(), { reservations: 0, objects: 1 });
    assert.equal(typeof environment.manager.usage().objects, "number");
    assert.equal(environment.manager.usage().bytes, 0);
    await bucket.put("second", text("second"), { contentType: "text/plain" });
    assert.equal(typeof bucket.stat("second").size, "number");
    assert.equal(await bucket.delete("second"), true);
    assert.equal(garbageStatements, 2);
    assert.deepEqual(await environment.manager.sweep(), { reservations: 0, objects: 0 });
  } finally { await environment.close(); }
});
