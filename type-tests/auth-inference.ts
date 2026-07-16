import {
  createClient,
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  s,
} from "../dist/index.js";

const auth = defineAuth({
  profile: {
    displayName: s.string(),
  },
});

const schema = defineDatabase({
  todos: defineTable({
    title: s.string(),
    done: s.boolean(),
  }).owned(),
});

export const authenticatedBackend = defineBackend({ schema, auth }).functions(({
  query,
  mutation,
  publicQuery,
}) => ({
  todos: {
    list: query({
      args: {},
      handler: ({ db, user, auth: requestAuth }) => {
        const id: string = user.id;
        const displayName: string = requestAuth.requireUser().profile.displayName;
        const rows = db.table("todos").collect();
        const owner: string | undefined = rows[0]?._ownerId;
        void id;
        void displayName;
        void owner;
        return rows;
      },
    }),
    add: mutation({
      args: { title: s.string() },
      handler: ({ db, user }, { title }) => {
        const owner: string = user.id;
        void owner;
        return db.table("todos").insert({ title, done: false });
      },
    }),
  },
  session: publicQuery({
    args: {},
    handler: ({ user }) => user?.email ?? null,
  }),
}));

const client = createClient<typeof authenticatedBackend>({ loadAuth: false });
const profileName: string | undefined = client.auth.user.value?.profile.displayName;
void profileName;

const publicBackend = defineBackend({ schema }).functions(({ query }) => ({
  list: query({ args: {}, handler: ({ db }) => db.table("todos").collect() }),
}));

// @ts-expect-error createClient is intentionally auth-first; public backends use createSyncClient.
createClient<typeof publicBackend>();
