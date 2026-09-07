import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend, type SyncClientOptions } from "./backend.ts";
import type { AuthDefinition } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
export type CommentRole = "reader" | "commenter" | "moderator";
export interface CommentItem { id: string; authorId: string; body: string; parentId: string | null; rootId: string; depth: number; version: number; createdAt: number; editedAt: number | null; deleted: boolean; resolved: boolean; canManage: boolean; }
export interface CommentPage { items: readonly CommentItem[]; next: { at: number; id: string } | null; canComment: boolean; }
export interface CommentServiceOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export interface CommentService { handle(request: Request): Promise<Response>; setAccess(resource: string, userId: string, role: CommentRole | null): void; close(): void; }
export interface CommentClient {
  list(resource: string, before?: { at: number; id: string }): Promise<CommentPage>;
  thread(resource: string, rootId: string): Promise<readonly CommentItem[]>;
  add(resource: string, body: string, options?: { parentId?: string; key?: string }): Promise<CommentItem>;
  edit(resource: string, id: string, body: string, expectedVersion: number): Promise<CommentItem>;
  remove(resource: string, id: string, expectedVersion: number): Promise<void>;
  resolve(resource: string, id: string, resolved: boolean, expectedVersion: number): Promise<void>;
}
const resourceSchema = s.string({ min: 1, max: 200 });
const schema = defineDatabase({
  commentMembers: defineTable({ resource: resourceSchema, role: s.enum(["reader", "commenter", "moderator"]) }).owned().index("by_resource", ["resource"]),
  resourceComments: defineTable({ resource: resourceSchema, authorId: s.string({ max: 200 }), body: s.string({ max: 2000 }), parentId: s.nullable(s.string()), rootId: s.nullable(s.string()), depth: s.number({ integer: true }), key: s.string({ max: 128 }), editedAt: s.nullable(s.number()), deleted: s.boolean(), resolved: s.boolean() }).index("by_resource", ["resource"]).index("by_root", ["rootId"]).index("by_key", ["resource", "authorId", "key"]),
});
/** Shared threads with persisted resource membership and per-author/moderator management. */
export async function openComments(options: CommentServiceOptions): Promise<CommentService> {
  const access = (db: any, resource: string, write = false) => { const member = db.table("commentMembers").query().where("resource", resource).first(); if (!member || (write && member.role === "reader")) throw new Error("Comment access is unavailable."); return member.role as CommentRole; };
  const view = (row: any, userId: string, role: CommentRole): CommentItem => ({ id: row._id, authorId: row.authorId, body: row.deleted ? "" : row.body, parentId: row.parentId, rootId: row.rootId ?? row._id, depth: row.depth, version: row._version, createdAt: row._creationTime, editedAt: row.editedAt, deleted: row.deleted, resolved: row.resolved, canManage: role === "moderator" || (role === "commenter" && row.authorId === userId) });
  const item = (db: any, resource: string, id: string) => { const row = db.table("resourceComments").get(id); if (!row || row.resource !== resource) throw new Error("Comment is unavailable."); return row; };
  const writable = (db: any, userId: string, resource: string, id: string, version: number) => { const role = access(db, resource, true), row = item(db, resource, id); if (row._version !== version || (row.authorId !== userId && role !== "moderator")) throw new Error("Comment changed or cannot be managed by this account."); return { row, role }; };
  const backend = defineBackend({ schema, auth: options.auth }).functions(({ query, mutation }) => ({
    list: query({ args: { resource: resourceSchema, before: s.optional(s.object({ at: s.number(), id: s.string({ max: 200 }) })) }, handler: ({ db, user }, { resource, before }) => {
      const role = access(db, resource), rows = db.table("resourceComments").query().where("resource", resource).where("parentId", null).collect().sort((a, b) => b._creationTime - a._creationTime || b._id.localeCompare(a._id)).filter(row => !before || row._creationTime < before.at || (row._creationTime === before.at && row._id < before.id));
      const page = rows.slice(0, 20), last = page[page.length - 1]; return { items: page.map(row => view(row, user!.id, role)), next: rows.length > 20 ? { at: last!._creationTime, id: last!._id } : null, canComment: role !== "reader" };
    } }),
    thread: query({ args: { resource: resourceSchema, rootId: s.string({ max: 200 }) }, handler: ({ db, user }, { resource, rootId }) => { const role = access(db, resource), root = item(db, resource, rootId); if (root.parentId !== null) throw new Error("Choose a root comment."); return [root, ...db.table("resourceComments").query().where("rootId", rootId).collect().sort((a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id))].map(row => view(row, user!.id, role)); } }),
    add: mutation({ args: { resource: resourceSchema, body: s.string({ min: 1, max: 2000 }), parentId: s.optional(s.string({ max: 200 })), key: s.string({ min: 1, max: 128 }) }, handler: ({ db, user }, { resource, body, parentId, key }) => {
      const role = access(db, resource, true), text = body.trim(), table = db.table("resourceComments"); if (!text) throw new Error("Write a comment before posting.");
      const duplicate = table.query().where("resource", resource).where("authorId", user!.id).where("key", key).first();
      if (duplicate) { if (duplicate.body !== text || duplicate.parentId !== (parentId ?? null)) throw new Error("Comment key was already used for different content."); return view(duplicate, user!.id, role); }
      if (table.query().where("resource", resource).collect().length >= 1000) throw new Error("This resource reached its 1,000-comment limit.");
      const parent = parentId ? item(db, resource, parentId) : null, rootId = parent ? parent.rootId ?? parent._id : null;
      if (parent && (parent.depth >= 4 || item(db, resource, rootId!).resolved || table.query().where("rootId", rootId).collect().length >= 49)) throw new Error("Thread is resolved or reached its depth/reply limit.");
      const id = table.insert({ resource, authorId: user!.id, body: text, parentId: parentId ?? null, rootId, depth: parent ? parent.depth + 1 : 0, key, editedAt: null, deleted: false, resolved: false }); return view(table.get(id), user!.id, role);
    } }),
    edit: mutation({ args: { resource: resourceSchema, id: s.string({ max: 200 }), body: s.string({ min: 1, max: 2000 }), expectedVersion: s.number({ integer: true, min: 1 }) }, handler: ({ db, user }, { resource, id, body, expectedVersion }) => { const { row, role } = writable(db, user!.id, resource, id, expectedVersion); if (row.deleted || !body.trim()) throw new Error("Deleted or empty comments cannot be edited."); const edited = db.table("resourceComments").patch(id, { body: body.trim(), editedAt: Date.now() }, { ifVersion: expectedVersion }); return view(edited, user!.id, role); } }),
    remove: mutation({ args: { resource: resourceSchema, id: s.string({ max: 200 }), expectedVersion: s.number({ integer: true, min: 1 }) }, handler: ({ db, user }, { resource, id, expectedVersion }) => { writable(db, user!.id, resource, id, expectedVersion); db.table("resourceComments").patch(id, { body: "", deleted: true, editedAt: Date.now() }, { ifVersion: expectedVersion }); } }),
    resolve: mutation({ args: { resource: resourceSchema, id: s.string({ max: 200 }), resolved: s.boolean(), expectedVersion: s.number({ integer: true, min: 1 }) }, handler: ({ db, user }, { resource, id, resolved, expectedVersion }) => { const { row } = writable(db, user!.id, resource, id, expectedVersion); if (row.parentId !== null) throw new Error("Resolve the root of a thread."); db.table("resourceComments").patch(id, { resolved }, { ifVersion: expectedVersion }); } }),
  }));
  const runtime = await openBackend(backend, { path: options.path, prefix: options.prefix ?? "__clank/comments" });
  return {
    handle: request => runtime.handle(request), close: () => runtime.close(),
    setAccess(resource, userId, role) {
      resourceSchema.parse(resource); if (role !== null && !["reader", "commenter", "moderator"].includes(role)) throw new TypeError("Invalid comment role.");
      runtime.database.transaction(db => {
        const user = runtime.database[SQLITE_INTERNAL].prepare("SELECT disabled FROM clank_auth_users WHERE id=?").get(userId); if (!user || Number(user.disabled)) throw new Error("Comment member is unavailable.");
        const table = db.table("commentMembers"), current = table.query().where("resource", resource).first();
        if (role === null) { if (current) table.delete(current._id); }
        else if (current) table.patch(current._id, { role });
        else { if (table.collect().length >= 2000) throw new Error("Comment membership limit reached."); table.insert({ resource, role }); }
      }, { userId });
    },
  };
}
export function createCommentClient(options: SyncClientOptions = {}): CommentClient {
  const api = createApi<any>(), prefix = (options.url ?? "/__clank/comments").replace(/\/$/, "");
  const transport = createSyncClient({ ...options, url: "", fetch: (url, init) => (options.fetch ?? fetch)(`${prefix}${String(url).replace(/^\/__clank/, "")}`, init) });
  return { list: (resource, before) => transport.query(api.list, { resource, before }), thread: (resource, rootId) => transport.query(api.thread, { resource, rootId }), add: (resource, body, settings = {}) => transport.mutate(api.add, { resource, body, parentId: settings.parentId, key: settings.key ?? crypto.randomUUID() }), edit: (resource, id, body, expectedVersion) => transport.mutate(api.edit, { resource, id, body, expectedVersion }), remove: (resource, id, expectedVersion) => transport.mutate(api.remove, { resource, id, expectedVersion }), resolve: (resource, id, resolved, expectedVersion) => transport.mutate(api.resolve, { resource, id, resolved, expectedVersion }) };
}

/** Shared thread controls with inline editing, replies, resolution, and stable retry keys. */
export function mountComments(container: HTMLElement, client: CommentClient, resource: string): () => void {
  const document = container.ownerDocument, panel = document.createElement("section"), status = document.createElement("p"), list = document.createElement("div"), compose = document.createElement("textarea"), replyLabel = document.createElement("p"), post = document.createElement("button"), more = document.createElement("button");
  panel.setAttribute("aria-label", "Comments"); status.setAttribute("role", "status"); compose.setAttribute("aria-label", "Write a comment"); compose.maxLength = 2000; post.type = more.type = "button"; post.textContent = "Post comment"; more.textContent = "Older threads";
  let closed = false, busy = false, canComment = false, threadResolved = false, rootId: string | null = null, parentId: string | undefined, next: CommentPage["next"] = null, key = crypto.randomUUID();
  const button = (text: string, action: () => Promise<void>) => { const node = document.createElement("button"); node.type = "button"; node.textContent = text; node.addEventListener("click", () => { void run(action); }); return node; };
  const render = (items: readonly CommentItem[], append: boolean) => {
    if (!append) list.replaceChildren();
    for (const item of items) {
      const article = document.createElement("article"), author = document.createElement("strong"), body = document.createElement("p"), time = document.createElement("p"); article.style.marginLeft = `${item.depth * 12}px`;
      author.textContent = `Member ${item.authorId.slice(0, 8)}`; body.textContent = item.deleted ? "Comment removed." : item.body; time.textContent = `${new Date(item.createdAt).toISOString()}${item.editedAt ? " · edited" : ""}${item.resolved ? " · resolved" : ""}`; article.append(author, time, body);
      if (!rootId) article.append(button("Open thread", async () => { rootId = item.rootId; await load(); }));
      if (canComment && !item.resolved && !threadResolved && item.depth < 4) article.append(button("Reply", async () => { parentId = item.id; key = crypto.randomUUID(); replyLabel.textContent = `Replying to Member ${item.authorId.slice(0, 8)}`; compose.focus(); }));
      if (item.canManage) {
        if (!item.deleted) {
          const details = document.createElement("details"), summary = document.createElement("summary"), edit = document.createElement("textarea"); summary.textContent = "Edit comment"; edit.setAttribute("aria-label", "Edit comment text"); edit.value = item.body; edit.maxLength = 2000;
          details.append(summary, edit, button("Save edit", async () => { await client.edit(resource, item.id, edit.value, item.version); await load(); })); article.append(details, button("Remove text", async () => { await client.remove(resource, item.id, item.version); await load(); }));
        }
        if (!item.parentId) article.append(button(item.resolved ? "Reopen thread" : "Resolve thread", async () => { await client.resolve(resource, item.id, !item.resolved, item.version); await load(); }));
      }
      list.append(article);
    }
    if (!list.childElementCount) list.textContent = "No comments yet.";
  };
  const load = async (append = false) => {
    if (rootId) { const items = await client.thread(resource, rootId); if (closed) return; threadResolved = items[0]?.resolved ?? false; render(items, false); more.hidden = true; }
    else { const page = await client.list(resource, append ? next ?? undefined : undefined); if (closed) return; threadResolved = false; canComment = page.canComment; next = page.next; render(page.items, append); more.hidden = !next; }
    compose.hidden = post.hidden = !canComment; status.textContent = canComment ? "Comments loaded." : "Read-only access.";
  };
  const run = async (action: () => Promise<void>) => {
    if (closed || busy) return; busy = true; panel.setAttribute("aria-busy", "true"); compose.disabled = post.disabled = true;
    try { await action(); } catch { if (!closed) { list.replaceChildren(); status.textContent = "Could not complete this action. Refresh access or retry your unchanged draft."; } }
    finally { busy = false; compose.disabled = post.disabled = false; panel.removeAttribute("aria-busy"); }
  };
  compose.addEventListener("input", () => { key = crypto.randomUUID(); });
  post.addEventListener("click", () => { void run(async () => { await client.add(resource, compose.value, { parentId, key }); if (closed) return; compose.value = ""; parentId = undefined; replyLabel.textContent = ""; key = crypto.randomUUID(); await load(); status.textContent = "Comment posted."; }); });
  more.addEventListener("click", () => { if (next) void run(() => load(true)); });
  panel.append(button("Refresh comments", () => load()), button("All threads", async () => { rootId = null; await load(); }), status, list, more, replyLabel, compose, post, button("Cancel reply", async () => { parentId = undefined; key = crypto.randomUUID(); replyLabel.textContent = ""; }));
  container.append(panel); void run(() => load()); return () => { closed = true; panel.remove(); };
}
