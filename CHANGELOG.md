# Changelog

Clank follows semantic versioning. Entries describe user-visible framework, CLI, protocol, storage, security, and deployment changes.

## Unreleased

### Added

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

### Fixed

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
- The official package name is `clank.run`, avoiding collision with the unrelated npm package named `clank`; binaries remain `clank` and `clank-platform`.

## 0.7.0 - 2026-07-16

### Added

- AI-first runtime schemas, actions, semantic UI, forms, headless UI primitives, SSR, hydration, routing, SQLite backend, authentication, migrations, and the Clank deployment platform.
- Deterministic deployment artifacts, encrypted platform secrets, device authorization, health-gated activation, logs, audit history, and rollback.

### Changed

- Renamed the complete framework, CLI, storage, protocol, documentation, and deployment UI from Proact to Clank while preserving legacy data through compatibility readers and in-place migration.
