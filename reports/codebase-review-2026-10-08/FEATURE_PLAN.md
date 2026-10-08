# Forty new Clank features

Clank already ships a large UI library, authentication, organizations, agent contracts, reviewed actions, offline writes, shared documents, imports, backups, canaries, and deployment tooling. These 40 proposals add new behavior to those workflows. Existing review fixes are prerequisites and are not counted as new features.

Prioritize host certification, safe promotion, agent control, reliable data workflows, and operational visibility. Larger infrastructure and database features should follow proven demand and a separate architecture proposal. The target audience is application developers and operators using Clank's existing framework and platform.

Each entry describes an initial deliverable and the evidence needed to accept it. Size is a rough engineering effort band: S = 1–3 engineer days, M = 4–10, L = 11–20, XL = more than 20. These estimates exclude hosting procurement, external-provider approval, and rollout observation. Dependencies refer to feature IDs; every feature also depends on the relevant fixes and type-contract baseline in the [review](README.md).

## Deployment workflows

Build on `platform.ts`, `deploy.ts`, `provider-service.ts`, `sqlite-sandbox.ts`, and `lifecycle.ts`. Existing promotion helpers describe plans; these proposals add persistent platform execution and administration.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 01 | Verified Linux host certification | Run disposable migration, SQLite worker, namespace, disk quota and runner probes in the configured deployment profile. Produce a versioned, expiring report tied to host policy and show specific blocked capabilities. A denied probe must prevent a green certificate; certify both allowed and denied hosts. | M | None |
| 02 | Artifact promotion across environments | Model development, staging and production targets. Promote the exact verified artifact digest without rebuilding, while resolving each environment's own secrets, data and migration policy. Prove digest preservation, independent data, role checks and failed-promotion rollback. | L | 01 |
| 03 | Persistent release channels | Give projects named channels with pinned immutable release history, current target and explicit promotion/rollback actions. A channel update must reject a stale expected version and never reinterpret an old artifact. Show CLI and dashboard parity. | M | 02 |
| 04 | Deployment dependency gates | Persist project-to-service dependencies and readiness requirements. Gate activation on bounded, versioned checks for required services, with a visible blocked reason and explicit override policy. Test timeout, revoked access and a dependency changing during activation. | M | 01, 02 |
| 05 | Scheduled release windows | Queue an approved promotion for an exact time or maintenance window, with timezone preview, cancellation and expiry. Revalidate permissions and artifact identity when executing. Prove one execution after restart and no execution after revocation or cancellation. | M | 03 |

## Platform availability and recovery

Build on `orchestration.ts`, `managed-canary.ts`, `node-evacuation.ts`, `provider-data.ts`, `point-in-time.ts`, and `recovery.ts`. Initial scope stays within a defined transactional control store; multi-region consensus needs its own proposal.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 06 | Automatic supervisor leadership | Persist ownership leases for built-in supervisor responsibilities, fence takeover, and resume desired state after a leader dies. Start with multiple coordinators using one supported transactional store. Kill leaders at each transition and prove that only one authoritative writer/background owner survives. | XL | 01, 34 |
| 07 | Online provider node handoff | Add a planned transfer protocol that stages a target, synchronizes a checkpoint, fences the source writer and switches ingress with a bounded interruption target. Preserve the current downtime path as fallback. Prove source loss, target failure and stale replay cannot create two writers. | XL | 06, 10 |
| 08 | Provider managed canaries | Extend traffic stages and guardrail measurements to provider runtimes. Keep initial scope to code-only releases with an explicit database-writer policy. Prove remote failure, controller restart and rollback clean up candidate workers before admitting the prior release. | XL | 06 |
| 09 | Isolated shadow traffic | Mirror only approved, sanitized, read-only requests to a candidate and compare bounded outcomes. Shadow requests get isolated data and disabled external side effects. Prove credentials/body redaction, resource ceilings and zero production writes before enabling comparisons. | L | 08 |
| 10 | Remote PITR orchestration | Make the platform schedule encrypted provider checkpoints and bounded journal exports, inspect recovery horizons, and restore a chosen point into a separate project. Prove corruption, retention gaps and lost source nodes fail safely; compare restored content with a known mutation ledger. | XL | 01 |

## Organization administration

Build on `organization-sso.ts`, `auth.ts`, `account-security.ts`, platform membership, and existing audit events. OIDC sign-in and custom offboarding already exist; the new scope is administration and standardized lifecycle behavior.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 11 | Verified multi-organization identity linking | Allow a signed-in user to attach an external organization identity after fresh local and provider authentication. Model multiple identities without email-only automatic linking. Prove collision, unlink, partial offboarding and organization revocation preserve the correct account boundaries. | L | None |
| 12 | SCIM user and group provisioning | Add a narrow standards-based provisioning adapter for creation, activation/deactivation and group membership, with scoped credentials and replay-safe updates. Map explicitly to Clank roles. Prove deactivation revokes sessions, delegated credentials and live access across processes. | L | 11 |
| 13 | Organization security policy console | Persist per-organization requirements for MFA/passkeys, SSO-only access, session duration and enrollment grace periods. Show effective policies before changes. Prove policy tightening closes access across browser, CLI and MCP, with a tested last-admin recovery path. | L | 11 |
| 14 | Temporary privileged access | Let administrators grant narrowly scoped, expiring privileges after recent authentication and a recorded reason. Show active elevations and revoke them immediately. Prove expiry and role removal affect in-flight decisions, without reviving privileges after restart. | M | 13 |
| 15 | Organization service accounts | Add dedicated machine principals with scoped permissions, credential rotation, expiry and an owner responsible for them. Do not model them as human sessions. Prove human-only approval controls reject machine credentials and all usage/audit attribution identifies the machine principal. | L | 16 |

## Agent and workflow control

Build on `reviewed-actions.ts`, `governance.ts`, `agent-activity.ts`, `jobs.ts`, and `trace-timeline.ts`. Existing single-approver receipts and workflow graphs remain the basis.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 16 | Agent operation budgets | Attach durable limits for calls, writes, affected records and external operations to a grant, with previews of remaining capacity. Debit budgets transactionally with accepted operations. Concurrent calls and ambiguous retries must neither overspend nor debit twice. | L | None |
| 17 | Approval quorum policies | Support distinct approvers, required role sets, separation of requester/approver and expiry. Revalidate all qualifying votes at commit. Prove duplicate votes, removed members, expired sessions and policy changes cannot satisfy a quorum. | L | 13, 18 |
| 18 | Reviews bound to affected records | Track preview dependencies and relevant record versions so an unrelated database write does not invalidate a review. Preserve conservative rejection when a policy has undeclared dependencies. Prove affected-row and ACL changes invalidate plans while unrelated changes do not. | L | None |
| 19 | Durable human waits in workflows | Add workflow states for awaiting a reviewed decision or bounded external event, with resume tokens, deadlines and cancellation. Release worker slots while waiting. Prove restart recovery, duplicate decisions, timeout races and permission revocation yield one transition. | L | 18 |
| 20 | Workflow compensation steps | Let workflows declare explicit, idempotent compensations and inspect compensation progress after a later failure. Mark irrecoverable/manual steps clearly. Inject failure at each step and prove a lost compensation response does not repeat an external operation. | L | 19 |

## Data and integration workflows

Build on `backend.ts`, `data-plane.ts`, `search.ts`, `durable-import.ts`, schema validators, and current change journals. These proposals extend existing interfaces rather than replacing them with parallel CRUD frameworks.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 21 | Typed PostgreSQL application backend | Implement a driver for the generated table/function contract with ownership, transactions, revisions and reconnect semantics. Begin with a documented supported subset. Run the same contract suite against SQLite and PostgreSQL and reject unsupported behavior explicitly. | XL | None |
| 22 | Authorized cross-table aggregates | Add typed count/sum/group projections over declared tables and relationships, with bounded query plans and the same owner/ACL scope as ordinary reads. Generated relationships already exist; this adds read aggregation. Prove inaccessible rows never affect totals and aggregate live updates remain selective. | L | None |
| 23 | Source-linked search indexes | Declare which table fields populate an FTS index and update it atomically with source writes, deletes and restores. Add resumable rebuild and drift diagnostics. Prove crashes/rebuilds do not serve deleted or unauthorized source records. | L | None |
| 24 | Search facets and stable result cursors | Add authorized-only filters/facets, deterministic paging and saved search definitions to the repaired search service. Pin cursor semantics to index/policy revisions. Prove hidden records cannot affect facet values and changed indexes cannot silently skip or duplicate results. | L | 23 |
| 25 | Import correction and upsert workflow | Let users inspect failed rows, correct mappings/values, preview authorized insert-versus-update effects and resume with version checks. Persist accepted corrections without mutating already applied batches. Prove changed source files, stale rows and lost responses cannot duplicate updates. | L | None |

## Collaborative application experiences

Build on `collaborative-documents.ts`, `collaboration.ts`, `buckets.ts`, `offline.ts`, and durable jobs. Existing presence, resumable uploads and image variant callbacks are reused.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 26 | Shared document cursor coordination | Integrate ephemeral presence with persistent text revisions, rebasing cursor/selection positions as edits are accepted. Existing generic presence is insufficient for document coordinates. Prove edits, reconnects and revoked membership cannot leave misleading cursors or disclose selections. | M | None |
| 27 | Document suggestions and branches | Add named branches and proposed edits with diff, accept/reject and version-fenced merge. Keep overlapping conflicts explicit. Prove an accepted suggestion is not applied twice and a stale suggestion cannot silently overwrite newer text. | L | 26 |
| 28 | Retained file versions and restore | Expose bounded immutable generations with owner-authorized history, restore and expiry policies. Existing bucket replacement preserves a current generation; this adds a user-facing history contract. Prove old signed URLs, restore races and retention cannot substitute another owner's bytes. | L | None |
| 29 | Durable media processing jobs | Queue declared image variants and other approved transforms, with source-generation fencing, bounded retries, progress and callback/provider adapters. This orchestrates existing transform hooks. Prove an old job cannot publish over a newer upload and failed processing does not replace original bytes. | M | 28 |
| 30 | Offline attachment queue | Store bounded device-local blobs, account-bound upload intents and replay receipts, then attach them atomically to a record after upload completion. Show pending and failed uploads. Prove account switching, expired permissions, partial uploads and lost responses cannot attach the wrong object. | L | 28 |

## Developer tools

Build on `devtools.ts`, `dev-updates.ts`, compiler source maps, contract schemas, `i18n.ts`, and the existing workbench. Preserve the dependency-free package; optional external tools belong behind explicit adapters.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 31 | Hydration mismatch inspector | Capture bounded server/client structural differences, component/source locations and the reason for fallback in local DevTools. Provide a reproducible snapshot export with redaction. Prove intentional mismatches are located accurately without leaking private SSR state or changing hydration behavior. | M | None |
| 32 | Interactive component contract harness | Create isolated specimens for SSR, hydration, keyboard/focus states and narrow widths, using component contracts and semantic journeys. Export deterministic assertions. Exercise real browser events and cleanup rather than relying exclusively on fake DOM fixtures. | L | 31 |
| 33 | OpenAPI export for backend functions | Generate a versioned OpenAPI description from runtime schemas and HTTP/auth contracts, with precise error and idempotency semantics. Preserve explicit agent exposure rules. Validate examples against a packed app and reject schema shapes the exporter cannot represent accurately. | M | None |
| 34 | Local provider fleet simulator | Run disposable virtual coordinator/provider processes with configurable lease loss, slow transport, disk failures and restarts. Show placement/fence timelines and export scenarios. Reproduce two-node takeover and prove simulator scenarios exercise actual provider contracts rather than mocked success paths. | L | 01 |
| 35 | Translation extraction and review workflow | Add catalog extraction, missing-key/placeholder checks, translator export/import and a reviewable locale diff. Existing typed catalogs remain canonical. Prove malformed translations fail before release and SSR/browser formatting uses the same accepted catalog revision. | M | None |

## Operator and customer visibility

Build on error/trace inboxes, `operations-monitor.ts`, metrics, usage admission and existing retained audit metadata. Keep public information explicitly separate from private operational details.

| ID | Feature | Initial scope and acceptance evidence | Size | Dependencies |
| --- | --- | --- | --- | --- |
| 36 | Project incident workspace | Connect release changes, error recurrence, trace/job timelines and operational alerts into an incident with owner, notes and resolution. Persist links rather than duplicating private payloads. Prove revoked roles lose access and deleted releases retain safe incident context. | M | None |
| 37 | SLO and error budget policies | Let operators define request-success/latency objectives, rolling windows and burn-rate alerts, including insufficient-data states. Show the arithmetic and measurement coverage. Replay known traffic fixtures and verify low traffic, missing buckets and restarts do not fabricate compliance. | L | 36 |
| 38 | Project cost attribution and budgets | Attribute measured storage, transfer and runtime usage using an explicit versioned operator rate card; add alerts and opt-in admission policies. Existing capacity estimates/forecasts are inputs, not invoices. Prove reconciliation, corrections and overrides remain auditable and distinguish unknown from zero cost. | L | 15 |
| 39 | Retention administration and holds | Give operators one inventory of application metadata/payload retention, safe purge previews, schedules and explicit holds. Begin with imports, collaboration receipts and audit exports. Prove holds survive restarts, scoped operators cannot purge other tenants and expired retries do not execute again. | L | None |
| 40 | Customer status pages | Publish selected component health and approved incident updates with a custom domain and subscriber preferences. Expose no internal paths, tenant identities or trace data. Prove private incidents remain private and updates/notifications are idempotent after recovery. | L | 36, 37 |

## Delivery order

| Stage | Feature IDs | Intended result |
| --- | --- | --- |
| Prerequisites | Review fixes, rollout diagnosis, type baseline, current capability ledger | A dependable base and honest release status. These are not part of the 40-feature count. |
| First ten | 01, 02, 16, 18, 23, 25, 28, 33, 34, 39 | Verified hosts, immutable promotion, safe agent execution, dependable data workflows, and practical integration tools. |
| Team and workflow operations | 03, 04, 05, 11, 12, 13, 15, 19, 36 | Persistent release administration, enterprise identity lifecycle, machine principals, human waits and incident ownership. |
| Availability and guardrails | 06, 08, 10, 17, 20, 29, 37 | Leadership, provider recovery/canaries, stronger approvals, compensation and measured service objectives. |
| Advanced application capability | 07, 09, 14, 21, 22, 24, 26, 27 | Online handoff, safe shadowing, temporary access, alternate data backend, richer queries and collaborative editing. |
| Experience and reporting | 30, 31, 32, 35, 38, 40 | Offline attachments, better browser diagnostics, translation tooling, cost visibility and customer communications. |

Within each stage, follow the dependencies rather than the table order. Feature 21 deserves a standalone architecture decision and contract prototype before committing to full driver parity. Features 06–10 need failure testing on the intended host topology and explicit writer/consensus assumptions.

## Acceptance for every feature

Each implementation proposal must identify the user and agent workflow, minimal public contract, permission boundary, retry/expiry behavior, persistent migration, compatibility, rollback, and measurable proof. Public consumer types need positive and negative packed-package fixtures. Persistent mutations need restart and ambiguous-response cases. Browser flows need real keyboard, focus, mobile-layout and revocation checks. Deployment changes need interruption/fencing evidence on a disposable environment matching the intended production profile.

Keep the zero-dependency runtime, expose bounded resource behavior, and reuse current primitives. Ship small reviewed changes with documentation and current capability evidence; do not merge all 40 capabilities as one unreviewable release.
