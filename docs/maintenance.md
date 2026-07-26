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
- [x] Added case-sensitive SVG and `foreignObject` namespace hydration, and aligned both bundled SSR examples with the browser's exact `clank.run` import-map specifier.
- [x] Re-certified all 166 tests, coverage floors, 46-file documentation audit, packaged conformance, and repository/history security scans.
- [x] Browser-verified node-preserving `attached` hydration, refresh, and post-hydration mutations in the full-stack example plus `attached` hydration in the authenticated example.
