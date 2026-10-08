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

test("notification keys reject changed content while preserving identical retries and account isolation", async () => {
  const app = await fixture();
  try {
    const alice = await app.register("alice-key@example.invalid"), bob = await app.register("bob-key@example.invalid");
    const input = { userId: alice.userId, key: "stable-event", category: "updates", title: "Ready", body: "Your export is ready", url: "/exports" };
    const id = app.center.publish(input);
    await alice.client.markRead(id);
    await app.restart();
    assert.equal(app.center.publish(input), id);
    for (const change of [{ category: "billing" }, { title: "Changed" }, { body: "Changed" }, { url: "/different" }]) {
      assert.throws(() => app.center.publish({ ...input, ...change }), /key was already used for a different notification/);
    }
    const [record] = await alice.client.list();
    assert.equal(record.title, input.title); assert.equal(record.body, input.body); assert.notEqual(record.readAt, null);
    assert.notEqual(app.center.publish({ ...input, userId: bob.userId }), id);
    assert.equal((await alice.client.list()).length, 1); assert.equal((await bob.client.list()).length, 1);
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

test('quiet hours and daily digests follow named-zone calendars across DST', async () => {
  const { nextNotificationDelivery } = await import('../dist/notifications.js');
  const quiet = { timeZone: 'America/New_York', quietHours: { start: '22:00', end: '08:00' } };
  assert.equal(new Date(nextNotificationDelivery(quiet, Date.parse('2026-03-08T04:30:00Z'))).toISOString(), '2026-03-08T12:00:00.000Z');
  assert.equal(new Date(nextNotificationDelivery({ delivery: 'daily', timeZone: 'America/New_York', digestTime: '02:30' }, Date.parse('2026-03-08T00:00:00Z'))).toISOString(), '2026-03-09T06:30:00.000Z');
  assert.equal(new Date(nextNotificationDelivery({ delivery: 'daily', timeZone: 'America/New_York', digestTime: '01:30' }, Date.parse('2026-11-01T00:00:00Z'))).toISOString(), '2026-11-01T05:30:00.000Z');
  for (const value of [{ quietHours: { start: '08:00', end: '08:00' } }, { timeZone: 'bad/zone' }, { delivery: 'never' }, { digestTime: '25:00' }]) assert.throws(() => nextNotificationDelivery(value));
});

test('hourly digests persist a sealed payload and stable retry identity across restarts', async () => {
  let now = Date.parse('2026-10-03T10:15:00Z'), failed = true;
  const sent = [], app = await fixture({ now: () => now, sendEmail: async message => { sent.push({ ...message }); if (failed) throw new Error('temporary failure'); } });
  try {
    const alice = await app.register('digest@example.invalid'), bob = await app.register('other@example.invalid');
    await alice.client.setPreference({ category: 'updates', inApp: true, email: true, delivery: 'hourly', timeZone: 'UTC' });
    const publish = (key) => app.center.publish({ userId: alice.userId, key, category: 'updates', title: key, body: 'Digest content' });
    const first = publish('first'), second = publish('second');
    assert.equal(await app.center.workEmailOnce(), false);
    assert.equal((await alice.client.list())[0].deliveryAt, Date.parse('2026-10-03T11:00:00Z'));
    await app.restart(); now = Date.parse('2026-10-03T11:00:00Z');
    assert.equal(await app.center.workEmailOnce(), true);
    assert.equal(sent.length, 1); assert.match(sent[0].subject, /^2 updates/);
    assert.match(sent[0].text, /first/); assert.match(sent[0].text, /second/);
    assert.equal((await alice.client.list()).find(row => row._id === first).emailAttempts, 1);
    assert.equal(await bob.client.retryEmail(first), false);
    publish('third'); failed = false;
    const db = new DatabaseSync(app.path); db.exec("UPDATE clank_jobs SET run_at = 0 WHERE state = 'retry'"); db.close();
    await app.restart();
    for (let turn = 0; turn < 4; turn++) await app.center.workEmailOnce();
    assert.equal(sent.length, 2); assert.equal(sent[0].text, sent[1].text); assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
    for (const id of [first, second]) assert.equal((await alice.client.list()).find(row => row._id === id).emailState, 'sent');
    assert.equal((await alice.client.list()).find(row => row.title === 'third').emailState, 'queued');
    assert.deepEqual(await bob.client.list(), []);
  } finally { await app.close(); }
});

test('delivery rechecks newly enabled quiet hours and account opt-out without sending early', async () => {
  let now = Date.parse('2026-10-03T23:00:00Z'); const sent = [];
  const app = await fixture({ now: () => now, sendEmail: async message => { sent.push(message); } });
  try {
    const alice = await app.register('quiet@example.invalid');
    await alice.client.setPreference({ category: 'updates', inApp: true, email: true });
    const id = app.center.publish({ userId: alice.userId, key: 'quiet', category: 'updates', title: 'Quiet', body: 'Later' });
    await alice.client.setPreference({ category: 'updates', inApp: true, email: true, timeZone: 'UTC', quietHours: { start: '22:00', end: '08:00' } });
    assert.equal(await app.center.workEmailOnce(), true); assert.equal(sent.length, 0);
    assert.equal((await alice.client.list())[0].emailState, 'deferred');
    assert.equal(await app.center.workEmailOnce(), false);
    await app.restart(); now = Date.parse('2026-10-04T08:00:00Z');
    await app.center.workEmailOnce(); assert.equal(sent.length, 1); assert.equal(sent[0].idempotencyKey, `clank-notification:${id}`);
    const settings = (await alice.client.preferences()).find(row => row.category === 'updates');
    assert.deepEqual(settings.quietHours, { start: '22:00', end: '08:00' });
  } finally { await app.close(); }
});

test('manual retry follows the current delivery job after a sealed digest is deferred for quiet hours', async()=>{
 let now=Date.parse('2026-10-03T10:00:00Z'),fail=true;const sent=[];
 const app=await fixture({now:()=>now,sendEmail:async message=>{sent.push(message);if(fail)throw new Error('provider unavailable')}});
 try{
  const alice=await app.register('deferred-retry@example.invalid');await alice.client.setPreference({category:'updates',inApp:true,email:true});
  const id=app.center.publish({userId:alice.userId,key:'deferred-retry',category:'updates',title:'Deferred retry',body:'Stable content'});await app.center.workEmailOnce();
  await alice.client.setPreference({category:'updates',inApp:true,email:true,timeZone:'UTC',quietHours:{start:'10:00',end:'11:00'}});
  let db=new DatabaseSync(app.path);db.exec("UPDATE clank_jobs SET run_at=0 WHERE state='retry'");db.close();await app.center.workEmailOnce();assert.equal(sent.length,1);
  await app.restart();now=Date.parse('2026-10-03T11:00:00Z');await app.center.workEmailOnce();assert.equal(sent.length,2);
  db=new DatabaseSync(app.path);db.exec("UPDATE clank_jobs SET state='dead' WHERE state='retry'");db.close();
  assert.equal(await alice.client.retryEmail(id),true);fail=false;await app.center.workEmailOnce();assert.equal(sent.length,3);assert.equal(sent[0].text,sent[2].text);assert.equal(sent[0].idempotencyKey,sent[2].idempotencyKey);assert.equal((await alice.client.list())[0].emailState,'sent');
 }finally{await app.close()}
});


test('notification rendering escapes malformed attempt counts from custom clients', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const html = renderNotificationCenter([{ _id: 'custom', title: 'Safe title', body: 'Safe body', readAt: null, emailState: 'failed', emailAttempts: payload, url: null }]);
  assert.equal(html.includes(payload), false);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; attempt(s)'));
  assert.ok(renderNotificationCenter([{ _id: 'custom', title: 'Title', body: 'Body', readAt: null, emailState: 'failed', emailAttempts: 2, url: null }]).includes('2 attempt(s)'));
});
