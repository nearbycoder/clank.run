# AI application blueprints

An application blueprint is the reviewable contract between a human request, an AI planner, generated source, and deployment resources.

The default file is `clank.app.ts`. It must export one data literal:

```ts
export default {
  name: "Orbit Tasks",
  description: "A live, authenticated task planner.",
  auth: {
    required: true,
    organizations: true,
    roles: {
      owner: {
        description: "Workspace administrator.",
        permissions: ["tasks.*", "members.*"],
      },
      member: {
        description: "Workspace member.",
        permissions: ["tasks.read", "tasks.write"],
      },
    },
  },
  entities: {
    tasks: {
      description: "Actionable work.",
      ownership: "workspace",
      realtime: true,
      displayField: "title",
      completionField: "done",
      fields: {
        title: { type: "string", min: 1, max: 200 },
        done: { type: "boolean", default: false },
      },
    },
  },
  routes: [
    { path: "/", view: "TaskList", entity: "tasks" },
  ],
  services: {
    reminders: {
      kind: "jobs",
      description: "Schedule durable reminders.",
      required: true,
    },
  },
  deployment: {
    database: "sqlite",
    scale: "single",
    isolation: "container",
  },
} satisfies import("clank.run/blueprint").AppBlueprintInput;
```

## Commands

```sh
clank explain
clank plan
clank plan --output .clank/reviewed-plan.json
clank generate .
clank generate ./new-app --blueprint ./clank.app.ts
```

`explain` summarizes identity, data, routes, operations, services, and unresolved production requirements.

`plan` normalizes the contract and prints `clank-plan/1`, including every generated path, byte length, SHA-256 checksum, aggregate digest, and warning. Identical blueprints on the same Clank version produce identical plans.

`generate` writes the authenticated full-stack application plus `.clank/plan.json`. It refuses to replace a changed file unless `--force` is supplied. The source blueprint is preserved when generating into its own directory.

## Static safety

Clank does not import or execute `clank.app.ts`. A dedicated parser accepts an exported JSON-like literal with comments, trailing commas, and an optional `satisfies` or `as const` clause. Function calls, computed properties, template expressions, environment reads, imports with runtime behavior, and arbitrary statements are rejected.

This means an AI can prepare a TypeScript-assisted contract without gaining implicit local-code execution during review or generation. Generated application source is still code and must pass normal review, authorization, conformance, and deployment controls.

## Contract surface

A blueprint declares:

- entities, field constraints, ownership, indexes, display/completion semantics, and live behavior;
- relationships and deletion expectations;
- authentication, organizations, roles, and permissions;
- routes, views, access requirements, and user-visible actions;
- immutable SQL migrations;
- files, images, email, jobs, cron, search, and webhook service requirements; and
- database, scaling, isolation, health, region, custom-domain, and public environment requirements.

Generated applications currently include built-in authentication by construction. `auth.required` may be omitted or set to `true`; unauthenticated generation is rejected rather than silently producing a client/backend mismatch.

The generator creates a deterministic baseline, not domain truth. Payment, legal, medical, tax, retention, or other domain-specific behavior still needs explicit contracts and review.

See [`examples/blueprint-todo/clank.app.ts`](../examples/blueprint-todo/clank.app.ts) for a Todoist-style specification.
