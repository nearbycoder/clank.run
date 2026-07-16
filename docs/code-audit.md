# Code and product audit

Audit date: 2026-07-16

This document records what was inspected, what changed, and what remains intentionally out of scope. It is evidence for maintainers, not a claim that any framework can make every application correct automatically.

## Scope

The audit covered:

- reactive ownership, computed invalidation, DOM updates, SSR, and hydration;
- TSX public typing and event/control ergonomics;
- runtime schemas and agent contracts;
- form state, validation, submission, focus, and cancellation;
- accessible disclosure, dialog, tabs, pagination, and directives;
- semantic agent inspection and operation;
- auth, passkeys, organization RBAC, data ownership, requests, files, deployment artifacts, migrations, secrets, ingress, backup, and release supervision;
- examples, strict types, package contents, documentation, desktop rendering, and narrow viewports.

## Findings resolved

| Finding | Resolution | Evidence |
| --- | --- | --- |
| A computed first read through `peek()` did not retain its own dependencies | `Computed.peek()` now suppresses only the caller subscription while evaluating with its own observer | Core regression test |
| Boolean ARIA `false` was removed | DOM and SSR now serialize explicit `"true"`/`"false"` states | DOM and SSR tests |
| Forms required repeated ad hoc signal/error code | Added schema-aware headless forms with cancellation, focus, server errors, reset, manifests, and typed controls | Form tests and three site variants |
| Agent inspection relied heavily on custom labels | Native IDs, labels, roles, required/readonly/invalid/checked/multiple state, and placeholders are understood | Agent-surface tests |
| Semantic inspection could expose password input values | Password and file values are omitted; file input automation is refused | Agent-surface tests |
| Reusable interactive controls were application-specific | Added disclosure, modal dialog, tabs, pagination, outside-click, and autofocus primitives | UI tests and site variants |
| Common web schemas were verbose | Added email, URL, date, date-time, record, defaults, refinement, and numeric/boolean coercion | Schema tests |
| JSX intrinsic elements were effectively `any` | Added native element/property/event typing, reactive attributes, bind/ref/directive types, ARIA/data attributes, and custom-element support | Strict type tests |
| Existing examples covered mostly todos | Added commerce, SaaS dashboard, and multi-step booking applications | Browser verification |
| Concurrent build/watch output could briefly disappear | Framework and public compiler builds now replace files atomically and remove only stale outputs | Concurrent-build regression tests |
| Documented clean example URLs returned 404 | The development server now resolves trailing-slash directories to `index.html` | Browser and HTTP verification |
| Generated apps did not declare their runtime for local development and editor types | Scaffolds now depend only on their matching Clank release and include build, dev, start, and deploy scripts | Package-consumer scaffold verification |
| A refreshed authenticated deployment page still displayed the `Sign in` heading | The server-rendered and client-rendered auth card now derive their heading from the same session state | Platform regression test and browser refresh verification |
| The Proact name remained embedded across package, CLI, storage, protocol, and UI surfaces | Renamed the product to Clank with in-place data migration and narrowly scoped legacy readers | Rename compatibility tests and migrated production-state copy |
| Authentication lacked production recovery and phishing-resistant credentials | Added email verification, generic single-use recovery, bounded MFA, WebAuthn passkeys, and atomic counter advancement | Auth and synthetic WebAuthn tests |
| Project authority was account-wide | Added organizations, invitations, four roles, scoped tokens, permission intersection, and removal-time revocation | Platform RBAC and isolation tests |
| Deploy coordination was local-only | Added durable authenticated leases, fences, nodes, desired generations, idempotent operations, retry, and stale-worker rejection | Orchestration and chaos tests |
| Backups were release-local snapshots only | Added encrypted authenticated backup repositories, retention, verification, restore confirmation, safety copies, API, and CLI | Recovery, platform, conformance, and chaos tests |
| The platform lacked a managed host/data-plane layer | Added exact-host ingress, DNS ownership challenges, external PostgreSQL transactions/migrations, and database provisioning contracts | Data-plane and platform tests |
| Release security evidence was manual | Added ASVS-oriented mapping, threat model, package/secret audit, immutable CI actions, CodeQL, chaos tests, and beta gate | `npm run check` and GitHub workflows |

## Readability decisions

- New behavior is split into focused `forms.ts` and `ui.ts` modules.
- Public controllers are headless and return ordinary props.
- Runtime schemas remain the source for TypeScript and agent contracts.
- IDs are deterministic for SSR, hydration, accessibility, and agent operation.
- Unsafe or unknown form keys throw rather than fail silently.
- Examples use domain-specific names and semantic native HTML.

Large existing modules such as `backend.ts`, `auth.ts`, and `platform.ts` remain cohesive but substantial. Splitting them without changing their public boundaries is future maintainability work; a mechanical split was not treated as inherently safer than tested cohesive code.

## Security posture

The existing security boundaries remain:

- bounded request and artifact intake;
- executable URL and inline-handler rejection;
- safe SSR escaping and serialized state;
- scrypt password hashing, CSRF, secure cookies, rate limits, roles, and revocation;
- owned SQLite rows and auth-partitioned live queries;
- traversal/symlink defenses;
- encrypted deployment secrets;
- immutable migration history, backup, health-gated activation, and rollback.

The audit added semantic password/file redaction and stricter form-key handling. Client forms and hidden UI are never authorization boundaries.

The 0.7.0 rename also preserves existing accounts, sessions, application rows, migration history, projects, releases, secrets, logs, and audit records. Clank writes only the new names after migration. See [Renaming from Proact](renaming-from-proact.md).

## Application coverage

The current examples prove different mechanics:

- `hello`: reactive primitives and agent actions.
- `todo`: keyed client CRUD.
- `fullstack`: SSR, SQLite, RPC, and live synchronization.
- `auth-todo`: sessions, user-owned data, SSR, and multi-tab live updates.
- `commerce`: search/filter/sort, cart state, modal checkout, validation, and async confirmation.
- `dashboard`: tabs, metrics, responsive navigation, tables, filtering, pagination, invite dialog, and settings.
- `booking`: multi-step composition, cross-field dates, room selection, computed pricing, guest validation, and confirmation.

These examples demonstrate framework breadth. They do not replace domain-specific payment, tax, inventory, medical, legal, or regulatory integrations.

## Known limits

- Form paths are intentionally top-level. Compose controllers for nested editors and independent wizard steps.
- No built-in file-upload storage or image pipeline exists.
- No virtualized list is included yet; large datasets should page server-side.
- Dialogs are rendered in place rather than through a portal.
- The built-in process supervisor remains single-leader even though durable distributed coordination primitives are available.
- The trusted process runner is not a sandbox; use the Docker runner for stronger isolation.
- TLS certificate automation, WAF/DDoS service, WebSocket ingress, remote worker integration, and globally distributed control storage remain future platform work.
- Tailwind's browser build is suitable for examples and zero-install prototyping; production applications should serve compiled CSS.

## Release gate

A release is acceptable only after:

1. strict TypeScript succeeds;
2. the zero-dependency contract succeeds;
3. all unit and end-to-end tests pass;
4. package contents contain no databases, environment files, credentials, or platform state;
5. fresh package consumers can type-check, scaffold, and build;
6. representative applications pass browser interaction, console/error, accessibility-tree, and responsive-layout checks.
7. `npm run conformance` passes against a packed release through browser auth, CLI device authorization, live synchronization, user isolation, deployment, migration, failed activation, rollback, and data restoration.
8. `npm run security:audit` verifies dependency, package-content, credential-pattern, governance, least-privilege, immutable-action, OIDC, and evidence requirements.
9. deterministic chaos tests prove worker reclaim/fencing, corrupt-backup fail-closed behavior, and ingress recovery.

See `docs/security.md` and `docs/platform-security.md` for the separate security checklists.
