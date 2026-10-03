# AI application blueprints

An application blueprint is the reviewable contract between a request, an AI planner, generated
source, and deployment resources. It is deliberately data rather than executable configuration:
an agent can propose one, a person can inspect the complete contract, and Clank can generate the
same app from it every time.

For reusable third-party blueprints, [Signed blueprint registry](./blueprint-registry.md) adds
exact semantic versions, scoped Ed25519 publishers, monotonic static catalogs, explicit trust and
revocation, and an install path that still uses this same data-only normalizer and generator.

The default file is `clank.app.ts`. It must export one literal:

```ts
export default {
  name: "Orbit Tasks",
  description: "A live, authenticated task planner.",
  auth: {
    roles: {
      owner: {
        description: "Workspace administrator.",
        permissions: ["tasks.*", "projects.*"],
      },
      member: {
        description: "Workspace member.",
        permissions: ["tasks.read", "tasks.write"],
      },
    },
  },
  entities: {
    projects: {
      description: "Containers for related work.",
      ownership: "user",
      realtime: true,
      displayField: "name",
      fields: {
        name: { type: "string", min: 1, max: 100 },
      },
    },
    tasks: {
      description: "Actionable work.",
      ownership: "user",
      realtime: true,
      displayField: "title",
      completionField: "done",
      fields: {
        title: { type: "string", min: 1, max: 200 },
        done: { type: "boolean", default: false },
        projectId: { type: "reference", entity: "projects" },
      },
      indexes: {
        by_project: { fields: ["projectId"] },
      },
    },
  },
  relationships: [
    {
      name: "projectTasks",
      from: "projects",
      to: "tasks",
      kind: "one-to-many",
      onDelete: "cascade",
      // Optional here: tasks.projectId is the only matching reference.
      reference: { entity: "tasks", field: "projectId" },
    },
  ],
  routes: [
    {
      path: "/",
      view: "Projects",
      entity: "projects",
      access: { roles: ["owner", "member"] },
    },
    {
      path: "/tasks",
      view: "TaskList",
      entity: "tasks",
      access: "authenticated",
    },
  ],
  actions: {
    "tasks.view": {
      description: "List the signed-in person's tasks.",
      entity: "tasks",
      operation: "read",
      behavior: "list",
      roles: ["owner", "member"],
    },
    "tasks.add": {
      description: "Create a task.",
      entity: "tasks",
      operation: "create",
      roles: ["owner", "member"],
    },
    "tasks.complete": {
      description: "Complete or reopen a task.",
      entity: "tasks",
      operation: "update",
      behavior: "toggle",
      roles: ["owner", "member"],
    },
    "tasks.delete": {
      description: "Permanently delete a task.",
      entity: "tasks",
      operation: "delete",
      roles: ["owner"],
      confirmation: "always",
    },
  },
  admin: {
    roles: ["owner"],
    entities: ["projects", "tasks"],
    allowMutations: true,
  },
  services: {
    reminders: {
      kind: "jobs",
      description: "Schedule durable reminders.",
      required: true,
      capabilities: ["delayed", "retry"],
    },
  },
  buckets: {
    attachments: {
      description: "Private task attachments.",
      ownership: "user",
      visibility: "private",
      browserAccess: "authenticated",
      allowedContentTypes: ["image/*", "application/pdf"],
      maxObjectBytes: 25 * 1024 * 1024,
      perOwnerMaxBytes: 100 * 1024 * 1024,
      resumable: true,
    },
  },
  fixtures: {
    review: {
      description: "A stable state for app and agent contract tests.",
      users: {
        primary: {
          email: "owner@example.invalid",
          role: "owner",
          profile: { name: "Fixture Owner" },
        },
      },
      records: {
        projects: {
          launch: {
            owner: "primary",
            values: { name: "Launch" },
          },
        },
        tasks: {
          ship: {
            owner: "primary",
            values: {
              title: "Ship the application",
              projectId: { ref: "projects.launch" },
            },
          },
        },
      },
    },
  },
  deployment: {
    database: "sqlite",
    scale: "single",
    isolation: "container",
    healthPath: "/healthz",
  },
} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;
```

See [`examples/blueprint-todo/clank.app.ts`](../examples/blueprint-todo/clank.app.ts) for a
smaller Todoist-style specification, or
[`examples/blueprint-workspace/clank.app.ts`](../examples/blueprint-workspace/clank.app.ts) for a
multi-route contract with cascade, nullify, restrict, live/request-response data, exact actions,
and references.

## Plan, explain, and generate

```sh
clank explain
clank plan
clank plan --output .clank/reviewed-plan.json
clank generate .
clank generate ./new-app --blueprint ./clank.app.ts
clank generate ./new-app --blueprint ./clank.app.ts --framework=local
```

`explain` summarizes identity, data, routes, actions, operations, services, and unresolved
production requirements.

`plan` normalizes the contract and prints `clank-plan/1`, including every generated path, byte
length, SHA-256 checksum, aggregate digest, and warning. Identical blueprints on the same Clank
version produce identical plans.

`generate` writes an authenticated full-stack application, human and agent operating guides, and
`.clank/plan.json`. It saves the exact generated source in owner-readable
`.clank/generated-baseline.json`. Subsequent runs compare that baseline, your current files, and
the proposed source. Independent edits merge; overlapping edits stop the entire write before any
application file changes. `--force` explicitly replaces source changes, but applied SQL migration
files remain immutable. The source blueprint is preserved when generating into its own directory. `--framework=local` points the app
at the current Clank checkout without requiring a registry release.

Then use the ordinary app loop:

```sh
cd new-app
npm install
npm run dev
```

`clank dev` builds, starts, watches, health-swaps, and reloads the app. `npm run deploy:check`
certifies the artifact without uploading it; `npm run deploy` creates or links the remote project,
runs migrations, verifies health, and activates the release.

Run the generated application contract independently:

```sh
npm test
npm run test:watch
```

## What generation executes

Generation is no longer a single-table mock-up. The baseline includes:

- every declared static route, plus typed record detail routes with a final named parameter;
- authenticated application navigation and explicit read-only public pages with server-side
  route-role checks;
- an optional generated admin studio with schema summaries and backend-authorized data controls;
- every entity, field constraint, index, ownership scope, field-aware create form, list, and safe
  delete/toggle controls;
- exact declared action names, descriptions, roles, confirmation hints, browser bindings, and MCP
  tool metadata;
- workspace creation, switching, owner-managed membership, and scoped records, references, history,
  and restores;
- relationship-aware transactional deletion with bounded `restrict`, `nullify`, and `cascade`
  behavior, one-to-one uniqueness, and many-to-many join entities;
- live subscriptions for `realtime: true` entities and mutation-triggered request/response refresh
  for `realtime: false` entities;
- service requirement validation, local development drivers, health checks, and a fail-closed
  production provisioning boundary;
- deterministic synthetic fixtures plus application-owned backend, ownership, manifest, and SSR
  tests using Node's built-in test runner; and
- built-in auth, SQLite, migrations, Tailwind compilation, CSP, observability, graceful shutdown,
  and the per-app OAuth/MCP server.

Generated forms support strings, long text, numbers, booleans, email, URL, date, date-time, enum,
nullable/optional/defaulted values, and entity references. Reference selects use the target
entity's display field.

The generated files remain normal TypeScript. Regeneration is an architectural starting point,
not a reason to overwrite deliberate application code.

## Fixtures and generated tests

Every blueprint produces at least one `clank-fixture/1` document under `fixtures/` and one
application-owned `tests/app.contract.mjs`. If `fixtures` is omitted, Clank derives a bounded
`default` fixture from the entity fields, defaults, roles, and references. Generated values are
stable across machines and repeated plans.

Declare named fixtures when the product state matters:

```ts
fixtures: {
  empty: {
    users: {
      primary: {
        email: "member@example.invalid",
        role: "member",
        profile: { name: "Fixture Member" },
      },
    },
    records: {},
  },
  review: {
    description: "Related project and task records.",
    users: {
      primary: {
        email: "owner@example.invalid",
        role: "owner",
        profile: { name: "Fixture Owner" },
      },
    },
    records: {
      projects: {
        launch: {
          owner: "primary",
          values: { name: "Launch" },
        },
      },
      tasks: {
        ship: {
          owner: "primary",
          values: {
            title: "Ship",
            projectId: { ref: "projects.launch" },
          },
        },
      },
    },
  },
},
```

Users and records have stable aliases. A reference uses `{ ref: "entity.record" }`; the test loader
creates referenced records first and replaces the alias with the real runtime ID. Required
references must therefore be acyclic. Private referenced records must use the same fixture owner,
matching the generated database's authorization boundary.

Normalization rejects unknown users, roles, entities, fields, records, invalid scalar values,
invalid enum/date/email/URL values, cross-owner private references, cyclic record references,
duplicate generated fixture paths, more than 20 fixtures, more than 10 users per fixture, or more
than 100 records per fixture. Profiles currently support the generated auth profile's optional
`name` field.

The generated suite:

- compares agent-enabled `GET /__clank/manifest` paths with every generated backend function;
- registers fixture users and calls the app's real create/list actions against an isolated
  in-memory database;
- resolves references, then verifies every supplied field value;
- proves private records are invisible to a separately registered account while public data
  remains visible;
- server-renders every declared route with its allowed role; and
- checks typed `agentAction` controls against the current backend manifest and contract revision,
  including stable IDs, descriptions, internal-action exclusion, and required UI coverage.

Fixtures are not migrations, seed scripts, passwords, or production snapshots. The deployment
allowlist contains only `dist/` and `migrations/`, so `fixtures/` and `tests/` remain local and in
source control. Keep identities under `.example.invalid`, use synthetic values, and never paste
customer or production data into a fixture.

## Entities and ownership

Each entity requires `description`, `displayField`, and at least one field. `completionField` must
name a boolean field. Entity and field names are TypeScript identifiers; entities that would
collapse to the same generated type name, such as `task` and `tasks`, are rejected.

Field types are:

```text
string · text · number · boolean · email · url · date · datetime · enum · reference
```

Use `required: false` for an omitted value, `nullable: true` for an explicit `null`, and `default`
when the backend should fill a missing input. `min` and `max` constrain string length or numeric
value. Number fields may set `integer: true`; enum fields require `values`; reference fields
require `entity`.

Ownership is `public`, `user`, or `workspace`. The generated database enforces user ownership
directly. Workspace-owned tables receive a server-managed `workspaceId` field. Every generated
handler resolves the signed-in user's selected workspace and current membership inside the same
read or write transaction, then scopes queries, record lookups, mutations, references, history,
and restores. Input schemas never accept a caller-supplied workspace ID for entity writes.

Each account starts in a private personal workspace. The generated workspace control can create
and select shared workspaces. Its owner can add or remove members using their registered user
IDs, shown in the same control. Membership does not confer the global application roles required
by an action. Removing a member immediately invalidates tracked queries and returns their next
operation to their personal workspace. Shared records do not become personal records.

The internal `workspaces` action group and `clankWorkspaces`, `clankMemberships`, and
`clankWorkspaceSelection` tables are reserved. Membership management actions are authenticated
and excluded from MCP; entity CRUD remains available through the normal authorized MCP surface.
The generated handlers are the authorization boundary: trusted server code must use their scoped
view rather than directly exposing the underlying workspace tables. Workspace history only
returns permitted snapshots; a bounded history page can contain fewer results after filtering.

## Routes and roles

Blueprint version 1 accepts static paths such as `/`, `/tasks`, and `/settings/profile`, plus a
single final named parameter such as `/tasks/:id`. A detail route must declare an `entity`.
Generation adds a typed `<entity>.detail` query whose ID schema and ownership checks come from
that entity. The detail page returns 401 for a signed-out visitor, 403 for a disallowed route
role, and 404 for an absent, malformed, or inaccessible record. Detail pages are read-only server
renders; generated record cards link to them. Queries, hashes, trailing slashes, and multiple or
non-final parameters remain invalid.

Route access is:

- `"authenticated"` for any signed-in user;
- `{ roles: ["owner", "member"] }` for a non-empty role allowlist; or
- `"public"` for a read-only page that can be rendered without signing in.

A public entity route requires `ownership: "public"`; it never silently widens a private entity.
It exposes the entity's declared fields through an anonymous `<entity>.publicList` query and,
when a detail route exists, a typed detail query. Publish only fields intended for all visitors.
Public informational routes may omit `entity`. These pages contain no mutation controls, private
hydration payloads, or application scripts. Mutations still require authentication. The names
`detail` and `publicList` are reserved when the corresponding generated loader exists.

The server rejects a signed-in user who lacks a route role before it queries route data. Navigation
and action controls hide unavailable choices as a usability feature, but the backend action
repeats the authorization check. Never treat a hidden button as authorization.

The `permissions` strings on role declarations document domain intent for humans and agents.
Generated enforcement comes from each route and action's explicit `roles` allowlist.

## Admin studio

When the role contract contains `owner` or `admin`, generation includes a responsive operations
surface at `/__clank/studio`. Configure it with `admin: { path, roles, entities,
allowMutations }`, or set `admin: false` to omit it. Apps without one of the conventional
privileged roles must declare a non-empty `admin.roles` list to opt in.

The studio reports schema and current-user-visible record information, then reuses the same typed
actions as the product UI and per-app MCP server. Its server route enforces the studio role before
loading data. Backend action roles and record ownership are still authoritative, so studio access
does not imply global database access. `allowMutations: false` hides studio mutation controls
without changing those actions elsewhere.

For every studio entity, generation also adds `<entity>.history` and `<entity>.restore` actions.
The responsive timeline is server rendered and refreshed after mutations. History queries inherit
owned-table isolation; restores validate the retained snapshot and create a new optimistic version.
They never rewind the live database cursor or erase intervening history. These actions are emitted
from the same backend function tree as browser RPC and MCP, so contract-revision and UI-parity
checks cover them automatically.

See [Generated admin studio](admin-studio.md) for the complete configuration, authorization model,
and generated verification contract.

## Actions and MCP

An entity action name has exactly two segments: `<entity>.<action>`. The local action segment is
preserved, so `tasks.complete` becomes the browser RPC action and the MCP tool named
`tasks_complete`; it is not semantically renamed to `tasks.toggle`. MCP metadata retains the
original `tasks.complete` action path.

Safe generated behaviors are:

| Operation | Behavior | Generated input |
| --- | --- | --- |
| `read` | `list` | no arguments; returns all visible records |
| `create` | `create` | the entity's validated fields |
| `update` | `update` | `id`, `version`, and a non-empty sparse `changes` object |
| `update` | `toggle` | `id`, `version`, and boolean `value` for `completionField` |
| `delete` | `delete` | `id` and optimistic-concurrency `version` |

Ordinary behavior is inferred from `operation`; update names ending in `complete`, `done`,
`reopen`, or `toggle` infer `toggle`. Set `behavior` explicitly whenever intent could be
ambiguous.

`operation: "custom"` is a deliberate source-code extension point. It receives a plan warning and
is not exposed over HTTP or MCP until application code supplies an argument schema, handler, and
agent metadata. Clank does not generate a convincing but incorrect money transfer, invitation,
payment, or other domain action from a sentence.

If an entity omits list/create/delete (and toggle when it has a completion field), the baseline
adds safely named actions so its generated UI remains usable. Declared behavior wins: declaring
`projects.view` prevents an extra `projects.list`.

Action roles are enforced with `auth.requireRole()` in the function handler, including MCP calls.
Deletes receive destructive metadata; list and toggle behavior receive idempotency metadata.
`GET /__clank/manifest` and authenticated MCP `tools/list` derive from that same function tree and
contract revision, so clients can detect action changes instead of retaining stale schemas.

## Relationships and deletion

`reference` identifies the field that stores an edge. It may be omitted when exactly one endpoint
has exactly one reference to the other endpoint. Ambiguous or missing references produce a plan
error before files are written; set `reference` explicitly to resolve that. A declared deletion
policy is never silently dropped.

On parent deletion:

- `restrict` returns public `409 RELATIONSHIP_RESTRICTED` while any visible child exists;
- `nullify` sets the nullable child reference to `null`; and
- `cascade` recursively deletes children.

All work happens in one SQLite transaction. A later restriction rolls back earlier cascade or
nullify work. Cascade cycles are rejected, cross-ownership deletion is rejected, `nullify` requires
a nullable field, optimistic record versions are preserved, and one deletion is capped at 1,000
related operations.

Generated create and sparse-update actions also resolve every non-null reference through the
caller's scoped database view. A missing, deleted, or other-owner target returns
`404 REFERENCE_NOT_FOUND`, preventing dangling and cross-owner edges even if somebody bypasses the
generated form and calls browser RPC or MCP directly.

`one-to-one` checks uniqueness of its non-null reference inside the same transaction as create,
sparse update, and historical restore. Duplicate writes fail with `409 RELATIONSHIP_CARDINALITY`.
Uniqueness follows the entity's user or workspace scope; public entities enforce it globally.

`many-to-many` creates `<relationshipName>Links` (or the explicitly named `join` entity), with
`fromId` and `toId` references and a defaulted `label` field. The endpoint pair is unique within
its scope. Both endpoints must share ownership. Deleting either endpoint applies `restrict` or
`cascade` to its join rows; it never deletes the opposite endpoint. `nullify` is not supported for
join edges. Generated join entities have ordinary typed CRUD, forms when routed, reference
validation, deterministic fixtures, and MCP actions. Existing explicit join entities must use
required non-null references to the declared endpoints.

## Services

Services describe files, images, email, jobs, cron, search, webhooks, or custom capabilities.
Generation writes:

- `src/service-requirements.ts`, the normalized name/kind/capability contract; and
- `src/services.ts`, the explicit driver composition point.

Under `clank dev`, generated development drivers satisfy the declared shape and report healthy.
They are intentionally marked as development placeholders and do not claim to send email or run
real external work. In production, no placeholder is installed. Missing required services stop
startup before the app accepts traffic; optional services may remain absent. Replace or extend
`openAppServices()` with real drivers and secret-backed configuration before deploying a required
integration. See [Services](services.md).

## Managed buckets

`buckets` is the first-class file and image contract, not a placeholder service. Generation writes
`src/buckets.ts`, supplies zero-setup local storage during development, connects the manager to
auth and MCP, and consumes the deployment platform's isolated root, signing key, namespace, and
administrator quota. Bucket policy validates ownership, public/private delivery, media types,
sizes, counts, cache behavior, resumable chunks, image dimensions, and declared variants before
the app starts. See [Managed buckets](buckets.md).

## Relationship to generated source

The important files are:

| File | Responsibility |
| --- | --- |
| `src/backend.ts` | schemas, exact actions, role guards, MCP metadata, and relationship deletion |
| `src/view.tsx` | accessible multi-entity UI, field forms, route navigation, typed stable backend action controls |
| `src/app.tsx` | hydration, auth, live/request-response data, and typed mutations |
| `src/server.tsx` | route SSR, role checks, CSP, health, services, static files, and API/MCP routing |
| `src/service-requirements.ts` | normalized external service contract |
| `src/services.ts` | local drivers and production service boundary |
| `src/buckets.ts` | managed object definitions plus local/S3 provider composition |
| `fixtures/*.json` | deterministic, synthetic, non-production app states |
| `tests/app.contract.mjs` | application-owned UI↔MCP parity, manifest, backend, isolation, fixture, and SSR checks |
| `migrations/` | immutable SQL history plus the canonical blueprint metadata |
| `AGENTS.md` | commands, file map, invariants, and definition of done for coding agents |

Every application still receives its own database and MCP server when deployed. The UI and MCP
surface share one backend definition, so a mutation added to that definition updates browser RPC,
the public manifest revision, OAuth-scoped MCP tools, and live invalidation together.

## Static safety

Clank does not import or execute `clank.app.ts`. A dedicated parser accepts an exported JSON-like
literal with comments, trailing commas, and an optional `satisfies` or `as const` clause. Function
calls, computed properties, template expressions, environment reads, runtime imports, and
arbitrary statements are rejected.

Relationship and fixture references, fixture ownership and values, role names, action/entity
alignment, behavior/operation compatibility, route collisions, cascade cycles, required-reference
creation cycles, service capabilities, migrations, deployment environment names, and generated
type collisions are validated before any files are written.

This means an AI can prepare a TypeScript-assisted contract without gaining implicit local-code
execution during review or generation. Generated source is still code and must pass ordinary
review, authorization, conformance, and deployment controls.

## Honest boundaries

The generator creates a deterministic full-stack baseline, not domain truth. Custom business
rules, payments, legal or medical decisions, public-field selection, production service
credentials, PostgreSQL drivers, and horizontal state coordination
need explicit implementation and review.

Read every `clank plan` warning. A warning is an unresolved boundary, not decorative output.

## Upgrade and rollback

Source regeneration does not migrate a live database. Back up the database and test its restore
before deploying changed ownership or relationship contracts. Existing generated user-owned
entities remain compatible. Earlier workspace blueprints used user ownership; upgrading those
requires a new numbered migration that fills each existing row's JSON `workspaceId` from its
`_owner_id`, and does the same for retained `clank_document_revisions.snapshot_data` using that
revision's `owner_id`. Preserve those original owner IDs. Review all affected tables and fail the
migration on rows without an owner. A database with missing required workspace IDs fails schema
validation at startup; it is not opened with an unscoped fallback.

Remove duplicate one-to-one references before enabling their new guards, and migrate old
many-to-many representations into the explicit join entity. Existing SQL migration files are
preserved during regeneration; add a new migration ID for each data change.

Before shared-workspace writes, rollback can restore the backed-up database and previous source.
After shared writes, reverting to the old user-owned schema is unsafe because shared records have
no single user owner. Use a reviewed reverse migration or restore the backup with the explicit
loss of subsequent writes. Keep `.clank/generated-baseline.json` with local development state;
older projects without a baseline conservatively report conflicts for changed destinations.
Restore the exact original generator output as the baseline from a known clean revision before
merging older hand-edited projects; do not adopt current hand edits as generated source.
