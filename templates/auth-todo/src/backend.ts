import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineJobs,
  defineTable,
  s,
  type DocumentFor,
} from "@clank.run/framework";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const authPepper = environment?.CLANK_AUTH_PEPPER ?? environment?.PROACT_AUTH_PEPPER;

export const auth = defineAuth({
  password: authPepper ? { pepper: authPepper } : undefined,
});

export const schema = defineDatabase({
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
  }).owned().index("by_done", ["done"]),
});

export type Todo = DocumentFor<typeof schema, "todos">;
const documentVersion = s.number({ integer: true, min: 1 });

export const background = defineJobs({ schema }).jobs(({ job }) => ({
  todos: {
    created: job({
      args: { id: s.id("todos") },
      queue: "events",
      description: "Process committed todo creation outside the request path.",
      retry: { maxAttempts: 5, initialDelayMs: 1_000 },
      handler: ({ db, job: metadata }, { id }) => {
        const todo = db.read((read) => read.table("todos").get(id));
        if (!todo) return { found: false };
        console.log(`Processed todo ${id} in ${metadata.id}.`);
        return { found: true };
      },
    }),
  },
}));

export const backend = defineBackend({ schema, auth, jobs: background }).functions(({ query, mutation }) => ({
  todos: {
    list: query({
      description: "List the signed-in user's todos.",
      args: {},
      handler: ({ db }) => db.table("todos").query().orderBy("_creationTime", "asc").collect(),
    }),
    add: mutation({
      description: "Create a todo for the signed-in user.",
      args: { title: s.string({ min: 1, max: 160, description: "Todo title" }) },
      agent: { destructive: false },
      handler: ({ db, jobs }, { title }) => {
        const id = db.table("todos").insert({
          title: title.trim(),
          done: false,
        });
        jobs.enqueue(background.jobs.todos.created, { id });
        return id;
      },
    }),
    setDone: mutation({
      description: "Mark one todo complete or incomplete.",
      args: { id: s.id("todos"), done: s.boolean(), version: documentVersion },
      agent: { destructive: false, idempotent: true },
      handler: ({ db }, { id, done, version }) =>
        db.table("todos").patch(id, { done }, { ifVersion: version }),
    }),
    remove: mutation({
      description: "Permanently remove one todo.",
      args: { id: s.id("todos"), version: documentVersion },
      agent: { destructive: true },
      handler: ({ db }, { id, version }) =>
        db.table("todos").delete(id, { ifVersion: version }),
    }),
  },
}));
