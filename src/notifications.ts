import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend, type OpenBackendOptions, type SyncClientOptions } from "./backend.ts";
import { defineJobs, type JobProcessHandle } from "./jobs.ts";
import type { AuthDefinition } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";

export interface NotificationItem {
  readonly _id: string; readonly _creationTime: number; readonly category: string; readonly title: string;
  readonly body: string; readonly url: string | null; readonly readAt: number | null;
  readonly emailState: string;
}
export interface NotificationPreferences { category: string; inApp: boolean; email: boolean; }
export interface NotificationCenterOptions {
  path: string;
  auth: AuthDefinition<any>;
  categories: readonly string[];
  prefix?: string;
  maxPerUser?: number;
  sendEmail?: (message: { to: string; subject: string; text: string; url: string | null; idempotencyKey: string; signal: AbortSignal }) => Promise<void>;
  onError?: OpenBackendOptions["onError"];
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
    inApp: s.boolean(), emailState: s.string({ max: 20 }) }).owned().index("by_key", ["key"]),
  notificationPreferences: defineTable({ category: s.string({ max: 80 }), inApp: s.boolean(), email: s.boolean() }).owned().index("by_category", ["category"]),
});
const api = createApi<any>();
const validUrl = (url: unknown) => url === null || (typeof url === "string" && /^\/(?!\/)/.test(url) && !/[\\\u0000-\u0020]/.test(url));

/** A notification service sharing the application's SQLite auth database and ordinary RPC/MCP contracts. */
export async function openNotificationCenter(options: NotificationCenterOptions): Promise<NotificationCenter> {
  const categories = [...new Set(options.categories)];
  const maximum = options.maxPerUser ?? 1000;
  if (!categories.length || categories.length > 32 || categories.some(category => !/^[a-z][a-z0-9._-]{0,79}$/.test(category))) throw new TypeError("Declare 1–32 notification categories.");
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000) throw new TypeError("Invalid notification retention limit.");
  const categorySchema = s.enum(categories as [string, ...string[]]);
  const preference = (db: any, category: string): NotificationPreferences => db.table("notificationPreferences").query().where("category", category).first() ?? { category, inApp: true, email: false };
  let runtime: Awaited<ReturnType<typeof openBackend>>;
  const jobs = defineJobs({ schema }).jobs(({ job }) => ({
    notificationEmail: job({ args: { id: s.id("notifications") }, agent: false,
      async handler({ db, signal }, { id }) {
        const notification = db.read(tx => tx.table("notifications").get(id));
        if (!notification || notification.emailState === "sent") return;
        const preferences = db.read(tx => preference(tx, notification.category));
        const user = runtime.database[SQLITE_INTERNAL].prepare("SELECT email, email_verified_at, disabled FROM clank_auth_users WHERE id = ?").get(notification._ownerId);
        if (!options.sendEmail || !preferences.email || !user || Number(user.disabled) !== 0 || user.email_verified_at === null) {
          db.transaction(tx => tx.table("notifications").patch(id, { emailState: "skipped" })); return;
        }
        try {
          await options.sendEmail({ to: String(user.email), subject: notification.title, text: notification.body, url: notification.url,
            idempotencyKey: `clank-notification:${id}`, signal });
          db.transaction(tx => { if (tx.table("notifications").get(id)) tx.table("notifications").patch(id, { emailState: "sent" }); });
        } catch (error) {
          db.transaction(tx => { if (tx.table("notifications").get(id)) tx.table("notifications").patch(id, { emailState: "failed" }); });
          throw error;
        }
      },
    }),
  }));
  const definition = defineBackend({ schema, auth: options.auth, jobs }).functions(({ query, mutation }) => ({
    list: query({ args: { unreadOnly: s.optional(s.boolean()) }, handler: ({ db }, { unreadOnly }) => {
      let rows = db.table("notifications").query().where("inApp", true);
      if (unreadOnly) rows = rows.where("readAt", null);
      return rows.orderBy("_creationTime", "desc").limit(100).collect().map(({ _id, _creationTime, category, title, body, url, readAt, emailState }) => ({ _id, _creationTime, category, title, body, url, readAt, emailState }));
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
    setPreference: mutation({ args: { category: categorySchema, inApp: s.boolean(), email: s.boolean() }, handler: ({ db }, input) => {
      const existing = db.table("notificationPreferences").query().where("category", input.category).first();
      if (existing) db.table("notificationPreferences").patch(existing._id, input); else db.table("notificationPreferences").insert(input);
      return input;
    } }),
  }));
  runtime = await openBackend(definition, { path: options.path, prefix: options.prefix ?? "__clank/notifications", onError: options.onError });
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
        if (existing) return existing._id;
        const preferences = preference(db, input.category);
        const email = Boolean(options.sendEmail && preferences.email);
        if (!preferences.inApp && !email) return null;
        const id = db.table("notifications").insert({ ...record, inApp: preferences.inApp, emailState: email ? "queued" : "none" });
        if (email) runtime.jobs!.publisher({ userId: input.userId }).enqueue(jobs.jobs.notificationEmail, { id }, { idempotencyKey: id });
        const old = db.table("notifications").query().orderBy("_creationTime", "desc").collect().filter(item => item._id !== id).slice(maximum - 1);
        for (const item of old) db.table("notifications").delete(item._id);
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
    setPreference: preferences => transport.mutate(api.setPreference, preferences),
  };
}

export function renderNotificationCenter(items: readonly NotificationItem[]): string {
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<section aria-label="Notifications"><h2>Notifications</h2>${items.length ? `<ul>${items.map(item => `<li><strong>${escape(item.title)}</strong><p>${escape(item.body)}</p><p>${item.readAt === null ? "Unread" : "Read"}</p>${item.url && validUrl(item.url) ? `<a href="${escape(item.url)}">Open</a>` : ""}<button type="button" data-notification="${escape(item._id)}" data-read="${item.readAt === null ? "true" : "false"}">Mark ${item.readAt === null ? "read" : "unread"}</button></li>`).join("")}</ul>` : "<p>You’re all caught up.</p>"}</section>`;
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
        preferences.append(field);
      }
    } catch { if (!disposed) status.textContent = "Notifications could not load. Refresh to retry."; }
    finally { busy = false; refresh.disabled = false; }
  };
  const click = async (event: Event) => {
    const target = event.target as HTMLElement;
    const id = target.dataset.notification; if (!id || busy || disposed) return;
    busy = true;
    try { await client.markRead(id, target.dataset.read === "true"); } catch { status.textContent = "Read state could not save."; busy = false; return; }
    busy = false; await update();
  };
  const change = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (!target.dataset.category || busy || disposed) return;
    busy = true;
    const field = target.closest("fieldset")!;
    try { await client.setPreference({ category: target.dataset.category, inApp: field.querySelector<HTMLInputElement>('[data-channel="inApp"]')!.checked, email: field.querySelector<HTMLInputElement>('[data-channel="email"]')!.checked }); }
    catch { status.textContent = "Preferences could not save. Refresh to retry."; busy = false; return; }
    busy = false; await update();
  };
  refresh.addEventListener("click", update); content.addEventListener("click", click); preferences.addEventListener("change", change); void update();
  return () => { disposed = true; refresh.removeEventListener("click", update); content.removeEventListener("click", click); preferences.removeEventListener("change", change); panel.remove(); };
}
