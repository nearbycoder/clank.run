# Authentication

Clank auth is built into the same zero-dependency SQLite, Fetch, SSR, and live-query layer as the rest of the framework. An authenticated application needs one auth definition, owned tables for private data, and the auth-first browser client.

## Minimal setup

```ts
import {
  defineAuth,
  defineBackend,
  defineDatabase,
  defineTable,
  s,
} from "clank";

export const auth = defineAuth();

export const schema = defineDatabase({
  todos: defineTable({
    title: s.string({ min: 1, max: 160 }),
    done: s.boolean(),
  }).owned(),
});

export const backend = defineBackend({ schema, auth })
  .functions(({ query, mutation }) => ({
    todos: {
      list: query({
        args: {},
        handler: ({ db }) => db.table("todos").collect(),
      }),
      add: mutation({
        args: { title: s.string({ min: 1, max: 160 }) },
        handler: ({ db }, { title }) =>
          db.table("todos").insert({ title, done: false }),
      }),
    },
  }));
```

When `auth` is present, `query` and `mutation` require a signed-in user by default. Their context includes non-null `user`, `auth`, and the correctly scoped `db`. Use `publicQuery` or `publicMutation` only when anonymous access is intentional.

An `.owned()` table automatically writes the current user ID on insert and adds that owner condition to every get, query, update, and delete. A user cannot address another user's row even if they learn its document ID.

## Browser client

```tsx
import { AuthGate, createClient, onCleanup } from "clank";
import type { backend } from "./backend.ts";

const client = createClient<typeof backend>();

function Todos() {
  const todos = client.live(client.api.todos.list);
  onCleanup(() => todos.dispose());

  return (
    <button onClick={() =>
      client.mutate(client.api.todos.add, { title: "Private task" })
    }>
      Add
    </button>
  );
}

function App() {
  return (
    <AuthGate auth={client.auth}>
      <Todos />
    </AuthGate>
  );
}
```

`createClient<typeof backend>()` creates all of the authenticated browser mechanics together:

- a zero-codegen typed `client.api` tree;
- reactive user, session, loading, and error state;
- registration, login, logout, logout-all, and password-change methods;
- CSRF headers on authenticated mutations;
- one-shot query and mutation calls;
- seeded live queries over EventSource.

It intentionally accepts the backend as a type argument rather than a runtime value. This prevents server configuration such as a password pepper from entering a browser module.

`AuthGate` renders a default accessible email/password screen for the default profile. Pass `signedOut` when an application has custom profile fields or wants a branded sign-in experience.

## Auth client API

```ts
client.auth.user.value;
client.auth.session.value;
client.auth.authenticated.value;
client.auth.loading.value;
client.auth.error.value;

await client.auth.register({
  email: "ada@example.com",
  password: "a long unique passphrase",
  profile: { name: "Ada" },
});
await client.auth.login({ email, password });
await client.auth.changePassword({ currentPassword, newPassword });
await client.auth.logout();
await client.auth.logoutAll();
await client.auth.reload();
```

The session credential is never exposed to JavaScript. The browser stores it only as an `HttpOnly` cookie. The CSRF token is held in memory and may be included in script-safe SSR boot state.

## SSR

Resolve the request before running private queries:

```tsx
const caller = await runtime.caller(request);
if (!caller.auth) throw new Error("Auth was not initialized.");

const bootAuth = authState(caller.auth);
const initial = caller.auth.user
  ? caller.query(api.todos.list)
  : { value: [], version: runtime.version };

const page = await renderDocument(view, {
  state: {
    auth: bootAuth,
    todos: initial.value,
    version: initial.version,
  },
  scripts: ["/app.js"],
  nonce,
});
```

In the browser:

```ts
const initial = readState<PageState>()!;
const client = createClient<typeof backend>({
  initialAuth: initial.auth,
});
client.seed(client.api.todos.list, {}, initial.todos, initial.version);
```

`authState()` selects only the serializable user, session metadata, and CSRF token. Never serialize cookies, password hashes, peppers, database handles, or raw request headers.

## Profiles and roles

The default profile is `{ name?: string }`. Define a custom runtime-validated profile when needed:

```ts
const auth = defineAuth({
  profile: {
    displayName: s.string({ min: 1, max: 80 }),
    timezone: s.string({ max: 80 }),
  },
  defaultRole: "member",
});
```

Inside a handler:

```ts
handler: ({ auth, user }) => {
  auth.requireRole("admin", "owner");
  return user.profile.displayName;
}
```

Trusted server code can call:

```ts
runtime.auth.setRole(userId, "admin");
runtime.auth.disableUser(userId);
runtime.auth.revokeUserSessions(userId);
```

Disabling a user deletes their sessions. Role changes and session revocations notify active live streams so stale connections close and reconnect through fresh authorization.

## Configuration

```ts
const auth = defineAuth({
  signup: true,
  defaultRole: "user",
  sessionDurationMs: 30 * 24 * 60 * 60 * 1000,
  idleTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
  cookie: {
    secure: "auto",
    sameSite: "Strict",
  },
  password: {
    minLength: 12,
    pepper: process.env.CLANK_AUTH_PEPPER,
  },
  rateLimit: {
    attempts: 10,
    windowMs: 10 * 60 * 1000,
  },
});
```

Defaults use scrypt with `N=2^17`, `r=8`, and `p=1`, a random 128-bit salt, a 64-byte derived key, constant-time comparison, and bounded concurrent hashing. A pepper is optional and must remain server-only. Changing or losing it invalidates existing password hashes unless the application implements an explicit migration.

Authentication attempts are rate-limited in process memory by normalized email and the trusted client IP supplied by Clank's Node adapter. A multi-instance deployment needs a shared upstream rate limiter as well.

## HTTP endpoints

With the default backend prefix:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/__clank/auth/session` | `GET` | Current safe auth state |
| `/__clank/auth/register` | `POST` | Create account and session |
| `/__clank/auth/login` | `POST` | Verify credentials and create session |
| `/__clank/auth/logout` | `POST` | Revoke the current session |
| `/__clank/auth/logout-all` | `POST` | Revoke every session for the user |
| `/__clank/auth/change-password` | `POST` | Verify current password, rotate hash, revoke sessions |

JSON content type and body limits are enforced. State-changing authenticated requests require the exact-origin check and `x-clank-csrf`. Responses are `no-store`.

## Security boundaries and current scope

Built-in auth provides email/password registration, login, sessions, CSRF protection, roles, owned data, and revocation. It does not yet provide email ownership verification, password-reset email, MFA/passkeys, OAuth/social login, organization membership, bot detection, or distributed rate limiting. Applications that require those controls must add them before treating an account as high assurance.

See [Security](security.md) for deployment requirements and [the authenticated Todo](../examples/auth-todo/backend.ts) for the complete working example.
