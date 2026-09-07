import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { defineAuth, openNotificationCenter, createNotificationClient, renderNotificationCenter } from "../dist/index.js";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "clank-notifications-"));
  const path = join(root, "app.sqlite");
  const config = { path, auth: defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } }), categories: ["updates", "billing"], ...options };
  let center = await openNotificationCenter(config);
  async function register(email) {
    const response = await center.handle(new Request("https://notifications.test/__clank/notifications/auth/register", { method: "POST", headers: { "content-type": "application/json", origin: "https://notifications.test" }, body: JSON.stringify({ email, password: "correct horse battery staple" }) }));
    assert.equal(response.status, 201);
    const data = await response.json();
    const cookie = response.headers.get("set-cookie").split(";", 1)[0];
    const client = createNotificationClient({ url: "https://notifications.test/__clank/notifications", auth: { csrfHeader: () => ({ "x-clank-csrf": data.csrfToken }) },
      fetch: (url, init) => center.handle(new Request(url, { ...init, headers: { ...init.headers, cookie, origin: "https://notifications.test" } })) });
    return { userId: data.user.id, client };
  }
  return { root, path, get center() { return center; }, register, restart: async () => { center.close(); center = await openNotificationCenter(config); }, close: async () => { center.close(); await rm(root, { recursive: true, force: true }); } };
}

test("notification center isolates accounts, persists read state/preferences, deduplicates publishes, and bounds retention", async () => {
  const app = await fixture({ maxPerUser: 2 });
  try {
    const alice = await app.register("alice@example.invalid"), bob = await app.register("bob@example.invalid");
    const input = { userId: alice.userId, key: "event-1", category: "updates", title: "Ready", body: "Your export is ready", url: "/exports" };
    const id = app.center.publish(input);
    assert.equal(app.center.publish(input), id);
    assert.equal(await alice.client.unreadCount(), 1);
    assert.equal((await bob.client.list()).length, 0);
    assert.equal(await bob.client.markRead(id), false);
    assert.equal(await alice.client.markRead(id), true);
    await app.restart();
    assert.equal(await alice.client.unreadCount(), 0);
    assert.notEqual((await alice.client.list())[0].readAt, null);
    await alice.client.markRead(id, false); assert.equal(await alice.client.markAllRead(), 1);
    await alice.client.setPreference({ category: "billing", inApp: false, email: false });
    assert.equal(app.center.publish({ ...input, key: "hidden", category: "billing" }), null);
    assert.equal((await bob.client.preferences()).find(row => row.category === "billing").inApp, true);
    assert.throws(() => app.center.publish({ ...input, url: "//outside.test" }), /URL/);
    assert.throws(() => app.center.publish({ ...input, url: "/\\outside.test" }), /URL/);
    assert.throws(() => app.center.publish({ ...input, userId: "missing" }), /recipient/);
    app.center.publish({ ...input, key: "event-2" }); app.center.publish({ ...input, key: "event-3" });
    assert.equal((await alice.client.list()).length, 2);
  } finally { await app.close(); }
});

test("optional notification email is durable, uses a stable delivery key, and rechecks preferences/verified recipients", async () => {
  const sent = [];
  const app = await fixture({ sendEmail: async message => { sent.push(message); } });
  try {
    const alice = await app.register("alice@example.invalid");
    await alice.client.setPreference({ category: "updates", inApp: true, email: true });
    const input = { userId: alice.userId, key: "email-1", category: "updates", title: "Ready", body: "A result is ready" };
    const unverified = new DatabaseSync(app.path); unverified.prepare("UPDATE clank_auth_users SET email_verified_at = NULL WHERE id = ?").run(alice.userId); unverified.close();
    app.center.publish(input); await app.center.workEmailOnce();
    assert.equal(sent.length, 0, "unverified recipients are not emailed");
    const db = new DatabaseSync(app.path); db.prepare("UPDATE clank_auth_users SET email_verified_at = ? WHERE id = ?").run(Date.now(), alice.userId); db.close();
    const id = app.center.publish({ ...input, key: "email-2" });
    await app.restart(); assert.equal(await app.center.workEmailOnce(), true);
    assert.equal(sent.length, 1); assert.equal(sent[0].idempotencyKey, `clank-notification:${id}`);
    assert.equal(sent[0].to, "alice@example.invalid");
    assert.equal((await alice.client.list()).find(row => row._id === id).emailState, "sent");
    app.center.publish({ ...input, key: "email-3" });
    await alice.client.setPreference({ category: "updates", inApp: true, email: false });
    await app.center.workEmailOnce(); assert.equal(sent.length, 1, "delivery rechecks opt-out");
  } finally { await app.close(); }
});

test("notification rendering escapes contents and rejects external or executable targets", () => {
  const html = renderNotificationCenter([{ _id: '\"><script>', title: "<script>alert(1)</script>", body: "<img>", readAt: null, url: "javascript:alert(1)" }]);
  assert.doesNotMatch(html, /<script>|<img>|javascript:/i);
  assert.match(html, /Mark read/);
});

test("notification email retries retain the provider idempotency key after a delivery error", async () => {
  const keys = [];
  const app = await fixture({ sendEmail: async message => { keys.push(message.idempotencyKey); if (keys.length === 1) throw new Error("provider unavailable"); } });
  try {
    const alice = await app.register("retry@example.invalid");
    await alice.client.setPreference({ category: "updates", inApp: true, email: true });
    const id = app.center.publish({ userId: alice.userId, key: "retry-event", category: "updates", title: "Ready", body: "Ready now" });
    await app.center.workEmailOnce();
    assert.equal((await alice.client.list())[0].emailState, "failed");
    const db = new DatabaseSync(app.path); db.exec("UPDATE clank_jobs SET run_at = 0 WHERE state = 'retry'"); db.close();
    await app.restart(); await app.center.workEmailOnce();
    assert.deepEqual(keys, [`clank-notification:${id}`, `clank-notification:${id}`]);
    assert.equal((await alice.client.list())[0].emailState, "sent");
  } finally { await app.close(); }
});
