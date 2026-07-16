import {
  createApi,
  createSyncClient,
  defineBackend,
  defineDatabase,
  defineTable,
  s,
  type DocumentFor,
} from "../dist/index.js";

const schema = defineDatabase({
  todos: defineTable({
    title: s.string(),
    done: s.boolean(),
    note: s.optional(s.string()),
  }).index("by_done", ["done"]),
  users: defineTable({ name: s.string() }),
});

export const backend = defineBackend({ schema }).functions(({ query, mutation }) => ({
  todos: {
    list: query({
      args: { done: s.optional(s.boolean()) },
      handler: ({ db }, { done }) => done === undefined
        ? db.table("todos").collect()
        : db.table("todos").query().where("done", done).collect(),
    }),
    add: mutation({
      args: { title: s.string(), note: s.optional(s.string()) },
      handler: ({ db }, input) => db.table("todos").insert({ ...input, done: false }),
    }),
    toggle: mutation({
      args: { id: s.id("todos") },
      handler: ({ db }, { id }) => {
        const todo = db.table("todos").get(id);
        return todo && db.table("todos").patch(id, { done: !todo.done });
      },
    }),
  },
}));

const api = createApi<typeof backend>();
const client = createSyncClient();
type InferredDB = Parameters<typeof backend.functions.todos.list.handler>[0]["db"];
declare const inferredDB: InferredDB;
// @ts-expect-error table names are inferred from the database schema.
inferredDB.table("missing");

async function inferredCalls() {
  const todos = await client.query(api.todos.list);
  const filtered = await client.query(api.todos.list, { done: false });
  const id = await client.mutate(api.todos.add, { title: "Inferred" });
  await client.mutate(api.todos.toggle, { id });
  const live = client.live(api.todos.list, {});
  const current: Array<DocumentFor<typeof schema, "todos">> | undefined = live.data.value;
  const title: string = todos[0]!.title;
  const optionalNote: string | undefined = filtered[0]!.note;
  void current;
  void title;
  void optionalNote;

  // @ts-expect-error title is required and inferred from the validator.
  await client.mutate(api.todos.add, {});
  // @ts-expect-error the done filter is boolean.
  await client.query(api.todos.list, { done: "no" });
}

void inferredCalls;
