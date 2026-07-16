# Changelog

Clank follows semantic versioning. Entries describe user-visible framework, CLI, protocol, storage, security, and deployment changes.

## Unreleased

### Added

- Packaged-release conformance covering scaffold, browser and CLI auth, live synchronization, isolation, deployment, migration, failed health activation, rollback, and data restoration.
- GitHub CI and OIDC trusted-publishing release workflows.
- Security reporting, contribution, conduct, ownership, and release-governance documentation.
- Deterministic AI blueprints with plan, explain, and generated authenticated application files.
- Email verification, password recovery, email-code MFA, WebAuthn passkeys, organizations, RBAC, invitations, and project-scoped CLI tokens.
- Typed file, email, job, webhook, observability, encrypted backup, orchestration, ingress, custom-domain, external PostgreSQL, and database-provisioning drivers.
- ASVS-oriented evidence, threat modeling, chaos tests, CodeQL, immutable GitHub Actions, package/credential auditing, and a public-beta gate.

### Fixed

- Failed distributed-lease acquisition now releases the local project queue.
- Managed ingress strips `Connection`-nominated headers and retries safe requests after transient upstream 5xx responses.
- WebAuthn CBOR parsing now bounds collection size and nesting, and passkey counter advancement is atomic.
- The official package name is `clank.run`, avoiding collision with the unrelated npm package named `clank`; binaries remain `clank` and `clank-platform`.

## 0.7.0 - 2026-07-16

### Added

- AI-first runtime schemas, actions, semantic UI, forms, headless UI primitives, SSR, hydration, routing, SQLite backend, authentication, migrations, and the Clank deployment platform.
- Deterministic deployment artifacts, encrypted platform secrets, device authorization, health-gated activation, logs, audit history, and rollback.

### Changed

- Renamed the complete framework, CLI, storage, protocol, documentation, and deployment UI from Proact to Clank while preserving legacy data through compatibility readers and in-place migration.
