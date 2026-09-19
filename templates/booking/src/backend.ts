import { AuthError, BackendActionError, defineAuth, defineBackend, defineDatabase, defineTable, s, type DocumentFor } from "@clank.run/framework";
const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
export const auth = defineAuth({ password: environment?.CLANK_AUTH_PEPPER ? { pepper: environment.CLANK_AUTH_PEPPER } : undefined });
export const schema = defineDatabase({ records: defineTable({
  ownerId: s.string(), title: s.string({ min: 1, max: 160 }), detail: s.string({ min: 1, max: 2000 }),
  status: s.enum(["booked", "cancelled"]), note: s.string({ max: 2000 }), startsAt: s.number(), endsAt: s.number(),
}).index("by_owner", ["ownerId"]).index("by_start", ["startsAt"]) });
export type RecipeDecision = "cancelled";
export type RecipeRecord = DocumentFor<typeof schema, "records">;
const version = s.number({ integer: true, min: 1 });
export const backend = defineBackend({ schema, auth }).functions(({ query, mutation }) => ({ records: {
  list: query({ description: "Reserve one 30-minute consultation. Start times use UTC.", args: {}, handler: ({ db, user }) => {
    let rows = db.table("records").query();
    rows = rows.where("ownerId", user.id);
    return rows.orderBy("_creationTime", "desc").limit(100).collect();
  } }),
  create: mutation({ description: "Book consultation for the signed-in account.", agent: { destructive: false },
    args: { title: s.string({ min: 1, max: 160 }), detail: s.string({ min: 1, max: 2000 }) },
    handler: ({ db, user }, { title, detail }) => {
      title = title.trim(); detail = detail.trim();
      if (!title || !detail) throw new BackendActionError(400, "INVALID_INPUT", "Title and details are required.");
      let startsAt = 0, endsAt = 0;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(detail)) throw new BackendActionError(400, "INVALID_TIME", "Choose a UTC date and time.");
      startsAt = Date.parse(detail + ":00Z"); endsAt = startsAt + 30 * 60_000;
      if (!Number.isFinite(startsAt) || new Date(startsAt).toISOString().slice(0, 16) !== detail || startsAt % (30 * 60_000) !== 0 || startsAt <= Date.now() || startsAt > Date.now() + 90 * 86_400_000) throw new BackendActionError(400, "INVALID_TIME", "Choose a half-hour start in the next 90 days.");
      if (db.table("records").query().where("status", "booked").where("startsAt", "lt", endsAt).where("endsAt", "gt", startsAt).first()) throw new BackendActionError(409, "SLOT_TAKEN", "That consultation overlaps another booking.");
      return db.table("records").insert({ ownerId: user.id, title, detail, status: "booked", note: "", startsAt, endsAt });
    },
  }),
  update: mutation({ description: "Cancel your booking and release its consultation slot.", agent: { destructive: false },
    args: { id: s.id("records"), version, status: s.enum(["cancelled"]), note: s.optional(s.string({ max: 2000 })) },
    handler: ({ db, user, auth }, { id, version, status, note }) => {
      const row = db.table("records").get(id);
      if (!row || row.ownerId !== user.id) throw new BackendActionError(404, "NOT_FOUND", "Booking unavailable.");
      if (row.status !== "booked") throw new BackendActionError(409, "ALREADY_CANCELLED", "Booking already cancelled.");
      return db.table("records").patch(id, { status, note: note?.trim() ?? row.note }, { ifVersion: version });
    },
  }),
} }));
