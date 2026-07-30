# Maintenance and release certification

This is the repeatable maintainer checklist for substantial framework or platform updates. It keeps the zero-dependency promise, runtime behavior, security evidence, and documentation in one review path.

## Working checklist

- [ ] Preserve unrelated work and inspect the branch, reachable history, repository size, package metadata, and generated output.
- [ ] Review framework, auth, storage, live-sync, deployment, DNS/ingress, observability, recovery, and CLI trust boundaries.
- [ ] Run the dependency-free build and the complete unit/integration suite with enforced coverage floors.
- [ ] Validate documentation links, README guide indexing, declaration synchronization, and every package export.
- [ ] Exercise a packed consumer through scaffold, auth, multi-session live sync, user isolation, deploy, migration, failed activation, rollback, and data restore.
- [ ] Scan package contents, the current tree, and all reachable history for credential material.
- [ ] Verify shutdown, readiness, bounded I/O, private errors, file permissions, and atomic local-state replacement.
- [ ] Perform browser checks for the touched human flow, console errors, accessibility semantics, and a narrow viewport.
- [ ] Review `git diff --check`, generated files, package contents, and the final status before publishing a branch or release artifact.
- [ ] Update the changelog and audit evidence without publishing a registry release unless that release was explicitly requested.

`npm run check` covers the build, dependency contract, coverage floors, documentation/declaration audit, packed-release conformance, deterministic chaos tests, package/current-tree/history credential scans, and workflow-policy checks. Browser review remains intentionally explicit because visual and interaction regressions need a rendered application.

## 2026-07-25 review

- [x] Preserved the existing security-remediation branch and removed the unused logo artifact.
- [x] Confirmed zero runtime, development, peer, and optional dependencies.
- [x] Passed the original 125-test baseline, packaged conformance, security audit, and healthy GitHub CI/CodeQL review.
- [x] Added enforced 80% line, 65% branch, and 80% function coverage floors.
- [x] Added automated local-link, documentation-index, declaration-parity, and package-export checks.
- [x] Bounded and validated CLI credential/link state, made private writes atomic, and bounded/timed platform responses.
- [x] Replaced constant control-plane health with storage-backed readiness and separate liveness.
- [x] Made signal shutdown attempt both HTTP and platform cleanup under a fixed deadline.
- [x] Browser-verified refreshed auth state and removed narrow project-detail overflow and the implicit favicon request.
- [x] Corrected file-service and TypeScript-gate documentation so the published contract matches the implementation.

The final certification result and exact test counts belong in the pull request or release record after the complete gate and browser review finish.

## 2026-07-30 storage phases

- [x] Added atomic local and zero-dependency S3-compatible object adapters with bounded SigV4
  requests, exact integrity metadata, retries, deadlines, and private provider errors.
- [x] Moved optional remote-runner source releases behind the object boundary while preserving
  content addressing, quotas, leased reads, legacy local releases, and deletion safety.
- [x] Added optional chunked object storage for encrypted recovery points without changing the
  zero-setup local default.
- [x] Authenticated per-database catalogs, verified chunk metadata and bytes, reassembled and
  checked every promoted backup, retained local copies on provider failure, and migrated legacy
  local recovery points on the next create.
- [x] Bound the platform backup namespace/root in the control database, kept restore targets safe
  during pre-restore backup pruning, and purged complete or incomplete object state during
  confirmed permanent project deletion.
- [x] Kept the current Railway production service on its existing local volume; no bucket or
  additional paid resource was provisioned.

## 2026-07-30 provider data lifecycle phase

- [x] Added an independently verified and desired-state-bound provider consumer for
  `clank-runtime/1`, with project-isolated data, staging, generations, recovery, metadata, and
  monotonic fence high-water marks.
- [x] Added SQLite initialize/preserve/replace modes, immutable release migrations, bounded
  consistent snapshot export, one-generation rollback, exact confirmed deletion, and memory-only
  delivery of environment and ingress secrets.
- [x] Made apply and rollback crash-recoverable around an atomic metadata commit point, preserved
  referenced recovery bytes during retry, rejected corrupted path/state relationships and storage
  links, and pruned unreferenced provider-owned artifacts.
- [x] Kept hosted runtime selection closed until isolated launch, private health, stateful node
  pinning, encrypted recovery replication, and atomic ingress activation are integrated.
- [x] Re-certified all 277 tests at 85.96% line, 74.39% branch, and 85.78% function
  coverage; 56 documentation files, 195 local links, 32 declaration files, and 30 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [x] Merged PR #87 as `b8b7b7ccb180ca25d88d1ebe4bb0795aac0b4213` after Node 22/24,
  packaged-release conformance, and CodeQL passed; post-merge CI, CodeQL, and docs deployment
  completed successfully.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 generation-bound ingress phase

- [x] Added a strict optional managed-ingress binding for an allowlisted provider origin,
  provider-local path, `clank-runtime/1`, desired generation, project ID, and private route token.
- [x] Removed public copies of every reserved binding header before setting trusted values, kept
  request paths on the configured origin/path, and used the same binding for private health.
- [x] Scoped circuit identity to the provider origin, protocol, path, and generation so a failed
  old runtime cannot leave a new generation's route open.
- [x] Kept route tokens out of URLs, metrics, responses, and health failures, and documented the
  provider's responsibility to validate the complete committed binding.
- [x] Re-certified all 281 tests at 86.05% line, 74.51% branch, and 85.88% function
  coverage; 56 documentation files, 196 local links, 32 declaration files, and 30 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [ ] Record GitHub CI, CodeQL, merge, and post-merge evidence after the phase PR passes.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 remote runtime transport phase

- [x] Added a deterministic, bounded runtime capsule that binds final environment, verified code,
  SQLite placement intent/snapshot, and ingress identity to one project/release/generation.
- [x] Added exact-lease, no-store coordinator transport with independent client deadlines, body
  limits, media-type checks, digest verification, and post-provider lease revalidation.
- [x] Carried the decoded capsule through both the in-process and authenticated HTTP provider
  contracts without placing secret values or SQLite bytes in headers, URLs, public errors, or
  durable operation results.
- [x] Preserved the existing legacy artifact path and kept built-in remote activation closed until
  provider snapshot/restore/delete, migration/rollback, and ingress lifecycle support is complete.
- [x] Re-certified all 272 tests at 86.06% line, 74.41% branch, and 85.51% function
  coverage; 55 documentation files, 180 local links, 31 declaration files, and 29 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 job operations phase

- [x] Added per-project queue health, bounded job/schedule inspection, dead-letter and overdue
  attention state, and explicit undeployed/unconfigured/upgrade compatibility states.
- [x] Added conditional cancel/retry controls across the browser, API, and linked-project CLI.
- [x] Kept payloads, results, error bodies, user/group identities, worker identities, and lease
  credentials outside every hosted response and control-plane audit record.
- [x] Preserved the zero-dependency, per-project SQLite queue and added no Railway service,
  database, or paid monitoring resource.

## 2026-07-30 provider portability phase

- [x] Added a credential-free `DeploymentProvider` desired-state contract with strict operation,
  generation, release, artifact, abort, stale-observation, and bounded-result semantics.
- [x] Added an independently verified, authenticated binary HTTP bridge with HTTPS/loopback
  admission, redirect refusal, deadlines, exact retries, private provider errors, and bounded I/O.
- [x] Added `clank-runner` as a zero-dependency packaged process with persistent node credentials,
  placement labels, capacity/concurrency controls, and signal-driven drain.
- [x] Kept the current Railway deployment on the existing single service and volume. No runner,
  provider gateway, database, bucket, or other billable resource was provisioned.
- [x] Re-certified all 253 tests at 85.88% line, 73.97% branch, and 85.17% function
  coverage; 51 documentation files and 28 package exports; packed consumer conformance; and
  package, current-tree, and reachable-history credential scans.

## 2026-07-30 previews and production styling phase

- [x] Added isolated, quota-bound preview environments with separate application data, secrets,
  releases, jobs, and MCP surfaces; production data and secrets are never cloned implicitly.
- [x] Added create/refresh, list, deploy, confirmed removal, bounded expiry, startup cleanup,
  audit history, CLI workflows, and a dedicated control-plane view.
- [x] Replaced the template-time Tailwind browser runtime with the official local Tailwind CLI,
  atomic production CSS output, strict path validation, shell-free execution, and tighter CSP.
- [x] Verified a real Tailwind 4.2.4 compile from a clean installation and retained the
  framework runtime's zero-dependency contract.
- [x] Re-certified all 256 tests at 85.87% line, 74.00% branch, and 85.20% function coverage;
  52 documentation files and 28 package exports; packed consumer conformance; and package,
  current-tree, and reachable-history credential scans.

## 2026-07-30 usage and abuse-controls phase

- [x] Added an atomic, durable UTC-month ledger for admitted requests and known transfer plus
  bounded per-project UTC-minute windows and retained totals for deleted projects.
- [x] Enforced account/workspace traffic overrides at managed ingress with exact concurrent
  request admission, stable retryable errors, fail-closed policy failures, and no application
  path, header, cookie, IP, query, body, or identity retention.
- [x] Added a stable member-authorized usage API, `clank usage`, legacy quota-table migration,
  bounded history pruning, transparent partial-history state, and explicit metering caveats.
- [x] Added a server-rendered Usage view with responsive project/resource reporting; verified
  populated desktop and 390px layouts, mobile navigation, authenticated refresh, accessibility
  semantics, no horizontal page overflow, and no Clank page console errors.
- [x] Re-certified all 260 tests at 86.02% line, 74.09% branch, and 85.32% function coverage;
  53 documentation files, 160 local links, 30 declaration files, and 28 package exports; packed
  consumer conformance; and package, current-tree, and reachable-history credential scans.
- [x] Kept the current Railway topology unchanged and did not publish an npm package.

## 2026-07-30 managed runner activation phase

- [x] Added administrator-created, exact-node-and-region, expiring one-time runner enrollment with
  digest-only storage, transactional reservation, single-use commit, safe rollback, bounded active
  grants, and secret-free audit records.
- [x] Added responsive fleet health, pending-enrollment, capacity, placement, work, drain,
  reactivate, enrollment-revoke, and credential-revoke controls to the platform operator console.
- [x] Made desired placement survive zero-capacity windows, reconsider unassigned work when
  capacity joins, and fence expired leases onto the current replacement node.
- [x] Added `clank-runner --check [--json]`, explicit coordinator activation, a closed default,
  and compatibility for deliberate legacy shared-secret automation.
- [x] Fixed immediate configured-admin reconciliation for the first bootstrap account and added
  a focused regression test.
- [x] Browser-verified first-account operator access, server-rendered `/admin` navigation, one-time
  secret display, secret disappearance after refresh, pending metadata, a 390px layout without
  horizontal overflow, and no Clank page console errors.
- [x] Kept project execution on the existing control-plane host until the next phase defines
  remote secrets, SQLite data, ingress, backup, rollback, and release placement; no Railway
  service, volume, bucket, or npm release was added.
- [x] Re-certified all 264 tests at 86.05% line, 74.31% branch, and 85.29% function coverage;
  54 documentation files, 169 local links, 30 declaration files, and 28 package exports; packed
  consumer conformance; and package, current-tree, and reachable-history credential scans.
- [ ] Record the CI evidence in the pull request after its required checks finish.

## 2026-07-26 follow-up

- [x] Merged the complete 2026-07-25 security and release-certification pass into `main`.
- [x] Replaced manual-only custom-domain routing refresh with bounded scheduled reconciliation.
- [x] Added durable DNS leases so multiple control planes cannot check and commit the same domain concurrently.
- [x] Added lookup deadlines, stale-result fencing, shutdown coordination, API status, and dashboard cadence visibility.
- [x] Removed the remaining console letter mark so no logo treatment remains.
- [x] Added durable scheduled encrypted backups with cross-control-plane claims, retention, private failure reporting, and graceful draining.
- [x] Added backup cadence/status, manual creation, and verification to the deployment console without exposing host paths.
- [x] Added automatic-backup encryption, failure, retention, multi-control-plane, and shutdown regression coverage.
- [x] Bounded cumulative release files and pre-deploy snapshots with durable per-project count/byte quotas.
- [x] Added confirmation-gated artifact cleanup with active-release and immediate-rollback protections.
- [x] Exposed release storage usage and cleanup in both the deployment console and CLI.
- [x] Re-certified all 136 tests, coverage floors, 45-file documentation/declaration audit, packed conformance, and repository/history security scan.
- [x] Browser-verified cleanup, persistent authenticated refresh, console health, accessibility semantics, and desktop/mobile layout.
- [x] Recorded the final full-suite, security, conformance, and browser evidence in [PR #9](https://github.com/nearbycoder/clank.run/pull/9); Node 22.16, Node 24, packaged conformance, JavaScript/TypeScript analysis, and CodeQL passed.
- [x] Added owner/admin-only permanent site deletion across the API, deployment console, and CLI.
- [x] Made site deletion reclaim quota, slug, port, and domain assignments while revoking scoped tokens and preserving its audit event.
- [x] Added exact confirmation, explicit data-loss acknowledgement, CSRF/scope/RBAC checks, durable locking, and symlink-safe project-root removal.
- [x] Re-certified all 138 tests at 82.22% line, 69.13% branch, and 82.21% function coverage, plus packed conformance and repository/history security scans.
- [x] Browser-verified exact-confirmation deletion, quota refresh, persistent authentication, console health, and desktop/mobile layout without overflow.
- [x] Added a durable workspace activity feed that keeps deleted-site evidence reachable through the dashboard, API, and structured CLI output.
- [x] Added organization attribution and old-schema backfill without weakening role, membership, project-token, pagination, or input boundaries.
- [x] Re-certified all 140 tests at 82.38% line, 69.30% branch, and 82.26% function coverage, plus packed conformance and repository/history security scans.
- [x] Browser-verified deleted-site activity, expandable metadata, authenticated refresh, console health, and desktop/mobile layout without overflow.
- [x] Added complete workspace people administration in the browser and CLI: email-bound invitation creation/acceptance/replacement/revocation, member role changes, administrator removal, and member self-leave.
- [x] Preserved last-owner and owner-only role boundaries, capped active invitations at 100, rejected existing-member reinvites, and redacted invitation-recipient emails from developer activity.
- [x] Re-certified all 141 tests at 82.53% line, 69.52% branch, and 82.36% function coverage, plus 45-file documentation/declaration audit, packed conformance, and repository/history security scans.
- [x] Browser-verified two-account invitation acceptance, role promotion, removal/self-leave, replacement/revocation, persistent auth, console health, and desktop/mobile People layouts without overflow.
- [x] Added quota-aware browser workspace creation with safe slug preview, immediate selection, and a responsive limit state.
- [x] Re-certified all 141 tests at 82.53% line, 69.56% branch, and 82.36% function coverage, plus packed conformance and repository/history security scans.
- [x] Browser-verified authenticated workspace creation, automatic slugging, immediate selection, enforced quota disabling, and desktop/mobile layout without overflow.
- [x] Added invitation-assisted registration so a new collaborator can create only the email-bound invited account and join atomically while ordinary signup remains closed.
- [x] Serialized first-account bootstrap across control-plane runtimes with an expiring SQLite claim and stable losing-account cleanup, and aligned platform policy with normalized auth paths.
- [x] Reloaded the server-rendered console at sign-out and session expiry so prior-account DOM and stale signup policy cannot cross an identity transition.
- [x] Re-certified all 143 tests at 82.56% line, 69.57% branch, and 82.36% function coverage, plus 45-file documentation/declaration audit, packed conformance, and repository/history security scans.
- [x] Browser-verified bootstrap closure, same-browser owner-to-invitee onboarding, consumed-invitation privacy, persistent refresh authentication, zero console/page errors, and a 390px People layout without horizontal overflow.
- [x] Moved platform auth and CLI device-start throttles into one HMAC-keyed, bounded SQLite sliding-window store shared across control-plane runtimes and restarts.
- [x] Corrected successful-login rate-limit clearing and covered cross-runtime accumulation, restart persistence, clock rollback, raw-identity privacy, 429 behavior, and high-cardinality pruning.
- [x] Re-certified all 145 tests at 82.61% line, 69.72% branch, and 82.47% function coverage, plus 45-file documentation/declaration audit, packed conformance, and repository/history security scans.
- [x] Browser-verified generic wrong-password handling, successful retry/reset, authenticated refresh, hashed-only retained limiter state, and zero console/page errors.
- [x] Added focused human and JSON CLI help, typo-safe options, readiness diagnostics, local-checkout scaffolding, offline deploy checks, structured timing results, and retry-safe deployment idempotency.
- [x] Added human and agent operating guides to both scaffold paths, including commands, file ownership, security/migration invariants, and a definition of done.
- [x] Corrected the generated browser import map discovered during fresh-app review so server-rendered authentication hydrates and becomes interactive.
- [x] Re-certified all 148 tests at 82.90% line, 69.76% branch, and 82.67% function coverage, plus documentation/declaration audit, packed conformance, and package/current-tree/history security scans.
- [x] Browser-verified a newly created local-checkout consumer through auth-mode switching, registration, todo creation, a second login, cross-browser live completion, zero error overlays, and no horizontal overflow.
- [x] Hardened hydration ownership so abandoned listeners, directives, keyed rows, and component output are cleaned without disguising application errors as structural mismatches.
- [x] Added case-sensitive SVG and `foreignObject` namespace hydration, and aligned both bundled SSR examples with the browser's exact framework import-map specifier.
- [x] Re-certified all 166 tests, coverage floors, 46-file documentation audit, packaged conformance, and repository/history security scans.
- [x] Browser-verified node-preserving `attached` hydration, refresh, and post-hydration mutations in the full-stack example plus `attached` hydration in the authenticated example.
