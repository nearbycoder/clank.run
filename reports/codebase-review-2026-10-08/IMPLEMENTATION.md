# Implementation ledger

Base: `4b990199965204f1200fcd0fb4ca2b7eb0b02bbc`, equal to freshly fetched `origin/main` on 2026-10-08.

Proposal: [issue #244](https://github.com/nearbycoder/clank.run/issues/244). Twenty-one features are merged across eighteen feature batches. Scheduled release windows (05) merged in [PR #282](https://github.com/nearbycoder/clank.run/pull/282) after all six fresh hosted checks at reviewed head `4c06c2f5d35940872afa6d1fa947c97c25b04597`, no new CodeQL alerts, no unresolved threads and an author review explicitly recorded as non-independent. The protected squash merge has the exact reviewed tree. Verified organization identity linking (11) merged in [PR #285](https://github.com/nearbycoder/clank.run/pull/285) after fresh combined full Node 26/22 gates and all six hosted checks. Both main checkouts match `2ce344a4301e4aa1ac42e4284ff28a8a2d7eb1ec`, with the exact reviewed tree and all 23 existing files preserved. Nineteen features remain; scoped provisioning (12) is next under [proposal #287](https://github.com/nearbycoder/clank.run/issues/287). Disposable reference-profile certification has real acceptance evidence; production Railway remains uncertified. Earlier snapshots below retain their original validation scope.

A feature is complete only when its documented acceptance evidence exists. Proposed contracts do not count as implemented features. The review baseline remains historical evidence; this ledger records subsequent work.

## Verified organization identity linking

Feature 12 is in implementation under [proposal #287](https://github.com/nearbycoder/clank.run/issues/287).
The focused HTTP, signed identity and native membership suite passes 39 checks, including an
actual accepted-write SIGKILL/restart and a separate process's live/browser/CLI/MCP revocation.
All 29 packed type fixtures pass without new source diagnostics. Full release gates and hosted
review remain pending; this does not change the accepted 21/40 feature count.

Feature 11 is implemented under [proposal #283](https://github.com/nearbycoder/clank.run/issues/283)
and merged in [PR #285](https://github.com/nearbycoder/clank.run/pull/285) with the canary drain and concurrent-fixture repairs after all fresh acceptance gates. Existing signed-in users can explicitly link
organization identities after real local MFA/passkey and fresh provider authentication. Stable
issuer/subject ownership, current policy/session/generation fences and versioned receipts prevent
email-only merging, stale callbacks or receipt replay from removing a later relink. Transactional
migration retains legacy identities and revocation/audit evidence. Dedicated accounts keep their
prior global-disable behavior; explicitly shared accounts retain unrelated organization access.

Scoped unlink/offboarding removes the exact organization membership and project grants, revokes
all browser/recovery/generic OAuth credentials and broad platform tokens, and preserves unrelated
organization/project-scoped credentials. Voluntary unlink requires another enabled owner when
removing ownership. A regression reproduced acceptance with only a disabled co-owner; the final
query rejects it. Forced provider offboarding remains authoritative. Last-owner operator recovery
belongs to feature 13; independent platform operator authority remains a separate grant.

All 74 focused checks and 28 packed positive/negative type fixtures pass without new source
allowances. Fresh combined full Node 22/26 gates each pass 1,970 reported / 1,967 passed /
zero failed or cancelled / three existing skips. Coverage is 91.75/80.61/89.96 on Node 26 and
91.75/80.63/90.00 on minimum Node 22. All six hosted checks pass with no new CodeQL alerts or
unresolved threads; author review is explicitly non-independent. Two actual SIGKILL/restart cycles
preserve accepted callback/unlink receipts and one durable removal; an old receipt cannot remove
a fresh relink. Actual keyboard/provider/MFA flows and account/revocation isolation are verified.
Lost accepted responses now reload current auth for HTTP errors, malformed/oversized bodies and
network failures. The client enforces a fifteen-second deadline and 256 KiB streaming limit.

The unchanged package contract contains 405 files / 6,130,854 unpacked bytes, with 160,602 bytes
remaining. Documentation build, doctor, offline artifact and HTTP/MCP checks pass. Desktop/phone
HTML, search and final guide text are verified; blocked browser agent-format navigation is
reported separately from successful HTTP/MCP verification. Hosted CodeQL also identified a fixture callback redirect; the destination is now fixed, and
actual GET/POST foreign-origin and wrong-path refusals plus valid/restart flows pass. No external
enterprise IdP tenant certification or production host certification is claimed. A full-suite run also caught candidate
cleanup terminating an admitted canary request; PR #286 merged its repair with deterministic
held-response proofs. The subsequent combined run exposed concurrent fixture installation/port
collisions; PR #288 merged test isolation after both full gates and all six hosted checks. Actual
failed tests were not retried; the fresh combined acceptance passed before protected merge. See [immutable acceptance evidence](identity-linking.json).

## Erased-line package prerequisite

Complete horizontal runs containing erased types now compact in unmapped builds, and fully
erased declaration lines retain their newline without indentation. Literal whitespace, token
separators, ASI, CRLF and mapped debugging output remain intact. The new size regression fails
on the previous compiler. All 47 focused cases and both complete Node 22/26 release gates pass:
1,946 reported / 1,943 passed / zero failed or cancelled / three existing privileged skips.
All 27 packed type fixtures pass with 159 existing diagnostics and no additions. Documentation
build, doctor, offline artifact and HTTP/MCP checks pass; desktop/phone HTML and search are
verified. Browser-blocked agent formats are verified separately by HTTP. The unchanged 405-file,
6 MiB ceiling now contains 6,100,641 bytes, saving 165,991 and leaving 190,815. All six fresh hosted checks passed, with no new alerts or unresolved threads. The ordinary
expected-head protected squash merge in [PR #284](https://github.com/nearbycoder/clank.run/pull/284)
has the exact reviewed tree. Both main checkouts are synchronized, and all 23 existing files
are preserved. This prerequisite adds no feature to the 20/40 count.
See [immutable acceptance evidence](erased-padding-prerequisite.json).

## Scheduled release windows

Feature 05 is implemented under [proposal #280](https://github.com/nearbycoder/clank.run/issues/280)
and merged in [PR #282](https://github.com/nearbycoder/clank.run/pull/282) after all six fresh
hosted checks, zero new alerts or unresolved threads, an explicit non-independent author review
and ordinary expected-head protected merge. The merged tree equals the reviewed tree. An exact current channel pin can be
queued for explicit UTC instants with an IANA timezone preview. The durable schedule captures
source artifact identity, target binding/active release, dependency version and the initiating
credential. Existing store leases and a monotonic claim fence execution; current authority,
artifact and required-service readiness are checked around asynchronous work and atomic
schedule/channel/environment acceptance. Cancellation uses a direct versioned CAS, and
interrupted ownership retains fences until verified prior-writer recovery. API, CLI and console
share exact retained receipts. Sign-out or credential revocation prevents pending execution.

All 17 local contracts, four console race regressions and 27 packed positive/negative consumer
fixtures pass with no new source diagnostics. The complete Node 22 gate passes 1,945 reported /
1,942 passed / zero failed or cancelled / three existing privileged skips; coverage is
91.87/80.52/90.14. Node 26 passes 1,941 reported / 1,938 passed, plus the four final console cases.
Ten actual disposable Docker/XFS provider checks pass, including controller restart, exact
replay, cancellation and expiry after candidate data commit, changed migration rejection and
complete owned cleanup. Real browser checks cover lost response/exact retry, keyboard
cancellation, controller-kill recovery, late inspection after navigation, root-access revocation,
sign-out and responsive cards. All production hashes are unchanged between the two full gates;
final differences are additional tests and an improved provider acceptance barrier.

Cancellation restores prior local data for apply-safe migrations. Provider code-only recovery
restores prior code while retaining committed application writes; it does not roll those writes
back. There is no exact-clock delivery guarantee. Capacity is 100 unresolved / 1,000 total retained
schedules per family; history is not silently pruned. The unchanged package budget contains
405 files / 6,266,632 unpacked bytes, with 24,824 bytes remaining. Documentation build,
doctor/offline artifact and HTTP/MCP checks pass. Desktop/phone HTML and search are verified;
non-HTML agent formats are blocked by the browser and verified by HTTP separately. See
[acceptance](release-windows.json) for immutable source/log/capture hashes, failed fixture
assumptions and precise limits. Production Railway remains uncertified.

## Deployment dependency gates

Feature 04 is merged in [PR #281](https://github.com/nearbycoder/clank.run/pull/281) under
[proposal #279](https://github.com/nearbycoder/clank.run/issues/279). Versioned requirements
cover managed services in the same workspace, bounded active/health readiness and optional upload
SHA-256. Browser reviews bind a credential-specific five-minute check ID, configuration version
and exact service activation sequence. Ordinary uploads, local canaries, explicit rollback and
environment/channel promotions revalidate current authority and identities before publication.
Human overrides require the configured policy, current administrator session and exact approval;
they bypass readiness alone. Interrupted work retains writer and artifact fences until verified
snapshot recovery or certified provider compensation.

Final review reproduced acceptance after service status or runtime policy changed during the last
actual health response. Private runtime identity now fences those changes; both regressions
verify rejection and restoration of the prior database. All 50 local deployment contracts and 26 packed consumer fixtures pass with no new diagnostics
against the unchanged type baseline. Thirteen real disposable Docker/XFS provider cases pass,
including first-activation cleanup, protected initialization proof across restart, retained data,
changed migrations, service replacement, unhealthy readiness, rollback replay, real provider
required-service generation changes and complete owned
resource cleanup. These drills found and fixed invalid initial stop requests and attempts to
reinitialize retained data. Real keyboard, mobile, override, service replacement, controller-kill
recovery and workspace revocation checks pass. The first complete Node 26 run found nine legacy
isolated-fixture failures; the corrected complete run passes 1,924 reported / 1,921 passed / zero
failed or cancelled / three existing privileged skips, plus coverage, documentation, conformance
and security. The final complete Node 22 gate also passes 1,924 reported / 1,921 passed / zero failed or
cancelled / three existing privileged skips, with coverage 91.85/80.50/90.14. The unchanged
405-file, 6 MiB package ceiling contains 6,223,690 unpacked bytes. All six updated-head hosted checks pass, with no new CodeQL alerts or unresolved threads. The protected merge matches the reviewed tree. Documentation
build/doctor/offline checks and HTTP/MCP contracts pass. The in-app browser blocks non-HTML raw
and agent formats; their HTTP contents are verified, with desktop/phone guide and live search
checks recorded separately. See [dependency acceptance](deployment-dependencies.json) for exact
source hashes, failed diagnostics, source deltas and limits. Production Railway remains uncertified.

## Persistent release channels

Feature 03 is merged in [PR #278](https://github.com/nearbycoder/clank.run/pull/278) under
[proposal #276](https://github.com/nearbycoder/clank.run/issues/276). Named channel pins retain exact successful uploads and
immutable history. API, CLI and dashboard share explicit promotion, historical rollback and
retirement. Target activation, acceptance receipts and rollback pointer publication commit
atomically. Exact accepted replay returns its original result without deploying old code again.
Pins protect cleanup and source-project deletion; pending rollback reserves bounded history
capacity. Retirement preserves uploads/data and keeps a monotonically versioned name tombstone.

All twelve actual local contracts pass, including SIGKILL/recovery, revoked source/target access,
concurrent CAS updates, seeded capacity limits, exact old-entry reads, CLI parity and configured
fresh authentication. Eight actual Docker/XFS provider cases pass. That proof reproduced and
fixed compensation resolving newly edited secrets again: recovery now restores the prior active
generation's frozen environment. Browser checks pass for keyboard pin/promotion/rollback, a
lost accepted response, retained exact retries across project navigation, phone error focus,
revoked access and field cleanup. Identity rendering now keeps Apply disabled without a current
review. Both complete Node 22.16 and 26.10 gates pass: 1,898 reported / 1,895 passed / zero
failed or cancelled / three existing privileged skips, with measured coverage above every floor.
A reproduced Node 26 truncated reporter error now receives the existing one bounded retry;
real test failures, cancellation, threshold misses and empty coverage still fail immediately.
Twenty-five packed consumer fixtures pass with 159 existing source diagnostics against the
unchanged 163 baseline. The 405-file package occupies 6,123,915 bytes under the unchanged 6 MiB
ceiling. Docs build/doctor/offline verification, desktop/phone reading/search and all twelve
actual HTTP/MCP checks pass. The downgrade guide explicitly requires retiring pins before
reverting to a controller that cannot enforce them. No production host was modified.
See [channel acceptance](release-channels.json), including failed diagnostic runs and the exact
provider-tested source delta and protected merge. All six fresh hosted checks passed at the
reviewed head; no new CodeQL alerts or unresolved threads remain. Eighteen features are merged
across fifteen batches; twenty-two remain. The author review is explicitly non-independent.

## Artifact promotion across environments

Artifact promotion (02) is merged under [proposal #275](https://github.com/nearbycoder/clank.run/issues/275) and [PR #277](https://github.com/nearbycoder/clank.run/pull/277).
The API, CLI and dashboard now bind independent targets with version checks and exact-upload
promotion receipts. Local tests exercise byte identity, independent data/secrets, production
roles, revoked source/target access, failed health, actual controller SIGKILL and verified
snapshot recovery after the prior writer's final write. Real browser checks cover keyboard
promotion, retained project drafts, stale review, phone width and revocation clearing.
Twenty-four packed consumer fixtures pass with 159 existing source diagnostics against the
unchanged 163 allowance. Documentation builds, offline artifact verification and all twelve
HTTP/agent endpoint checks pass. Nine real provider authority/expiry cases pass, including
current certification, exact bytes, independent state, controller restart, four staged/queued
revocations, actual certificate expiry and verified cleanup. All eight health/restart cases
also pass against the guardian readiness fix. A delayed real guardian regression passes; daemon
fixture PID records now update atomically, and an owned orphan from the earlier truncated record
was stopped after verifying its exact command, directory and process group. The actual Docker
controller SIGKILL/restart regression passes. Complete Node 26 verification passes with 1,886
reported / 1,883 passed / zero failed or cancelled / three existing privileged skips; coverage
91.80/80.39/90.08. Minimum Node passes every test and coverage; its remaining conformance/security
phases pass separately after supplying npm on PATH. Hosted Node 22/24, types and conformance
pass at the initial PR head, but CodeQL finds two fixture code-sanitization alerts. The fixture
now loads parameters as JSON; all twelve affected minimum-Node tests pass. All six fixed-head
hosted checks pass, including full Node 22/24 and CodeQL with no new alerts. Both findings are
resolved; the protected squash merge has the exact reviewed tree. Seventeen features are merged;
twenty-three remain. Both checkouts are synchronized and all 23 existing files are preserved.
See [promotion acceptance](environment-promotions.json) for evidence and failed diagnostic runs.
The next persistent-channel contract is proposed in [issue #276](https://github.com/nearbycoder/clank.run/issues/276).

## Local provider fleet simulator

Proposal [#273](https://github.com/nearbycoder/clank.run/issues/273) adds fixed, portable
scenarios and bounded placement/fence timelines through an optional API and the provider CLI.
Actual coordinator, provider and agent processes exercise takeover, lease loss, slow HTTP
transport, a private read-only mount and coordinator/provider restarts. A current host
certificate and explicit disposable authorization are required.

The real Node 22.16 Debian guest passes all six faults and six additional acceptance cases:
live cancellation, parent SIGKILL, denied owned cleanup, an already-reserved quota, insufficient
certificate lifetime and the actual CLI. Cleanup failure and parent death retain admission
fencing until verified recovery. Exact artifacts, increasing fences, revoked/stale access,
real ingress and committed migration/data state are checked. Portable takeover initializes a
synthetic database; the separate stopped stateful placement proves control-store pinning.
Database replication and automatic supervisor leadership are outside this feature.

The drills exposed two existing defects: capability-bearing non-root providers could not
launch Bubblewrap SQLite workers, and umask 077 changed verified artifact modes. Child-only
capability clearing and explicit restoration of verified modes fix those paths.

All 28 focused minimum-Node tests and 23 packed consumer fixtures pass, with 159 existing
source diagnostics against the unchanged 163 allowance. The final Node 26 release gate
reports 1,873 tests / 1,870 passed / zero failures or cancellations / three existing
privileged skips, and coverage 91.83/80.39/90.12. Documentation, conformance and security
pass. The 405-file package is 5,992,002 bytes under the unchanged 6 MiB ceiling. Desktop/phone
docs search, navigation, guide and real HTTP/agent endpoints pass. An earlier local Node 22
full gate failed closed on truncated V8 coverage JSON despite all tests passing; its full
coverage result is not claimed, and hosted Node 22 remains required.

See [fleet acceptance evidence](fleet-simulator.json). Feature 34 is merged in [PR #274](https://github.com/nearbycoder/clank.run/pull/274)
after all six hosted checks pass at reviewed head `01ff61d95e23d2da597eb81ad564e36a970b6097`.
The protected merge tree matches the reviewed tree, both checkouts are synchronized and
all 23 existing files are preserved. Sixteen features are merged; twenty-four remain.
Production Railway remains uncertified.

## Minimum-Node package prerequisite

Proposal [#271](https://github.com/nearbycoder/clank.run/issues/271) extends compacted native
stripping to unmapped erasable Node 22/24 builds. Unsupported syntax alone falls back to their
native transformation, preserving enum/namespace/parameter-property runtime semantics. Mapped
output and the Node 26 compatibility boundary stay unchanged. Concise core/forms source
comments keep the original browser byte ceilings; their transformed runtime code is identical.

All ten compiler cases pass separately on Node 22.16, 24.21 and 26.10. The final minimum-Node
release gate passes: 1,868 reported / 1,865 passed / zero failed/cancelled / three existing
privileged skips; coverage 92.11/80.39/90.43 line/branch/function. All 22 packed type fixtures
pass with 159 existing source diagnostics against the unchanged 163 allowance. Documentation,
conformance and security checks pass. The 403-file package shrinks by 329,823 bytes to
5,946,809, leaving 344,647 under the unchanged 6 MiB ceiling. No additional feature is counted.
Hosted Node 22 exposed concurrent build output changes during a certification fixture. The
fixture now uses a private immutable installation snapshot, preserving every strict admission
assertion; all four focused cases and the revised complete local gate pass.
See [compiler strip evidence](compiler-strip-review.json). Existing immutable artifact bytes
are preserved; updated framework installations need fresh host certification.

## Merged main and follow-up maintenance

PRs #245, #246 and #247 are merged. The subsequent maintenance review starts from main commit `1e6e62acbf2e59400c023bd3a33125fe1fc2c7d4` and fixes Task failure/cleanup/listener behavior, account-screen isolation, anonymous verification guards, HTTP error observers and durable delivery retries/revocation. It also corrects canary worker-readiness and kernel-probe timing fixtures. No additional roadmap feature is counted as delivered.

The complete maintenance gate passes with 1,657 tests reported, 1,654 passed, zero failures/cancellations and three privileged-host skips. Coverage is 91.96% lines, 79.69% branches and 89.86% functions. All 126 focused tests and 13 packed consumer fixtures pass; source diagnostics are reduced from 290 to 278 without increasing baseline allowances. The existing 393-file package, dependency contract, documentation, conformance and security gates pass. Production host certification remains unavailable because the current Railway host denies required Linux namespaces. See [maintenance review](maintenance-review.json) for findings, source/log hashes, reproduction evidence and remaining debt. The earlier sections below preserve their original batch evidence.

## Auth and job continuation from PR #248

PR #248 is merged as `59bf25908864112ab733ba09a01cb9fea34b904d`. The next review fixes auth
response/MFA/passkey races, prevents stale job attempts from writing or creating durable fan-out,
and contains rejected auth/backend/job error observers. The current job claim is checked inside
the database transaction, so active fan-out still commits or rolls back with application writes.
All 88 focused tests and all 13 packed type fixtures pass. Source diagnostics decrease from
278 to 246, with all 32 job-module diagnostics resolved and no baseline additions. The full gate
reports 1,676 passing tests, zero failures and three expected privileged-host skips; coverage,
documentation, package, conformance and security checks pass. See
[continuation review](continuation-review.json) for full validation, evidence and remaining limits.
The roadmap count remains six implemented and thirty-four planned.

## Storage and runner continuation from PR #249

PR #249 is merged as `7aeedc7d8c82575541672f55e853613d5a9fedd9`. The next review preserves
object-write and browser-upload inputs across asynchronous work, stops malformed resumable
progress, classifies and redacts S3 body failures, releases rejected unread bodies, and rejects
non-byte object inputs. Artifact and runtime transfer now hashes and sends a copied buffer
through lease revalidation. Bucket, coordinator and agent observers contain rejected promises.

All 80 focused tests pass. The semantic baseline drops from 246 to 163, removing all 83
diagnostics in buckets, object storage and runner modules with no additions. Public declarations,
wire formats, persistent schemas and dependencies are unchanged. The full gate reports 1,702
passing tests, zero failures/cancellations and three expected privileged-host skips; documentation,
coverage, package conformance and security checks pass. Results and remaining limits are recorded
in [storage and runner review](storage-runner-review.json).
The roadmap remains six implemented and thirty-four planned.

## Agent budget feature batch

Feature 16 adds an opt-in durable budget ledger over the existing SQLite application database.
Proposal: [issue #251](https://github.com/nearbycoder/clank.run/issues/251). Registered actions
automatically count accepted calls, write invocations and distinct affected records, with a
declared external-operation debit for transactional outbox work. Current owner/principal and
action authorization are required even when returning an exact retained receipt.

All 22 focused tests pass, including four independent processes competing for one accepted
call, independent connections, restart replay, changed retries/revisions, revocation/expiry,
ownership, capacity/retirement and rollback after caught overspending or invalid output. A real
MCP adapter proves accepted retries spend once. An additional encrypted PITR test restores the
row, grant debit and receipt at the same commit boundary, then proves replay spends nothing. All 14 packed consumer fixtures pass with zero new source diagnostics against the 163-error
baseline. The full release gate passes: 1,726 tests reported, 1,723 passed, zero failures/cancellations
and three privileged-host skips. Coverage is 92.11% lines, 79.85% branches and 90.08% functions.
Documentation, conformance, dependency and security checks pass. See
[budget implementation](budget-implementation.json) for source/log hashes and explicit boundaries. The byte ceiling stays 6 MiB; exactly
two additional distribution files use the explicit 395-file ceiling in the proposal.

## Retained file versions

Feature 28 starts from merged main `7eaaed08a28fbc340dc86d3203a65dba43e03765`, after [PR #252](https://github.com/nearbycoder/clank.run/pull/252) delivered agent budgets through all six hosted checks. Both checkouts were synchronized and existing untracked files preserved. Proposal: [issue #253](https://github.com/nearbycoder/clank.run/issues/253).

Version-enabled buckets now retain bounded immutable generations, expose owner-authorized history/downloads and restore with current-generation fencing and durable exact-retry receipts. Old current-read URLs cannot silently return replacements. The built-in file browser supplies private downloads and CSRF-protected restore forms. Current-session checks close body/provider revocation races. Retired bytes and receipt retention remain bounded independently of current-object quota; rollback and bearer-capability boundaries are explicit.

All 62 focused tests pass, including 23 new feature tests. Real browser keyboard, focus, mobile, download, stale-file and revoked-access checks pass. All 15 packed consumer fixtures pass with no new diagnostics above the existing 163. The full release gate reports 1,750 tests, 1,747 passed, zero failures/cancellations and three privileged-host skips; coverage is 92.16% lines, 79.95% branches and 90.12% functions. Documentation, packaged conformance and security gates pass with the unchanged 395-file/6 MiB limits. See [retained file versions](retained-file-versions.json) for source/log hashes and explicit acceptance limits.

## Release package prerequisite

[PR #254](https://github.com/nearbycoder/clank.run/pull/254) merged retained file versions as
`054f1f03b12e153093880148a43d3641762b79c6` after all six hosted checks passed. Both checkouts
are synchronized and preexisting untracked files are preserved.

The next build change compacts Node 26 type-erasure padding only in unmapped output. It preserves
runtime literals, separators, newlines and mapped output, adds no dependency and leaves Node
22/24 transforms unchanged. The 395-file package shrinks from 6,174,977 to 5,655,821 bytes,
leaving 635,635 bytes under the unchanged 6 MiB limit for subsequent capabilities.
All 16 focused tests and 15 packed consumer fixtures pass with no new source diagnostics.
The full release gate reports 1,754 tests, 1,751 passed, zero failures/cancellations and three
privileged-host skips; coverage is 92.17% lines, 79.95% branches and 90.12% functions.
See [compiler padding review](compiler-padding-review.json). This prerequisite does not change
the feature count: eight implemented and thirty-two planned.

## Source-linked search

Feature 23 starts from merged main `761671eb6fbd24addd811af4ed056eda37d531bf`, after
[PR #256](https://github.com/nearbycoder/clank.run/pull/256) passes all six hosted checks.
Proposal: [issue #257](https://github.com/nearbycoder/clank.run/issues/257). Named typed bindings
project source writes, deletes and record-history restores atomically across upgraded writers.
Search verifies current scoped source rows before ranking, and rebuild/diagnostics have bounded
persistent cursors and generation/revision fences. Existing manual search remains compatible;
unlinked application schemas and recovery epochs remain unchanged. Failed first registration
rolls back all derived tables.

All 75 focused tests, including 16 source-search tests and two new UI race regressions, pass.
Actual process kills during write/rebuild preserve the committed boundary; real browser keyboard,
focus, mobile, pending scope/disposal and revoked-access checks pass. All 16 packed consumer
fixtures pass without additions to the 163 source diagnostics. Preopened upgraded streaming writers
read the shared defaulted metadata and reject attempts to bypass review routes. The initial hosted
Node 24 run exposed a read-only crash-observer journal recovery failure (SQLite 776); the corrected
SELECT-only observer and deterministic hot-journal regression pass all three crash tests on Node 24. The full gate reports 1,772 tests,
1,769 passed, zero failures/cancellations and three privileged-host skips; coverage is
92.19% lines, 80.04% branches and 90.16% functions. Documentation, conformance and security pass;
the package has 395 files and 5,677,195 bytes under unchanged bounds. Existing PITR rejection of
FTS virtual tables remains explicit. See [source-linked search](source-linked-search.json).
Nine features have acceptance evidence; thirty-one remain planned.

## Reviewable import corrections and upserts

[PR #258](https://github.com/nearbycoder/clank.run/pull/258) merged source-linked search as
`22a530873fd54e02ee7c5551a4a68cf8d539b077` after all six hosted checks passed. Both checkouts
were synchronized, and all seven/sixteen preexisting untracked files were preserved.

Feature 25 adds immutable canonical source staging, separate mapping/value corrections and
explicit authorized insert/update/skip review. Accepted batches bind source, correction revision,
job progress and target versions; target writes, counters and exact receipts commit atomically.
Applied batches stay immutable. Legacy streaming contracts and structural clients remain usable.
Proposal: [issue #259](https://github.com/nearbycoder/clank.run/issues/259).

All 55 focused tests pass, including 22 feature tests and four UI regressions. Actual process kills,
independent connections, lost creation/update responses, restart, changed sources/mappings,
invalid/ambiguous rows, scoped/current authorization, capacity rollback and search projection are
verified. Real browser file chooser, keyboard/focus, mobile, correction/review, stale rejection,
account/disposal and clearing displayed source on session revocation pass. All 17 packed consumer
fixtures pass without additions to the 163 source diagnostics. Preopened upgraded streaming writers
read the shared defaulted metadata and reject attempts to bypass review routes. The initial hosted
Node 24 run exposed a read-only crash-observer journal recovery failure (SQLite 776); the corrected
SELECT-only observer and deterministic hot-journal regression pass all three crash tests on Node 24. The full gate reports 1,799 tests,
1,796 passed, zero failures/cancellations and three privileged-host skips; coverage is
92.22% lines, 80.09% branches and 90.24% functions. Documentation, conformance and security pass;
the package has 395 files and 5,725,758 bytes under unchanged bounds. See
[reviewable imports](reviewable-imports.json) for exact evidence and retention/migration boundaries.
Ten features have acceptance evidence; thirty remain planned. [PR #260](https://github.com/nearbycoder/clank.run/pull/260) merged as
`55a6509248d635346910b59fa8d21708660d1ff8` after all six fresh hosted checks passed,
with no unresolved threads. The protected merge tree matches reviewed head `632ed519`;
both checkouts were synchronized and the seven/sixteen preexisting files preserved.

## Retention administration and holds

Feature 39 starts from merged main `55a6509248d635346910b59fa8d21708660d1ff8`.
Proposal: [issue #261](https://github.com/nearbycoder/clank.run/issues/261).
Scoped operators receive one per-database inventory, private-snapshot purge review, durable
versioned holds and periodic schedules over imports, collaboration receipts/history and
acknowledged platform audit exports. Current source associations, session and role checks
apply to new work and exact receipt replay. Purge, retry retirement and acceptance commit
atomically. Expired import identities and collaboration revision floors prevent re-execution.

Holds protect source payload and history across already-open upgraded writers, including
both global and per-document database history cleanup. A real 100,000-snapshot fixture
proves capacity rollback preserves evidence. Acknowledged held audit envelopes remain
without redelivery; outbox bounds apply backpressure, while signed pending delivery continues.
Scheduled occurrences revalidate session/policy and execute once across independent processes.

All 63 focused tests pass, including 17 feature tests, four operator UI regressions, real
SIGKILL rollback boundaries, process contention, revoked authority, malformed metadata,
source/receipt/history capacity and independent audit checkpoint continuity. Real browser
keyboard/focus, hold/review/purge, persisted rules, account switching, revocation, disposal
and 390px/1280px layout checks pass. All 18 packed consumer fixtures pass with no new
source diagnostics above the existing 163. The full release gate reports 1,822 tests,
1,819 passed, zero failures/cancellations and three privileged-host skips; coverage is
92.27% lines, 80.18% branches and 90.32% functions. Documentation, conformance and security
pass. Exactly four distribution files bring the package to 399 files and 5,808,460 bytes,
under the unchanged 6 MiB byte ceiling. See [retention evidence](retention-administration.json)
and [operator guide](../../docs/retention-administration.md) for source/log hashes and
upgrade, source-transfer, lifetime receipt, protected-data and physical-retention boundaries.

Eleven features are merged after PR #262; twenty-nine remain
planned. No host certification or completion of the whole roadmap is claimed.

## Search browsing and saved definitions

Feature 24 starts from merged main `803154168141500e77db33b0daa37d3857d8e11b`, after
[PR #262](https://github.com/nearbycoder/clank.run/pull/262) delivered retention through all six
hosted checks. Proposal: [issue #263](https://github.com/nearbycoder/clank.run/issues/263).
Source-linked search now provides declared scalar facets, complete authorized counts,
AND equality filters, deterministic title/relevance paging and account-owned saved definitions.
Cursors pin current authority, source/index and policy revisions; changed state conflicts
instead of silently skipping or duplicating rows. Exact latest save/delete retries survive
restart and lost committed responses, while compact retired keys prevent stale recreation.

All 51 focused tests pass, including ten feature cases, four UI regressions, three parser
regressions and real SQLite sandbox checks. Real independent processes accept one saved mutation and a real SIGKILL rolls
back uncommitted SQL. Unicode ties/matching, ACL/cursor changes, revocation and candidate,
source-byte, distinct-value, account, lifetime-key and metadata-byte bounds pass. Real browser
keyboard/filter/paging, saved load/edit/reload, narrow width, account change, revocation and
disposal checks pass. Disabled last-page focus loss is corrected. Object-schema review fixes
inherited field lookup, literal-key prototype mutation and swallowed unexpected refinements.
Refinements now require synchronous booleans and contain rejected thenables in a real strict
Node process. Real V8 profiles with colliding namespace filenames are retained independently,
and workers receive a private pinned coverage directory rather than the parent profile root.

The complete Node 22.16 gate passes with 1,840 tests reported, 1,837 passed, zero failures/cancellations
and three privileged-host skips. Coverage is 88.23% lines, 80.29% branches and 90.43% functions.
All 19 packed consumer fixtures pass with the unchanged 163-diagnostic source baseline.
Docs, packaged conformance and security checks pass: 399 files / 6,163,301 bytes under the
unchanged 399-file / 6 MiB ceilings. See [search browsing evidence](search-browsing.json) and
[guide](../../docs/search-browsing.md) for source/log hashes, latest-retry/tombstone limits and
the existing source-search writer/PITR boundaries. The first hosted release job passed every runtime
test but exhausted the single malformed-coverage-artifact retry. The private worker-profile fix
passes the complete minimum-Node local gate; the revised head passed all six hosted checks. PR #264 merged as
`22356868facd64e4470a11564b0b87122ed82659`, matching the reviewed head
`5d1a0f955265e4a8b835d7c9d6950a674bfc899c` tree. There are no unresolved review threads
or requested changes. Both checkouts were synchronized and 23 existing files preserved.
Twelve features are merged; twenty-eight remain.

## Component harness: feature 32

Proposal [#265](https://github.com/nearbycoder/clank.run/issues/265) adds an optional module for
captured typed specimens, common UI contracts, scoped SSR/hydration, native interactive controls
and deterministic assertion exports. Matching hydration preserves the SSR node; structural
recovery releases the abandoned instance. Reset/selection/disposal release reactive subscriptions
and native listeners. Cancellation, adopted/detached roots and late checks cannot clear newer
mounts or publish stale reports. Factories remain trusted developer code on disposable fixture
pages; document reservation is not an origin or JavaScript sandbox.

Eight real Chrome journeys pass at 1280/390 widths (96 steps), including trusted Enter/Space/
arrow/Tab/Shift+Tab input, modal focus wrapping, Escape return and measured overflow. Four lifecycle
journeys prove abort/adoption/revision rejection, mismatch recovery, stale-report discard and
cleanup. In-app browser checks also exercise actual selection/reset/check/export/dispose controls;
local desktop/mobile screenshots are retained outside Git. ARIA checked inspection and owned
Chrome signal/profile cleanup are corrected without weakening the browser sandbox.

All 19 focused tests and 20 packed consumer fixtures pass. Source types have 159 existing
diagnostics, down from 163 without expanding the baseline. The full minimum-Node 22.16 release
gate reports 1,852 tests, 1,849 passed, zero failures/cancellations and the three existing privileged
host skips; coverage is 87.97% lines, 80.37% branches and 90.43% functions. Documentation,
packaged conformance and security pass. Exactly two distribution files bring the package to
401 files / 6,198,569 bytes under proposal #265's exact file limit and unchanged 6 MiB ceiling.
See [harness evidence](component-harness.json) and [guide](../../docs/component-harness.md).
Hosted CodeQL review found two fixture alerts on the first head. Case-insensitive HTML
assertions and fixed prebuilt fixture pages now pass actual HTTP injection regressions; the
revised head passed all six fresh hosted checks. [PR #266](https://github.com/nearbycoder/clank.run/pull/266)
merged as `3481fc206a55eb3cc1c2d991497597f30619ec86`, matching the reviewed head
`a8dc8940aa9a491ad373ded359e853095cf1bda6` tree. Both CodeQL threads are resolved and
there are no requested changes. Both checkouts were synchronized and 23 existing files preserved.
Thirteen features are merged; twenty-seven remain. Authorized aggregates (22) are next under proposal #267.

## Authorized aggregates: feature 22

Proposal [#267](https://github.com/nearbycoder/clank.run/issues/267) adds typed count/sum/group
projections to existing query builders. Direct declared references use the caller's ownership
scope, explicit per-source policies and the current SQLite snapshot. Native JSON admission
precedes materialization; related lookups, groups, output and numeric overflow fail without
partial totals. Missing or denied inner references never contribute. Policy ACL reads retain
tracked dependencies; unrelated owners and parent IDs stay quiet. Retained builders/readers
cannot aggregate in a later transaction. Inherited table/query/index field names are rejected
while explicitly declared literal names remain valid.

All ten focused tests pass, including a real concurrent WAL writer and restart, native-driver
materialization instrumentation, owner isolation, capacity/Unicode/arithmetic failures, plan
captures, separate alias policies and real authenticated live session revocation. All 21 packed
consumer fixtures pass without new source diagnostics (159 actual; the allowance remains 163).
The full Node 22.16 gate reports 1,862 tests, 1,859 passed, zero failures/cancellations and three
existing privileged-host skips. Coverage is 88.01% lines, 80.47% branches and 90.47% functions.
Documentation, packed conformance and security pass; the package remains 401 files / 6,218,111
bytes under the unchanged 401-file / 6 MiB limits. No modules, dependencies or migrations are
added. See [aggregate evidence](authorized-aggregates.json) and [guide](../../docs/authorized-aggregates.md).
SQLite internal scans, trusted schema parsing and extra policy reads are outside admission
limits; denied source candidates can affect admission in the owner's scope, never successful
values or totals. This is backend validation and does not claim privileged host certification.
[PR #268](https://github.com/nearbycoder/clank.run/pull/268) passed all six fresh hosted checks
with no new CodeQL alerts, unresolved threads or requested changes. It merged as
`283cbcf0aa368fd7f1fc40cc2c1067e578241bcc`, with the same tree as reviewed head
`66eb5fa60eefe3c7f89633b3e6a30939f26ef0d8`. Both checkouts were synchronized and all
23 existing files preserved. Fourteen features are merged; twenty-six remain.

## Linux host certification: feature 01 awaiting reviewed delivery

Proposal [#269](https://github.com/nearbycoder/clank.run/issues/269) adds the optional
`host-certification` contract and provider CLI certification/inspection. Fixed probes require
actual namespace, migration/SQLite worker rollback, exact XFS byte/inode/WAL rejection,
the production Docker launcher, selected resources and controlled positive/negative egress.
Private authenticated reports bind boot, policy, mount, framework/runtime/tool bytes and local
Docker/image identity, expire and reject changed or tampered state. Root inspections also honor a host-wide attempt from a different private directory; passing V1 profiles require real/effective root UID. Unconfirmed cleanup retains
attempt markers; there is no implicit image pull, caller probe callback or process fallback.

The minimum-Node complete gate passes: 1,866 reported, 1,863 passed, zero failed/cancelled,
three existing privileged skips; coverage 87.54% lines, 80.50% branches and 90.43% functions.
Four new ordinary regressions and 22 packed type fixtures pass; source diagnostics remain
159 against the unchanged 163 allowance. The exact optional module adds two distribution
files: 403 files and 6,276,632 bytes, within the unchanged 6 MiB byte ceiling.

A fresh owned Debian 13 KVM guest has its own Docker daemon and new XFS disk, separate from
the workstation and production. All 23 existing privileged/isolation regressions pass without
skips. Six actual new scenarios pass: selective egress, deny-all egress, denied namespaces,
missing-image refusal, parent death during SQLite with rollback, and denied cleanup that
keeps markers until exact operator cleanup. Tests run from an installation path containing
spaces. Guest policy/tool permissions are restored, and owned runtimes, links, firewall and
test files are absent. These are disposable-profile certificates; production Railway remains
uncertified. No provider leadership/handoff/remote recovery is counted as delivered.
See [certification evidence](linux-host-certification.json) for source/log/provenance hashes
and supported limits. Feature 01 remains in progress until reviewed PR delivery; 14 are merged.

## Review prerequisites

| Item | State | Evidence |
| --- | --- | --- |
| Authorized search candidate limits | Implemented | Denied matches do not consume the authorized candidate budget or affect truncation; full-scope admission is separately bounded. `tests/durable-features.test.mjs` and `fix-verification.json`. |
| Accent-aware search ranking/snippets | Implemented | Original UTF-16 offsets retained through Latin folding; Greek tokenizer semantics preserved. Combining-mark, score and snippet regressions pass. |
| Collaborative receipt retention | Implemented | Revision-window pruning, global receipt admission, expired replay rejection, history retirement and maximum-window regression pass. Existing archives/backups have independent retention. |
| Terminal import payload retention | Implemented | Terminal chunk and document-history retirement; bounded jobs/chunks/bytes; stable job identity, completion/cancellation and restart regressions pass. |
| Semantic type-contract gate | Implemented | Pinned external tools; no new diagnostics against the existing 290; all 11 packed consumer positive/negative fixtures and imported declarations pass. Source debt remains. |
| Current capability documentation | Updated | `docs/code-audit.md` distinguishes its historical snapshot from capabilities shipped since then. |
| Studio deployment diagnosis | Root cause verified; host repair pending | Read-only Railway SSH probe: `unshare` and Bubblewrap both fail with Permission denied. `SQLITE_ISOLATION_UNAVAILABLE` now diagnoses the recognized worker failure without exposing arbitrary stderr or bypassing isolation. A compatible disposable host is required for certification/recovery tests. |

## Roadmap

| ID | Feature | State | Acceptance evidence |
| --- | --- | --- | --- |
| 01 | Verified Linux host certification | Implemented | Proposal #269 / merged PR #270; complete minimum-Node/type gates, four ordinary regressions, six actual allowed/denied/interrupted/cleanup KVM scenarios and 23 privileged isolation regressions. All six hosted checks pass; production remains uncertified. `linux-host-certification.json`. |
| 02 | Artifact promotion across environments | Implemented and merged | [Acceptance and protected delivery](environment-promotions.json) |
| 03 | Persistent release channels | Implemented and merged | Proposal #276 / merged PR #278; [acceptance](release-channels.json). |
| 04 | Deployment dependency gates | Implemented and merged | Proposal #279 / merged PR #281; [acceptance](deployment-dependencies.json). |
| 05 | Scheduled release windows | Implemented and merged | Proposal #280 / merged PR #282; [acceptance and protected delivery](release-windows.json). |
| 06 | Automatic supervisor leadership | Planned | Pending |
| 07 | Online provider node handoff | Planned | Pending |
| 08 | Provider managed canaries | Planned | Pending |
| 09 | Isolated shadow traffic | Planned | Pending |
| 10 | Remote PITR orchestration | Planned | Pending |
| 11 | Verified multi-organization identity linking | Implemented; merge pending | Proposal #283; real fresh local/provider proof, retained subject ownership, scoped unlink/offboarding and restart-safe exact receipts. 74 focused tests, 28 packed fixtures, final full Node 22/26 gates, actual browser/revocation and two SIGKILL/restart cycles pass. `identity-linking.json`. |
| 12 | SCIM user and group provisioning | Planned | Pending |
| 13 | Organization security policy console | Planned | Pending |
| 14 | Temporary privileged access | Planned | Pending |
| 15 | Organization service accounts | Planned | Pending |
| 16 | Agent operation budgets | Implemented | Proposal #251; 22 focused tests, actual four-process contention, atomic rollback, restart/exact replay, ownership/revocation/expiry, bounded retention, real MCP calls and 14 packed consumer fixtures. Full release gate passes. |
| 17 | Approval quorum policies | Planned | Pending |
| 18 | Reviews bound to affected records | Implemented | Opt-in tracked reads, requester identity fence, affected-row/ACL changes, unrelated writes, journal gaps, restart and receipt replay tested in `tests/reviewed-actions.test.mjs`. Default remains conservative. |
| 19 | Durable human waits in workflows | Planned | Pending |
| 20 | Workflow compensation steps | Planned | Pending |
| 21 | Typed PostgreSQL application backend | Planned | Pending |
| 22 | Authorized cross-table aggregates | Implemented | Proposal #267; typed owner/policy-scoped count/sum/group, native JSON admission and selective related/ACL updates. Ten real SQLite regressions, 21 packed fixtures and full minimum-Node release gate pass. `authorized-aggregates.json`. |
| 23 | Source-linked search indexes | Implemented | Proposal #257; atomic source writes/deletes/history restore, pre-opened independent writers, two actual process crashes, resumable fenced rebuild, bounded drift diagnosis, current owner/record authorization and 16 packed consumer fixtures. Real keyboard/mobile/scope/disposal/revocation checks and full release gate pass. |
| 24 | Search facets and stable result cursors | Implemented | Proposal #263; authorized facets, pinned paging and fenced saved definitions; 51 focused tests, 19 packed fixtures, complete release gate and actual browser controls. `search-browsing.json`. |
| 25 | Import correction and upsert workflow | Implemented | Proposal #259; immutable server-verified source, separate durable corrections, version-fenced upserts, exact correction/apply receipts, two actual process crashes, lost responses/restart, ownership/current ACL and bounded admission. All 55 focused tests, 17 packed fixtures and full release gate pass; actual upload/keyboard/mobile/stale/account/disposal/revocation checks. |
| 26 | Shared document cursor coordination | Implemented | Revision-aware, session-bound ephemeral cursors; edit/deletion rebasing, expiry/capacity, per-participant owned authorization, session/ACL/email-verification revocation and restart/reconnect tested. Keyboard/browser and mobile checks pass. |
| 27 | Document suggestions and branches | Implemented | Named durable drafts, immutable proposals, before/after review, author/reviewer policies, document/branch fences, overlap/missing-history rejection, bounded payload/rebase bytes, transactional acceptance and exact restart replay tested. |
| 28 | Retained file versions and restore | Implemented | Proposal #253; 23 new feature tests and 62 focused tests, immutable owner/key-scoped history, generation fences, restart/receipt replay, bounded retention and provider cleanup, in-flight session revocation, actual keyboard/mobile/download checks and 15 packed consumer fixtures. Full release gate passes. |
| 29 | Durable media processing jobs | Planned | Pending |
| 30 | Offline attachment queue | Planned | Pending |
| 31 | Hydration mismatch inspector | Implemented | Optional metadata capture, pre-cleanup child paths, original TSX locations, patch/remount reasons, immutable bounded history and redacted JSON. Unit/packed consumer and real keyboard/mobile/cleanup checks pass. DOM gzip budget remains 12,000 bytes. |
| 32 | Interactive component contract harness | Implemented | PR #266 merged after all six fresh checks; 19 focused tests, 20 packed type fixtures, eight actual Chrome journeys/96 steps, minimum-Node release gate and CodeQL pass. |
| 33 | OpenAPI export for backend functions | Implemented | Runtime schemas, cookie/CSRF and replay contracts; unsupported/coercive/refined shapes rejected; actual positive/negative authenticated HTTP requests tested against the packed artifact. `tests/openapi.test.mjs`, `type-tests/openapi.ts`. |
| 34 | Local provider fleet simulator | Implemented and merged | [Actual coordinator/provider drills](fleet-simulator.json) |
| 35 | Translation extraction and review workflow | Implemented | Canonical catalog extraction, locale/source/current fences, placeholder/key/plural validation and reviewed diff acceptance. Node tests, packed types and real browser keyboard/mobile checks confirm the server/browser revision matches. |
| 36 | Project incident workspace | Planned | Pending |
| 37 | SLO and error budget policies | Planned | Pending |
| 38 | Project cost attribution and budgets | Planned | Pending |
| 39 | Retention administration and holds | Implemented | Scoped inventory, exact purge receipts, restart-persistent holds, protected history admission, expired-retry fencing and competing scheduled runners; 63 focused tests, 18 packed fixtures, full release gate and actual browser controls. `retention-administration.json`. |
| 40 | Customer status pages | Planned | Pending |

## Validation and remaining work

The complete `npm run check` passed on Node 26.10.0: 1,622 tests reported, 1,619 passed, zero failed/cancelled, three skipped; coverage 91.92% lines, 79.47% branches, 89.73% functions. Documentation/export/declaration audits, zero-dependency enforcement, packed-release conformance, and package/tree/history security checks passed. Subsequent focused tests additionally verify retirement of collaboration history copies. The semantic gate passes with 290 existing source diagnostics and 11 packed consumer fixtures. See `implementation-verification.json` for log hashes and exact scope.

The first batch publish allowlist contains 391 files. Four new distribution files for OpenAPI and translation review raise the bounded allowance from 390 to 394; the 6 MiB byte ceiling remains in force. Hydration inspection adds two distribution files within that same 394-file limit. No framework dependencies were added. Two existing published declaration errors were corrected: JSX ambient inclusion and the bucket error constructor.

The translation browser fixture (`tests/fixtures/translation-browser.mjs`) rejects invalid placeholders, prevents acceptance until review passes, supports keyboard review/acceptance, and renders the accepted catalog with the same SHA-256 revision as the server. At 390 × 844 pixels, horizontal content width equals viewport width. Browser warnings/errors were absent. Screenshots are local review evidence, not package contents.

Railway's current production runtime has `unshare` and Bubblewrap installed, but its kernel policy rejects namespace creation. This explains the worker startup failure; this branch diagnoses it and preserves fail-closed isolation. No production deployment or host policy change was performed. A disposable Linux host matching the intended Docker/XFS profile is still needed; no green host certificate, provider failover result, or remote recovery certification is claimed.

The document batch adds 26 and 27 and passes its own validation below. The remaining deployment/identity/backend changes require their documented contracts and acceptance evidence. Planned features do not count as delivered.

## Document batch verification

The complete local gate passed against the final document and OpenAPI changes with 1,635 tests reported, 1,632 passed, zero failures/cancellations and three privileged cases skipped; coverage 91.88% lines, 79.58% branches, 89.73% functions. The focused run passed all 51 tests, including email-verification revocation, invalid reviewer configuration and OpenAPI resource bounds. The pinned semantic gate has no new diagnostics against 290 existing ones, and all 12 packed consumer fixtures pass with declaration checks enabled. See [document verification](document-verification.json) for exact file and log hashes.

The real HTTP/browser fixture (`tests/fixtures/collaborative-browser.mjs`) uses two synthetic authenticated users and a disposable database. Keyboard selection publishes revision-bound presence. A concurrent server edit makes acceptance fail; refreshing then accepting preserves both edits and persists `!Dear Hello earth` at revision 4. Revocation clears the text, selections and actionable proposal controls. At a 390px viewport, content width equals client width (375px with its vertical scrollbar), so there is no horizontal overflow. Browser warnings/errors were absent. Both browser fixtures serve preloaded assets without request-derived filesystem paths.

PR #245 at `02ff56ece5170885244a161f55ddd02e7107b4ec` and PR #246 at `28a79f2cb7f289d482cae2a35112fb205bef478e` have both passed hosted Node 22.16/24 runtime tests, packed-release conformance, semantic/packed consumer typing, JavaScript/TypeScript CodeQL analysis, and the CodeQL alert gate. [First-batch CI](https://github.com/nearbycoder/clank.run/actions/runs/37816448471), [document CI](https://github.com/nearbycoder/clank.run/actions/runs/37816824257). No production rollout, merge, disposable-host certification or completion of the remaining 34 features is claimed.

## Hydration batch verification

Capture is isolated in `hydration-inspection.ts`; ordinary DOM imports load no inspector implementation. Existing SSR attachment, text correction, keyed/portal behavior, partial attachment cleanup and binding-error propagation remain intact. Optional TSX metadata uses original coordinates and bounded basenames, with no props/HTML changes. Public exports and declarations are opt-in.

All 61 focused tests passed, including runtime size/work budgets and the coverage-artifact retry regressions. The semantic gate has no new diagnostics against 290 existing ones, and all 13 packed consumer fixtures pass with declaration checking enabled. The DOM module measures 11,966 bytes gzip against the unchanged 12,000-byte limit; capture logic is loaded through the optional inspector rather than increasing that limit. Concise source comments retain their complete contract documentation in declarations and guides.

The real SSR/browser fixture (`tests/fixtures/hydration-browser.mjs`) preserves the matching button and its Enter-key interaction, locates a nested structural fallback at child path `0.1` with source `HydrationDemo.tsx:8:124`, and records a text correction at `0.0` with source `HydrationDemo.tsx:10:38`. Its JSON export excludes synthetic private SSR text/attributes and directory paths; keyboard export focuses/selects the read-only report. At a 390px viewport, client and content widths are both 375px. Disposal removes both inspected apps, runs the second attachment cleanup and clears retained inspection entries. Expected mismatch warnings are static; browser errors are absent.

An experimental Node 26 coverage artifact was malformed after all runnable tests passed. The existing one-retry detector now recognizes Node 26’s wrapped JSON parse error as well as the prior SyntaxError form. Actual test failures, cancelled tests, inconsistent counts, unrecognized errors and coverage shortfalls remain ineligible for retry; a second artifact failure still fails the gate. Line/branch/function thresholds remain 80/65/80. The final complete `npm run check` passed: 1,644 tests reported, 1,641 passed, no failures/cancellations and three privileged cases skipped; coverage 91.92% lines, 79.65% branches, 89.74% functions. The publish allowlist contains 393 files within the unchanged 394-file / 6 MiB limits. See [hydration verification](hydration-verification.json) for source/log hashes and parent-batch hosted checks.
