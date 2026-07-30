export const groups = [
  {
    id: "start",
    title: "Start with npm",
    description: "Install the package, create an app, choose its shape, and ship the first working version.",
    entries: [
      ["getting-started", "docs/getting-started.md"],
      ["application-recipes", "docs/application-recipes.md"],
      ["ai-first", "docs/ai-first.md"],
      ["public-beta", "docs/public-beta.md"]
    ]
  },
  {
    id: "framework",
    title: "Framework",
    description: "The reactive runtime, rendering model, routing, forms, UI behavior, and public APIs.",
    entries: [
      ["architecture", "docs/architecture.md"],
      ["reactivity", "docs/reactivity.md"],
      ["rendering", "docs/rendering.md"],
      ["routing", "docs/routing.md"],
      ["forms", "docs/forms.md"],
      ["ui", "docs/ui.md"],
      ["tailwind", "docs/tailwind.md"],
      ["performance", "docs/performance.md"],
      ["api-reference", "docs/api-reference.md"]
    ]
  },
  {
    id: "full-stack",
    title: "Full stack",
    description: "Server rendering, live SQLite data, authentication, migrations, services, and observability.",
    entries: [
      ["full-stack", "docs/full-stack.md"],
      ["database", "docs/database.md"],
      ["migrations", "docs/migrations.md"],
      ["auth", "docs/auth.md"],
      ["authentication", "docs/authentication.md"],
      ["server", "docs/server.md"],
      ["jobs-and-cron", "docs/jobs-and-cron.md"],
      ["services", "docs/services.md"],
      ["object-storage", "docs/object-storage.md"],
      ["observability", "docs/observability.md"],
      ["data-plane", "docs/data-plane.md"]
    ]
  },
  {
    id: "agents",
    title: "Agents and generation",
    description: "Deterministic blueprints, authenticated application actions, and contracts that make applications legible to agents.",
    entries: [
      ["per-app-mcp", "docs/per-app-mcp.md"],
      ["agent-protocol", "docs/agent-protocol.md"],
      ["blueprints", "docs/blueprints.md"]
    ]
  },
  {
    id: "deploy",
    title: "Deploy and operate",
    description: "The CLI, control plane, releases, custom domains, organizations, and production hosting.",
    entries: [
      ["cli", "docs/cli.md"],
      ["deployment-platform", "docs/deployment-platform.md"],
      ["preview-environments", "docs/preview-environments.md"],
      ["usage-and-limits", "docs/usage-and-limits.md"],
      ["platform-dashboard", "docs/platform-dashboard.md"],
      ["organizations", "docs/organizations.md"],
      ["distributed-deployment", "docs/distributed-deployment.md"],
      ["provider-adapters", "docs/provider-adapters.md"],
      ["railway", "docs/railway.md"],
      ["self-hosting", "docs/self-hosting.md"],
      ["releases", "docs/releases.md"]
    ]
  },
  {
    id: "security",
    title: "Security and resilience",
    description: "Threat boundaries, verification evidence, failure testing, recovery, and platform hardening.",
    entries: [
      ["security", "docs/security.md"],
      ["platform-security", "docs/platform-security.md"],
      ["threat-model", "docs/threat-model.md"],
      ["security-asvs", "docs/security-asvs.md"],
      ["code-audit", "docs/code-audit.md"],
      ["chaos-testing", "docs/chaos-testing.md"],
      ["conformance", "docs/conformance.md"],
      ["recovery", "docs/recovery.md"]
    ]
  },
  {
    id: "project",
    title: "Project",
    description: "Maintenance, compatibility, releases, contribution rules, and the open-source project record.",
    entries: [
      ["maintenance", "docs/maintenance.md"],
      ["renaming-from-proact", "docs/renaming-from-proact.md"],
      ["overview", "README.md"],
      ["changelog", "CHANGELOG.md"],
      ["contributing", "CONTRIBUTING.md"],
      ["security-policy", "SECURITY.md"],
      ["code-of-conduct", "CODE_OF_CONDUCT.md"]
    ]
  }
];
