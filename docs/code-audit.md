# Code and product audit

Audit date: 2026-07-30

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
| Remote nodes had no lease-bound release transport | Added canonical-operation selection, node/lease/fence authorization, bounded content-addressed transfer, opt-in owner-only retention, and independent provider/client integrity verification | Runner, platform, storage-accounting, and chaos tests |
| Remote provider data had no reusable commit/recovery boundary | Added independently bound runtime consumption, isolated immutable generations, SQLite mode/migration/snapshot handling, monotonic fences, atomic metadata, crash journals, one-generation rollback, confirmed deletion, and scoped owner-only storage | Provider data lifecycle, corruption, stale replay, validation failure, rollback, snapshot, and interrupted-journal tests |
| Off-host objects required an external runtime package | Added a provider-neutral object contract with atomic no-follow local envelopes and a zero-dependency S3-compatible SigV4 adapter; remote runner uploads persist a repository identity/key and use it for leased reads and destructive cleanup | Object-storage, platform object-repository, package-consumer, documentation, and security tests |
| Backups were release-local snapshots or manual recovery points only | Added encrypted authenticated backup repositories, durable scheduling, cross-control-plane claims, retention, verification, restore confirmation, safety copies, path-safe API/console surfaces, and CLI | Recovery, platform-backup, conformance, and chaos tests |
| The platform lacked a managed host/data-plane layer | Added exact-host ingress, DNS ownership challenges, external PostgreSQL transactions/migrations, and database provisioning contracts | Data-plane and platform tests |
| Release security evidence was manual | Added ASVS-oriented mapping, threat model, package/secret audit, immutable CI actions, CodeQL, chaos tests, and beta gate | `npm run check` and GitHub workflows |
| Hosted quotas could be bypassed through extra organizations and rejected domains could survive rollback | Added account organization/site limits and moved domain capacity checks into the insert transaction | Platform quota and direct SQLite row-count regressions |
| Hosted traffic had minute metrics but no durable workspace ledger or admission boundary | Added atomic UTC-month request/known-transfer accounting, per-project minute windows, account/workspace overrides, bounded retention, fail-closed managed-ingress admission, a stable usage API, responsive SSR dashboard, and CLI reporting | Concurrent admission, legacy migration, deletion retention, privacy, API/RBAC, CLI, desktop/mobile, refresh, conformance, and security regressions |
| Caller IP headers, passkey start responses, and recovery delivery timing exposed authentication side channels | Bound rate limits to trusted adapter identity, switched to discoverable passkeys, and removed delivery from the response path | Authentication enumeration, spoofing, and blocked-delivery regressions |
| Binary uploads and remote SQL responses could buffer past route limits | Added shared bounded streaming readers that cancel at the first over-limit chunk | Artifact, file-service, and PostgreSQL streaming regressions |
| Disconnects did not cancel every downstream stream and Docker arguments contained secret values | Propagated cancellation through ingress/Node and changed Docker to name-only environment arguments | Ingress, Node disconnect, and fake-Docker process-argument regressions |
| Repository leak checks covered only the package and a small credential set | Expanded credential patterns and scan current repository files plus all reachable Git history | `npm run security:audit` |
| A green release did not enforce coverage or documentation/declaration integrity | Added minimum line/branch/function coverage and checked local links, guide indexing, declaration parity, and export targets | `npm run check` and `npm run docs:audit` |
| CLI state writes and control-plane responses lacked complete interruption/resource bounds | Added strict bounded config/link parsing, atomic private replacement, request deadlines, strict UTF-8 JSON parsing, and response byte caps | CLI regression tests and packaged conformance |
| `/healthz` reported a constant result and signal shutdown could skip platform cleanup after an HTTP close failure | Added storage-backed readiness, separate liveness, and bounded cleanup that attempts both layers | Platform readiness tests and conformance process shutdown |
| Repeated deployments retained unbounded extracted files and rollback snapshots | Added locked per-project count/byte ceilings plus path-derived, rollback-scoped cleanup that preserves immutable evidence | Platform quota, authorization, symlink, snapshot, CLI, and dashboard regressions |
| Enforced site quotas had no safe user-facing reclamation path | Added owner/admin-only permanent deletion with dual confirmation, scoped-token denial, durable locking, path-safe storage cleanup, metadata cascades, token revocation, and surviving audit evidence | Platform RBAC, CSRF, path substitution, runtime, storage, orchestration, quota/slug/port/domain reuse, CLI, and dashboard regressions |
| Deleted-site audit evidence survived in SQLite but became unreachable through the project API | Added durable organization attribution, old-schema backfill, current-role filtering, project-token containment, stable cursor pagination, dashboard Activity, and structured CLI output | Deletion survival, migration, RBAC/scope, pagination/input, CLI, desktop/mobile, refresh, and browser-console regressions |
| Routine workspace access administration and invitation acceptance required CLI work, while replacement invitations remained valid | Added complete browser invite/accept/member administration, CLI parity, administrator-only pending metadata, developer audit redaction, atomic invitation replacement, active-invite bounds, revocation, and existing-member rejection | RBAC, replay, email binding/privacy, cap, role/removal, CLI, CSRF, desktop/mobile, and browser-console regressions |
| Creating an additional workspace still required CLI knowledge | Added quota-aware browser creation, normalized slug preview, immediate selection, and server-authoritative validation | CSRF/quota regression, authenticated browser creation, and responsive dialog verification |
| Default bootstrap made invitations unusable for collaborators who did not already have an account; simultaneous control planes lacked a durable first-account claim; and platform/auth path normalization differed | Added email-bound invitation-assisted registration with rollback cleanup, an expiring SQLite bootstrap claim with insertion-order fallback, and one normalized signup-policy operation | Disabled/bootstrap, repeated-slash/legacy path, origin, expiry, mismatch, replay, account-cleanup, and two-runtime concurrency regressions |
| Reusing the console after sign-out could retain the prior account's rendered People data and stale bootstrap button state | Reload the server-rendered console on sign-out or session expiry so identity, policy, and DOM state are rebuilt together | Same-browser owner-to-invitee onboarding, refresh, role/privacy, and console-error verification |
| Platform auth and device-start throttles reset per process, while successful login cleared a malformed key | Added one atomic HMAC-keyed SQLite sliding-window store shared by auth and device onboarding, corrected successful-login clearing, and bounded high-cardinality retention | Framework reset, cross-runtime accumulation, restart persistence, raw-identity absence, clock rollback, 429, and 20k-key pruning regressions |
| Generated auth pages rendered correctly but mapped `clank` while compiled browser modules imported the framework package, preventing hydration | Aligned both scaffold import maps with `@clank.run/framework` and added generated-source regression coverage | Fresh scaffold registration and two-browser live-sync verification |
| CLI help could execute a command, offline dry-runs required auth, unknown options were ignored, and async failures had inconsistent exit behavior | Added command-aware help, strict option validation and suggestions, reliable async error handling, offline dry-runs, readiness diagnostics, and structured agent output | CLI regression tests, local-checkout consumer, packaged conformance, and fresh-app browser review |

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

- bounded request, upload, and remote artifact-transfer intake;
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
- A capability-gated local file store and upload endpoint are included for trusted single-host deployments; production object storage, CDN delivery, and image transformation remain provider integrations.
- No virtualized list is included yet; large datasets should page server-side.
- Dialogs are rendered in place rather than through a portal.
- The built-in process supervisor remains single-leader even though durable distributed coordination primitives and verified remote release transfer are available.
- The trusted process runner is not a sandbox; use the Docker runner for stronger isolation.
- Clank now provides verified domain eligibility for Caddy On-Demand TLS and a complete generic
  remote-agent lifecycle, but certificate/key custody, WAF/DDoS service, WebSocket ingress,
  infrastructure-specific remote execution, scoped remote secret/data delivery, and globally
  distributed control storage remain external or future platform work.
- Tailwind's browser build is suitable for examples and zero-install prototyping; production applications should serve compiled CSS.

## Release gate

A release is acceptable only after:

1. the zero-dependency TS/TSX syntax-lowering build succeeds;
2. checked-in declarations match built declarations, package export targets resolve, and local documentation links remain valid;
3. all unit and end-to-end tests pass above the enforced 80% line, 65% branch, and 80% function coverage floors;
4. package contents contain no databases, environment files, credentials, or platform state;
5. fresh package consumers can scaffold and build;
6. representative applications pass browser interaction, console/error, accessibility-tree, and responsive-layout checks;
7. `npm run conformance` passes against a packed release through browser auth, CLI device authorization, live synchronization, user isolation, deployment, migration, failed activation, rollback, and data restoration;
8. `npm run security:audit` verifies dependency, package-content, current-tree and reachable-history credential patterns, governance, least-privilege, immutable-action, OIDC, and evidence requirements; and
9. deterministic chaos tests prove worker reclaim/fencing, corrupt-backup fail-closed behavior, and ingress recovery.

Clank deliberately does not install a TypeScript package. Its built-in compiler validates syntax lowering, while the checked-in declarations define the consumer contract. Run `tsc --noEmit` as an additional semantic type check when a separately provisioned, trusted TypeScript compiler is available; do not describe that optional external tool as part of the zero-dependency gate.

See `docs/security.md` and `docs/platform-security.md` for the separate security checklists.
