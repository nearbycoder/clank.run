import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBucketClient, createBucketMcpTools, defineBucket, openBucketManager } from "../dist/buckets.js";
import { openLocalObjectStore } from "../dist/object-storage.js";
import { defineAuth } from "../dist/auth.js";
import { defineBackend, defineDatabase, defineTable, openBackend } from "../dist/backend.js";
import { s } from "../dist/ai.js";

const text = value => new TextEncoder().encode(value);
const decode = bytes => new TextDecoder().decode(bytes);
const alice = { userId: "alice" }, bob = { userId: "bob" };
const policy = { maxAgeMs: 60000, maxPerObject: 5, maxVersions: 20, maxBytes: 10000, perOwnerMaxBytes: 5000 };
const definition = (extra = {}) => defineBucket({ name: "files", allowedContentTypes: ["text/plain"], maxObjectBytes: 100, maxBytes: 1000, versions: policy, ...extra });
function barrier() { let resolve; const promise = new Promise(ready => { resolve = ready; }); return { promise, resolve }; }
async function fixture(definitions = [definition()], extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-versions-"));
  const local = await openLocalObjectStore({ directory: join(root, "objects"), maxObjectBytes: 1000 });
  const { wrapStore, ...settings } = extra;
  const options = { definitions, store: wrapStore?.(local) ?? local, databasePath: join(root, "catalog.sqlite"),
    stagingDirectory: join(root, "staging"), signingKey: "01234567890123456789012345678901", publicOrigin: "https://app.example", ...settings };
  let manager = await openBucketManager(options);
  return { root, local, get manager() { return manager; },
    inspect(handler) { const db = new DatabaseSync(options.databasePath); try { return handler(db); } finally { db.close(); } },
    async reopen(next = definitions, store = options.store) { manager.close(); manager = await openBucketManager({ ...options, definitions: next, store }); },
    async close() { manager.close(); await rm(root, { recursive: true, force: true }); },
  };
}
const put = (bucket, value, owner = alice) => bucket.put("notes", text(value), { ...owner, contentType: "text/plain" });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
async function physicalObjects(root) {
  const files = await readdir(join(root, "objects"), { recursive: true });
  return files.filter(path => path.endsWith(".object")).length;
}

test("retention is explicitly bounded, immutable and disabled by default", () => {
  assert.equal(defineBucket({ name: "files" }).versions, false);
  const d = definition(); assert.ok(Object.isFrozen(d.versions));
  for (const invalid of [{ maxAgeMs: 0 }, { maxPerObject: 101 }, { maxVersions: 1001 }, { maxBytes: 0 }, { perOwnerMaxBytes: 10001 }, { surprise: true }]) {
    assert.throws(() => definition({ versions: { ...policy, ...invalid } }), TypeError);
  }
  assert.throws(() => definition({ versions: {} }), TypeError);
});

test("replacement retires immutable generations and old current capabilities fail closed", async () => {
  const env = await fixture();
  try {
    const files = env.manager.bucket("files"), first = await put(files, "first");
    const old = await files.createReadIntent("notes", alice);
    await put(files, "replacement");
    assert.equal((await env.manager.handle(new Request(old.url))).status, 404);
    const [version] = files.listVersions("notes", alice);
    assert.equal(version.sha256, first.sha256); assert.equal(version.objectId, first.id);
    assert.equal("url" in version, false); assert.equal("storageKey" in version, false);
    assert.ok(Object.isFrozen(version));
    assert.equal(decode((await files.getVersion("notes", version.id, alice)).bytes), "first");
    const download = await files.createVersionReadIntent("notes", version.id, alice);
    const response = await env.manager.handle(new Request(download.url));
    assert.equal(response.status, 200); assert.equal(await response.text(), "first");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(files.usage(alice).objects, 1); assert.equal(files.usage(alice).bytes, 11);
    await put(files, "replacement");
    assert.equal(files.listVersions("notes", alice).length, 2, "identical bytes are still distinct generations");
  } finally { await env.close(); }
});

test("history and restores remain partitioned by owner and key", async () => {
  const env = await fixture();
  try {
    const files = env.manager.bucket("files");
    await put(files, "alice-original"); const current = await put(files, "alice-current");
    await put(files, "bob-original", bob); const bobCurrent = await put(files, "bob-current", bob);
    const [version] = files.listVersions("notes", alice);
    await rejects(files.getVersion("notes", version.id, bob), "BUCKET_VERSION_NOT_FOUND");
    await rejects(files.getVersion("another", version.id, alice), "BUCKET_VERSION_NOT_FOUND");
    await rejects(files.restoreVersion("notes", version.id, { ...bob, operationId: "foreign", ifSha256: bobCurrent.sha256 }), "BUCKET_VERSION_NOT_FOUND");
    const restored = await files.restoreVersion("notes", version.id, { ...alice, operationId: "restore-one", ifSha256: current.sha256 });
    assert.equal(restored.sha256, version.sha256);
    assert.equal(decode((await files.get("notes", bob)).bytes), "bob-current");
    await rejects(files.restoreVersion("notes", version.id, { ...alice, operationId: "restore-one", ifSha256: restored.sha256 }), "RESTORE_RETRY_CONFLICT");
    await rejects(files.restoreVersion("notes", version.id, { ...alice, operationId: "no-precondition" }), "RESTORE_PRECONDITION_REQUIRED");
  } finally { await env.close(); }
});

test("delete retains history and expected-absence restore cannot overwrite a recreated file", async () => {
  const env = await fixture();
  try {
    const files = env.manager.bucket("files"); await put(files, "deleted");
    assert.equal(await files.delete("notes", alice), true);
    const [version] = files.listVersions("notes", alice);
    assert.equal(files.stat("notes", alice), null);
    await put(files, "recreated");
    await rejects(files.restoreVersion("notes", version.id, { ...alice, operationId: "absent", ifSha256: null }), "BUCKET_OBJECT_CHANGED");
    await files.delete("notes", alice);
    await files.restoreVersion("notes", version.id, { ...alice, operationId: "restore-deleted", ifSha256: null });
    assert.equal(decode((await files.get("notes", alice)).bytes), "deleted");
  } finally { await env.close(); }
});

test("accepted restore receipt survives restart and source eviction without repeating the write", async () => {
  const env = await fixture([definition({ versions: { ...policy, maxPerObject: 1 } })]);
  try {
    let files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice), input = { ...alice, operationId: "lost-response", ifSha256: current.sha256 };
    const accepted = await files.restoreVersion("notes", version.id, input);
    const storedKey = env.inspect(db => db.prepare("SELECT storage_key FROM clank_bucket_objects WHERE owner_id = 'alice'").get().storage_key);
    assert.ok(!files.listVersions("notes", alice).some(item => item.id === version.id));
    await env.reopen([definition({ versions: { ...policy, maxPerObject: 1 } })]); files = env.manager.bucket("files");
    assert.deepEqual(await files.restoreVersion("notes", version.id, input), accepted);
    assert.equal(env.inspect(db => db.prepare("SELECT storage_key FROM clank_bucket_objects WHERE owner_id = 'alice'").get().storage_key), storedKey);
    assert.equal(env.inspect(db => db.prepare("SELECT count(*) AS n FROM clank_bucket_restore_receipts").get().n), 1);
    await rejects(files.restoreVersion("notes", version.id, { ...bob, operationId: "lost-response", ifSha256: null }), "BUCKET_VERSION_NOT_FOUND");
  } finally { await env.close(); }
});

test("a same-digest replacement during restore's read still invalidates its destination fence", async () => {
  const started = barrier(), release = barrier(); let delay = false;
  const env = await fixture(undefined, { wrapStore: store => ({ ...store, async get(key) {
    const value = await store.get(key); if (delay) { delay = false; started.resolve(); await release.promise; } return value;
  } }) });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice); delay = true;
    const pending = files.restoreVersion("notes", version.id, { ...alice, operationId: "stale-generation", ifSha256: current.sha256 });
    const result = rejects(pending, "BUCKET_OBJECT_CHANGED");
    await started.promise; await put(files, "current"); release.resolve(); await result;
    assert.equal(decode((await files.get("notes", alice)).bytes), "current");
    assert.equal(env.inspect(db => db.prepare("SELECT count(*) AS n FROM clank_bucket_restore_receipts").get().n), 0);
  } finally { release.resolve(); await env.close(); }
});

test("restore captures its owner's operation and expected digest before async I/O", async () => {
  const started = barrier(), release = barrier(); let delay = false;
  const env = await fixture(undefined, { wrapStore: store => ({ ...store, async get(key) {
    const value = await store.get(key); if (delay) { delay = false; started.resolve(); await release.promise; } return value;
  } }) });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice), input = { ...alice, operationId: "captured", ifSha256: current.sha256 };
    delay = true; const pending = files.restoreVersion("notes", version.id, input);
    await started.promise; Object.assign(input, { userId: "bob", operationId: "changed", ifSha256: null }); release.resolve();
    assert.equal((await pending).ownerId, "alice");
    assert.equal(files.stat("notes", bob), null);
    assert.equal(env.inspect(db => db.prepare("SELECT operation_id FROM clank_bucket_restore_receipts").get().operation_id), "captured");
  } finally { release.resolve(); await env.close(); }
});

test("expiry during provider put rolls back restore and cleans up late destination bytes", async () => {
  let clock = 1800000000000, delay = false; const started = barrier(), release = barrier();
  const env = await fixture([definition({ versions: { ...policy, maxAgeMs: 1000 } })], { now: () => clock, wrapStore: store => ({ ...store,
    async put(...args) { if (delay) { delay = false; started.resolve(); await release.promise; } return store.put(...args); },
  }) });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice); delay = true;
    const pending = files.restoreVersion("notes", version.id, { ...alice, operationId: "expired-source", ifSha256: current.sha256 });
    const result = rejects(pending, "BUCKET_VERSION_NOT_FOUND");
    await started.promise; clock += 1001; await env.manager.sweep(); release.resolve(); await result;
    assert.equal(files.stat("notes", alice).sha256, current.sha256);
    assert.equal(files.usage(alice).reservedBytes, 0);
    assert.equal(await physicalObjects(env.root), 1);
  } finally { release.resolve(); await env.close(); }
});

test("deleting and recreating a destination during provider put cannot admit the old restore", async () => {
  let delay = false; const started = barrier(), release = barrier();
  const env = await fixture(undefined, { wrapStore: store => ({ ...store,
    async put(...args) { if (delay) { delay = false; started.resolve(); await release.promise; } return store.put(...args); },
  }) });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice); delay = true;
    const pending = files.restoreVersion("notes", version.id, { ...alice, operationId: "cancelled-destination", ifSha256: current.sha256 });
    const result = rejects(pending, "UPLOAD_EXPIRED");
    await started.promise; await files.delete("notes", alice); await put(files, "newer"); release.resolve(); await result;
    assert.equal(decode((await files.get("notes", alice)).bytes), "newer");
    assert.equal(files.usage(alice).reservedObjects, 0);
  } finally { release.resolve(); await env.close(); }
});

test("retained download rechecks expiry after delayed provider I/O", async () => {
  let clock = 1800000000000, delay = false; const started = barrier(), release = barrier();
  const env = await fixture([definition({ versions: { ...policy, maxAgeMs: 1000 } })], { now: () => clock, wrapStore: store => ({ ...store,
    async get(key) { const value = await store.get(key); if (delay) { delay = false; started.resolve(); await release.promise; } return value; },
  }) });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); await put(files, "current");
    const [version] = files.listVersions("notes", alice), intent = await files.createVersionReadIntent("notes", version.id, alice);
    assert.equal(intent.expiresAt, version.expiresAt); delay = true;
    const pending = env.manager.handle(new Request(intent.url)); await started.promise; clock += 1001; release.resolve();
    assert.equal((await pending).status, 404);
  } finally { release.resolve(); await env.close(); }
});

test("current signed and public downloads recheck generation after delayed provider I/O", async () => {
  for (const visibility of ["private", "public"]) {
    let delay = false; const started = barrier(), release = barrier();
    const env = await fixture([definition({ visibility })], { wrapStore: store => ({ ...store,
      async get(key) { const value = await store.get(key); if (delay) { delay = false; started.resolve(); await release.promise; } return value; },
    }) });
    try {
      const files = env.manager.bucket("files"), original = await put(files, "original");
      const url = visibility === "public" ? original.url : (await files.createReadIntent("notes", alice)).url;
      delay = true; const pending = env.manager.handle(new Request(url)); await started.promise;
      await put(files, "current"); release.resolve(); assert.equal((await pending).status, 404);
    } finally { release.resolve(); await env.close(); }
  }
});

test("retained byte and generation limits evict oldest snapshots without exposing other owners", async () => {
  const env = await fixture([definition({ versions: { ...policy, maxPerObject: 2, maxVersions: 3, maxBytes: 12, perOwnerMaxBytes: 8 } })]);
  try {
    const files = env.manager.bucket("files");
    for (const value of ["aaaa", "bbbb", "cccc", "dddd"]) await put(files, value);
    assert.deepEqual(files.listVersions("notes", alice).map(v => v.size), [4, 4]);
    for (const value of ["1111", "2222", "3333"]) await put(files, value, bob);
    assert.equal(files.listVersions("notes", bob).length, 2); assert.equal(files.listVersions("notes", alice).length, 1);
    assert.equal(env.inspect(db => db.prepare("SELECT sum(size) AS n FROM clank_bucket_versions").get().n), 12);
    assert.equal(env.inspect(db => db.prepare("SELECT count(*) AS n FROM clank_bucket_versions").get().n), 3);
  } finally { await env.close(); }
});

test("tightened policy and disabling history reclaim snapshots on restart and close old capabilities", async () => {
  let clock = 1800000000000; const env = await fixture(undefined, { now: () => clock });
  try {
    let files = env.manager.bucket("files"); await put(files, "original"); await put(files, "current");
    const [version] = files.listVersions("notes", alice), intent = await files.createVersionReadIntent("notes", version.id, alice);
    clock += 2000; await env.reopen([definition({ versions: { ...policy, maxAgeMs: 1000 } })]);
    assert.equal((await env.manager.handle(new Request(intent.url))).status, 404);
    files = env.manager.bucket("files"); assert.deepEqual(files.listVersions("notes", alice), []);
    await put(files, "another"); await env.reopen([definition({ versions: false })]);
    assert.deepEqual(env.manager.bucket("files").listVersions("notes", alice), []);
    assert.equal(await physicalObjects(env.root), 1);
    assert.equal(decode((await env.manager.bucket("files").get("notes", alice)).bytes), "another");
  } finally { await env.close(); }
});

test("cleanup failures remain queued for restart without retaining an accessible expired version", async () => {
  let clock = 1800000000000, fail = false;
  const env = await fixture([definition({ versions: { ...policy, maxAgeMs: 1000 } })], { now: () => clock,
    wrapStore: store => ({ ...store, async delete(key) { if (fail) throw new Error("offline provider"); return store.delete(key); } }) });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); await put(files, "current");
    const [version] = files.listVersions("notes", alice); fail = true; clock += 1001; await env.manager.sweep();
    await rejects(files.getVersion("notes", version.id, alice), "BUCKET_VERSION_NOT_FOUND");
    assert.equal(env.inspect(db => db.prepare("SELECT count(*) AS n FROM clank_bucket_garbage").get().n), 1);
    await env.reopen(undefined, env.local);
    assert.equal(env.inspect(db => db.prepare("SELECT count(*) AS n FROM clank_bucket_garbage").get().n), 0);
    assert.equal(await physicalObjects(env.root), 1);
  } finally { await env.close(); }
});

test("forged provider bytes cannot satisfy a retained read or restore", async () => {
  let corrupt = false; const env = await fixture(undefined, { wrapStore: store => ({ ...store,
    async get(key) { const value = await store.get(key); return corrupt && value ? { ...value, bytes: text("forgery!") } : value; },
  }) });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice); corrupt = true;
    await rejects(files.getVersion("notes", version.id, alice), "BUCKET_INTEGRITY_FAILED");
    await rejects(files.restoreVersion("notes", version.id, { ...alice, operationId: "corrupt", ifSha256: current.sha256 }), "BUCKET_INTEGRITY_FAILED");
    assert.equal(files.stat("notes", alice).sha256, current.sha256);
  } finally { await env.close(); }
});

test("MCP history uses the same owner boundary, read scope and replay-safe restore", async () => {
  const env = await fixture();
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const tools = createBucketMcpTools(env.manager, { identity: ctx => ({ userId: ctx.id }), maxInlineBytes: 2 });
    const find = name => tools.find(tool => tool.name === `bucket_files_${name}`);
    assert.equal(find("versions").requiredScope, "agent:read"); assert.equal(find("restore_version").requiredScope, "agent:write");
    const [version] = await find("versions").invoke({ key: "notes" }, { id: "alice" });
    const read = await find("read_version").invoke({ key: "notes", versionId: version.id }, { id: "alice" });
    assert.equal((await env.manager.handle(new Request(read.readIntent.url))).status, 200);
    const input = { key: "notes", versionId: version.id, operationId: "agent-restore", ifSha256: current.sha256 };
    const accepted = await find("restore_version").invoke(input, { id: "alice" });
    assert.deepEqual(await find("restore_version").invoke(input, { id: "alice" }), accepted);
    await rejects(find("read_version").invoke({ key: "notes", versionId: version.id }, { id: "bob" }), "BUCKET_VERSION_NOT_FOUND");
  } finally { await env.close(); }
});

test("browser client history and restore enforce authentication and write verification", async () => {
  const env = await fixture([definition({ visibility: "public", ownership: "app", browserAccess: "public" })]);
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    let authenticated = false, csrf = "wrong", verifies = 0;
    const client = createBucketClient("files", { csrfToken: () => csrf, fetch: (url, init) => env.manager.handle(new Request(new URL(url, "https://app.example"), init), {
      authenticated, verifyWrite() { verifies++; if (new Headers(init?.headers).get("x-clank-csrf") !== "valid") throw new Error("write denied"); },
    }) });
    await rejects(client.listVersions("notes"), "BUCKET_AUTH_REQUIRED"); authenticated = true;
    const [version] = await client.listVersions("notes"), intent = await client.createVersionReadIntent("notes", version.id);
    const response = await env.manager.handle(new Request(intent.url)); assert.equal(response.headers.get("cache-control"), "private, no-store");
    await assert.rejects(client.restoreVersion("notes", version.id, { operationId: "browser-restore", ifSha256: current.sha256 }));
    assert.equal(files.stat("notes").sha256, current.sha256); csrf = "valid";
    assert.equal((await client.restoreVersion("notes", version.id, { operationId: "browser-restore", ifSha256: current.sha256 })).sha256, version.sha256);
    assert.equal(verifies, 2);
  } finally { await env.close(); }
});

test("backend history forms use current session CSRF and revoked sessions cannot inspect or replay", async () => {
  const env = await fixture(); let backend;
  try {
    const schema = defineDatabase({ records: defineTable({ title: s.string() }) });
    const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
    backend = await openBackend(defineBackend({ schema, auth }).functions(() => ({})), { path: join(env.root, "app.sqlite"), buckets: env.manager });
    const response = await backend.handle(new Request("https://app.example/__clank/auth/register", { method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example", "x-clank-client-ip": "127.0.0.1" },
      body: JSON.stringify({ email: "history@example.com", password: "correct horse battery staple", profile: { name: "Alice" } }) }));
    assert.equal(response.status, 201); const session = await response.json(), cookie = response.headers.get("set-cookie").split(";", 1)[0];
    const files = env.manager.bucket("files"), owner = { userId: session.user.id };
    await put(files, "original", owner); const current = await put(files, "current", owner);
    const [version] = files.listVersions("notes", owner);
    const page = await backend.handle(new Request("https://app.example/__clank/buckets?bucket=files&history=notes", { headers: { cookie } }));
    assert.equal(page.status, 200); const html = await page.text();
    assert.match(html, /<button type="submit">Restore<\/button>/u); assert.ok(html.includes(session.csrfToken));
    assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/u);
    const call = csrf => backend.handle(new Request("https://app.example/__clank/buckets/files/versions", { method: "POST",
      headers: { cookie, origin: "https://app.example", "content-type": "application/json", "x-clank-csrf": csrf },
      body: JSON.stringify({ key: "notes", versionId: version.id, operationId: "authenticated-restore", ifSha256: current.sha256 }) }));
    assert.notEqual((await call("forged")).status, 200); assert.equal(files.stat("notes", owner).sha256, current.sha256);
    assert.equal((await call(session.csrfToken)).status, 200);
    backend.auth.revokeUserSessions(session.user.id);
    assert.equal((await backend.handle(new Request("https://app.example/__clank/buckets?bucket=files&history=notes", { headers: { cookie } }))).status, 401);
    assert.equal((await call(session.csrfToken)).status, 401);
  } finally { backend?.close(); await env.close(); }
});

test("restore admission still obeys active-object quota and bounded receipt capacity", async () => {
  const env = await fixture([definition({ maxObjectBytes: 10, perOwnerMaxBytes: 10 })]);
  try {
    const files = env.manager.bucket("files"); await put(files, "1234567890"); await files.delete("notes", alice);
    const [version] = files.listVersions("notes", alice);
    await files.put("other", text("x"), { ...alice, contentType: "text/plain" });
    await rejects(files.restoreVersion("notes", version.id, { ...alice, operationId: "quota", ifSha256: null }), "BUCKET_QUOTA_EXCEEDED");
    assert.equal(files.stat("notes", alice), null); await files.delete("other", alice);
    env.inspect(db => {
      db.exec("BEGIN IMMEDIATE");
      const insert = db.prepare("INSERT INTO clank_bucket_restore_receipts VALUES ('files', 'other', ?, 'retired', 'fingerprint', '{}', ?, ?)");
      const now = Date.now(); for (let i = 0; i < 10000; i++) insert.run(`capacity-${i}`, now, now + 60000);
      db.exec("COMMIT");
    });
    await rejects(files.restoreVersion("notes", version.id, { ...alice, operationId: "capacity", ifSha256: null }), "RESTORE_RECEIPT_CAPACITY");
    assert.equal(files.stat("notes", alice), null); assert.equal(files.usage(alice).reservedObjects, 0);
  } finally { await env.close(); }
});

test("expired restore receipts and retired version IDs cannot execute again after pruning", async () => {
  let clock = 1800000000000;
  const env = await fixture([definition({ versions: { ...policy, maxAgeMs: 1000, maxPerObject: 1 } })], { now: () => clock });
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice), input = { ...alice, operationId: "expired-retry", ifSha256: current.sha256 };
    const accepted = await files.restoreVersion("notes", version.id, input);
    clock += 1001; await env.manager.sweep();
    await rejects(files.restoreVersion("notes", version.id, input), "BUCKET_OBJECT_CHANGED");
    assert.equal(files.stat("notes", alice).sha256, accepted.sha256);
    await put(files, "current");
    await rejects(files.restoreVersion("notes", version.id, input), "BUCKET_VERSION_NOT_FOUND");
    assert.equal(files.stat("notes", alice).sha256, current.sha256);
    assert.equal(env.inspect(db => db.prepare("SELECT count(*) AS n FROM clank_bucket_restore_receipts").get().n), 0);
  } finally { await env.close(); }
});

test("session revocation during the request body or provider write cannot commit a browser restore", async () => {
  for (const phase of ["body", "provider"]) {
    let delay = false; const started = barrier(), release = barrier();
    const env = await fixture(undefined, { wrapStore: store => ({ ...store,
      async put(...args) { if (delay) { delay = false; started.resolve(); await release.promise; } return store.put(...args); },
    }) });
    let backend, peer;
    try {
      const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
      const definition = defineBackend({ schema: defineDatabase({ records: defineTable({ title: s.string() }) }), auth }).functions(() => ({}));
      const path = join(env.root, "app.sqlite"); backend = await openBackend(definition, { path, buckets: env.manager });
      peer = await openBackend(definition, { path });
      const registered = await backend.handle(new Request("https://app.example/__clank/auth/register", { method: "POST",
        headers: { origin: "https://app.example", "content-type": "application/json", "x-clank-client-ip": "127.0.0.1" },
        body: JSON.stringify({ email: `${phase}@example.com`, password: "correct horse battery staple", profile: { name: "Alice" } }) }));
      const session = await registered.json(), cookie = registered.headers.get("set-cookie").split(";", 1)[0], owner = { userId: session.user.id };
      const files = env.manager.bucket("files"); await put(files, "original", owner); const current = await put(files, "current", owner);
      const [version] = files.listVersions("notes", owner), payload = JSON.stringify({ key: "notes", versionId: version.id, operationId: "revoked-in-flight", ifSha256: current.sha256 });
      const body = phase === "body" ? new ReadableStream({ pull(controller) {
        peer.auth.revokeUserSessions(session.user.id); controller.enqueue(text(payload)); controller.close();
      } }, { highWaterMark: 0 }) : payload;
      if (phase === "provider") delay = true;
      const pending = backend.handle(new Request("https://app.example/__clank/buckets/files/versions", { method: "POST",
        headers: { cookie, origin: "https://app.example", "content-type": "application/json", "x-clank-csrf": session.csrfToken },
        body, ...(phase === "body" ? { duplex: "half" } : {}),
      }));
      if (phase === "provider") { await started.promise; peer.auth.revokeUserSessions(session.user.id); release.resolve(); }
      assert.equal((await pending).status, 401, phase);
      assert.equal(files.stat("notes", owner).sha256, current.sha256, phase);
      assert.equal(env.inspect(db => db.prepare("SELECT count(*) AS n FROM clank_bucket_restore_receipts").get().n), 0, phase);
      assert.equal(files.usage(owner).reservedObjects, 0, phase);
    } finally { release.resolve(); peer?.close(); backend?.close(); await env.close(); }
  }
});

test("inconsistent stored ownership cannot substitute a history snapshot or restore receipt", async () => {
  const env = await fixture();
  try {
    const files = env.manager.bucket("files"); await put(files, "original"); const current = await put(files, "current");
    const [version] = files.listVersions("notes", alice), input = { ...alice, operationId: "integrity", ifSha256: current.sha256 };
    await files.restoreVersion("notes", version.id, input);
    env.inspect(db => {
      const row = db.prepare("SELECT receipt FROM clank_bucket_restore_receipts").get(), receipt = JSON.parse(row.receipt);
      receipt.ownerId = "bob";
      db.prepare("UPDATE clank_bucket_restore_receipts SET receipt = ?").run(JSON.stringify(receipt));
    });
    await rejects(files.restoreVersion("notes", version.id, input), "BUCKET_INTEGRITY_FAILED");
    env.inspect(db => {
      const row = db.prepare("SELECT metadata_json FROM clank_bucket_versions WHERE version_id = ?").get(version.id), metadata = JSON.parse(row.metadata_json);
      metadata.owner_id = "bob";
      db.prepare("UPDATE clank_bucket_versions SET metadata_json = ? WHERE version_id = ?").run(JSON.stringify(metadata), version.id);
    });
    await rejects(files.getVersion("notes", version.id, alice), "BUCKET_INTEGRITY_FAILED");
  } finally { await env.close(); }
});

test("an async credential refresh cannot authorize history access", async () => {
  const env = await fixture();
  try {
    const response = await env.manager.handle(new Request("https://app.example/__clank/buckets/files/versions?key=notes"), {
      authenticated: true, userId: "alice", verifyCurrent: async () => { throw new Error("async revocation"); },
    });
    assert.equal(response.status, 400); assert.match(await response.text(), /synchronous/u);
    await new Promise(resolve => setImmediate(resolve));
  } finally { await env.close(); }
});
