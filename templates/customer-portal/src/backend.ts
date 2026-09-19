import { AuthError, BackendActionError, defineAuth, defineBackend, defineDatabase, defineTable, s, type DocumentFor } from "@clank.run/framework";
const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
export const auth = defineAuth({ password: environment?.CLANK_AUTH_PEPPER ? { pepper: environment.CLANK_AUTH_PEPPER } : undefined });
export const schema = defineDatabase({ records: defineTable({
  ownerId: s.string(), title: s.string({ min: 1, max: 160 }), detail: s.string({ min: 1, max: 2000 }),
  status: s.enum(["open", "closed"]), note: s.string({ max: 2000 }), startsAt: s.number(), endsAt: s.number(),
}).index("by_owner", ["ownerId"]).index("by_start", ["startsAt"]) });
export type RecipeDecision = "open" | "closed";
export type RecipeRecord = DocumentFor<typeof schema, "records">;
const version = s.number({ integer: true, min: 1 });
export const backend = defineBackend({ schema, auth }).functions(({ query, mutation }) => ({ records: {
  list: query({ description: "Private service requests with staff responses and customer-controlled closure.", args: {}, handler: ({ db, user }) => {
    let rows = db.table("records").query();
    if (user.role !== "staff" && user.role !== "admin") rows = rows.where("ownerId", user.id);
    return rows.orderBy("_creationTime", "desc").limit(100).collect();
  } }),
  create: mutation({ description: "Create request for the signed-in account.", agent: { destructive: false },
    args: { title: s.string({ min: 1, max: 160 }), detail: s.string({ min: 1, max: 2000 }) },
    handler: ({ db, user }, { title, detail }) => {
      title = title.trim(); detail = detail.trim();
      if (!title || !detail) throw new BackendActionError(400, "INVALID_INPUT", "Title and details are required.");
      let startsAt = 0, endsAt = 0;
      
      return db.table("records").insert({ ownerId: user.id, title, detail, status: "open", note: "", startsAt, endsAt });
    },
  }),
  update: mutation({ description: "Close or reopen your request; staff may add a response.", agent: { destructive: false },
    args: { id: s.id("records"), version, status: s.enum(["open", "closed"]), note: s.optional(s.string({ max: 2000 })) },
    handler: ({ db, user, auth }, { id, version, status, note }) => {
      const row = db.table("records").get(id);
      const staff = user.role === "staff" || user.role === "admin";
      if (!row || (!staff && row.ownerId !== user.id)) throw new BackendActionError(404, "NOT_FOUND", "Request unavailable.");
      if (note !== undefined && !staff) throw new AuthError("STAFF_ONLY", "Only staff may write a response.", 403);
      return db.table("records").patch(id, { status, note: note?.trim() ?? row.note }, { ifVersion: version });
    },
  }),
} }));
