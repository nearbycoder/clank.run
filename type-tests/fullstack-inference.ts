import {
  createApi,
  createMcpAppDocument,
  createSyncClient,
  defineMcpApp,
  defineBackend,
  defineDatabase,
  defineJobs,
  defineTable,
  defineWorkflow,
  defineWorkflows,
  s,
  type DocumentFor,
  type JobRuntime,
} from "../dist/index.js";

const todoMcpApp = defineMcpApp({
  uri: "ui://todos/board",
  name: "todo_board",
  html: createMcpAppDocument({
    title: "Todos",
    body: "<main id=app></main>",
  }),
  permissions: { clipboardWrite: {} },
});

defineMcpApp({
  // @ts-expect-error MCP App resources require the ui:// scheme.
  uri: "https://example.com/todos",
  name: "invalid",
  html: "<!doctype html><html></html>",
});

const schema = defineDatabase({
  todos: defineTable({
    title: s.string(),
    done: s.boolean(),
    note: s.optional(s.string()),
  }).index("by_done", ["done"]),
  users: defineTable({ name: s.string() }),
});

const jobDefinitions = defineJobs({ schema }).jobs(({ job }) => ({
  prepare: job({
    args: { title: s.string() },
    returns: s.object({ normalized: s.string() }),
    handler: (_context, { title }) => ({ normalized: title.trim() }),
  }),
  finish: job({
    args: { title: s.string() },
    returns: s.object({ id: s.id("todos") }),
    handler: ({ db }, { title }) => ({
      id: db.transaction((write) => write.table("todos").insert({ title, done: false })),
    }),
  }),
}));

const createTodoWorkflow = defineWorkflow({
  args: { title: s.string() },
  returns: s.object({ id: s.id("todos") }),
  graph: ({ step }) => {
    const prepare = step(jobDefinitions.jobs.prepare, {
      args: ({ input }) => ({ title: input.title }),
    });
    const finish = step(jobDefinitions.jobs.finish, {
      needs: [prepare],
      args: ({ result }) => ({ title: result(prepare).normalized }),
    });
    return { prepare, finish };
  },
  output: ({ results }) => results.finish,
});

const background = defineWorkflows(jobDefinitions, { todos: { create: createTodoWorkflow } });
declare const jobRuntime: JobRuntime<typeof background>;
jobRuntime.startWorkflow(createTodoWorkflow, { title: "Typed workflow" });
// @ts-expect-error workflow input is inferred from its argument schema.
jobRuntime.startWorkflow(createTodoWorkflow, { value: "wrong" });

export const backend = defineBackend({ schema }).functions(({ query, mutation }) => ({
  todos: {
    list: query({
      args: { done: s.optional(s.boolean()) },
      agent: { app: todoMcpApp },
      handler: ({ db }, { done }) => done === undefined
        ? db.table("todos").collect()
        : db.table("todos").query().where("done", done).collect(),
    }),
    history: query({
      args: { id: s.id("todos") },
      agent: { app: { resource: todoMcpApp, visibility: ["app"] } },
      handler: ({ db }, { id }) => db.table("todos").history(id, { limit: 10 }),
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
    restore: mutation({
      args: {
        id: s.id("todos"),
        revision: s.number({ integer: true, min: 1 }),
        sequence: s.number({ integer: true, min: 0 }),
        version: s.nullable(s.number({ integer: true, min: 1 })),
      },
      handler: ({ db }, { id, revision, sequence, version }) =>
        db.table("todos").restore(id, { revision, sequence }, { ifVersion: version }),
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
  const history = await client.query(api.todos.history, { id });
  if (history[0]) {
    await client.mutate(api.todos.restore, {
      id,
      revision: history[0].cursor.revision,
      sequence: history[0].cursor.sequence,
      version: history[0].document._version,
    });
  }
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
