export default {
  name: "Orbit Tasks",
  slug: "orbit-tasks",
  description: "A collaborative Todoist-style planner with live tasks, roles, reminders, and deploy requirements.",
  auth: {
    required: true,
    organizations: true,
    roles: {
      owner: {
        description: "Owns workspace settings and membership.",
        permissions: ["tasks.*", "members.*", "settings.*"],
      },
      member: {
        description: "Creates and completes workspace tasks.",
        permissions: ["tasks.read", "tasks.write"],
      },
    },
  },
  entities: {
    tasks: {
      description: "Actionable work belonging to a workspace.",
      ownership: "workspace",
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
        dueOn: {
          type: "date",
          required: false,
          nullable: true,
          default: null,
        },
      },
      indexes: {
        by_done: { fields: ["done"] },
        by_priority: { fields: ["priority"] },
      },
    },
  },
  relationships: [],
  routes: [
    {
      path: "/",
      view: "TaskInbox",
      entity: "tasks",
      access: { roles: ["owner", "member"] },
    },
  ],
  actions: {
    "tasks.create": {
      description: "Create a task in the active workspace.",
      entity: "tasks",
      operation: "create",
      roles: ["owner", "member"],
    },
    "tasks.complete": {
      description: "Complete or reopen a task.",
      entity: "tasks",
      operation: "update",
      roles: ["owner", "member"],
      realtime: true,
    },
    "tasks.delete": {
      description: "Permanently delete a task.",
      entity: "tasks",
      operation: "delete",
      roles: ["owner"],
      confirmation: "always",
    },
  },
  services: {
    reminders: {
      kind: "jobs",
      description: "Schedule durable task reminders.",
      required: true,
      capabilities: ["delayed", "retry"],
    },
    mail: {
      kind: "email",
      description: "Deliver invitations and reminder notifications.",
      required: true,
      capabilities: ["transactional"],
    },
  },
  deployment: {
    database: "sqlite",
    scale: "single",
    isolation: "container",
    healthPath: "/healthz",
    customDomains: true,
  },
} satisfies import("clank.run/blueprint").AppBlueprintInput;
