import {
  defineBackend,
  defineDatabase,
  defineJobs,
  defineTable,
  openBackend,
  s,
  type DocumentId,
} from "../dist/index.js";

const schema = defineDatabase({
  messages: defineTable({
    body: s.string(),
    delivered: s.boolean(),
  }).owned(),
});

const background = defineJobs({ schema }).jobs(({ job }) => ({
  messages: {
    deliver: job({
      args: {
        id: s.id("messages"),
        channel: s.enum(["email", "push"]),
      },
      queue: "delivery",
      handler: ({ db }, { id }) => db.transaction((write) =>
        write.table("messages").patch(id, { delivered: true })),
    }),
  },
}));

const backend = defineBackend({ schema, jobs: background }).functions(({ mutation }) => ({
  send: mutation({
    args: {
      body: s.string(),
      channel: s.enum(["email", "push"]),
    },
    handler: ({ db, jobs }, { body, channel }) => {
      const id = db.table("messages").insert({ body, delivered: false });
      jobs.enqueue(background.jobs.messages.deliver, { id, channel });

      // @ts-expect-error channel is inferred from the job validator.
      jobs.enqueue(background.jobs.messages.deliver, { id, channel: "sms" });
      return id;
    },
  }),
}));

async function inferredRuntime() {
  const runtime = await openBackend(backend, { path: "type-test.sqlite" });
  if (runtime.jobs) {
    const id = "message_runtime" as DocumentId<"messages">;
    runtime.jobs.enqueue(background.jobs.messages.deliver, { id, channel: "push" });
    runtime.jobs.list({ state: "dead", queue: "delivery" });
  }
}

void inferredRuntime;
