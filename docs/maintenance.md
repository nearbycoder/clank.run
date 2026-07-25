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
