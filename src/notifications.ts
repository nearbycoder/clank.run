import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend, type OpenBackendOptions, type SyncClientOptions, type BackendRuntime, type FunctionReference } from "./backend.ts";
import { defineJobs, type JobProcessHandle } from "./jobs.ts";
import type { AuthDefinition } from "./auth.ts";
import { s } from "./ai.ts";
import { previewSchedule } from "./schedules.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";

export interface NotificationItem {
  readonly _id: string; readonly _creationTime: number; readonly category: string; readonly title: string;
  readonly body: string; readonly url: string | null; readonly readAt: number | null;
  readonly emailState: string;
  readonly deliveryAt?: number; readonly emailAttempts?: number;
}
export interface NotificationDeliveryPolicy {
  delivery?: "immediate" | "hourly" | "daily";
  timeZone?: string;
  digestTime?: string;
  quietHours?: { start: string; end: string } | null;
}
function deliveryPolicy(input: NotificationDeliveryPolicy): Required<NotificationDeliveryPolicy> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["delivery", "timeZone", "digestTime", "quietHours", "category", "inApp", "email"].includes(key))) throw new TypeError("Invalid notification delivery policy.");
  if (input.quietHours !== undefined && input.quietHours !== null && (typeof input.quietHours !== "object" || Array.isArray(input.quietHours) || Object.keys(input.quietHours).some(key => !["start", "end"].includes(key)))) throw new TypeError("Invalid quiet hours.");
  const delivery = input.delivery ?? "immediate", timeZone = input.timeZone ?? "UTC", digestTime = input.digestTime ?? "09:00", quietHours = input.quietHours ?? null;
  if (!["immediate", "hourly", "daily"].includes(delivery) || typeof timeZone !== "string" || timeZone.length > 100) throw new TypeError("Invalid notification delivery policy.");
  new Intl.DateTimeFormat("en", { timeZone });
  const validTime = (value: unknown) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(digestTime) || quietHours && (typeof quietHours !== "object" || !validTime(quietHours.start) || !validTime(quietHours.end) || quietHours.start === quietHours.end)) throw new TypeError("Choose valid, distinct quiet-hour times.");
  return { delivery, timeZone, digestTime, quietHours };
}
function afterQuietHours(at: number, policy: Required<NotificationDeliveryPolicy>): number {
  if (!policy.quietHours) return at;
  const { start, end } = policy.quietHours, formatter = new Intl.DateTimeFormat("en-GB", { timeZone: policy.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let minute = 0; minute < 2881; minute++) {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value])), time = `${parts.hour}:${parts.minute}`;
    if (!(start < end ? time >= start && time < end : time >= start || time < end)) return at;
    at = Math.floor(at / 60000) * 60000 + 60000;
  }
  throw new Error("No delivery window is available within two days.");
}
/** Earliest delivery instant; calendar digests and quiet hours use the recipient's named zone. */
export function nextNotificationDelivery(input: NotificationDeliveryPolicy, now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > Date.UTC(2099, 11, 30)) throw new TypeError("Invalid delivery clock.");
  const policy = deliveryPolicy(input);
  let at = now;
  if (policy.delivery === "hourly") at = (Math.floor(now / 3600000) + 1) * 3600000;
  if (policy.delivery === "daily") {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: policy.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
    at = previewSchedule({ frequency: "daily", startDate: `${parts.year}-${parts.month}-${parts.day}`, time: policy.digestTime, timeZone: policy.timeZone }, { after: now, limit: 1, horizonDays: 4 }).occurrences[0]!.at;
  }
  return afterQuietHours(at, policy);
}

export interface NotificationPreferences extends NotificationDeliveryPolicy { category: string; inApp: boolean; email: boolean; }
export interface NotificationCenterOptions {
  path: string;
  auth: AuthDefinition<any>;
  categories: readonly string[];
  prefix?: string;
  maxPerUser?: number;
  sendEmail?: (message: { to: string; subject: string; text: string; url: string | null; idempotencyKey: string; signal: AbortSignal }) => Promise<void>;
  onError?: OpenBackendOptions["onError"];
  /** Injectable delivery clock; job leases use the same clock. */
  now?: () => number;
}
export interface NotificationCenter {
  handle(request: Request): Promise<Response>;
  publish(input: { userId: string; key: string; category: string; title: string; body: string; url?: string }): string | null;
  workEmailOnce(): Promise<boolean>;
  startEmailWorker(): JobProcessHandle;
  close(): void;
}
const schema = defineDatabase({
  notifications: defineTable({ key: s.string({ min: 1, max: 200 }), category: s.string({ max: 80 }), title: s.string({ min: 1, max: 200 }),
    body: s.string({ max: 8000 }), url: s.nullable(s.string({ max: 2048 })), readAt: s.nullable(s.number()),
    inApp: s.boolean(), emailState: s.string({ max: 20 }), deliveryAt: s.optional(s.number()), emailAttempts: s.optional(s.number()), batchId: s.optional(s.string()) }).owned().index("by_key", ["key"]),
  notificationDeliveryBatches: defineTable({ leader: s.string(), recipient: s.string(), payload: s.string({ max: 1048576 }), state: s.string(), jobId: s.string() }).owned(),
  notificationPreferences: defineTable({ category: s.string({ max: 80 }), inApp: s.boolean(), email: s.boolean(), policy: s.optional(s.string({ max: 4096 })) }).owned().index("by_category", ["category"]),
});
const api: {
  list: FunctionReference<"query", { unreadOnly?: boolean }, readonly NotificationItem[]>;
  unreadCount: FunctionReference<"query", {}, number>;
  markRead: FunctionReference<"mutation", { id: string; read: boolean }, boolean>;
  markAllRead: FunctionReference<"mutation", {}, number>;
  preferences: FunctionReference<"query", {}, readonly NotificationPreferences[]>;
  setPreference: FunctionReference<"mutation", { category: string; inApp: boolean; email: boolean; policy?: string }, NotificationPreferences>;
  retryEmail: FunctionReference<"mutation", { id: string }, boolean>;
} = createApi<any>();
const validUrl = (url: unknown) => url === null || (typeof url === "string" && /^\/(?!\/)/.test(url) && !/[\\\u0000-\u0020]/.test(url));

/** A notification service sharing the application's SQLite auth database and ordinary RPC/MCP contracts. */
export async function openNotificationCenter(options: NotificationCenterOptions): Promise<NotificationCenter> {
  const categories = [...new Set(options.categories)];
  const maximum = options.maxPerUser ?? 1000;
  if (!categories.length || categories.length > 32 || categories.some(category => !/^[a-z][a-z0-9._-]{0,79}$/.test(category))) throw new TypeError("Declare 1–32 notification categories.");
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000) throw new TypeError("Invalid notification retention limit.");
  const categorySchema = s.enum(categories as [string, ...string[]]);
  const clock = options.now ?? Date.now;
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0 || value > Date.UTC(2099, 11, 30)) throw new TypeError("Invalid notification clock."); return value; };
  now();
  const preference = (db: any, category: string): NotificationPreferences => {
    const row = db.table("notificationPreferences").query().where("category", category).first();
    return { category, inApp: row?.inApp ?? true, email: row?.email ?? false, ...deliveryPolicy(row?.policy ? JSON.parse(row.policy) : {}) };
  };
  let runtime: BackendRuntime<typeof schema, any, AuthDefinition<any>, any>;
  const jobs = defineJobs({ schema }).jobs(({ job }) => ({
    notificationEmail: job({ args: { id: s.id("notifications") }, agent: false,
      async handler({ db, signal, job, jobs: publisher }, { id }) {
        let notification = db.read(tx => tx.table("notifications").get(id));
        if (!notification || ["sent", "skipped"].includes(notification.emailState) || notification.batchId && notification.batchId !== id) return;
        const preferences = db.read(tx => preference(tx, notification.category));
        const user = runtime.database[SQLITE_INTERNAL].prepare("SELECT email, email_verified_at, disabled FROM clank_auth_users WHERE id = ?").get(notification._ownerId);
        const finish = (state: string, items = [id]) => db.transaction(tx => {
          for (const item of items) if (tx.table("notifications").get(item)) tx.table("notifications").patch(item, { emailState: state, emailAttempts: job.attempt });
          const batch = tx.table("notificationDeliveryBatches").query().where("leader", id).first();
          if (batch) tx.table("notificationDeliveryBatches").patch(batch._id, { state });
        });
        let batch = db.read(tx => tx.table("notificationDeliveryBatches").query().where("leader", id).first());
        if (!options.sendEmail || !preferences.email || !user || Number(user.disabled) !== 0 || user.email_verified_at === null || batch && batch.recipient !== user.email) {
          finish("skipped", batch ? JSON.parse(batch.payload).ids : [id]); return;
        }
        const runAt = afterQuietHours(now(), deliveryPolicy(preferences));
        if (runAt > now()) {
          db.transaction(tx => {
            const queued = publisher.enqueue(jobs.jobs.notificationEmail, { id }, { runAt, idempotencyKey: `defer:${id}:${runAt}`, group: `${notification._ownerId}:${notification.category}` });
            for (const item of batch ? JSON.parse(batch.payload).ids : [id]) if (tx.table("notifications").get(item)) tx.table("notifications").patch(item, { deliveryAt: runAt, emailState: "deferred" });
            if (batch) tx.table("notificationDeliveryBatches").patch(batch._id, { jobId: queued.id, state: "deferred" });
          });
          return;
        }
        if (!batch) {
          batch = db.transaction(tx => {
            const table = tx.table("notifications");
            const items = preferences.delivery === "immediate" ? [notification!] : table.collect().filter(row => row.category === notification!.category && !row.batchId && ["queued", "deferred"].includes(row.emailState) && (row.deliveryAt ?? 0) <= now()).sort((a,b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id)).slice(0, 50);
            if (!items.some(row => row._id === id)) items.splice(49, 1, notification!);
            const payload = { ids: items.map(row => row._id), subject: items.length === 1 ? items[0]!.title : `${items.length} ${notification!.category} notifications`, text: items.map(row => `${row.title}\n${row.body}${row.url ? `\n${row.url}` : ""}`).join("\n\n"), url: items.length === 1 ? items[0]!.url : null };
            for (const item of items) table.patch(item._id, { batchId: id, emailState: "sending", emailAttempts: job.attempt });
            const batchId = tx.table("notificationDeliveryBatches").insert({ leader: id, recipient: String(user.email), payload: JSON.stringify(payload), state: "sending", jobId: job.id });
            return tx.table("notificationDeliveryBatches").get(batchId)!;
          });
        }
        // Retries can move to a new job after a quiet-hours postponement. Keep
        // the sealed batch attached to the live job for manual retry admission.
        if (batch.jobId !== job.id || batch.state !== "sending") db.transaction(tx => {
          tx.table("notificationDeliveryBatches").patch(batch!._id, { jobId: job.id, state: "sending" });
          for (const item of JSON.parse(batch!.payload).ids) if (tx.table("notifications").get(item)) tx.table("notifications").patch(item, { emailState: "sending", emailAttempts: job.attempt });
        });
        const payload = JSON.parse(batch.payload);
        try {
          await options.sendEmail({ to: batch.recipient, subject: payload.subject, text: payload.text, url: payload.url, idempotencyKey: `clank-notification:${id}`, signal });
          finish("sent", payload.ids);
        } catch (error) { finish("failed", payload.ids); throw error; }
      },
    }),
  }));
  const definition = defineBackend({ schema, auth: options.auth, jobs }).functions(({ query, mutation }) => ({
    list: query({ args: { unreadOnly: s.optional(s.boolean()) }, handler: ({ db }, { unreadOnly }) => {
      let rows = db.table("notifications").query().where("inApp", true);
      if (unreadOnly) rows = rows.where("readAt", null);
      return rows.orderBy("_creationTime", "desc").limit(100).collect().map(({ _id, _creationTime, category, title, body, url, readAt, emailState, deliveryAt, emailAttempts }) => ({ _id, _creationTime, category, title, body, url, readAt, emailState, ...(deliveryAt === undefined ? {} : { deliveryAt }), ...(emailAttempts === undefined ? {} : { emailAttempts }) }));
    } }),
    unreadCount: query({ args: {}, handler: ({ db }) => db.table("notifications").query().where("inApp", true).where("readAt", null).collect().length }),
    markRead: mutation({ args: { id: s.id("notifications"), read: s.boolean() }, handler: ({ db }, { id, read }) => {
      const item = db.table("notifications").get(id); if (!item) return false;
      db.table("notifications").patch(id, { readAt: read ? item.readAt ?? Date.now() : null }); return true;
    } }),
    markAllRead: mutation({ args: {}, handler: ({ db }) => {
      const rows = db.table("notifications").query().where("inApp", true).where("readAt", null).collect();
      const now = Date.now(); for (const item of rows) db.table("notifications").patch(item._id, { readAt: now }); return rows.length;
    } }),
    preferences: query({ args: {}, handler: ({ db }) => categories.map(category => preference(db, category)) }),
    setPreference: mutation({ args: { category: categorySchema, inApp: s.boolean(), email: s.boolean(), policy: s.optional(s.string({ max: 4096 })) }, handler: ({ db }, input) => {
      const existing = db.table("notificationPreferences").query().where("category", input.category).first();
      const policy = input.policy === undefined ? existing?.policy ?? JSON.stringify(deliveryPolicy({})) : JSON.stringify(deliveryPolicy(JSON.parse(input.policy)));
      const value = { ...input, policy };
      if (existing) db.table("notificationPreferences").patch(existing._id, value); else db.table("notificationPreferences").insert(value);
      return preference(db, input.category);
    } }),
    retryEmail: mutation({ args: { id: s.id("notifications") }, handler: ({ db }, { id }) => {
      const notification = db.table("notifications").get(id);
      if (!notification || notification.emailState !== "failed") return false;
      const batch = db.table("notificationDeliveryBatches").query().where("leader", notification.batchId ?? id).first();
      return batch ? runtime.jobs!.retry(batch.jobId) : false;
    } }),
  }));
  runtime = await openBackend(definition, { path: options.path, prefix: options.prefix ?? "__clank/notifications", onError: options.onError, jobs: { now } });
  return {
    handle: request => runtime.handle(request),
    publish(input) {
      if (!categories.includes(input.category) || !validUrl(input.url ?? null)) throw new TypeError("Invalid notification category or local URL.");
      const record = schema.tables.notifications.schema.parse({ key: input.key, category: input.category, title: input.title, body: input.body,
        url: input.url ?? null, readAt: null, inApp: true, emailState: "none" });
      return runtime.database.transaction(db => {
        const user = runtime.database[SQLITE_INTERNAL].prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(input.userId);
        if (!user || Number(user.disabled) !== 0) throw new Error("Notification recipient is unavailable.");
        const existing = db.table("notifications").query().where("key", input.key).first();
        if (existing) {
          if (existing.category !== record.category || existing.title !== record.title || existing.body !== record.body || existing.url !== record.url) {
            throw new Error("Notification key was already used for a different notification.");
          }
          return existing._id;
        }
        const preferences = preference(db, input.category);
        const email = Boolean(options.sendEmail && preferences.email);
        if (!preferences.inApp && !email) return null;
        const existingRows = db.table("notifications").collect();
        if (email && existingRows.filter(row => ["queued", "sending", "failed", "deferred"].includes(row.emailState)).length >= maximum) throw new Error("Pending notification delivery limit reached.");
        const deliveryAt = email ? nextNotificationDelivery(preferences, now()) : undefined;
        const id = db.table("notifications").insert({ ...record, inApp: preferences.inApp, emailState: email ? "queued" : "none", ...(email ? { deliveryAt, emailAttempts: 0 } : {}) });
        if (email) runtime.jobs!.publisher({ userId: input.userId }).enqueue(jobs.jobs.notificationEmail, { id }, { idempotencyKey: id, runAt: deliveryAt, group: `${input.userId}:${input.category}` });
        const old = db.table("notifications").query().orderBy("_creationTime", "desc").collect().filter(item => item._id !== id).slice(maximum - 1);
        for (const item of old) if (!["queued", "sending", "failed", "deferred"].includes(item.emailState)) db.table("notifications").delete(item._id);
        for (const batch of db.table("notificationDeliveryBatches").collect()) if (["sent", "skipped"].includes(batch.state) && !db.table("notifications").query().where("batchId", batch.leader).first()) db.table("notificationDeliveryBatches").delete(batch._id);
        return id;
      }, { userId: input.userId });
    },
    workEmailOnce: () => runtime.jobs!.workOnce(),
    startEmailWorker: () => runtime.jobs!.startWorker(),
    close: () => runtime.close(),
  };
}

export interface NotificationClient {
  list(unreadOnly?: boolean): Promise<readonly NotificationItem[]>;
  unreadCount(): Promise<number>;
  markRead(id: string, read?: boolean): Promise<boolean>;
  markAllRead(): Promise<number>;
  preferences(): Promise<readonly NotificationPreferences[]>;
  retryEmail(id: string): Promise<boolean>;
  setPreference(preferences: NotificationPreferences): Promise<NotificationPreferences>;
}
export function createNotificationClient(options: SyncClientOptions = {}): NotificationClient {
  // SyncClient accepts a backend prefix through its base URL only via a custom fetch adapter.
  // Rewrite its fixed /__clank segment to the notification service's declared prefix.
  const prefix = (options.url ?? "/__clank/notifications").replace(/\/$/, "");
  const transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return {
    list: (unreadOnly = false) => transport.query(api.list, { unreadOnly }),
    unreadCount: () => transport.query(api.unreadCount),
    markRead: (id, read = true) => transport.mutate(api.markRead, { id, read }),
    markAllRead: () => transport.mutate(api.markAllRead),
    preferences: () => transport.query(api.preferences),
    setPreference: preferences => { const { category, inApp, email, ...policy } = preferences; return transport.mutate(api.setPreference, { category, inApp, email, ...(Object.keys(policy).length ? { policy: JSON.stringify(deliveryPolicy(policy)) } : {}) }); },
    retryEmail: id => transport.mutate(api.retryEmail, { id }),
  };
}

export function renderNotificationCenter(items: readonly NotificationItem[]): string {
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<section aria-label="Notifications"><h2>Notifications</h2>${items.length ? `<ul>${items.map(item => `<li><strong>${escape(item.title)}</strong><p>${escape(item.body)}</p><p>${item.readAt === null ? "Unread" : "Read"}</p><p>Email: ${escape(item.emailState ?? "none")}${item.deliveryAt ? ` · ${escape(new Date(item.deliveryAt).toISOString())}` : ""}${item.emailAttempts ? ` · ${escape(item.emailAttempts)} attempt(s)` : ""}</p>${item.emailState === "failed" ? `<button type="button" data-retry="${escape(item._id)}">Retry failed email</button>` : ""}${item.url && validUrl(item.url) ? `<a href="${escape(item.url)}">Open</a>` : ""}<button type="button" data-notification="${escape(item._id)}" data-read="${item.readAt === null ? "true" : "false"}">Mark ${item.readAt === null ? "read" : "unread"}</button></li>`).join("")}</ul>` : "<p>You’re all caught up.</p>"}</section>`;
}

/** Mount read/unread controls and per-category preferences, with explicit refresh and error state. */
export function mountNotificationCenter(container: HTMLElement, client: NotificationClient): () => void {
  const panel = container.ownerDocument.createElement("aside");
  const refresh = container.ownerDocument.createElement("button"); refresh.type = "button"; refresh.textContent = "Refresh notifications";
  const status = container.ownerDocument.createElement("p"); status.setAttribute("role", "status");
  const content = container.ownerDocument.createElement("div");
  const preferences = container.ownerDocument.createElement("div");
  panel.append(refresh, status, content, preferences); container.append(panel);
  let disposed = false, busy = false;
  const update = async () => {
    if (busy || disposed) return; busy = true; refresh.disabled = true;
    try {
      const [items, settings, unread] = await Promise.all([client.list(), client.preferences(), client.unreadCount()]);
      if (disposed) return;
      content.innerHTML = renderNotificationCenter(items); preferences.replaceChildren();
      status.textContent = `${unread} unread notifications`;
      const heading = container.ownerDocument.createElement("h3"); heading.textContent = "Notification preferences"; preferences.append(heading);
      for (const setting of settings) {
        const field = container.ownerDocument.createElement("fieldset"), legend = container.ownerDocument.createElement("legend"); legend.textContent = setting.category; field.append(legend);
        for (const channel of ["inApp", "email"] as const) {
          const label = container.ownerDocument.createElement("label"), input = container.ownerDocument.createElement("input");
          input.type = "checkbox"; input.checked = setting[channel]; input.dataset.category = setting.category; input.dataset.channel = channel;
          label.append(input, channel === "inApp" ? " In-app" : " Email"); field.append(label);
        }
        const delivery = container.ownerDocument.createElement("select"); delivery.dataset.category = setting.category; delivery.dataset.policy = "delivery"; delivery.setAttribute("aria-label", `${setting.category} email delivery`);
        for (const [value, label] of [["immediate", "Immediately"], ["hourly", "Hourly digest"], ["daily", "Daily digest"]]) { const option = container.ownerDocument.createElement("option"); option.value = value!; option.textContent = label!; delivery.append(option); }
        delivery.value = setting.delivery ?? "immediate"; field.append(delivery);
        for (const [key, label, value] of [["timeZone", "Time zone", setting.timeZone ?? "UTC"], ["digestTime", "Daily digest time", setting.digestTime ?? "09:00"], ["quietStart", "Quiet hours start", setting.quietHours?.start ?? ""], ["quietEnd", "Quiet hours end", setting.quietHours?.end ?? ""]]) {
          const input = container.ownerDocument.createElement("input"); input.type = key === "timeZone" ? "text" : "time"; input.value = value!; input.dataset.policy = key; input.dataset.category = setting.category; input.setAttribute("aria-label", `${setting.category} ${label}`); field.append(input);
        }
        preferences.append(field);
      }
    } catch { if (!disposed) status.textContent = "Notifications could not load. Refresh to retry."; }
    finally { busy = false; refresh.disabled = false; }
  };
  const click = async (event: Event) => {
    const target = event.target as HTMLElement;
    const id = target.dataset.notification ?? target.dataset.retry; if (!id || busy || disposed) return;
    busy = true;
    try { if (target.dataset.retry) { if (!await client.retryEmail(id)) { busy = false; status.textContent = "Automatic retries are still pending, or the email is no longer retryable."; return; } } else await client.markRead(id, target.dataset.read === "true"); } catch { status.textContent = "Read state could not save."; busy = false; return; }
    busy = false; await update();
  };
  const change = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (!target.dataset.category || busy || disposed) return;
    busy = true;
    const field = target.closest("fieldset")!;
    const value = (key: string) => field.querySelector<HTMLInputElement>(`[data-policy="${key}"]`)!.value;
    // A quiet interval needs both ends; leave the first edit in the form.
    if (Boolean(value("quietStart")) !== Boolean(value("quietEnd"))) { busy = false; status.textContent = "Choose both quiet-hour times, or clear both."; return; }
    try { await client.setPreference({ category: target.dataset.category, inApp: field.querySelector<HTMLInputElement>('[data-channel="inApp"]')!.checked, email: field.querySelector<HTMLInputElement>('[data-channel="email"]')!.checked, delivery: value("delivery") as NotificationDeliveryPolicy["delivery"], timeZone: value("timeZone"), digestTime: value("digestTime"), quietHours: value("quietStart") ? { start: value("quietStart"), end: value("quietEnd") } : null }); }
    catch { status.textContent = "Preferences could not save. Refresh to retry."; busy = false; return; }
    busy = false; await update();
  };
  refresh.addEventListener("click", update); content.addEventListener("click", click); preferences.addEventListener("change", change); void update();
  return () => { disposed = true; refresh.removeEventListener("click", update); content.removeEventListener("click", click); preferences.removeEventListener("change", change); panel.remove(); };
}
