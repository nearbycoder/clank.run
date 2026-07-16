import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHttpEmailService,
  createServiceRegistry,
  createWebhookSender,
  defineDatabase,
  defineServiceDriver,
  openFileEmailService,
  openJobQueue,
  openLocalFileStore,
  openSQLite,
  signWebhook,
  verifyWebhook,
} from "../dist/index.js";

test("service registry validates named capabilities and reports isolated health", async () => {
  const registry = createServiceRegistry([
    defineServiceDriver({
      name: "uploads",
      kind: "files",
      capabilities: ["signed-read", "signed-write"],
      service: { value: 42 },
      async health() { return { ok: true }; },
    }),
    defineServiceDriver({
      name: "mail",
      kind: "email",
      capabilities: ["transactional"],
      service: {},
      async health() { throw new Error("mail offline"); },
    }),
  ]);
  assert.equal(registry.get("uploads").value, 42);
  registry.assert([
    { name: "uploads", kind: "files", capabilities: ["signed-read"] },
    { name: "optional-search", kind: "search", required: false },
  ]);
  assert.throws(
    () => registry.assert([{ name: "uploads", kind: "files", capabilities: ["public-read"] }]),
    /lacks public-read/,
  );
  const health = await registry.health();
  assert.deepEqual(health.uploads, { ok: true });
  assert.deepEqual(health.mail, { ok: false, detail: "mail offline" });
});

test("local files use integrity metadata and operation-scoped expiring capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-files-"));
  try {
    const files = await openLocalFileStore({
      directory: root,
      signingKey: "a sufficiently long file signing secret for tests",
      maxFileBytes: 64,
    });
    const writeToken = await files.sign({
      key: "users/alice/avatar.txt",
      operation: "write",
      expiresAt: Date.now() + 60_000,
    });
    const uploaded = await files.handle(new Request(`https://todo.test/__clank/files/${writeToken}`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "avatar",
    }));
    assert.equal(uploaded.status, 201);
    const record = (await uploaded.json()).file;
    assert.equal(record.key, "users/alice/avatar.txt");
    assert.equal(record.size, 6);

    const readToken = await files.sign({
      key: "users/alice/avatar.txt",
      operation: "read",
      expiresAt: Date.now() + 60_000,
    });
    const downloaded = await files.handle(new Request(`https://todo.test/__clank/files/${readToken}`));
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "avatar");
    assert.equal(downloaded.headers.get("content-type"), "text/plain");
    assert.match(downloaded.headers.get("etag"), /^"sha256-[a-f0-9]{64}"$/);
    const paddedPrefix = `${"/".repeat(50_000)}__clank/files${"/".repeat(50_000)}`;
    const paddedDownload = await files.handle(
      new Request(`https://todo.test/__clank/files/${readToken}`),
      paddedPrefix,
    );
    assert.equal(paddedDownload.status, 200);
    assert.equal(await paddedDownload.text(), "avatar");

    const wrongOperation = await files.handle(new Request(`https://todo.test/__clank/files/${writeToken}`));
    assert.equal(wrongOperation.status, 403);
    const tampered = await files.handle(new Request(
      `https://todo.test/__clank/files/${readToken.slice(0, -1)}x`,
    ));
    assert.equal(tampered.status, 403);
    await assert.rejects(
      files.put("../escape", new Uint8Array()),
      /Invalid file key/,
    );
    await assert.rejects(
      files.put("too-large.bin", new Uint8Array(65)),
      /exceeds 64/,
    );
    assert.equal(await files.delete("users/alice/avatar.txt"), true);
    assert.equal(await files.get("users/alice/avatar.txt"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file and HTTP email drivers validate envelopes and preserve idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-mail-"));
  try {
    const outbox = await openFileEmailService({ directory: root });
    const receipt = await outbox.send({
      from: { email: "noreply@example.com", name: "Todo" },
      to: [{ email: "person@example.com" }],
      subject: "Verify",
      text: "Use the link.",
      idempotencyKey: "verification-0001",
    });
    assert.equal(receipt.provider, "file");
    const entries = await readdir(root);
    assert.equal(entries.length, 1);
    const stored = JSON.parse(await readFile(join(root, entries[0]), "utf8"));
    assert.equal(stored.to[0].email, "person@example.com");
    assert.equal((await stat(join(root, entries[0]))).mode & 0o777, 0o600);

    const requests = [];
    const remote = createHttpEmailService({
      url: "https://mail.example.test/send",
      token: "mail-token",
      retries: 0,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ id: "provider-message" });
      },
    });
    const sent = await remote.send({
      from: { email: "noreply@example.com" },
      to: [{ email: "person@example.com" }],
      subject: "Reset",
      text: "Reset link",
      idempotencyKey: "password-reset-0001",
    });
    assert.equal(sent.id, "provider-message");
    assert.equal(requests[0].init.headers.authorization, "Bearer mail-token");
    assert.equal(requests[0].init.headers["idempotency-key"], "password-reset-0001");
    await assert.rejects(
      remote.send({
        from: { email: "noreply@example.com" },
        to: [{ email: "person@example.com" }],
        subject: "Bad",
        text: "Body",
        headers: { Authorization: "override" },
      }),
      /reserved header/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable jobs provide idempotent enqueue, leases, retries, completion, and dead letters", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-jobs-"));
  const database = await openSQLite(defineDatabase({}), {
    path: join(root, "jobs.sqlite"),
    wal: false,
  });
  let deliveries = 0;
  const queue = openJobQueue(database, {
    async deliver(payload, context) {
      assert.equal(payload.message, "hello");
      deliveries++;
      if (context.attempt === 1) throw new Error("temporary provider failure");
    },
    async fail() {
      throw new Error("permanent failure");
    },
  }, { retryBaseMs: 1, handlerTimeoutMs: 1_000 });
  try {
    const first = await queue.enqueue("deliver", { message: "hello" }, { uniqueKey: "message-1" });
    const duplicate = await queue.enqueue("deliver", { message: "hello" }, { uniqueKey: "message-1" });
    assert.deepEqual(duplicate, { id: first.id, existing: true });
    assert.equal(await queue.runOnce(), 1);
    assert.equal(queue.inspect(first.id).status, "retry");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await queue.runOnce(), 1);
    assert.equal(queue.inspect(first.id).status, "completed");
    assert.equal(deliveries, 2);

    const dead = await queue.enqueue("fail", {}, { maxAttempts: 1 });
    assert.equal(await queue.runOnce(), 1);
    assert.equal(queue.inspect(dead.id).status, "dead");
    assert.equal(queue.retry(dead.id), true);
    assert.equal(queue.inspect(dead.id).status, "retry");
  } finally {
    queue.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("webhooks bind timestamp and body, reject replay windows, and retry with one delivery ID", async () => {
  const secret = "a sufficiently long webhook secret for tests";
  const body = JSON.stringify({ taskId: "task-1" });
  const signed = await signWebhook(body, secret, 1_700_000_000);
  assert.equal(await verifyWebhook({
    body,
    secret,
    timestamp: signed.timestamp,
    signature: signed.signature,
    now: 1_700_000_010,
  }), true);
  assert.equal(await verifyWebhook({
    body: `${body} `,
    secret,
    timestamp: signed.timestamp,
    signature: signed.signature,
    now: 1_700_000_010,
  }), false);
  assert.equal(await verifyWebhook({
    body,
    secret,
    timestamp: signed.timestamp,
    signature: signed.signature,
    now: 1_700_001_000,
  }), false);

  const deliveries = [];
  const sender = createWebhookSender({
    retries: 1,
    fetch: async (_url, init) => {
      deliveries.push(init.headers["x-clank-delivery"]);
      const status = deliveries.length === 1 ? 503 : 204;
      return new Response(status === 204 ? null : "", { status });
    },
  });
  const result = await sender.send({
    url: "https://hooks.example.test/task",
    event: "task.completed",
    payload: { taskId: "task-1" },
    secret,
  });
  assert.deepEqual(result, { status: 204, attempts: 2 });
  assert.equal(deliveries[0], deliveries[1]);
});
