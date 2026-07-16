# Application recipes for humans and agents

This guide is the shortest path from an application request to a readable Clank implementation.

## Choose the shape first

| Application need | Clank starting point |
| --- | --- |
| Static marketing or content | TSX, signals for small interactions, router only when multiple client routes add value |
| Rich client application | TSX, `createRouter`, forms, headless UI state, resources |
| CRUD product | `defineDatabase`, `defineBackend`, typed queries/mutations, live client |
| Private user application | `defineAuth`, owned tables, `createClient`, `AuthGate` |
| Agent-operable workflow | schemas, named actions, semantic native controls, explicit `agentAction` |
| Deployable product | `clank create`, migrations, health endpoint, `clank deploy` |

Do not add a backend to a page that has no server-owned state. Do not keep private or shared state only in browser signals.

## Contract-first build order

For AI-generated applications, this order minimizes rewrites:

1. Write the user journeys and data ownership rules.
2. Define schemas for persisted data, form input, and agent actions.
3. Define database tables and backend functions.
4. Build shared semantic views.
5. Add forms and interaction controllers.
6. Add Tailwind classes after the HTML structure works.
7. Add stable agent IDs to important actions.
8. Test validation, keyboard use, narrow screens, auth isolation, and live updates.
9. Add migrations and deployment configuration.

Runtime schemas are the shared truth. TypeScript inference and JSON Schema both flow from them.

## Forms

Prefer one `createForm` controller per independently validated user task.

Good:

```ts
const profile = createForm({ /* profile fields */ });
const password = createForm({ /* password fields */ });
```

Less readable:

```ts
const everySettingOnTheAccountPage = createForm({ /* unrelated sections */ });
```

Use native `label`, `input`, `select`, `textarea`, and `button` elements. Spread the field helper props, then add classes and application-specific attributes.

Remote uniqueness, authorization, inventory, pricing, and other server-owned checks belong in the submission handler or backend—not in client-only validation.

## Reusable interaction logic

- Expandable content: `createDisclosure`.
- Modal task: `createDialog`.
- Section switching: `createTabs`.
- Long tables or catalogs: `createPagination`.
- Async data: `resource`.
- Async side effect: `actionRunner` or a form submission.
- Stable list identity: `<For each={items} by="id">`.
- Route-level async data: router `load`.

Keep controllers beside the feature that owns them. A controller should have a specific ID such as `invite-member`, not `dialog-1`.

## Agent semantics

Agents already understand native controls when the HTML is accessible:

```tsx
<label for="email">Work email</label>
<input id="email" name="email" type="email" />
```

Add Clank metadata where native semantics cannot express the application capability:

```tsx
<button
  agentId="archive-project"
  agentAction="projects.archive"
  agentLabel="Archive current project"
  intent="destructive-control"
>
  Archive
</button>
```

Rules:

- IDs must be deterministic and unique in the mounted surface.
- Labels describe the action, not its color or position.
- `agentAction` should match a discoverable server action when one exists.
- Metadata never replaces authorization.
- Password, file, and secret values must not be exposed through labels or state.

## CRUD and live collaboration

Define the table:

```ts
const schema = defineDatabase({
  projects: defineTable({
    name: s.string({ min: 1, max: 120 }),
    status: s.enum(["active", "archived"]),
  }).owned(),
});
```

Define inferred functions:

```ts
const backend = defineBackend({ schema, auth }).functions(({ query, mutation }) => ({
  projects: {
    list: query({
      args: {},
      handler: ({ db }) => db.table("projects").collect(),
    }),
    create: mutation({
      args: { name: s.string({ min: 1, max: 120 }) },
      handler: ({ db }, { name }) =>
        db.table("projects").insert({ name, status: "active" }),
    }),
  },
}));
```

Use `client.live()` in the browser. The query cache reruns only when a committed change intersects its recorded dependencies, and every subscribed tab receives the new snapshot.

## Commerce

Typical composition:

- signals/computed values for local filters and cart preview;
- server-owned price and inventory validation at checkout;
- `createDialog` for the cart or quick view;
- `createForm` for address and payment-provider handoff;
- named actions for add/remove/checkout where agents should operate the store;
- owned order tables after authentication.

See `examples/commerce`.

## Dashboard

Typical composition:

- `createTabs` for major workspace sections;
- computed filtering plus `createPagination`;
- semantic native table markup;
- `createDialog` + `createForm` for create/edit flows;
- live queries for operational data;
- role checks in backend functions, not hidden buttons alone.

See `examples/dashboard`.

## Booking or wizard

Use one form per step when steps have independent validation. Keep selections such as a room or plan in a signal, then compute the summary and total.

The final backend mutation must recompute availability and price from server-owned data. Client totals are display state, not an authority.

See `examples/booking`.

## Readability checklist

- Feature names are domain names: `invite`, `checkout`, `selectedRoom`.
- Components represent meaningful regions, not arbitrary visual fragments.
- Event handlers are short and named when they contain business rules.
- Validation schemas sit beside the workflow that consumes them.
- Shared behavior uses a controller instead of repeated event-listener code.
- Tailwind classes do not hide missing semantic HTML.
- Comments explain security or lifecycle constraints, not obvious syntax.
- Examples compile under strict TypeScript.

## Verification checklist

For each generated application:

- run strict TypeScript;
- run unit tests for schemas and state transitions;
- exercise every form's invalid and successful paths;
- test keyboard dismissal/focus for dialogs;
- inspect the semantic agent tree;
- verify password/file values are absent;
- test desktop and narrow viewport layouts;
- check browser console and page errors;
- for full-stack apps, test two users and two simultaneous tabs;
- test deployment health failure and migration rollback before production.
