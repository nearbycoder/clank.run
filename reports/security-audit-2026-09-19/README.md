# Security audit — 2026-09-19

Repository: `nearbycoder/clank.run` (local Proact/Clank checkout). Audited upstream revision: `fbd3e8dd5adc4d2f6cd91f8a4c974db67bebea80`, version 0.22.1. Work branch: `codex/security-audit`.

Latest upstream `main` was fetched and merged before review. The merge preserves the three existing local Synth commits and takes the upstream Synth version reporting changes. Local `main` contains that merge; the security changes are on the audit branch. The pre-existing untracked `verify-daily-log-oauth.mjs` was preserved and was not executed.

## Scope and method

The baseline inventory contained 644 tracked files and nine package manifests. Repository-wide checks covered current files and reachable Git history for high-confidence credential patterns, the published package allowlist, release metadata, dependency declarations, and immutable/least-privilege CI configuration. Manual review and controlled regression tests concentrated on these trust boundaries:

- Authentication, session revocation, password/MFA/passkey ceremonies, OAuth, MCP, OIDC, and backend ownership.
- Workspace membership, scoped automation tokens, CLI transport, deployment artifacts, migration guards, ingress, and provider/runner fencing.
- Local and S3 storage, managed buckets, email/webhooks, jobs/workflows/durable objects, billing, analytics, observability, CSV, and account-scoped product features.
- SSR/DOM URLs, routing, static-file paths, application templates, public documentation/demo endpoints, and browser bridge/source boundaries.

The framework and bundled sites declare no third-party npm dependencies. The minimal and authenticated starter templates include Tailwind development dependencies; these were checked separately using registry metadata and the npm bulk advisory endpoint.

## Findings fixed

Priority is a contextual assessment, not a CVSS score. Each entry has automated regression coverage; filesystem hardening is also subject to the trusted-host assumptions below.

| ID | Priority | Finding and correction | Evidence |
| --- | --- | --- | --- |
| A01 | High | Delayed backend and auth requests could use a revoked session or stale role after awaiting request bodies/crypto. Current authority is rechecked before execution or credential writes. | `tests/auth.test.mjs` |
| A02 | High | An old-password login could complete after a password change revoked sessions. Session and MFA issuance are bound to the current password proof; password changes/reset invalidate pending MFA challenges. | `tests/auth.test.mjs` |
| A03 | High | Disabled accounts could finish MFA and receive persistent sessions. Account status is checked transactionally during issuance and recovery. | `tests/auth.test.mjs` |
| A04 | High | Concurrent OAuth refresh or adaptive recovery could restore broader scope after grant reduction. Token writes now compare the persisted current scope. | `tests/mcp.test.mjs` |
| A05 | Medium | WebAuthn allowed a nonzero signature counter to reset to zero. The counter must advance whenever either counter is nonzero; counterless authenticators remain supported. | `tests/webauthn.test.mjs` |
| A06 | High | A removed workspace member retained owner access to projects they created. Workspace projects now require current membership, including list/dashboard queries; creator fallback is restricted to legacy projects without a workspace. | `tests/platform-security-audit.test.mjs`, `tests/platform-tenant-lookups.test.mjs` |
| A07 | High | A project token with token-management permission could delegate permissions outside its own scope and a longer lifetime. Children now preserve permission, expiry, and preview restrictions; issuance rechecks membership, bearer validity, and the original browser session after asynchronous input. | `tests/platform-security-audit.test.mjs` |
| A08 | High | CLI redirects could resend sensitive POST bodies to another origin. Platform transport now refuses redirects and omits ambient credentials. | `tests/compiler-cli.test.mjs` |
| A09 | High | A deployment include could traverse a symlinked ancestor and package files outside the project. Canonical roots, ancestor checks, no-follow file opens, and descriptor identity checks close that path. | `tests/migrations-deploy.test.mjs` |
| A10 | Medium | SQLite single-quoted identifiers bypassed reserved migration-ledger protection. Reserved names are now recognized through that quote form. | `tests/migrations-deploy.test.mjs` |
| A11 | Medium | Global job idempotency keys caused one user's request to return another user's job ID and suppress their own job. Deduplication is owner-scoped, with an atomic index migration preserving retained jobs. | `tests/jobs.test.mjs` |
| A12 | High | Legacy signed file downloads could serve uploaded HTML/SVG as active same-origin content. Responses now use attachment disposition, sandbox CSP, and no-referrer. | `tests/services.test.mjs` |
| A13 | Medium | Legacy file/email storage accepted unsafe filesystem state and insufficiently bounded metadata/file reads. Directory ownership/modes, no-follow file descriptors, file identity, read bounds, and metadata validation are enforced; extra capability-token segments are rejected. | `tests/services.test.mjs` |
| A14 | Medium | An offline queue snapshot could expose the previous account's pending input after logout/account switch. Construction and snapshots now enforce the account binding and disposed state. | `tests/offline.test.mjs` |
| A15 | High | Arrays/coercible values bypassed executable-URL validation, and object resource URLs were unchecked. The URL policy now covers the serialized value and object `data`. | `tests/security-boundaries.test.mjs`, `tests/dom.test.mjs` |
| A16 | Medium | A public symlink or index alias could expose hidden files despite default dotfile denial. Both resolved file targets and resolved directory indexes are checked. | `tests/security-boundaries.test.mjs` |
| A17 | Low | A query named `__proto__` changed the returned query object's prototype. Query names are now written as own data properties and inherited keys are not mistaken for prior values. | `tests/security-boundaries.test.mjs` |
| A18 | Medium | The release coverage gate accepted an empty measurement as 100% because generated `sourceURL` labels pointed outside its include filter. Unmapped builds now retain their emitted paths; the gate rejects empty/missing measurements without lowering thresholds. | `tests/test-coverage.test.mjs` includes an actual compiler/V8 subprocess regression |

## Validation

- Baseline complete release gate: 819 tests passed, plus site builds, documentation/package conformance, and repository security checks. The reported baseline coverage was invalid: generated source labels caused all framework files to be excluded from measurement (A18).
- Focused checks: authentication/backend/MCP/WebAuthn/OIDC; storage/jobs/billing/product features; DOM/SSR/static paths; deployment/platform/migration regressions.
- Final `npm run check` **passed on Node 24.21.0**: **846 tests, 846 passed, zero failures/skips/cancellations**, with real framework coverage of **86.50% lines, 77.59% branches, and 85.05% functions**. The unchanged thresholds are 80%, 65%, and 80% respectively. This adds 27 tests to the 819-test baseline.
- Framework, documentation, Design Studio, and Synth builds passed. Documentation/declaration/export audits, the ten-stage packaged-release conformance journey, publication allowlist, current-tree/history credential checks, and workflow/release security checks all passed. `git diff --check` is clean.
- An intermediate full run passed 842/843 tests; the existing background-startup test took 493.7 ms against its 400 ms assertion during overlapping validation. The unchanged test passed in isolation. Final validation runs without other audit test processes.
- GitHub's open CodeQL and Dependabot alert APIs both returned empty lists during this audit. This does not mean the new patch has received a hosted CodeQL run.
- Template dependency review: 71 distinct packages and 102 resolved package versions (including optional dependencies and the declared Tailwind minimum) returned no known npm advisories. See [dependency evidence](dependency-advisories.json). The normal lock-only resolution attempt was blocked by the host's remote-package policy, so this check used metadata only and did not relax that policy.

The final check command was:

```sh
PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH npm run check
```

The validation runtime lives outside the repository; an installed Node 24 runtime can be used instead. Test execution did not require adding framework dependencies. The normal build regenerated tracked example JavaScript to remove the same absolute source labels; generated `dist` and vendored site output remain ignored.

## Compatibility and limits

- Legacy file downloads now prompt download instead of serving arbitrary content inline. Private storage directories/files with unsafe ownership, permissions, symlinks, or metadata fail closed; operators may need to correct existing storage permissions.
- Job deduplication is now per owner. Existing jobs are retained; startup migrates the uniqueness index transactionally.
- Removed workspace members lose creator fallback. Delegated project tokens remain independent credentials, with no promise of cascading parent revocation.
- Migration safety conservatively rejects single-quoted literals beginning with reserved `clank_`/`proact_` prefixes, including data literals, because SQLite also accepts them as identifiers. Review affected migrations rather than silently bypassing the guard.
- Tests use Node 24.21.0, downloaded from Node.js and verified against its published SHA-256 manifest. The host's Node 26.7.0 cannot build the existing compiler because Node 26 removed `stripTypeScriptTypes` transform mode. That pre-existing compatibility issue is outside these security fixes; see the [Node.js API history](https://nodejs.org/api/module.html#modulestriptypescripttypescode-options).
- This is a repository and controlled local-test audit. It does not attest production TLS/egress, OS/container isolation, live provider configuration, account access, physical authenticators, or deployed secret rotation. Host administrators and application source remain trusted under the repository's threat model. Filesystem validation does not create a sandbox against a malicious administrator.
- Credential scanning is heuristic; registry advisories are a point-in-time lookup. The audit cannot prove the absence of other vulnerabilities. No deployments, releases, remote pushes, public vulnerability reports, or credential rotations were performed.
