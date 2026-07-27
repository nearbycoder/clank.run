# Changelog

Clank follows semantic versioning. Entries describe user-visible framework, CLI, protocol, storage, security, and deployment changes.

## Unreleased

### Added

- The documentation now includes a practical per-app MCP guide covering automatic query and
  mutation tools, application-specific auth and data isolation, Codex connection, and contract
  freshness as UI actions change.
- Clank now ships a shared three-color brand mark with favicon, compact UI, and Apple touch
  variants. The deployment control plane and documentation site both publish and display the
  same generated identity.

### Fixed

- The protected-main documentation workflow now removes one oldest inactive artifact only when
  the docs project reaches its release limit, preserving uninterrupted automatic deployments
  without deleting the active release or bypassing immediate rollback protection.

## 0.9.3 - 2026-07-27

### Added

- MCP-visible backend contracts now receive deterministic revisions derived from server identity,
  tool names, schemas, descriptions, scopes, and annotations. Revisions are exposed through
  runtime manifests, discovery documents, Server Cards, response headers, list-result metadata,
  and deployment-sensitive `serverInfo.version` values.
- Bounded MCP Streamable HTTP sessions and authenticated SSE notification streams now support
  `notifications/tools/list_changed`. A new application process rejects a prior release's session
  so compliant clients automatically reinitialize and rediscover actions after rolling deploys.

### Changed

- `tools/list`, `resources/list`, and `resources/read` now publish `ttlMs: 0` and private cache
  scope, while public discovery requires revalidation. Unknown tool errors include a structured
  refresh hint instead of leaving clients with an unexplained stale call.
- Generated agent guides now require every UI operation that reads or persists server state to use
  the same typed backend query or mutation exposed through MCP, with manifest/tool parity included
  in the definition of done.

## 0.9.2 - 2026-07-27

### Fixed

- MCP OAuth consent pages now permit form navigation to the exact validated callback origin.
  This prevents Chromium from blocking the successful `303` loopback redirect after consuming
  the one-time consent proof, while retaining same-origin form restrictions everywhere else.

## 0.9.1 - 2026-07-27

### Added

- `docs.clank.run` now exposes a public, read-only MCP server with bounded list, search, and
  canonical Markdown retrieval tools plus stable Clank and MCP Server Card discovery.

### Fixed

- MCP OAuth consent no longer depends on extension or embedded-browser Origin behavior. Consent
  pages now receive a one-time, expiring proof bound to the authenticated session and exact OAuth
  request; approval consumes it atomically alongside the existing session CSRF check.
- Signed-out MCP OAuth now offers a same-origin password form that advances directly to consent,
  while retaining strict Origin checks, credential throttling, secure cookies, generic failures,
  and same-origin-only return paths.
- MCP authorization remains a direct, standards-based exchange between the application and the
  MCP client. Connecting an agent never requires the Clank deployment CLI, the Clank control
  plane, a callback relay, Tailscale, or copying an authorization response.

## 0.9.0 - 2026-07-26

### Added

- Automatic MCP Streamable HTTP tools for every Clank backend function, public server discovery,
  typed action resources, conservative side-effect annotations, and an OAuth authorization-code
  flow with PKCE, resource-bound access tokens, read/write scopes, rotating refresh tokens, and
  authenticated application-user isolation.
- Successful protected-main CI revisions now automatically build, validate, and deploy `docs.clank.run` through a dedicated GitHub environment and a least-privilege project token.
- Documentation code fences now use dependency-free, server-rendered syntax highlighting for TypeScript, TSX, JavaScript, shell, JSON, SQL, HTML, CSS, configuration, and Mermaid examples.
- Code-only application deployments now launch and health-check candidates on spare ports, atomically switch managed ingress, drain requests already assigned to the prior upstream, and stop the prior release only after the route change.
- Platform administrators can now attribute live container memory across the control plane, each hosted application process, V8 heap, file cache, kernel memory, swap, and per-process peaks from the responsive admin console.
- Platform administrators can now reconcile mounted-volume usage with the control database, isolated project databases, releases, migration snapshots, encrypted recovery backups, orphaned directories, and filesystem overhead without exposing paths or file contents.

### Fixed

- The deployment platform now reserves its own HTTP listener from the application port allocator
  and deterministically reassigns persisted project conflicts during startup.
- Deployment artifact collection now ignores the compiler's atomic temporary files, preventing a concurrent framework build from producing a transient file or `ENOENT` failure in an otherwise deterministic bundle.
- Deployment packaging now retries a complete, metadata-verified source snapshot when files or directory entries change during collection, preventing concurrent cleanup or replacement from producing partial artifacts.
- Railway startup recovers project runtimes concurrently without delaying the public listener, shutdown drains HTTP and platform resources together, and automatic crash recovery can no longer race a user deployment.
- Managed-ingress circuit breakers no longer carry an unhealthy prior upstream's open circuit into a newly activated release.

## 0.8.0 - 2026-07-26

### Added

- A dependency-free interactive launcher when `clank` runs in a terminal, with guided create, readiness, login, deploy, and help workflows plus authenticated and minimal full-stack templates.
- A secure managed-platform default for `clank login`, so normal hosted use connects to `https://clank.run` without a `--server` flag while self-hosted platforms retain an explicit override.
- The framework now publishes from the `@clank.run` npm organization as `@clank.run/framework`, with explicit public-registry, provenance, repository, documentation, and package-export metadata.
- A fully authenticated deployment dashboard with site status, 1-hour through 30-day ingress charts, releases, logs, and guided custom-domain setup.
- Transactionally enforced per-organization site and per-project custom-domain limits, with operator-configurable metric retention.
- Minute-level fixed-histogram ingress metrics plus DNS routing inspection and a Caddy On-Demand TLS permission endpoint for deployed built-in and verified custom hosts.
- Packaged-release conformance covering scaffold, browser and CLI auth, live synchronization, isolation, deployment, migration, failed health activation, rollback, and data restoration.
- GitHub CI and OIDC trusted-publishing release workflows.
- Security reporting, contribution, conduct, ownership, and release-governance documentation.
- Deterministic AI blueprints with plan, explain, and generated authenticated application files.
- Email verification, password recovery, email-code MFA, WebAuthn passkeys, organizations, RBAC, invitations, and project-scoped CLI tokens.
- Typed file, email, job, webhook, observability, encrypted backup, orchestration, ingress, custom-domain, external PostgreSQL, and database-provisioning drivers.
- ASVS-oriented evidence, threat modeling, chaos tests, CodeQL, immutable GitHub Actions, package/credential auditing, and a public-beta gate.
- Enforced line, branch, and function coverage floors plus a documentation audit that verifies local links, guide indexing, declaration synchronization, and package export targets.
- Storage-backed `/healthz` and `/readyz` probes alongside the process-only `/livez` endpoint.
- Bounded automatic custom-domain routing reconciliation with durable cross-control-plane leases, lookup deadlines, operator configuration, and dashboard status.
- Automatic verified encrypted database backups with durable cross-control-plane leases, configurable cadence and retention, private failure reporting, and dashboard controls.
- Enforced per-project release count/byte quotas plus rollback-scoped dashboard and CLI cleanup for inactive runtime artifacts and pre-deploy snapshots.
- Owner/admin-only permanent site deletion in the dashboard, API, and CLI with exact confirmation, explicit data-loss acknowledgement, scoped-token denial, path-safe storage removal, token revocation, and retained audit evidence.
- A role-filtered, cursor-paginated workspace activity feed in the dashboard, API, and CLI that retains deleted-site history and upgrades existing audit rows with organization attribution.
- Workspace people administration in the dashboard and CLI, including browser acceptance, member role changes, immediate removal, safe pending-invitation listing, one-time token copy, replacement, and revocation.
- Quota-aware workspace creation in the People console with safe slug preview and immediate selection.
- Durable SQLite-backed deployment-platform authentication and CLI device-start rate limits shared across control-plane runtimes and restarts.
- Command-aware human and JSON CLI help, agent-readable readiness diagnostics, generated `README.md`/`AGENTS.md` guides, and local-checkout scaffolding that does not require an npm release.
- Offline deterministic deployment dry-runs, structured deployment results with timing, one-command first-project naming/workspace selection, and retry-safe persisted idempotency attempts.

### Changed

- Authentication now defaults to an eight-character password minimum across framework and platform forms; applications can still require a higher value, and scrypt hashing, bounded concurrency, rate limits, and optional server-only peppering remain in place.
- The documentation site now begins with the published npm package and generated-app workflow, with hosted login examples consistently using the managed `clank.run` service.

### Fixed

- Deployment-console header controls now center their labels and icons consistently, while account quota totals retain readable spacing at narrow widths.
- Workspace invitations can now create their email-bound account and accept membership in one browser flow even when public registration is disabled or the one-time bootstrap is complete.
- First-account bootstrap is now protected by an expiring SQLite claim across control-plane runtimes, preventing concurrent processes from creating multiple initial accounts.
- Platform signup policy now evaluates the same normalized auth operation as the low-level router, closing repeated-slash registration bypasses.
- Sign-out and expired-session transitions now reload the deployment console at the identity boundary, clearing prior-account dashboard DOM and recomputing bootstrap availability before another account signs in.
- Successful password login now clears the exact failed-attempt rate-limit key instead of leaving the account throttled.
- CLI profile and project-link state is now bounded, structurally validated, URL-canonicalized, privately and atomically replaced, and never reflected in parse errors.
- CLI control-plane responses are streaming-bounded, decoded as strict UTF-8/JSON, and protected by finite request and deployment timeouts.
- Platform signal handling now closes both the HTTP listener and control-plane state, reports shutdown failures, and enforces a 30-second termination deadline.
- Project navigation now resets scroll position and closes the mobile drawer; the detail tab row stays within narrow viewports without a page-level horizontal scrollbar or clipped breadcrumb, and the console explicitly serves no favicon asset.
- The deployment console no longer renders or requests a logo asset or letter-mark treatment.
- Backup API responses no longer expose private host database paths.
- Repeated deployments can no longer grow retained release storage without an installation-defined ceiling.
- Site quotas can now be reclaimed without operator-side SQLite or filesystem edits.
- Managed ingress now fixes the upstream origin before applying a request path and streaming-bounds bodies without `Content-Length`, closing scheme-relative SSRF and unbounded-buffer paths.
- Pending custom-domain assignments can no longer be moved between projects; platform-owned DNS namespaces are reserved.
- Reissuing an invitation now revokes every older active token for that workspace/email, existing members cannot be reinvited, and active invitations are capped at 100 per workspace.
- Refreshed dashboard sessions now render one consistent authentication state and return to sign-in when a session expires.
- Failed distributed-lease acquisition now releases the local project queue.
- Managed ingress strips `Connection`-nominated headers and retries safe requests after transient upstream 5xx responses.
- WebAuthn CBOR parsing now bounds collection size and nesting, and passkey counter advancement is atomic.
- Blueprint suffix parsing and local-file endpoint normalization are linear on adversarial input.
- Unexpected deployment-platform failures are logged privately and never reflected to HTTP clients.
- Every HTTP/runtime adapter now keeps unexpected exception text private, and adversarial prefix, identifier, URL, and numeric-literal parsing is linear.
- CLI device login prints its browser approval URL without launching an operating-system command.
- The minimum runtime is Node 22.16, the first Node 22 release with the built-in SQLite backup API used by migrations and recovery.
- The official package name is `@clank.run/framework`, avoiding collision with unrelated unscoped packages while leaving the binaries as `clank` and `clank-platform`.
- Command-specific `--help` no longer authenticates or executes the command, dry-run deploys no longer require login, asynchronous CLI failures now reliably exit non-zero without stack traces, and unknown long options fail with spelling guidance instead of being ignored.
- Generated authenticated apps and bundled SSR examples now map the browser's actual `@clank.run/framework` module specifier, allowing their server-rendered screens to hydrate and become interactive.
- Hydration now cleans partially attached listeners, directives, keyed rows, and component ownership before fallback; only structural mismatches remount, lifecycle/application errors remain visible, and case-sensitive SVG plus `foreignObject` namespaces preserve their server nodes.
- Local deployment artifacts are now written through a private atomic replacement, preventing a pre-existing output symlink from redirecting CLI writes.

## 0.7.0 - 2026-07-16

### Added

- AI-first runtime schemas, actions, semantic UI, forms, headless UI primitives, SSR, hydration, routing, SQLite backend, authentication, migrations, and the Clank deployment platform.
- Deterministic deployment artifacts, encrypted platform secrets, device authorization, health-gated activation, logs, audit history, and rollback.

### Changed

- Renamed the complete framework, CLI, storage, protocol, documentation, and deployment UI from Proact to Clank while preserving legacy data through compatibility readers and in-place migration.
