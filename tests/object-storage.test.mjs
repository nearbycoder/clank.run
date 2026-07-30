import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createS3ObjectStore,
  ObjectStoreError,
  openLocalObjectStore,
} from "../dist/object-storage.js";

test("local object storage is atomic, owner-only, bounded, and integrity checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-local-objects-"));
  try {
    const store = await openLocalObjectStore({
      directory: root,
      maxObjectBytes: 1_024,
    });
    const source = new TextEncoder().encode("first object");
    const first = await store.put("releases/project-01/release-01.clank.gz", source, {
      contentType: "application/vnd.clank.deploy+gzip",
    });
    source.fill(0);
    assert.equal(store.kind, "local");
    assert.equal(first.size, 12);
    assert.equal(first.sha256, sha256(new TextEncoder().encode("first object")));
    assert.equal(first.contentType, "application/vnd.clank.deploy+gzip");
    assert.deepEqual(await store.stat(first.key), first);
    assert.equal(
      new TextDecoder().decode((await store.get(first.key)).bytes),
      "first object",
    );

    const objectPath = join(
      root,
      "objects",
      sha256(new TextEncoder().encode(first.key)).slice(0, 2),
      `${sha256(new TextEncoder().encode(first.key))}.object`,
    );
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(objectPath)).mode & 0o777, 0o600);

    const replacement = await store.put(first.key, new TextEncoder().encode("second object"));
    assert.equal(replacement.createdAt, first.createdAt);
    assert.ok(replacement.updatedAt >= first.updatedAt);
    assert.equal(new TextDecoder().decode((await store.get(first.key)).bytes), "second object");

    const envelope = await readFile(objectPath);
    envelope[envelope.length - 1] ^= 0xff;
    await writeFile(objectPath, envelope);
    await assert.rejects(
      store.get(first.key),
      (error) => error instanceof ObjectStoreError
        && error.code === "OBJECT_INTEGRITY_FAILED",
    );

    await chmod(objectPath, 0o644);
    await assert.rejects(
      store.stat(first.key),
      (error) => error instanceof ObjectStoreError
        && error.code === "UNSAFE_LOCAL_OBJECT",
    );
    await chmod(objectPath, 0o600);
    assert.equal(await store.delete(first.key), true);
    assert.equal(await store.delete(first.key), false);
    assert.equal(await store.get(first.key), null);

    await assert.rejects(
      store.put("too-large", new Uint8Array(1_025)),
      (error) => error instanceof ObjectStoreError
        && error.status === 413
        && error.code === "OBJECT_TOO_LARGE",
    );
    await assert.rejects(store.get("../escape"), /Object key is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local object storage refuses symbolic-link roots and object shards", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-local-object-links-"));
  try {
    const target = join(root, "target");
    const linked = join(root, "linked");
    await mkdir(target);
    await symlink(target, linked);
    await assert.rejects(
      openLocalObjectStore({ directory: linked }),
      (error) => error instanceof ObjectStoreError
        && error.code === "UNSAFE_LOCAL_OBJECT",
    );

    const storeRoot = join(root, "store");
    const store = await openLocalObjectStore({ directory: storeRoot });
    const key = "linked-shard-object";
    const shard = sha256(new TextEncoder().encode(key)).slice(0, 2);
    await symlink(target, join(storeRoot, "objects", shard));
    await assert.rejects(
      store.put(key, new TextEncoder().encode("must not escape")),
      (error) => error instanceof ObjectStoreError
        && error.code === "UNSAFE_LOCAL_OBJECT",
    );
    assert.deepEqual(await readFile(join(target, `${sha256(new TextEncoder().encode(key))}.object`)).catch(
      (error) => error.code,
    ), "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 object storage signs and verifies the portable object lifecycle", async () => {
  const service = fakeS3({
    accessKeyId: "CLANKTESTACCESS",
    secretAccessKey: "clank-test-secret-access-key-123456",
    region: "auto",
    sessionToken: "clank-test-session-token-1234567890",
  });
  const now = new Date("2026-07-30T02:30:45.000Z");
  const store = createS3ObjectStore({
    endpoint: "https://storage.example.test",
    region: "auto",
    bucket: "clank-backups",
    accessKeyId: service.accessKeyId,
    secretAccessKey: service.secretAccessKey,
    sessionToken: service.sessionToken,
    prefix: "installation-01",
    fetch: service.fetch,
    retries: 0,
    maxObjectBytes: 4_096,
    now: () => now,
  });

  assert.equal(store.kind, "s3");
  assert.equal(await store.stat("releases/project-01/release-01.clank.gz"), null);
  const bytes = new TextEncoder().encode("content-addressed release");
  const stored = await store.put("releases/project-01/release-01.clank.gz", bytes, {
    contentType: "application/vnd.clank.deploy+gzip",
  });
  bytes.fill(0);
  assert.equal(stored.sha256, sha256(new TextEncoder().encode("content-addressed release")));
  assert.equal(stored.size, 25);

  const request = service.requests.find((entry) => entry.method === "PUT");
  assert.equal(
    request.url,
    "https://clank-backups.storage.example.test/installation-01/releases/project-01/release-01.clank.gz",
  );
  assert.equal(request.redirect, "error");
  assert.match(request.authorization, /^AWS4-HMAC-SHA256 Credential=CLANKTESTACCESS\/20260730\/auto\/s3\/aws4_request/u);
  assert.match(request.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-clank-created-at;x-amz-meta-clank-sha256;x-amz-meta-clank-updated-at;x-amz-security-token/u);

  const downloaded = await store.get(stored.key);
  assert.deepEqual(downloaded.metadata, stored);
  assert.equal(new TextDecoder().decode(downloaded.bytes), "content-addressed release");
  assert.deepEqual(await store.stat(stored.key), stored);
  assert.equal(await store.delete(stored.key), true);
  assert.equal(await store.delete(stored.key), false);
  assert.equal(await store.get(stored.key), null);
  assert.ok(service.requests.length >= 8);
});

test("S3 object storage supports path style and retries exact transient writes", async () => {
  const service = fakeS3({
    accessKeyId: "MINIOACCESS",
    secretAccessKey: "minio-secret-access-key-1234567890",
    region: "us-east-1",
    failFirstPut: true,
  });
  const store = createS3ObjectStore({
    endpoint: "http://127.0.0.1:9000",
    region: service.region,
    bucket: "local-clank",
    accessKeyId: service.accessKeyId,
    secretAccessKey: service.secretAccessKey,
    pathStyle: true,
    fetch: service.fetch,
    retries: 1,
    now: () => new Date("2026-07-30T03:00:00.000Z"),
  });
  await store.put("backups/project-01/database.enc", new TextEncoder().encode("encrypted"));
  const puts = service.requests.filter((entry) => entry.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].url, "http://127.0.0.1:9000/local-clank/backups/project-01/database.enc");
  assert.equal(puts[0].bodySha256, puts[1].bodySha256);
  assert.equal(puts[0].authorization, puts[1].authorization);
});

test("S3 object storage rejects unsafe configuration and fails closed on corrupt responses", async () => {
  assert.throws(
    () => createS3ObjectStore({
      endpoint: "http://storage.example.test",
      region: "auto",
      bucket: "clank-bucket",
      accessKeyId: "ACCESSKEY",
      secretAccessKey: "secret-access-key",
    }),
    /HTTPS origin/u,
  );
  assert.throws(
    () => createS3ObjectStore({
      endpoint: "https://user:secret@storage.example.test",
      region: "auto",
      bucket: "clank-bucket",
      accessKeyId: "ACCESSKEY",
      secretAccessKey: "secret-access-key",
    }),
    /HTTPS origin/u,
  );
  assert.throws(
    () => createS3ObjectStore({
      endpoint: "https://storage.example.test",
      region: "auto",
      bucket: "dotted.bucket",
      accessKeyId: "ACCESSKEY",
      secretAccessKey: "secret-access-key",
    }),
    /require pathStyle/u,
  );
  assert.throws(
    () => createS3ObjectStore({
      endpoint: "https://storage.example.test",
      region: "auto",
      bucket: "clank-bucket",
      accessKeyId: "ACCESSKEY\r\nx-unsafe: yes",
      secretAccessKey: "secret-access-key",
    }),
    /accessKeyId/u,
  );

  const corrupt = createS3ObjectStore({
    endpoint: "https://storage.example.test",
    region: "auto",
    bucket: "clank-bucket",
    accessKeyId: "ACCESSKEY",
    secretAccessKey: "secret-access-key",
    retries: 0,
    maxObjectBytes: 1_024,
    fetch: async (_url, init) => {
      assert.equal(init.redirect, "error");
      const bytes = new TextEncoder().encode("tampered");
      return new Response(bytes, {
        status: 200,
        headers: objectHeaders({
          key: "object-01",
          bytes,
          sha256Value: "0".repeat(64),
        }),
      });
    },
  });
  await assert.rejects(
    corrupt.get("object-01"),
    (error) => error instanceof ObjectStoreError
      && error.code === "OBJECT_INTEGRITY_FAILED",
  );

  let cancelled = false;
  const oversized = createS3ObjectStore({
    endpoint: "https://storage.example.test",
    region: "auto",
    bucket: "clank-bucket",
    accessKeyId: "ACCESSKEY",
    secretAccessKey: "secret-access-key",
    retries: 0,
    maxObjectBytes: 1_024,
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_025));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: objectHeaders({
        key: "object-02",
        bytes: new Uint8Array(1),
      }),
    }),
  });
  await assert.rejects(
    oversized.get("object-02"),
    (error) => error instanceof ObjectStoreError
      && error.code === "OBJECT_TOO_LARGE",
  );
  assert.equal(cancelled, true);
});

test("S3 object storage bounds provider failures and request deadlines", async () => {
  let cancelled = false;
  const denied = createS3ObjectStore({
    endpoint: "https://storage.example.test",
    region: "auto",
    bucket: "clank-bucket",
    accessKeyId: "ACCESSKEY",
    secretAccessKey: "secret-access-key",
    retries: 0,
    maxErrorBytes: 256,
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(257));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 403 }),
  });
  await assert.rejects(
    denied.get("private-object"),
    (error) => error instanceof ObjectStoreError
      && error.code === "OBJECT_STORE_DENIED"
      && !error.message.includes("private-object"),
  );
  assert.equal(cancelled, true);

  const timeout = createS3ObjectStore({
    endpoint: "https://storage.example.test",
    region: "auto",
    bucket: "clank-bucket",
    accessKeyId: "ACCESSKEY",
    secretAccessKey: "secret-access-key",
    retries: 0,
    timeoutMs: 100,
    fetch: async (_url, init) => {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
      throw new Error("unreachable");
    },
  });
  await assert.rejects(
    timeout.stat("slow-object"),
    (error) => error instanceof ObjectStoreError
      && error.status === 504
      && error.code === "OBJECT_STORE_TIMEOUT",
  );
});

function fakeS3(options) {
  const objects = new Map();
  const requests = [];
  let failedPut = false;
  const service = {
    ...options,
    requests,
    async fetch(urlInput, init = {}) {
      const url = new URL(urlInput);
      const headers = new Headers(init.headers);
      const body = init.body ? new Uint8Array(init.body) : new Uint8Array();
      verifySignature({
        method: init.method,
        url,
        headers,
        body,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: options.region,
      });
      if (options.sessionToken) {
        assert.equal(headers.get("x-amz-security-token"), options.sessionToken);
      }
      requests.push({
        method: init.method,
        url: url.href,
        redirect: init.redirect,
        authorization: headers.get("authorization"),
        bodySha256: sha256(body),
      });
      const key = url.pathname;
      if (init.method === "HEAD") {
        const object = objects.get(key);
        return object
          ? new Response(null, { status: 200, headers: object.headers })
          : new Response(null, { status: 404 });
      }
      if (init.method === "PUT") {
        if (options.failFirstPut && !failedPut) {
          failedPut = true;
          return new Response("transient", { status: 503 });
        }
        assert.equal(headers.get("x-amz-content-sha256"), sha256(body));
        const metadata = {
          key: logicalKey(url),
          size: body.byteLength,
          sha256: headers.get("x-amz-meta-clank-sha256"),
          contentType: headers.get("content-type"),
          createdAt: Number(headers.get("x-amz-meta-clank-created-at")),
          updatedAt: Number(headers.get("x-amz-meta-clank-updated-at")),
        };
        objects.set(key, {
          bytes: new Uint8Array(body),
          headers: objectHeaders({
            key: metadata.key,
            bytes: body,
            sha256Value: metadata.sha256,
            contentType: metadata.contentType,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
          }),
        });
        return new Response(null, { status: 200 });
      }
      if (init.method === "GET") {
        const object = objects.get(key);
        return object
          ? new Response(object.bytes, { status: 200, headers: object.headers })
          : new Response(null, { status: 404 });
      }
      if (init.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  };
  return service;
}

function logicalKey(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "127.0.0.1") segments.shift();
  if (segments[0] === "installation-01") segments.shift();
  return segments.map(decodeURIComponent).join("/");
}

function objectHeaders({
  key,
  bytes,
  sha256Value = sha256(bytes),
  contentType = "application/octet-stream",
  createdAt = 1_722_300_000_000,
  updatedAt = createdAt,
}) {
  return {
    "content-length": String(bytes.byteLength),
    "content-type": contentType,
    "x-amz-meta-clank-created-at": String(createdAt),
    "x-amz-meta-clank-sha256": sha256Value,
    "x-amz-meta-clank-updated-at": String(updatedAt),
  };
}

function verifySignature({
  method,
  url,
  headers,
  body,
  accessKeyId,
  secretAccessKey,
  region,
}) {
  assert.equal(headers.get("x-amz-content-sha256"), sha256(body));
  const authorization = headers.get("authorization");
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u
    .exec(authorization ?? "");
  assert.ok(match, `invalid authorization: ${authorization}`);
  assert.equal(match[1], accessKeyId);
  assert.equal(match[3], region);
  const signedNames = match[4].split(";");
  const canonicalHeaders = signedNames.map((name) => {
    const value = name === "host" ? url.host : headers.get(name);
    assert.notEqual(value, null, `missing signed header ${name}`);
    return `${name}:${value.trim().replace(/[ \t]+/gu, " ")}\n`;
  }).join("");
  const query = [...url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonical = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    match[4],
    headers.get("x-amz-content-sha256"),
  ].join("\n");
  const scope = `${match[2]}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    headers.get("x-amz-date"),
    scope,
    sha256(new TextEncoder().encode(canonical)),
  ].join("\n");
  const dateKey = hmac(match[2], `AWS4${secretAccessKey}`);
  const regionKey = hmac(region, dateKey);
  const serviceKey = hmac("s3", regionKey);
  const signingKey = hmac("aws4_request", serviceKey);
  assert.equal(match[5], hmac(stringToSign, signingKey).toString("hex"));
}

function hmac(value, key) {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
