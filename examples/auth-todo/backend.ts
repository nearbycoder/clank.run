import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  DatabaseConflictError,
  s,
  type DocumentFor,
} from "clank.run";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const authPepper = environment?.CLANK_AUTH_PEPPER ?? environment?.PROACT_AUTH_PEPPER;

export const auth = defineAuth({
  // Keep the pepper server-only. The browser imports this module as a type, never as code.
  password: authPepper ? { pepper: authPepper } : undefined,
});

export const databaseSchema = defineDatabase({
  profiles: defineTable({
    displayName: s.string({ min: 1, max: 120 }),
  }).owned(),
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
  })
    .owned()
    .index("by_done", ["done"]),
});

export type Todo = DocumentFor<typeof databaseSchema, "todos">;
export type Profile = DocumentFor<typeof databaseSchema, "profiles">;

const nonEmptyTitle = s.refine(
  s.string({ max: 160 }),
  (value) => value.trim().length > 0,
  "Todo titles cannot be empty.",
);
const nonEmptyDisplayName = s.refine(
  s.string({ max: 120 }),
  (value) => value.trim().length > 0,
  "Display names cannot be empty.",
);
const documentVersion = s.number({ integer: true, min: 1 });

export const backend = defineBackend({
  schema: databaseSchema,
  auth,
}).functions(({ query, mutation }) => ({
  profile: {
    get: query({
      args: {},
      handler: ({ db }) => db.table("profiles")
        .query()
        .orderBy("_creationTime", "asc")
        .first(),
    }),

    update: mutation({
      args: {
        displayName: nonEmptyDisplayName,
        version: s.nullable(documentVersion),
      },
      handler: ({ db }, { displayName, version }) => {
        const value = displayName.trim();
        const profile = db.table("profiles")
          .query()
          .orderBy("_creationTime", "asc")
          .first();
        if (version === null) {
          if (profile) {
            throw new DatabaseConflictError("profiles", profile._id, null, profile._version);
          }
          return db.table("profiles").insert({ displayName: value });
        }
        if (!profile) {
          throw new DatabaseConflictError("profiles", "profile", version, null);
        }
        return db.table("profiles").patch(
          profile._id,
          { displayName: value },
          { ifVersion: version },
        );
      },
    }),
  },

  todos: {
    list: query({
      args: {},
      handler: ({ db }) => db.table("todos")
        .query()
        .orderBy("_creationTime", "asc")
        .collect(),
    }),

    add: mutation({
      args: { title: nonEmptyTitle },
      handler: ({ db }, { title }) => db.table("todos").insert({
        title: title.trim(),
        done: false,
      }),
    }),

    setDone: mutation({
      args: {
        id: s.id("todos"),
        done: s.boolean(),
        version: documentVersion,
      },
      handler: ({ db }, { id, done, version }) => db.table("todos").patch(
        id,
        { done },
        { ifVersion: version },
      ),
    }),

    rename: mutation({
      args: {
        id: s.id("todos"),
        title: nonEmptyTitle,
        version: documentVersion,
      },
      handler: ({ db }, { id, title, version }) => db.table("todos").patch(
        id,
        { title: title.trim() },
        { ifVersion: version },
      ),
    }),

    remove: mutation({
      args: {
        id: s.id("todos"),
        version: documentVersion,
      },
      handler: ({ db }, { id, version }) => db.table("todos").delete(
        id,
        { ifVersion: version },
      ),
    }),

    clearCompleted: mutation({
      args: {},
      handler: ({ db }) => {
        const completed = db.table("todos").query().where("done", true).collect();
        for (const todo of completed) {
          db.table("todos").delete(todo._id, { ifVersion: todo._version });
        }
        return completed.length;
      },
    }),
  },
}));
