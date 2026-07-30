export default {
  name: "Delivery Workspace",
  slug: "delivery-workspace",
  description: "Projects with related live tasks, retained notes, release gates, and exact agent actions.",
  auth: {
    required: true,
    roles: {
      owner: {
        description: "Owns delivery settings and destructive actions.",
        permissions: ["projects.*", "tasks.*", "notes.*", "gates.*"],
      },
      member: {
        description: "Creates and updates delivery work.",
        permissions: ["projects.read", "projects.create", "tasks.*", "notes.*"],
      },
    },
  },
  entities: {
    projects: {
      description: "Top-level delivery projects.",
      ownership: "user",
      realtime: true,
      displayField: "name",
      fields: {
        name: {
          type: "string",
          description: "A short, recognizable project name.",
          min: 1,
          max: 100,
        },
      },
    },
    tasks: {
      description: "Live work that is deleted with its project.",
      ownership: "user",
      realtime: true,
      displayField: "title",
      completionField: "done",
      fields: {
        title: { type: "string", min: 1, max: 200 },
        done: { type: "boolean", default: false },
        priority: {
          type: "enum",
          values: ["low", "normal", "high"],
          default: "normal",
        },
        projectId: {
          type: "reference",
          entity: "projects",
          description: "The project that owns this work.",
        },
      },
      indexes: {
        by_project: { fields: ["projectId"] },
        by_done: { fields: ["done"] },
      },
    },
    notes: {
      description: "Request/response notes retained if their project is removed.",
      ownership: "user",
      realtime: false,
      displayField: "body",
      fields: {
        body: { type: "text", min: 1, max: 2000 },
        projectId: {
          type: "reference",
          entity: "projects",
          nullable: true,
        },
      },
      indexes: {
        by_project: { fields: ["projectId"] },
      },
    },
    gates: {
      description: "Release gates that explicitly restrict project deletion.",
      ownership: "user",
      realtime: true,
      displayField: "title",
      fields: {
        title: { type: "string", min: 1, max: 100 },
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
      reference: { entity: "tasks", field: "projectId" },
    },
    {
      name: "projectNotes",
      from: "projects",
      to: "notes",
      kind: "one-to-many",
      onDelete: "nullify",
      reference: { entity: "notes", field: "projectId" },
    },
    {
      name: "projectGates",
      from: "projects",
      to: "gates",
      kind: "one-to-many",
      onDelete: "restrict",
      reference: { entity: "gates", field: "projectId" },
    },
  ],
  routes: [
    {
      path: "/",
      view: "Projects",
      description: "Create and review delivery projects.",
      entity: "projects",
      access: { roles: ["owner", "member"] },
    },
    {
      path: "/tasks",
      view: "Tasks",
      description: "Manage live project tasks.",
      entity: "tasks",
      access: "authenticated",
    },
    {
      path: "/notes",
      view: "Notes",
      description: "Manage retained project notes.",
      entity: "notes",
      access: "authenticated",
    },
    {
      path: "/gates",
      view: "ReleaseGates",
      description: "Manage explicit release blockers.",
      entity: "gates",
      access: { roles: ["owner"] },
    },
    {
      path: "/about",
      view: "About",
      description: "This information-only route was generated directly from the blueprint.",
      access: "authenticated",
    },
  ],
  actions: {
    "projects.view": {
      description: "List projects visible to the signed-in person.",
      entity: "projects",
      operation: "read",
      roles: ["owner", "member"],
    },
    "projects.create": {
      description: "Create a project.",
      entity: "projects",
      operation: "create",
      roles: ["owner", "member"],
    },
    "projects.rename": {
      description: "Change project fields with optimistic concurrency.",
      entity: "projects",
      operation: "update",
      behavior: "update",
      roles: ["owner"],
    },
    "projects.delete": {
      description: "Delete a project after applying every relationship policy.",
      entity: "projects",
      operation: "delete",
      roles: ["owner"],
      confirmation: "always",
    },
    "tasks.view": {
      description: "List tasks visible to the signed-in person.",
      entity: "tasks",
      operation: "read",
    },
    "tasks.add": {
      description: "Create a task in a visible project.",
      entity: "tasks",
      operation: "create",
    },
    "tasks.complete": {
      description: "Complete or reopen a task.",
      entity: "tasks",
      operation: "update",
      behavior: "toggle",
      realtime: true,
    },
    "tasks.edit": {
      description: "Change task fields with optimistic concurrency.",
      entity: "tasks",
      operation: "update",
      behavior: "update",
    },
    "tasks.delete": {
      description: "Permanently delete a task.",
      entity: "tasks",
      operation: "delete",
      confirmation: "always",
    },
  },
  services: {
    notifications: {
      kind: "email",
      description: "Optional delivery notifications.",
      required: false,
      capabilities: ["send"],
    },
  },
  fixtures: {
    review: {
      description: "A project with related work for deterministic app contract tests.",
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
              title: "Ship the workspace",
              projectId: { ref: "projects.launch" },
            },
          },
        },
        notes: {
          context: {
            owner: "primary",
            values: {
              body: "Review the generated fixture contract.",
              projectId: { ref: "projects.launch" },
            },
          },
        },
        gates: {
          security: {
            owner: "primary",
            values: {
              title: "Security review",
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
    customDomains: true,
  },
} satisfies import("@clank.run/framework/blueprint").AppBlueprintInput;
