# Generated admin studio

Clank can derive a secure, server-rendered operations surface from an application blueprint. The
studio shows the selected entity schemas, the records visible to the signed-in account, and the
same typed create, update, and delete controls used by the product UI.

This is an application admin surface, not a database superuser. Opening it never bypasses a query,
mutation, role, ownership rule, validation schema, or optimistic concurrency check.

## Enable it

An app with an `owner` or `admin` role receives a studio automatically:

```ts
export default {
  auth: {
    roles: {
      owner: {
        description: "Application administrator.",
        permissions: ["tasks.*"],
      },
      member: {
        description: "Application member.",
        permissions: ["tasks.read", "tasks.write"],
      },
    },
  },
  // entities, routes, and actions...
} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;
```

The default URL is `/__clank/studio`. Only the inferred `owner` and `admin` roles can open it.
Set `admin: false` to omit the route and all generated studio code.

Use an explicit contract when the app uses a different privileged role, needs a smaller data
surface, or should be read-only:

```ts
export default {
  auth: {
    roles: {
      operator: {
        description: "Operates the application.",
        permissions: ["tasks.*", "projects.read"],
      },
      member: {
        description: "Uses the application.",
        permissions: ["tasks.read", "tasks.write"],
      },
    },
  },
  admin: {
    path: "/operations",
    roles: ["operator"],
    entities: ["projects", "tasks"],
    allowMutations: false,
  },
  // entities, routes, and actions...
} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;
```

`roles` must name existing application roles. It is required when neither `owner` nor `admin`
exists. `entities` must name existing entities and defaults to every entity. `allowMutations`
defaults to `true`.

The path is static. `/__clank/studio` is the only studio path allowed inside Clank's reserved
namespace; choose an ordinary application path for a custom URL.

## What is generated

The studio is generated into the application's normal `src/view.tsx`, `src/app.tsx`, and
`src/server.tsx` files. It provides:

- server-rendered schema, ownership, update-mode, record-count, and field information;
- browser hydration without replacing the server-rendered document;
- live updates for realtime entities and ordinary post-mutation refresh for other entities;
- responsive entity forms and lists built from the blueprint field contract;
- role-filtered links and controls; and
- a direct link to the app-local Agent access inbox.

There is no separate admin API. A generated control references the same typed backend function as
the corresponding product control. That function is also the action described by the app's MCP
manifest. Generated contract tests fail when a rendered control and that backend/MCP contract
drift apart.

## Authorization model

Authorization is enforced in layers:

1. The server checks the studio route role before loading data or rendering the page.
2. The hydrated UI repeats the role check before showing navigation or studio content.
3. Each query and mutation checks its own backend action role.
4. Owned tables constrain records to the authenticated owner.
5. Mutations validate inputs and expected document versions inside a transaction.

The backend is authoritative. For example, an `owner` allowed into the studio still cannot invoke
an action declared only for `member`. A user-owned entity count is the number visible to the
current user, not a global database total. This makes the studio safe by construction, but it also
means broader operational access must be modeled deliberately in the action and ownership
contracts. Clank does not manufacture a hidden bypass.

`allowMutations: false` removes mutation controls from the studio. It does not change actions used
elsewhere in the product or by an authorized MCP client. Restrict those separately with action
roles and agent grant scopes.

## Agent access

Every generated app retains its own OAuth-protected MCP endpoint. The studio's **Agent access**
link opens `/__clank/oauth/access`, where the signed-in user can inspect, reduce, or revoke their
application-bound agent grants. The studio itself does not issue tokens or expose secrets.

An agent changing a blueprint should treat `admin.roles`, `admin.entities`, backend action roles,
and ownership as one reviewable security boundary. Run `clank plan` to inspect the normalized
studio route and `npm test` to verify SSR, ownership isolation, and UI-to-MCP action parity before
deploying.

## Generated contract checks

The application-owned test suite:

- server-renders the studio using an allowed fixture role;
- proves the studio route is part of the deterministic plan;
- verifies every mutable studio control resolves to a current typed server action;
- compares those actions with the no-store backend/MCP manifest; and
- excludes read-only studio panels from required mutation-control coverage.

Use `npm test` for the generated application and `npm run deploy:check` before upload. Neither
command needs production data or credentials.
