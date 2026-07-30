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

## 2026-07-30 integrated development loop phase

- [x] Replaced generated one-shot development scripts with one `clank dev` command driven by the
  same transparent build, entry, environment, and health contract used for deployment.
- [x] Added serialized project watching, atomic compiler output reuse, candidate health checks,
  last-good-process retention, bounded crash recovery, graceful replacement shutdown, and reserved
  output/database/dependency exclusions.
- [x] Added a bounded loopback reverse proxy that preserves streaming/non-HTML responses, injects a
  CSP-compatible external reload client into eligible HTML, and fans out reloads to at most 64
  connected browsers.
- [x] Added newline-delimited `clank-dev-event/1` lifecycle output for agents while keeping build
  and application diagnostics on stderr.
- [x] Passed the complete local gate: 328 tests, 85.92% line coverage, a 209-file packed
  allowlist, packaged consumer/auth/MCP/deploy/migration/failure/rollback conformance, 59-file
  documentation audit, complete current-tree and reachable-history credential scans, and the
  zero-dependency security policy checks.
- [x] Verified a freshly generated minimal app in Chromium: SSR hydration attached in place,
  reactive interaction updated without navigation, a source edit rebuilt and health-swapped to
  revision 3, the existing tab reloaded over SSE at the unchanged URL, and the rendered page had no
  console or page errors.
- [x] Recorded [PR #107](https://github.com/nearbycoder/clank.run/pull/107): Node 22.16,
  Node 24, packaged conformance, JavaScript/TypeScript analysis, and CodeQL passed before squash
  merge `dab6b96b818f5ce612ce767ae0a453867010d678`; post-merge CI run `30559675869`, CodeQL
  run `30559676098`, and docs deployment run `30559836141` passed on that exact source.
- [x] Railway deployment `da0cbcc0-b52b-4686-8d5a-35862f28a726` activated the exact merge
  commit through `/railway.json`, removed the prior generation only after success, and served
  healthy database-backed readiness. `docs.clank.run` remained healthy at version `0.10.0`.
- [x] Added no Railway service, replica, volume, database, bucket, or other paid resource.

## 2026-07-30 executable AI blueprint phase

- [x] Expanded generated apps from one primary entity/route into every declared static route,
  entity, field type, reference selector, and role-filtered navigation target with SSR, hydration,
  live or request/response data, responsive Tailwind UI, stable agent controls, and no client-only
  authorization assumption.
- [x] Preserved exact declared server-action names and descriptions across browser RPC, public
  manifests, OAuth-scoped MCP tools, and contract revisions; enforced declared roles in backend
  handlers; generated sparse updates and explicit safe CRUD fallbacks; and left custom domain
  actions as warning-bearing implementation points instead of inventing argument schemas.
- [x] Added explicit/inferred relationship references plus bounded, atomic `restrict`, `nullify`,
  and recursive `cascade` deletion. Rejected cross-ownership deletes, nullable mismatches,
  ambiguous relationship storage, cascade cycles, dangling/cross-owner create or update
  references, empty route-role policies, route/framework collisions, and generated type-name
  collisions.
- [x] Added public bounded `BackendActionError` mapping for browser RPC and MCP while keeping
  unexpected failures private and transactionally rolling back partial work.
- [x] Wired generated service requirements into startup and health. Local `clank dev` receives
  explicit development-only drivers; production has no pretend drivers and fails before serving
  when a required integration is missing.
- [x] Added multi-entity runtime coverage for exact actions, owner/member denial, SSR route source,
  MCP manifests, empty updates, relationship rollback, restrict/nullify/cascade completion,
  request/response entities, service wiring, and both browser-RPC and MCP application errors.
- [x] Corrected select binding order so generated enum/reference form resets apply after their
  options mount, and separated development module revalidation from production immutable caching.
- [x] Wrapped generated route navigation on narrow viewports and closed runtime streams concurrently
  with the HTTP server and service drivers so long-lived connections cannot stall shutdown.
- [x] Applied explicit post-JSON JavaScript-source escaping to every generated literal and added
  adversarial compilation/rendering coverage after CodeQL identified closing-script data flows.
- [x] Rewrote the blueprint guide around executable semantics, validation, generated files,
  relationship/service boundaries, per-app MCP parity, and honest warnings; expanded each generated
  README and `AGENTS.md` with the concrete app contract and provisioning boundary.
- [x] Passed the complete local gate: 334 tests, 86.46% line / 75.40% branch / 87.04% function
  coverage, 59 Markdown files, 252 local links, 54 indexed guides, 35 synchronized declaration
  files, 33 package exports, packed consumer/deploy/migration/rollback conformance, release/current
  tree/history credential scans, and a 211-file npm dry run under the five-MiB ceiling.
- [x] Browser-certified a generated five-route workspace on desktop and 390 px mobile: registration,
  SSR/hydration, exact mutations, live and request/response refresh, reference selection, form
  resets, transactional relationship restriction, development replacement, responsive layout,
  browser diagnostics, and live-stream shutdown all passed.
- [ ] Record PR checks, CodeQL, merge SHA, post-merge docs deployment, Railway activation, and
  production health.
- [x] Added no Railway service, replica, volume, database, bucket, or other paid resource.

## 2026-07-30 version 0.10.0 release phase

- [x] Selected a minor release because the accumulated public provider, preview, usage, and
  agent-readable CLI capabilities extend the package without intentionally breaking existing APIs.
- [x] Synchronized `package.json`, the dated changelog release heading, and the Getting Started
  dependency example at `0.10.0`.
- [x] Added a permanent release-gate check preventing those three release identities from drifting.
- [x] Passed the complete local gate: 327 tests, 85.92% line / 74.60% branch / 86.54%
  function coverage, 59 Markdown files, 249 local links, 35 declaration files, 33 package
  exports, packed-release conformance, and package/current-tree/reachable-history credential scans.
- [x] Inspected the dry-run npm package: `@clank.run/framework@0.10.0`, 208 files, 1,148,732-byte
  tarball, and 4,465,769 unpacked bytes under the enforced five-MiB ceiling.
- [x] Recorded the release chain: [PR #105](https://github.com/nearbycoder/clank.run/pull/105)
  passed Node 22.16, Node 24, packaged conformance, JavaScript/TypeScript analysis, and CodeQL;
  merge `9919ef8f9e3412ec45302cdec2e745ffb56f69ec` passed post-merge CI, CodeQL, and docs
  deployment; annotated tag `v0.10.0` points to that exact commit; and
  [release run 30555610181](https://github.com/nearbycoder/clank.run/actions/runs/30555610181)
  rebuilt, tested, packed, attested, attached, and staged the package through npm trusted
  publishing.
- [x] Verified and approved npm stage `52dfe47b-dcb0-47aa-8818-6f1ffe63fa84`: the staged
  tarball's SHA-1 `a6d59fdf13e5342ba6716f3654c49e17071a7ebb` and SHA-256
  `0bb635dd0f678f6e59c5a7cf8e619c6e8ca56451da17e23ac6f87728086c4c22` match the npm
  registry and GitHub release asset. npm reports verified registry signature and SLSA provenance,
  with `latest` resolving to `0.10.0`.
- [x] Installed `@clank.run/framework@0.10.0` from the public registry into an empty directory,
  generated the authenticated Todo starter through the packaged CLI, installed it without
  vulnerabilities, verified registry signatures/attestations, built Tailwind and all TypeScript,
  passed `clank doctor`, and served healthy SSR, hydration state, MCP discovery, and OAuth metadata.
  `https://docs.clank.run/healthz` reported version `0.10.0`, while Railway served the exact merge
  commit with healthy liveness and readiness checks.
- [x] Added no Railway service, replica, volume, database, bucket, or other paid resource.

## 2026-07-30 agent-first create phase

- [x] Added a versioned human/JSON template catalog with explicit starter capabilities.
- [x] Added a structured create result with project identity, framework dependency, file
  checksums, and copyable next commands.
- [x] Bounded and context-encoded user-selected project names before generating TypeScript, TSX,
  or Markdown.
- [x] Rejected create targets that are files or symbolic links before copying any scaffold files.
- [x] Corrected blueprint-generated login guidance to use the hosted `https://clank.run` default.
- [x] Passed the complete local gate: 327 tests, 85.92% line / 74.60% branch / 86.54%
  function coverage, 59 Markdown files, 249 local links, 35 declaration files, 33 package
  exports, packed-release conformance, and package/current-tree/reachable-history credential scans.
- [ ] Record GitHub CI/CodeQL evidence, merge SHA, and post-merge documentation result.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 provider diagnostics phase

- [x] Added a bounded memory-only provider output tail with role/instance/stream metadata.
- [x] Added one-shot exact-container memory/limit, CPU, PID, network-I/O, and block-I/O sampling
  without shell execution or public container identity.
- [x] Added a generation-bound private control route with strict auth, query, response-size, and
  lifecycle serialization.
- [x] Added control-plane origin/identity/length/schema/aggregate validation, post-transfer
  placement recheck, and project-secret redaction.
- [x] Added resilient project Performance and Logs UI integration; a failed diagnostic sample does
  not suppress stored traffic metrics or durable platform logs.
- [x] Passed the complete local gate: 326 tests, 85.92% line / 74.61% branch / 86.54%
  function coverage, 59 Markdown files, 249 local links, declaration/export synchronization,
  packed-release conformance, and package/current-tree/reachable-history credential scans.
- [ ] Record GitHub CI/CodeQL evidence, merge SHA, and post-merge documentation result.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 provider restore control-plane phase

- [x] Added durable replacement-generation intent binding the exact recovery ID, authenticated
  digest, byte count, safety-backup ID, active release, frozen environment, and generation.
- [x] Re-authenticated encrypted recovery bytes during private capsule loading and rechecked the
  immutable generation record after the bounded read.
- [x] Added target verification, provider safety-backup creation, pending retention protection,
  post-drain provider safety, SQLite replacement, current migrations, health-gated publication,
  timeout resume, failed-operation re-fencing, and queue/completion audit.
- [x] Upgraded existing provider-generation tables in place while preserving old generations as
  ordinary `preserve` intent.
- [x] Passed the complete local gate: 325 tests, 85.94% line / 74.83% branch / 86.45%
  function coverage, 59 Markdown files, 249 local links, declaration/export synchronization,
  packed-release conformance, and current-tree/history credential scans.
- [ ] Record GitHub CI/CodeQL evidence, merge SHA, and post-merge documentation result.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 provider backup control-plane phase

- [x] Added exact active-node/generation provider snapshot consumption with private derived
  credentials, redirect refusal, response deadlines, streaming byte bounds, exact identity
  headers, checksum verification, and post-transfer placement revalidation.
- [x] Routed manual and scheduled provider backups into the existing AES-256-GCM local or
  S3-compatible repositories without plaintext staging; enabled listing, verification, quotas,
  retention, scheduler state, UI status, audit, and provider-project object purge.
- [x] Corrected first provider deployment from impossible `preserve` mode to isolated database
  initialization while retaining preserve semantics for every later generation.
- [x] Added positive private-HTTP export/encryption/verification coverage plus stale response,
  credential non-persistence, scheduler inclusion, provider capacity, and fixed public failure
  assertions.
- [x] Re-certified all 322 tests at 85.96% line, 74.85% branch, and 86.41% function
  coverage; 59 documentation files, 249 local links, 35 declaration files, and 33 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [ ] Record GitHub CI/CodeQL evidence, merge SHA, and post-merge documentation result.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 provider recovery foundation phase

- [x] Added a generation-bound provider snapshot control endpoint with a separate capsule secret,
  in-memory digest retention, fixed non-enumerating failures, exact durable release/generation
  checks, consistent provider-data export, and verified response identity.
- [x] Added import-only encrypted recovery repositories, direct in-memory snapshot encryption, and
  bounded authenticated backup reads without plaintext repository staging.
- [x] Preserved local and S3-compatible object repositories, retention protection, explicit
  restore targets, and the zero-dependency contract.
- [x] Added focused missing/wrong/stale provider credential, restart/stop revocation, response
  identity, invalid SQLite/checksum, no-plaintext-staging, explicit-target restore, and object
  round-trip coverage.
- [x] Re-certified all 320 tests at 85.99% line, 74.89% branch, and 86.44% function
  coverage; 59 documentation files, 249 local links, 35 declaration files, and 33 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [ ] Record GitHub CI/CodeQL evidence, merge SHA, and post-merge documentation result.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

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
- [x] Merged PR #88 as `097f3db4022e0d0cba68e4e575f25426d468c740` after Node 22/24,
  packaged-release conformance, and CodeQL passed; post-merge CI, CodeQL, docs deployment, human
  guide, and agent JSON completed successfully.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 provider runtime ingress phase

- [x] Added a zero-dependency provider-private registry with strict generation bindings,
  loopback-only upstreams, plaintext-token non-retention, and non-secret inspection.
- [x] Validated the edge contract end to end, stripped reserved and hop-by-hop headers in both
  directions, bounded URLs/bodies/time/capacity, preserved streaming, and returned one generic
  unavailable result for unknown, forged, and stale bindings.
- [x] Reserved requests before asynchronous token verification, supported safe old/new generation
  overlap, fenced stale/conflicting activation, and revoked exact generations before draining.
- [x] Kept process launch, sandboxing, SQLite mutation, control-plane routing, TLS, and restart
  reconciliation explicit rather than implying that a proxy creates those guarantees.
- [x] Re-certified all 290 tests at 86.15% line, 74.76% branch, and 86.00% function
  coverage; 57 documentation files, 212 local links, 33 declaration files, and 31 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [x] Merged PR #89 as `07811e9e5cc1e2595e1b2dbc2425555e94faf4ad` after Node 22/24,
  packaged-release conformance, and CodeQL passed; post-merge CI, CodeQL, docs deployment, human
  guide, and agent JSON completed successfully.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 Docker launcher environment-boundary phase

- [x] Removed application-named environment variables from the host-side Docker CLI process.
- [x] Added a single name-only encoded runtime envelope that is decoded and deleted inside the
  container before application import, without putting secret values in process arguments.
- [x] Covered Docker daemon redirection and dynamic-loader injection names with an end-to-end fake
  Docker regression while preserving application secret delivery.
- [x] Re-certified all 290 tests at 86.16% line, 74.74% branch, and 85.99% function
  coverage; 57 documentation files, 212 local links, 33 declaration files, and 31 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [x] Merged PR #90 as `ab12eb7a629567e4f6b7d22adea1d661e09ce0ae` after Node 22/24,
  packaged-release conformance, and CodeQL passed; post-merge CI, CodeQL, docs deployment, human
  guide, and agent JSON completed successfully.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 complete provider service phase

- [x] Added a zero-dependency high-level provider service that independently verifies runtime
  capsules, persists exact owner-only operation/generation/fence intent, and composes provider
  data, isolated Docker launch, stopped desired state, and private runtime ingress.
- [x] Enforced drain-before-stop and journal-recovery-after-quiescence ordering, exact
  response-lost retry, restart relaunch without process adoption, conflict fencing, ingress-last
  activation, and reverse-order failed-candidate cleanup.
- [x] Deferred workers and the scheduler until provider data commits, and added a data-store
  discard hook that must prove candidate cleanup before uncommitted SQLite rollback or leave
  recovery journaled.
- [x] Added focused restart, retry-after-commit, activation failure, undrained traffic, same-fence
  conflict, private metadata, deferred background, and cleanup-before-rollback coverage.
- [x] Re-certified all 305 tests at 86.07% line, 74.84% branch, and 86.06% function
  coverage; 59 documentation files, 246 local links, 35 declaration files, and 33 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [ ] Record GitHub CI, CodeQL, merge, post-merge, and live documentation evidence.
- [x] Added no Railway service, volume, database, bucket, or other paid resource.

## 2026-07-30 isolated provider Docker runtime phase

- [x] Added a zero-dependency reference launcher for the exact verified web, worker, and scheduler
  topology with private loopback health and non-secret candidate inspection.
- [x] Required immutable images and non-root execution by default; constrained root, capabilities,
  privilege escalation, memory/swap, CPU, PIDs, tmpfs, logs, mounts, restart policy, stop time,
  project count, container count, and loopback port allocation.
- [x] Delivered the final application environment through bounded container stdin after Node
  startup, keeping capsule secrets out of Docker arguments, labels, host application variables,
  and persisted container environment metadata.
- [x] Bound launch to the exact config returned by verified provider data, exposed no environment
  or ingress token through inspection, fenced conflicting/stale generations, and allowed exact
  committed-generation restart for failed-rollout recovery.
- [x] Added exact-owner startup orphan cleanup, uncertain-create cleanup, graceful verified stop,
  no process adoption after restart, and launch/health/close race fencing.
- [x] Re-certified all 295 tests at 86.07% line, 74.66% branch, and 85.79% function
  coverage; 58 documentation files, 227 local links, 34 declaration files, and 32 package
  exports; packed consumer conformance; and package, current-tree, and reachable-history security
  scans.
- [x] Merged PR #91 as `2d0ea94203ab336b8ea836a6ae5b41e74ce36de1` after Node 22/24,
  packaged-release conformance, and CodeQL passed; post-merge CI, CodeQL, docs deployment, human
  guide, and agent JSON completed successfully.
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
