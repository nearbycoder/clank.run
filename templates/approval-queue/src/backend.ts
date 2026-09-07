import { AuthError, BackendActionError, defineAuth, defineBackend, defineDatabase, defineTable, s, type DocumentFor } from "@clank.run/framework";
const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
export const auth = defineAuth({ password: environment?.CLANK_AUTH_PEPPER ? { pepper: environment.CLANK_AUTH_PEPPER } : undefined });
export const schema = defineDatabase({ records: defineTable({
  ownerId: s.string(), title: s.string({ min: 1, max: 160 }), detail: s.string({ min: 1, max: 2000 }),
  status: s.enum(["pending", "approved", "rejected"]), note: s.string({ max: 2000 }), startsAt: s.number(), endsAt: s.number(),
}).index("by_owner", ["ownerId"]).index("by_start", ["startsAt"]) });
export type RecipeDecision = "approved" | "rejected";
export type RecipeRecord = DocumentFor<typeof schema, "records">;
const version = s.number({ integer: true, min: 1 });
export const backend = defineBackend({ schema, auth }).functions(({ query, mutation }) => ({ records: {
  list: query({ description: "Submit requests for a separate reviewer to approve or reject.", args: {}, handler: ({ db, user }) => {
    let rows = db.table("records").query();
    if (user.role !== "reviewer" && user.role !== "admin") rows = rows.where("ownerId", user.id);
    return rows.orderBy("_creationTime", "desc").limit(100).collect();
  } }),
  create: mutation({ description: "Submit request for the signed-in account.", agent: { destructive: false },
    args: { title: s.string({ min: 1, max: 160 }), detail: s.string({ min: 1, max: 2000 }) },
    handler: ({ db, user }, { title, detail }) => {
      title = title.trim(); detail = detail.trim();
      if (!title || !detail) throw new BackendActionError(400, "INVALID_INPUT", "Title and details are required.");
      let startsAt = 0, endsAt = 0;
      
      return db.table("records").insert({ ownerId: user.id, title, detail, status: "pending", note: "", startsAt, endsAt });
    },
  }),
  update: mutation({ description: "Review another user’s pending request. Only reviewers/admins can decide; self-approval is forbidden.", agent: { destructive: false },
    args: { id: s.id("records"), version, status: s.enum(["approved", "rejected"]), note: s.optional(s.string({ max: 2000 })) },
    handler: ({ db, user, auth }, { id, version, status, note }) => {
      const row = db.table("records").get(id);
      auth.requireRole("reviewer", "admin");
      if (!row) throw new BackendActionError(404, "NOT_FOUND", "Request unavailable.");
      if (row.ownerId === user.id) throw new AuthError("SELF_APPROVAL", "Another reviewer must decide your request.", 403);
      if (row.status !== "pending") throw new BackendActionError(409, "ALREADY_DECIDED", "This request has already been decided.");
      return db.table("records").patch(id, { status, note: note?.trim() ?? row.note }, { ifVersion: version });
    },
  }),
} }));
