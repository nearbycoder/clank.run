# Implementation ledger

Base: `4b990199965204f1200fcd0fb4ca2b7eb0b02bbc`, equal to freshly fetched `origin/main` on 2026-10-08.

Proposal: [issue #244](https://github.com/nearbycoder/clank.run/issues/244). Thirty-seven features have complete accepted evidence across thirty feature batches; three remain under verification. The synchronized protected-main snapshot before combined feature delivery (2026-10-11) is `95f332233fb56feb08993853f765ba26df081999`, including reviewed release declaration/CLI/inbox repairs [PR #360](https://github.com/nearbycoder/clank.run/pull/360), the separately accepted inbox typing repair [PR #361](https://github.com/nearbycoder/clank.run/pull/361), and the [accepted shadow ingress prerequisite](shadow-ingress-acceptance.json), accepted release-spacing maintenance [PR #348](https://github.com/nearbycoder/clank.run/pull/348), the shadow supervisor/schema prerequisite [PR #351](https://github.com/nearbycoder/clank.run/pull/351), and provider managed canaries [PR #346](https://github.com/nearbycoder/clank.run/pull/346), authenticated canary HTTP controls [PR #342](https://github.com/nearbycoder/clank.run/pull/342), SQLite preparation guards [PR #345](https://github.com/nearbycoder/clank.run/pull/345), retention-worker shutdown maintenance [PR #344](https://github.com/nearbycoder/clank.run/pull/344), durable canary retirement [PR #340](https://github.com/nearbycoder/clank.run/pull/340), startup-contention maintenance [PR #341](https://github.com/nearbycoder/clank.run/pull/341), the protected provider-controller prerequisite [PR #337](https://github.com/nearbycoder/clank.run/pull/337), provider-isolation prerequisite [PR #336](https://github.com/nearbycoder/clank.run/pull/336), protected [PostgreSQL feature 21 PR #333](https://github.com/nearbycoder/clank.run/pull/333) and maintenance merges [#330](https://github.com/nearbycoder/clank.run/pull/330) and [#332](https://github.com/nearbycoder/clank.run/pull/332). Both main checkouts match its reviewed tree and all 23 pre-existing local files are preserved. Earlier feature snapshots and their immutable evidence retain their original scope; production Railway remains uncertified.

A feature is complete only when its documented acceptance evidence exists. Proposed contracts do not count as implemented features. The review baseline remains historical evidence; this ledger records subsequent work.

## Fresh SLO and error-budget acceptance

Feature 37 now has complete browser and native acceptance. Fifty actual ingress requests produce 47 successful responses and 48 completions within 250 ms. In a complete five-minute window, Chrome shows a success budget of 0.5 requests, a remaining budget of -2.5 and a burn rate of 6 with an open alert. The latency objective shows a budget of 2.5 requests, a remaining budget of 0.5 and a burn rate of 0.8. Controller close/open preserves both policies and the known bucket; its measurement gap makes budget and burn unavailable and marks the retained alert unknown. A later complete zero-request window still cannot establish compliance. All 78 focused native and contract checks pass without skips. All 322 runtime source files used by the browser fixture match protected main. [Evidence and retained harness diagnostics](slo-fresh-acceptance.json).

This increases accepted evidence to 37/40. Features 07, 17 and 40 and the broader fresh verification remain unfinished.

## Fresh incident workspace acceptance

Feature36 now has complete browser and native acceptance. Connected Chrome creates a critical incident with an existing owner, attaches the actual provider release, records the verified recovery observation and resolves it. Independent SQLite confirms version4, one note, one release link and four receipts; controller close/open preserves those exact rows and the rendered receipt. The named native diagnostic case follows actual error recurrence, trace, job, workflow and alert references without storing private payloads. Current membership/session/body/diagnostic-await checks fence revoked roles. Ordinary release deletion and restart preserve only safe immutable release context. Separate actual SIGKILL tests prove durable exact retries. [Evidence](incident-fresh-acceptance.json).

This increases accepted evidence to36/40. Features07,17,37 and40 and the broader fresh verification remain unfinished.

## Fresh shadow, recovery and organization-policy acceptance

Features 09, 10 and 13 now have complete requirement-specific evidence. Shadow acceptance uses the actual certified Docker provider and Chrome console: six primary requests yield four comparable pairs and two capacity skips, with no unknown outcomes or primary writes. Automatic deadline expiry and explicit original-epoch stop leave only the original primary. The exact six Docker cases pass on each Node22/26 runtime. A transient history-read refusal remains recorded with its specific cause unproven; an explicit refresh shows both retained terminal receipts. [Evidence](shadow-fresh-acceptance.json).

Recovery acceptance uses an actual trusted native provider, application process and SQLite. The browser schedules encrypted checkpoints, inspects the retained0–3 horizon, and restores transaction2 after the source process is killed and its volume deleted. Independent target data is exactly mutation two, credentials are not copied, and the separate destination is suspended until explicit activation. HTTP200 after activation, controller reopening and unchanged replay preserve the original receipt and one destination. The unchanged default30-archive capacity refuses later manual capture before reserving an intent; no positive browser manual-capture claim is made. All158 focused native recovery cases pass, including corruption, retention gaps and actual controller SIGKILL. The browser reopening itself uses close/open in the same parent process. [Evidence](recovery-fresh-acceptance.json).

Organization-policy acceptance combines actual fresh Chrome preview, keyboard focus/Escape, expired-auth refusal, passkey policy save and viewer denial with an independently reread version1 policy and one receipt. The current331-case native selection includes named browser/project CLI, actual MCP consent/PKCE/refresh generation, signed OIDC, grace/session and independent last-admin recovery cases. Cryptographic fixture UV and the controlled IdP are explicitly qualified; these records do not claim physical-authenticator or production IdP certification. [Evidence](policy-fresh-acceptance.json).

This is an evidence-only acceptance update on protected main3f05439. The runtime settings clipping found during recovery is preserved as a separate pending UI fix, and no flawless-layout claim is made. Feature07 implementation and features17/36/37/40 acceptance remain unfinished; fresh verification of the broader list continues. The earlier32/40 snapshots retain their original historical counts. Production Railway remains uncertified.

## Fresh temporary-access acceptance

Feature 14 is accepted after native Chrome grant/use/expiry/revocation checks. An actual one-minute grant expires and refuses later preview creation. A five-minute grant permits one isolated preview while the recipient remains a viewer. Required revocation reasons, Escape/focus, immediate revocation, stale issuer authentication refusal and native reauthentication pass. Independent SQLite retains only the expected preview, exact grant history and receipts.

The actual public component also passes keyboard grant, required-reason revocation and draft discard in a390px iframe, with a358.4px dialog and375px document without horizontal overflow. Escape preserves the exact draft and restores its action. Confirmation retains one revoked grant and two receipts, clears only the local draft, and leaves the viewer role and three baseline projects unchanged. This separately authored component harness does not alter the full console's framing protections and does not certify a physical phone or authenticator.

All44 current temporary-access/controller/client/native HTTP cases pass with zero failures or skips, including actual streamed-request expiry/revocation/membership/policy revalidation and controller SIGKILL/restart retirement. Protected [PR #395](https://github.com/nearbycoder/clank.run/pull/395) passed its exact local3,911-test gate (3,868 passed,43 skipped,zero failures/cancellations) and all eight hosted checks. The later protected navigation guard in [PR #396](https://github.com/nearbycoder/clank.run/pull/396) passes its final3,924-test gate and89 focused modal/focus/native navigation cases; fresh Chrome cancellation/confirmed navigation also pass. See [fresh temporary-access acceptance](temporary-fresh-acceptance.json). Canonical acceptance is32/40; the remaining original features and broader fresh verification remain unfinished.

## Fresh project cost acceptance

Feature 38 is accepted after fresh Chrome verification of reviewed budget creation/editing, known cost6 against budget5 with blocked admission, a bounded override and immediate revocation, audited reconciliation, Escape/focus, and narrow keyboard controls in an actual 390px iframe. Estimates remain explicitly separate from invoices. This iframe is a real browser layout check, not physical-phone certification.

A fresh native fixture withholds the successful budget acknowledgment body after SQLite commits version2. Chrome retains the exact intent, freezes editing and offers an explicit unchanged retry. Keyboard retry returns the retained receipt; all three native receipts and the policy are byte-identical before/after, with no additional version. Removing the actual fixture membership makes the next automatic native read return404 and clears all private cost data and controls. This is a next-read revocation check; no in-flight membership-removal race is inferred.

All 60 current focused cost/controller/client/native HTTP cases pass with zero failures or skips, including native collector-await session revocation, restart, unknown coverage, actual ingress blocks/overrides, authenticated CLI/MCP boundaries and transactional audit/readback failures. The unchanged runtime was protected through [PR #393](https://github.com/nearbycoder/clank.run/pull/393) and [PR #396](https://github.com/nearbycoder/clank.run/pull/396), whose final exact local gate passed 3,924 tests (3,881 passed, 43 skipped, zero failures/cancellations) and all eight hosted checks. The retained earlier local SQLite/supervisor and hosted canary failures are described in [navigation delivery evidence](settings-navigation-modal.json); they are not erased by this acceptance record. See [fresh cost acceptance](cost-fresh-acceptance.json). This raises canonical acceptance to 31/40; fresh verification of the remaining features, full source handoff, and production-host certification remain separate unfinished work.

## Fresh offline attachment acceptance

Feature30 is accepted after fresh Chrome verification with native IndexedDB/Web Locks, authenticated HTTP uploads/private downloads and independently inspected SQLite receipts. Keyboard synchronize, lost acknowledgment with an explicit identical retry, discard cancellation/confirmation/focus, account switching, expired native sessions and actual listener loss preserve the correct account-bound intent and one expected attachment. A partial upload retains six bytes without publishing an object or attachment; capability expiry and retry recover the original intent. A real390px iframe verifies narrow layout and keyboard actions; this does not certify a physical phone.

Protected [PR #394](https://github.com/nearbycoder/clank.run/pull/394) delivered the discard modal and fixtures at reviewed head `a7ee91674b22f76669245fc315995cadd50f1fce`; squash main `aa5f1e44193ff1e07431d652a0a4e5bcf55a5864` has the identical tree `c09538dee3a2fd7fb8f923561b1767043385317e`. All eight hosted checks passed. The first full local gate retained one existing supervisor observer `database is locked` failure; both unchanged cases passed separately, and the identical-head full repeat passed3,907 tests (3,864 passed,43 skipped,zero failures/cancellations), coverage, documentation, packaged conformance and security. No observer timeout, assertion or production behavior was weakened. This increases the canonical accepted count to30/40; the broader fresh verification of all forty continues.

## Original production source launch review

The private source function now consumes the original service/data owner, authenticates the committed capsule and retained release files, refuses existing managed writers, and couples actual Docker creation/C1/grant/channel/stdin bootstrap to native first-base dispatch and bounded HTTP health. It exposes only the original container observation and cleanup; readiness/write/control/activation remain separate owning transitions. [Production launch review](source-production-launch-review.json).

Native production calls pass on the cached Node22/26 images, with original constructor return, native base readback, fenced writes and started/version4 grant state. Closing the original owner invalidates observation; replacing/restoring the original channel mount cannot revive it. Worker admission still refuses a retired initializer. Every successful case verifies exact owned-container removal and zero remaining original pins. The unsupported-schema fixture failures, premature health probe and real channel-retirement observation failure remain retained. Source and container security profiles, quotas and original recovery validation stay unchanged.

Both selected source suites pass270 cases on Node22/24. All323 paired outputs match,146 public declarations remain unchanged,54 packed fixtures pass with149 inherited/zero new diagnostics, and452 package files total7,072,728 bytes under the unchanged8MiB ceiling with zero dependencies. The first complete gate reports3,893 tests,3,856 passes,zero failures/cancellations and37 skips, then fails its final exact package manifest audit because the new module path was missing. The manifest now includes exactly that path with unchanged8MiB/dependency/forbidden-path assertions. An independently reproduced wrong-owner reservation bug is fixed by synchronous owner pairing before capsule input/reservation; the original reproduction and31 focused cases now pass on each runtime. The next complete gate reports four failures because inventory fixtures still expect451 rather than reviewed452; those exact assertions now include the actual launch module while retaining all historical inventory boundaries, equal-count swap/missing-path refusal and unchanged8MiB limit. All12 cases pass eachNode22/24. A later local gate reports3,894 tests/3,856 passes/one native SQLite observer lock failure/37 skips; its exact cause remains unproven. Both unchanged supervisor interruption cases pass independently. Hosted6ca checks finish7/8PASS, with one retention schedule test failure. Controlled native reproduction shows its epoch-aligned next occurrence can be one millisecond away, invalidating the assumption that consecutive calls share one occurrence. The test now pins only synchronous runner observations, restores the native clock in finally before awaits, preserves exact1/0 assertions and checks the next actual boundary;18/18 retention cases pass eachNode22/24 in a reviewed scratch copy. The older local run remains diagnostic only after this fixture edit; a fresh complete corrected-head gate, exact-head hosted checks and protected delivery remain required. Corrected e7 hosted checks finish7/8PASS: package3894/3857/0/0/37, both nativePostgreSQL24/24, packedtypes54/149inherited/0new, Node24andstatic/CodeQLPASS; Node22reportsone mediaSIGKILLrecovery-testfailure. Actual child heartbeat extension after the pre-kill lease read reproducesrunning versusretry. The fixture now waits for a real renewal, captures the final persisted lease after actual process death, and recovers after that lease expires; original one-provider/publication and attempt2 assertions remain. All3process cases pass eachNode22/24. The older live local gate remains diagnostic only after this new fixture edit. Fresh new-head local/hosted gates and protected delivery remain required. Full source readiness/control/write/every-role stop/target/ingress/fallback/interruption acceptance and the remaining original40-feature scope are unchanged. Acceptance stays **29/40**.

## Protected pre-C1 launch data delivery

[PR #389](https://github.com/nearbycoder/clank.run/pull/389) merged normally after all eight exact-head hosted checks pass. Reviewed head `88ac1a4ee3aab0a5de2c2aa2cc36325b19e224fc` becomes main `8937f27c2a12a2899c0fdf3aeb9a29c75b3ba36a`, with identical tree `55db5beec42437faf89c320db0e1c280306f228d` and prior main `137ad21` as its parent. Both original checkouts and the implementation root are synced; all23 original files and all322 tested outputs are verified unchanged. No PR is open at this delivery boundary. [Data retention review](source-launch-data-review.json).

The complete local gate and returned hosted Node22/24/package summaries each report3,881 tests/3,844 passes/zero failures or cancellations/37 existing skips. Local coverage is91.98/82.28/90.12; conformance, documentation, dependency and repository/history security pass. Types54 packed fixtures pass with149 inherited/zero new diagnostics, and each native PostgreSQL job passes24 cases. Truncated hosted logs support only their returned terminal facts. The first narrow fixture refusal mismatch, the initially ignored missing selection argument and the live-log HTTP502 unavailable observation remain retained; no assertion, quota, retry, native profile or package ceiling changed.

The next branch is `codex/provider-source-launch-integration-389`. Actual production launch consumption and complete native readiness/control/write/every-role stop/target/ingress/fallback/interruption acceptance remain required. Browser admin-policy verification remains unresolved. Acceptance stays **29/40**.

## Original committed source launch data review

The private source launch observer derives database/release paths from the original committed provider metadata and binds the exact release, generation, capsule and fence. It reserves bounded capacity before awaits, retains native descriptors, refuses unsettled journals and path redirection, rechecks after its final await, and releases on closure. The actual higher-fence idempotent apply path invalidates an older observation instead of upgrading its authority. [Data retention review](source-launch-data-review.json).

All18 focused Node22 cases and the same18 native cases on each Node22/26 pass. Native cases use the actual existing Docker daemon with all322 guest production modules verified; they create no application containers and claim no readiness/write/stop authority. Both compiled builds match,146 public declarations remain unchanged,54 packed type fixtures pass with149 inherited/zero new diagnostics, and451 package files total7,053,587 bytes below the unchanged8MiB ceiling with zero dependencies. All23 original files are preserved. The complete local gate and all eight exact-head hosted checks pass; protected delivery is recorded below.

Production launch consumption, original native completion/readiness/control/write admission, every-role writer stop and full target/ingress/fallback/interruption proof remain required. Browser admin-policy verification remains unresolved. Acceptance stays **29/40**.

## Protected source service ownership delivery

[PR #388](https://github.com/nearbycoder/clank.run/pull/388) merged normally after all eight corrected-head hosted checks pass. Reviewed head `2d1e95e9804f57a7683cf415b263d428d6d70204` becomes main `137ad215e8460361ab57fee279d8e05a00ce42c8`, with identical tree `b0b7f21ad0b6b98ddd9073c0a7548f1a82554678` and prior main `153d7e8` as its parent. Both original checkouts and the implementation root are synced; all23 original local files and all322 tested outputs are verified unchanged. No PR is open at this delivery boundary. [Ownership review](source-service-ownership-review.json).

The final complete local gate and returned hosted Node22/24/package summaries report3,863 tests/3,826 passes/zero failures or cancellations/37 existing skips. Local measured coverage is91.97/82.29/90.11; conformance, documentation, dependency and repository/history security pass. Packed types54 pass with149 inherited/zero new diagnostics, and both native PostgreSQL jobs pass24 cases. Hosted logs are truncated; only returned terminal facts are claimed. The original seven-pass/Node24-failed head, unknown specific ECONNRESET cause, controlled TCP before/after proof, native admission publication/inode prototype failures and transient log HTTP502 observation remain retained. No assertion, quota, host profile, package limit or retry policy changed.

The next branch is `codex/provider-source-launch-388`. The private source owner admission and stdin entry are delivered; actual production launch consumption, exact settled baseline/fence identity, original native completion/readiness/control/write admission and every-role writer stop remain required before full target/ingress/fallback/interruption acceptance. Browser admin-policy verification remains unresolved. Acceptance stays **29/40**.

## Private source service ownership review

An explicit private source admission reserves exactly one genuine bridge owner before startup awaits. It independently verifies the original non-root Linux/Docker domain, empty initial catalog state, and retained namespace inodes. A final publication check refuses native changes after the last startup await; copies, ordinary owners, retained grants and unsupported versions cannot establish admission. The opaque facade resolves only its original owner and becomes permanently invalid after drift or closure. It grants no application, readiness, write or provider-wide stop authority. [Ownership review](source-service-ownership-review.json).

Review reproduces both a late valid native grant accepted by the prototype and adoption of an equal-byte replacement catalog. Final publication checks and original descriptor retention fix them; restored bytes/inodes cannot revive a failed facade. All290 focused cases pass on each Node22/24, including14 new source admission cases. Fourteen final native Node22/26 cases validate the unchanged original Docker daemon and native namespace/SQLite ownership, with no containers created and all original pins released. All322 paired outputs match, only provider-handoff.js changes,146 public declarations remain unchanged,54 packed types pass with149 inherited/zero new diagnostics, and451 package files total7,047,198 bytes under the unchanged8MiB ceiling with zero dependencies. All23 original local files remain unchanged.

The completed task-owned source-entry upload archive was byte-verified against its retained regular-filesystem copy and relocated there with its original path preserved; no VM backing inode/profile, image, reserve, source data or user file changed. The full local gate is running on owned regular storage; hosted gates and protected delivery remain required. Production factory consumption and full source/readiness/control/every-role writer/target/ingress acceptance remain pending. Acceptance stays **29/40**.

The first complete local ownership gate passes3,862/3,825/0/0/37 with measured coverage91.97/82.28/90.11. Original hosted checks finish with seven passes and Node24 failing one existing native shadow-history test:3,862/3,824/1/0/37. Its returned log shows ECONNRESET but no request phase or reused-socket detail; the specific hosted cause remains unknown. A controlled real TCP endpoint close reproduces the exact reset from the fixture's implicit global idle-socket reuse on both Node22/24. The helper now owns one fresh connection per operation, with no retry/replay or acceptance of transport loss; the same native case completes two requests on two connections. All20 affected shadow-status cases pass on each runtime, including unchanged real guardian SIGKILL/schema-loss assertions. Production bytes, package, types and native ownership proofs remain unchanged. The queued merge was explicitly disabled; the corrected complete local gate and fresh exact-head hosted gates remain required. [Ownership/HTTP repair review](source-service-ownership-review.json).

## Protected private source entry delivery

[PR #387](https://github.com/nearbycoder/clank.run/pull/387) merged normally after all eight exact-head hosted checks pass. Reviewed head `dc1ff4b6caf85107b1717172d3240dc5485b1e6c` becomes main `153d7e83b68db43ea11d9ee4af6140f9d667484a`, with identical tree `4507454e2ed9db8f4ba129b1952de544be603067` and prior main `adad1cd` as its parent. Both original checkouts and the implementation root are synced; all23 original local files and all322 compiled outputs are verified unchanged. No PR is open at this delivery boundary. [Entry review](source-entry-review.json).

The final complete local gate and returned hosted Node22/24/package summaries each report3,848 tests/3,811 passes/zero failures or cancellations/37 existing skips. Local measured coverage is91.97/82.28/90.10; conformance, documentation, dependency and repository/history security pass. Packed types54 pass with149 inherited/zero new diagnostics, and both native PostgreSQL jobs pass24 cases. Hosted logs are truncated; only returned terminal facts are claimed. The host /tmp ENOSPC gate, actual15-case hardcoded-path reproduction, initial CLI/frame fixture failures and transient live-log HTTP502 observation remain preserved. The final gate uses an exact owned regular-filesystem TMPDIR; no assertions, quotas, retry policy, VM or package limit changed.

The next branch is `codex/provider-source-ownership-387`. Production source-service admission, actual launch/health/data ordering, ready/control/write authority, every writer role stopped and full target/ingress/fallback/interruption acceptance remain required. Browser admin-policy verification remains unresolved. Acceptance stays **29/40**.

## Private source entry transport review

The new private source entry receives a bounded canonical environment/bootstrap envelope through stdin EOF before importing the approved application. It refuses extra frames, malformed UTF-8, excessive structure, unsupported fields, invalid paths, symlinks and existing slots, and emits only a fixed failure message. The original constructor still authenticates native bootstrap authority; parser results and slot consumption grant no readiness or write permission. [Entry review](source-entry-review.json).

All218 selected cases pass on Node22 and Node24. Ten genuine-container cases pass across immutable cached Node22/26 images, including original constructor capture and metadata/close/catalog invalidation; all ten exact owned containers are absent. Fourteen native CLI cases pass on each of Node22/24. All322 paired outputs match,146 public declarations remain unchanged,54 packed type fixtures pass with149 inherited/zero new diagnostics, and451 package files total7,042,257 bytes under the unchanged8MiB ceiling with zero dependencies. All23 original local files are preserved. Initial frame/harness failures and package observation formatting are retained. The first complete gate stops on actual host /tmp ENOSPC after2,984 pass records and3 failure records; its log is truncated without a terminal test summary. A separate native reproduction proves all15 source-channel fixtures fail before their assertions because their hardcoded /tmp ignores TMPDIR. The fixture now honors node:os tmpdir(), and all15 cases pass on each Node22/24 with unchanged assertions and production bytes. The fresh complete gate runs in an exact owned regular-filesystem temporary directory; hosted checks and protected delivery remain required.

The container proof starts from a genuine previously committed baseline. Production factory ordering, readiness/control/write admission, every-role writer stop, target activation and ingress/fallback/interruption acceptance remain required. Acceptance stays **29/40**.

## Protected original constructor startup delivery

[PR #386](https://github.com/nearbycoder/clank.run/pull/386) is merged through normal protected squash after all eight corrected-head checks pass. Reviewed head61e5f864a73ba929e8615344a807390e5769ce81 becomes mainadad1cdc74a14d75b168dd35badb24ec18734ce1 with the identical1bd70ecffb3341a0bd80e30a67fa1232634187c4 tree and prior main4fc4397 as its parent. Both original checkouts and the implementation root are synced; all23 original local files and all321 compiled outputs are verified unchanged. No PR is open at this delivery boundary. The next branch is codex/provider-source-entry-386, and its implementation worktree remains locked after exact startup-cleanup recovery. [Constructor/fixture delivery review](source-constructor-review.json).

Hosted Node22/24 and packaged-release jobs each return3815 tests /3778 passes /zero failures or cancellations /37 existing skips. Types pass54 packed fixtures with149 inherited/zero new diagnostics, both native PostgreSQL jobs pass24 cases, and static/CodeQL checks pass. The complete local gate measures91.98/82.27/90.11 coverage and passes conformance/docs/dependency/repository/history security. Package450 files /7,037,232 bytes,146 public declarations and zero dependencies remain unchanged. The first failed checkout-removal gate, exact28-file Git snapshot recovery, original Node24 fixture failures and both controlled reproductions are retained.

This delivers an explicit original-constructor reservation and native completion before returning a source runtime; it grants no readiness/write permission. Production source entry/bootstrap delivery, pre-commit health/post-commit initialization, complete readiness/control/write admission, every-role writer exclusion/stop, target activation and ingress/fallback/interruption proof remain required. Original feature scope remains intact; acceptance stays **29/40**.

## Hosted fixture boundary corrections for constructor delivery

PR386's original c1cec34 head completes all eight hosted jobs: seven pass and Node24 fails two cases,3815 tests /3776 passes /two failures /zero cancellations /37 existing skips. The temporary-access setup INSERT has default zero busy wait and loses to a concurrent native writer; the hosted trace reports SQLite code5 but does not identify the holder. A controlled native two-process test reproduces immediate SQLITE_BUSY with timeout0, then one exact insertion after a separately held writer releases under a bounded1000ms native wait. Only the fixture seed connection gains that wait; no manual mutation retry, permission relaxation or production change.

The usage test assumes its earlier requests and later rate denial stay in one minute. A controlled actual next-minute request reproduces200 versus the original429 assertion. The corrected story pins only Date with the native test mock while keeping real process/network timers and every quota/count/privacy/deletion assertion. All12 affected cases pass on Node22 and Node24. Runtime code, all321 outputs,146 declarations, package450 files /7,037,232 bytes and native constructor proofs remain unchanged. The fresh complete local gate passes3815/3778/0/0/37, measured coverage91.98/82.27/90.11, including conformance/docs/dependency/repository/history security. Original hosted failure, controlled reproductions and prior successful local gate are retained. [Constructor/fixture review](source-constructor-review.json).

Auto-merge is disabled while the corrected head is under review. Fresh final-head hosted all8 checks and protected delivery remain required. This repairs verification; original feature scope and **29/40** acceptance remain unchanged.

## Original constructor source startup reservation

An explicit private startup slot reserves the first original backend constructor before any await, consumes only bounded own data, and refuses later constructors even after failure. Supplied databases and declared jobs are rejected before native opening. The genuine constructor retains original cleanup while building, then initializes through the shared private source helper before returning its runtime. Ordinary no-slot startup and manual initialization remain supported; extra public initialization arguments cannot supply a private constructor bootstrap. This grants no readiness or ordinary-write permission. [Constructor review](source-constructor-review.json).

The review reproduced a native writer changing capture metadata after lower-layer completion but before the new constructor's final await resumed. The original constructor incorrectly returns, and the before test fails with missing expected rejection. The correction independently revalidates the original completion after that final await; the same case now rejects and releases all original catalog/recovery/database pins. The first selected run also retains one fixture failure caused by spreading accessor-bearing retry options; fresh fixed retry options preserve all getter-zero assertions.

All178 focused cases pass on Node22 and Node24,54 packed type fixtures pass with149 inherited/zero new diagnostics, and all321 paired outputs match while146 public declarations remain unchanged. Only backend.js changes. Ten final-code paired immutable Node22/26 container cases prove constructor reservation, original capture before return, competing-constructor refusal, copies/accessors/active reads, native drift/restoration, original close and catalog replay/restoration. Ten earlier prototype cases remain superseded. All38 exact owned containers, including earlier delivery/prototype cases, are confirmed absent on the unchanged daemon, with the unchanged2.25GB reserve maintained. The450-file package is7,037,232 bytes under the unchanged8MiB ceiling with zero dependencies. The first complete gate is interrupted by actual startup-cleanup checkout removal:2125 reported/1970 passes/148 file-missing failures/zero cancellations/seven skips. The saved snapshot recovers all28 exact changed files, all6 frozen inputs and321 rebuilt outputs match their prior proofs, all23 original files remain unchanged, and the active worktree is locked. The fresh recovered complete local gate passes3815/3778/0/0/37, measured coverage91.98/82.27/90.11, including coverage/conformance/docs/dependency/repository/history security.

Production source entry/bootstrap delivery, pre-commit health/post-commit initialization, complete readiness/control/write admission, every-role writer exclusion/stop, target activation, ingress/fallback and original interruption acceptance remain required. Chrome admin policy verification remains unavailable; no bypass or indirect target is used. Fresh exact-head hosted checks and protected delivery remain required. Original feature scope is unchanged; acceptance stays **29/40**.

## Protected original completion and catalog replay repair delivery

[PR #385](https://github.com/nearbycoder/clank.run/pull/385) is merged through protected squash auto-merge after all eight corrected-head checks pass. Reviewed head3ba9148700e3dd067eae5b403b131622c08fe686 becomes main4fc4397395fba2237fda630b4bdccb77cc4129d6 with the identical c57c2e51f751147e515bb051d8c0cdd614086b8b tree and prior mainc21308c as its parent. Both original checkouts and the implementation root are synced; all23 original files and all321 compiled outputs are verified unchanged. No PR is open at this delivery boundary. The next branch is codex/provider-source-control-385. [Completion and replay review](source-completion-review.json).

Hosted Node22/24 and packaged-release jobs each return3797 tests /3760 passes /zero failures or cancellations /37 existing skips. Both native PostgreSQL jobs pass24 cases; types pass54 packed fixtures with149 inherited/zero new diagnostics; static analysis and CodeQL pass. The complete local gate measures91.97/82.26/90.12 coverage and passes conformance/docs/dependency/repository/history security. All18 exact native test containers are absent on the unchanged daemon; public declarations146, package450 files /7,035,420 bytes and zero dependencies remain unchanged.

Production startup still needs explicit source ownership and original constructor reservation before application/background access, resolution of pre-commit health versus post-commit native initialization, complete readiness/control/write admission, every writer role stopped, target activation, ingress/fallback and interruption proof. Current constructor identity capture and single-connection first-base proof do not replace those requirements. Original feature scope is unchanged; acceptance remains **29/40**.

## Original source completion provenance and revalidation

The captured backend retains its exact native completion only after original-connection completion and first-base peer finalization succeed. Its private check requires the original runtime/result pair before accessing claimed fields, then rechecks identity/idleness, current catalog/directory pins and sealed metadata through the original native connection. Copied/serialized/proxied status cannot qualify. Native drift and original close invalidate proof; restored external metadata cannot revive the capture seal. This grants no readiness or write permission. [Completion review](source-completion-review.json).

The review found an additional native catalog replay: the original completion proof accepted a started-to-created regression at version5 with a valid recomputed mirror. That controlled before case fails its refusal assertion and confirms exact container cleanup. The correction permits only original created/version3 or started/version4 bootstrap transitions and permanently closes the source reader after any failed native authority check. It closes the worker client, zeros retained keys and releases catalog pins; restoring original rows cannot revive the original completion. Three native component cases cover created/started version advancement and lifecycle regression with actual row restoration and descriptor-release checks. The original PR head passed all eight hosted checks, but those results cannot qualify this corrected head.

All160 comprehensive cases pass on Node22 and Node24. Ten paired immutable Node22/26 container cases verify positive original completion, copy/accessor/active-read refusal, native drift/restoration, original backend close, catalog version advancement and lifecycle regression/restoration. All18 exact owned containers, including the retained before failure, are absent on the unchanged daemon; the unchanged2.25GB reserve remains intact. All321 paired outputs match,146 public declarations remain unchanged,54 packed type fixtures pass with149 inherited/zero new diagnostics, and the450-file package is7,035,420 bytes under the unchanged8MiB ceiling with zero dependencies. The corrected full local gate passes3797/3760/0/0/37, coverage91.97/82.26/90.12, including conformance/docs/dependency/repository/history security. The original superseded full gate passes3794/3757/0/0/37. Its first run retains11 fixture failures from the old two-field handle detector; the exact complete/assertComplete/close detector restores original native fault/cleanup assertions without skips or assertion retries.

Chrome policy verification remains unavailable; no bypass or indirect target is used. Native browser acceptance, production launch/health/data ordering, original source ready/control/write admission, every writer role stopped, target activation, ingress/fallback and interruption proof remain required. Fresh corrected-head hosted checks and protected delivery remain required. Acceptance stays **29/40**.

## Protected original source bootstrap and canary repair delivery

[PR #384](https://github.com/nearbycoder/clank.run/pull/384) merged through normal main protection as c21308cf962c7441577ef3571a729157d7003d55, with tree6d0d8e619a46649fca1d2e79a88103f9ee5e4cbe identical to reviewed812b52cdb443bb12e07becc1c9adcced507dfefa. All eight hosted checks pass. Final local and returned hosted Node22/24/package terminal summaries report3,793 tests /3,756 passes /zero failures or cancellations /37 existing skips. Measured local coverage is91.97/82.25/90.12; types, conformance, docs and repository/history security pass. Hosted logs are truncated; only returned facts are claimed. [Bootstrap/canary review](source-backend-bootstrap-review.json).

Both original checkouts and the implementation root are synced to protected main. All23 original files and all321 compiled outputs are verified unchanged,146 public declarations remain unchanged, and no PR is open. The450-file package is7,034,035 bytes under the unchanged8MiB ceiling with zero dependencies. The next branch is codex/provider-source-readiness-384; these owned delivery notes remain for its reviewed increment.

This completes the original C0 first-base integration and fixes retired-canary retry admission. It does not establish production source readiness/write admission or the complete online handoff. The actual provider launcher waits for HTTP health inside data.apply validation, while source-worker authority requires COMMITTED data. This ordering must be resolved without adopting prepared facades/unsettled journals, before original readiness, all-writer stop, target activation and ingress/fallback acceptance. Acceptance stays **29/40**.

## Original source backend and native checkpoint channel

The explicit private v2 bootstrap connects the original captured backend to its fixed native channel. The source owns capture and encrypted repository publication; genuine host workers perform only backup/inspect/verify after local capability validation. Original inode pins, read-only mount checks, authenticated byte bounds and deadlines refuse uncertainty without reconnect/replay. The peer stays live through encrypted repository publication and independent original-connection completion; three worker replies alone cannot finalize initialization. Existing v1 behavior and the source write fence remain intact. [Backend/channel review](source-backend-bootstrap-review.json).

All280 focused cases pass on both Node22 and Node24;16 native byte-stream cases model only mountinfo/pathname. Twelve paired real-container cases prove original C0 completion, stale epoch/binding/malformed input refusals, revocation and runtime closure. Actual worker Node descendants have six namespace identities distinct from both live provider and source. Four cancellations close their exact owned worker in66–92ms. All31 owned containers, including draft failures/interrupted cleanup, are absent on the unchanged daemon. All321 paired outputs match,146 public declarations are unchanged,54 packed types pass with149 inherited/zero new diagnostics, and450 files/7,034,035 bytes remain under the unchanged8MiB ceiling with zero dependencies.

The first complete gate fails coverage ENOSPC on host /tmp:3789/3751/1/0/37. The fresh complete gate on a new exact owned regular-filesystem temporary directory passes3793/3756/0/0/37, coverage 91.97/82.25/90.12. The previous filesystem16 gate passed the earlier prototype and remains superseded; final native-completion run21 passed all tests but failed an empty native V8 artifact. Run30 failed a real canary assertion, and the controlled native reproduction proves its original drain receipt could authorize two extra requests after withdrawal. The final gate includes the reproduced peer-lifetime regression and exact empty-artifact signature under the unchanged one-retry/all-pass/measured-coverage policy. No threshold, retry, quota or VM/profile weakening. The canary repair requires fresh admission for every retry/rejected fetch while preserving original admitted response draining. All48 focused ingress/canary cases pass on Node22/24, and both real platform drain cases pass on Node22/26. Fresh hosted checks and protected delivery remain required.

Production launch/health/data ordering, source readiness/write admission, all-writer stop, target activation, ingress/fallback and original interruption acceptance remain required. Acceptance stays **29/40**.

## Protected authenticated source channel delivery

[PR #383](https://github.com/nearbycoder/clank.run/pull/383) merged normally as987adb7e8254b2db0cca0c8bf37883eab1741855, tree9e1287128a3a47b1abeaffb4bbd83d8c92a1ab4e, identical to reviewed71c197f782a9a4b6e7e22e8415218d4eb8b72c42. All8 checks pass; local and returned Node22/24/package terminal summaries report3774/3737/0/0/37. Both original checkouts match protected main and all23 original files/all321 compiled outputs are preserved. No PR remained open before this increment. Earlier timeout/shadow-fixture failures are retained; truncated logs support only returned facts. [Channel review](issued-source-channel-review.json).

## Original issued source channel and authenticated worker integration

The original issued grant now authenticates and owns private channel directories before container creation. An exact native created transition binds one server epoch; concurrent binding, namespace adoption, copied input, key drift and failed opt-in fallback refuse. The genuine container observer admits the fourth read-only channel mount only from this original registry and verifies its actual native identity/permissions. Authenticated three-step requests execute through the existing genuine provider worker. Peer loss/linked owner closure cancels owned work and retains channel pins until its original dispatch/cleanup settles. [Channel review](issued-source-channel-review.json).

All15 component cases and271 focused Node24 cases pass; packed types pass54 fixtures with149 inherited/zero new diagnostics. Sixteen paired native container cases pass, with six final dispatch cases additionally checking namespace enforcement through trusted hosting, zero SQLite spawn on bad authentication and exact active-worker termination on disconnect. Native unlink attempts return EROFS; all33 owned containers are absent on the unchanged daemon, with the unchanged disk reserve preserved. These clients run in the host process and the source entry remains a timer; original C0 capture/bootstrap/readiness and a full host certificate are not claimed. All321 paired outputs match and146 public declarations remain unchanged; the450-file package is7,027,013 bytes with zero dependencies under the unchanged8MiB ceiling. All271 focused cases pass on both Node22 and Node24. The complete local Node26 gate passes3,774 reported/3,737 passed/zero failures or cancellations/37 existing skips, including coverage, conformance, docs and repository/history security. All hosted gates and protected delivery remain required.

PR383's original head passes seven hosted checks, including both runtime suites with3,774 reported/3,737 passed/zero failures or cancellations/37 existing skips. Its packaged-release job is cancelled at the configured25-minute limit, confirmed by the backend annotation. The unchanged complete gate supports one narrowly recognized malformed-coverage-artifact retry after every assertion passes. The job budget now covers both bounded runs and setup/conformance with45 minutes; no assertion, threshold, test or retry limit changes. The truncated original terminal log does not show an earlier retry marker, so that particular attempt is not claimed to have retried. Corrected exact-head hosted gates and protected delivery remain required.

The revised45-minute hosted gate reaches a real assertion failure in the existing anonymous native shadow comparison fixture: a settled response is not counted comparable. A controlled1500ms native candidate response under its original1000ms request budget reproduces the exact0-vs1 assertion and records candidate-timeout. The returned hosted log does not include its unknown-reason map, so the particular hosted reason remains qualified. The positive fixture now explicitly permits10000ms/30000ms and includes that real1500ms response; all metadata/EOF/primary invariants remain required. All40 observer cases pass on Node22 and Node24, including unchanged short deadline failures. Production bytes are unchanged. The corrected full local gate, fresh exact-head hosted checks and protected delivery remain required.

Original backend bootstrap/native completion, readiness/write admission, every writer role stopped, target activation and ingress/interruption acceptance remain required. Acceptance stays **29/40**.

## Protected native source-worker transport delivery

[PR #382](https://github.com/nearbycoder/clank.run/pull/382) merged through normal main protection as `a01a1d0f1b405fd740e59d97b890e9a05cb1902b`, tree `09a7db020816d9bddbc8eb3ecc402aa91995e53a`, identical to reviewed `12763529fa604b8ffc5590a488ea3505b5b1c894`. All eight hosted checks pass. Final local Node26 and returned Node22/Node24/package terminal summaries each report3,759 tests /3,722 passes /zero failures or cancellations /37 existing skips. Coverage, packed types, conformance, docs and repository/history security pass. Hosted logs are truncated; only their returned terminal summaries are claimed. The original import-gate and native UTF-8 rejection failures remain retained. [Transport review](source-worker-transport-review.json).

Both original checkouts and the implementation root HEAD match protected main. All23 original local files and all321 tested compiled outputs are verified unchanged, and no PR is open. The450-file package is7,013,658 bytes under the unchanged8MiB ceiling with zero dependencies and146 unchanged public declarations. The next working branch is `codex/provider-source-channel-grant-382`; these delivery notes are retained for its reviewed increment.

This delivers raw socket framing, native directory/socket ownership and actual child-close cleanup. Genuine issued-grant preparation, the fourth read-only container mount, authenticated worker dispatch, original captured backend bootstrap/readiness, provider-wide writer exclusion and complete target/ingress acceptance remain required. Acceptance stays **29/40**.

## Native private source-worker transport review

The source-worker wire module now contains a raw UNIX broker using three original private directory capabilities, a pinned socket inode and a fixed owned ChildProcess. It bounds one peer, three sequential frames, one unanswered request, native UTF-8 bytes, escaped IPC and absolute collection/reply deadlines. Directory and socket identity are checked before frame delivery. It mints no provider/source authority and executes no SQLite operations. [Transport review](source-worker-transport-review.json).

Native review reproduced Node's automatic listener cleanup deleting a replacement pathname. The broker now closes from a separate empty non-writable directory and waits for actual child close before removing only its pinned socket names. Unknown endpoint replacements are preserved. Further review fixes dangling-symlink admission, JSON-escaped maximum replies, waiting-frame identity drift, decoder byte accounting and reused directory-FD cleanup authority. All169 focused cases pass on Node22 and Node24;54 packed type fixtures pass with149 inherited and zero new diagnostics. All321 paired outputs match,146 public declarations are unchanged and the450-file package is7,013,658 bytes under its unchanged8MiB ceiling with zero dependencies. The original full gate fails its browser import deferral scan despite all18 native broker cases passing; the child now dynamically loads its native modules without changing the scan. An independent native rejection probe also reproduces a hidden incomplete UTF-8 suffix after a newline; the broker now requires the newline to be the final native byte. All20 corrected native cases and the unchanged import scan pass. Corrected focused/type, complete local and all eight exact-head hosted gates pass; protected delivery is recorded above.

This implements raw socket ownership only. Genuine issued-grant preparation, fourth read-only mount, authenticated provider worker dispatch, original captured backend bootstrap/readiness, writer exclusion and target/ingress acceptance remain required. Acceptance stays **29/40**.

## Protected provider worker authority delivery

[PR #381](https://github.com/nearbycoder/clank.run/pull/381) merged through main protection as `ae645b6dcbd11d6d699f4a44cf4f94bde632bea2`, tree `10b886586d19826dad93920950a5b780a92b14a5`, identical to reviewed `ac1edc0`. All eight hosted checks pass. Final local Node26 and returned Node22/Node24/package summaries each report3,739 tests /3,702 passes /zero failures or cancellations /37 existing skips. Coverage, packed types, conformance, docs and repository/history security pass. Hosted diagnostics remain truncated terminal summaries. [Worker review](source-worker-authority-review.json).

Both original checkouts and the implementation root match protected main. All23 original local files are verified unchanged, no PR is open, and all321 compiled outputs match the tested pair. During final delivery, the original `d164/clank` checkout disappeared. Git's startup-cleanup snapshot `a63a4e0`, whose parent is prior main `4b7176d`, contains exactly its seven original untracked files with identical sizes and hashes. The checkout was restored at that prior main, those exact files restored as untracked, and normal protected-main synchronization completed. The snapshot reference and an independent recovery copy remain intact; no unrelated data was removed. Subsequent work uses `codex/provider-source-worker-transport-381`.

This delivers genuine provider-derived fixed host workers and persistent workspace identity through their three-operation lifetime. Socket/channel mounts, coupled original-connection bootstrap, readiness/write admission, all-writer exclusion and complete handoff/target/ingress evidence remain required. Acceptance stays **29/40**.

## Genuine provider source worker review

A private capability can now be minted only from the original retained provider container/data/grant ownership. It derives source paths and holds four native host directory capabilities through backup, inspection and verification of one backup. Inode, UID/GID, private mode and canonical-path checks continue between operations. Provider tasks always use default namespaces through trusted hosting; constructor source and ordinary helper policies retain their contracts. Close awaits owned work/cleanup; its ten-second deadline reports uncertainty while retaining the original flight and any unsettled ownership. Native task scheduler release continues to follow actual task close. [Worker review](source-worker-authority-review.json).

Native review reproduced replacement-directory adoption between operations in the unpublished draft. Retained workspace pins now refuse it; linked parent closure also releases idle pins. All22 final paired Node22/26 cases pass, including fixed execution, authority/scope, active and idle close, native revocation/stop, directory replacement during/between work, queue cancellation and held close observation. Deadline cases delay the framework callback after actual child termination; no kernel-stall, captured C0 app, independently sampled worker namespace or full host certificate is claimed. Three setup/fixture failures and the actual draft directory-adoption failure remain retained. All47 exact owned containers are absent on the original daemon, and the guest remains above its unchanged2.25GB reserve.

All321 paired outputs match and146 public declarations remain unchanged. Final focused/type and full local/hosted gates are required before delivery. The450-file package remains below the unchanged8MiB ceiling, with zero dependencies. Channel mounts/transport, coupled original-connection bootstrap, readiness, writer exclusion and complete handoff acceptance remain pending. Acceptance stays **29/40**.

## Protected source worker cancellation delivery

[PR #380](https://github.com/nearbycoder/clank.run/pull/380) merged through main protection as `4b7176dbfd578846a483ab8865d9a827423ba07c`, tree `85a2535d345c0b11c3099516ae35c5e0da87d9bf`, identical to reviewed `cbe92d6`. All eight final hosted checks pass. Final local Node26 and returned Node22/Node24/package summaries each report3,738 tests /3,701 passes /zero failures or cancellations /37 existing skips. Measured local coverage is92.01/82.32/90.23; types, docs, packed conformance and repository/history security pass. Hosted diagnostics are truncated summaries. The original worker failure and both fixture COMMIT failures remain retained, with a deterministic reader-lock reproduction and one bounded-wait committed mutation.

Both original checkouts and the implementation root match protected main. All23 original files remain unchanged, no PR is open, and all321 compiled outputs match the tested pair. The450-file package remains6,996,714 bytes under the unchanged8MiB ceiling, with zero dependencies and unchanged public declarations. The reviewed branch is preserved; subsequent work uses `codex/provider-source-worker-authority-380`.

This delivers active/queued cancellation for original constructor-minted backend source tasks. Genuine provider host worker authority, complete host policy certification, coupled channel/bootstrap, readiness, all-writer exclusion and the complete handoff/target/ingress path remain required. Acceptance stays **29/40**. [Cancellation review](source-worker-cancellation-review.json).

## Shared source fixture catalog write correction

The narrow cancellation-fixture correction passes its full local3,738/3,701 gate, but its hosted packaged gate identifies the same native COMMIT lock collision in an older worker-admission revocation story. The shared fixture therefore now defaults all catalog mutation calls to one bounded1,000ms SQLite busy wait. The deterministic reproduction explicitly retains zero wait and confirms rollback; the corrected transaction still invokes its body once and commits one version increment. All153 final runtime/sandbox/wire cases pass on Node22/24/26. All production code and321 paired outputs remain identical to the original cancellation head. Both hosted failures are retained; final full local and eight fresh hosted gates remain required before delivery. Acceptance stays **29/40**. [Cancellation review](source-worker-cancellation-review.json).

## Source cancellation fixture contention correction

PR380's original head passes seven hosted gates, including the complete packaged gate and Node22 suite, but Node24 reports one failure at the new revocation fixture's COMMIT: native SQLiteerr5. A real retained reader reproduces the same commit refusal; the failed transaction rolls back. The corrected cancellation fixtures wait at most one second for that reader lock, execute the mutation body once, and independently prove revoked state and one catalog version increment. The original CI reader connection/timing was not sampled; watcher contention is an inference from the code and reproduced native condition. Production code and all321 compiled outputs remain unchanged. The corrected153-case runtime/sandbox/wire selection passes on Node22/24/26. The final probe owns a20-second failure cleanup deadline. Corrected full local and all eight hosted gates remain required; no unchanged-head rerun or green delivery is claimed. [Cancellation review](source-worker-cancellation-review.json).

## Source worker cancellation review

Original constructor-minted source tasks now cancel queued admission and terminate their exact owned native worker when retained source authority is lost. Rejection waits for the actual child close; sandbox cleanup and scheduler release follow it. Queued cancellation removes only its own entry, and aborting an already admitted task cannot release its slot early. Existing fixed source projection, default namespaces, resource bounds and ordinary workers retain their contracts. [Cancellation review](source-worker-cancellation-review.json).

Unchanged main reproduces a revoked, stdin-held native worker remaining alive beyond the two-second regression bound. Corrected native revocation, backend closure and catalog replacement require actual worker close, SIGKILL and PID absence before rejection. Queued revocation preserves two unrelated ordinary workers and later admission. These tests use genuine constructor tokens, SQLite and Bubblewrap, with explicitly scripted Docker-domain/grant setup. All ten final cancellation/scheduler cases pass on Node22/24/26; the broader174-case selection passes on each runtime. The full final local gate passes3,737 reported /3,700 passes /zero failures or cancellations /37 existing skips, including measured coverage, packed conformance, docs and repository/history security. All321 paired outputs match, public declarations are unchanged, and the450-file package is6,996,714 bytes under the unchanged8MiB ceiling with zero dependencies. Hosted exact-head checks and protected delivery remain required.

This implements cancellation for the existing backend source context. Genuine provider host worker authority, coupled channel/bootstrap, readiness, writer exclusion and complete handoff acceptance remain pending. Acceptance stays **29/40**.

## Protected container observation and supervisor recovery delivery

[PR #379](https://github.com/nearbycoder/clank.run/pull/379) merged through main protection as `068559f249a1bda0171e3343bd97f3bf520f2964`, tree `49ff2d05394a01ecd576dad6acab41b24515e2dd`, identical to reviewed `e785bc0`. All eight corrected hosted checks pass. Corrected local Node26 and returned Node22/Node24/package terminal summaries each report3,730 tests /3,693 passes /zero failures or cancellations /37 existing skips. Measured coverage, packed conformance, docs, public typing and genuine repository/history security pass; returned hosted diagnostics remain truncated summaries.

The original packaged SIGSTOP failure remains retained. A genuine process-held SQLite lock reproduces it on unchanged supervisor code; corrected native recovery and the five-second ordinary/running-owner bounds pass on all three runtimes. The container observation's original native proof and code remain unchanged by that repair. Both original checkouts and the implementation root match protected main, all23 original files remain unchanged, no PR is open and all321 compiled outputs match the tested pair. The450-file package is6,995,134 bytes under the unchanged8MiB ceiling with zero dependencies and unchanged public declarations. An existing historical branch prevented only the final new-branch registration; it is preserved, and the verified checkout now uses fresh `codex/provider-source-worker-capability` without repeating merge or sync mutations.

This delivers current container observation and safe stopped-supervisor startup waiting. Worker capability/active cancellation, complete network/daemon policy certification, channel mount/socket transport, original application bootstrap/readiness and the complete handoff/stop/target/ingress path remain required. Acceptance stays **29/40**. [Container review](source-container-admission-review.json) · [Recovery review](supervisor-frozen-lock-review.json).

## Stopped supervisor lock recovery correction

PR379's original container-observation head passes seven hosted checks but its packaged release gate fails the existing native SIGSTOP source-reservation story: successor enrollment encounters a locked supervisor catalog. The source may be stopped inside a SQLite write transaction while its independent guardian still honors a thirty-second lease; the original five-second enrollment wait cannot cover that real fencing interval. A corrected owned fixture deterministically retains a native write lock in the actual source PID before SIGSTOP and reproduces the same startup failure. The first unsupported managed-BEGIN fixture attempt is retained separately. [Lock review](supervisor-frozen-lock-review.json).

The corrected opener grants no duties while waiting. Only a committed matching native lease/configuration plus an actual stopped PID/birth permits one monotonic extension bounded by its remaining lease and five-second cleanup margin, capped by the configured lease plus five. Generic, running and unknown writer contention retains the five-second deadline; transaction bodies, commits, epoch changes, process signals and normal fencing are not retried. Eight focused real-lock/recovery cases pass on each Node22/24/26, including the forced SIGSTOP and unchanged generic/running-owner deadlines. All42 broader supervisor/recovery cases pass on Node22 and Node24. The corrected full local Node26 gate passes3,730 reported /3,693 passes /zero failures or cancellations /37 existing skips, with measured coverage on its first run, packed conformance, docs and repository/history security. All321 corrected paired outputs match; only the private supervisor module changes from the original reviewed container head, and public declarations stay unchanged. The450-file package is6,995,134 bytes under the unchanged8MiB ceiling with zero dependencies. A new reviewed head, all eight hosted gates, protected merge and main synchronization remain required. Acceptance stays **29/40**.

## Native source container observation review

A genuine committed-data lease now retains the original running source process root and six namespace descriptors. Current checks cover PID birth, exact app/data/catalog bind sources and inode identity, read-only mounts, native non-root UID/GID/groups, zero capabilities, no-new-privileges, AppArmor/seccomp flags and actual cgroup memory/swap/CPU/PID/unfrozen limits. Exclusive native domain checks and exact container/image/grant metadata surround verification awaits. Closure links through data, grant and owner, and uncertain cleanup refuses publication. Copies cannot pass the genuine lease registry. This supplies native container observation; it does not admit a SQLite worker, open the control socket, initialize the original application capture handle or prove source readiness/writer stop. [Admission review](source-container-admission-review.json).

Actual provider data-store commits and native grant issue/created/started acknowledgments support paired immutable Node22/26 container tests. Eight lifecycle cases independently verify seven retained descriptors and refusal/release after stop, pause, data close and durable revocation; two final-source paired cases pass after supplementary-group tightening. Each case performs twelve native verifications. All fifteen exact owned test containers, including retained failures, are absent on the original daemon. This is observation evidence, not a full host certificate or Feature07 acceptance.

All413 focused handoff/data/source/wire cases pass on Node22/24/26, including56 new scope refusals. Packed types pass54 fixtures with149 inherited/zero new diagnostics; all321 paired compiled outputs match and only the private handoff module changes. The450-file package is6,993,316 bytes under the unchanged8MiB ceiling with zero dependencies and unchanged public declarations. The native default nullable OOM field and unordered mount-array comparison faults are retained with their narrow corrections; the unrelated-process fixture and isolated prompt-copy faults remain qualified. The complete local Node26 gate passes3,729 reported /3,692 passes /zero failures or cancellations /37 existing skips, including coverage, packed conformance, documentation and repository/history security. Its first all-green runtime suite produced a known malformed experimental coverage artifact; the existing single isolated retry passes the measured report and unchanged runtime cases. Hosted gates, protected merge and main synchronization remain required. Acceptance stays **29/40**.

## Protected committed source data delivery

[PR #378](https://github.com/nearbycoder/clank.run/pull/378) merged through main protection as `21dec48f5d251bd191ca90c6ec25053960ab7bd5`, tree `07e3439ad66a710be189451c335d9a0456881e46`, identical to reviewed `abcc0bd`. All eight hosted checks pass. Corrected full local Node26 and returned Node22/Node24/package terminal summaries each report3,673 tests /3,636 passes /zero failures or cancellations /37 existing skips. Packed conformance, docs and genuine repository/history security pass. Hosted diagnostics are explicitly truncated summaries; unreturned full-log bytes are not claimed. Original CodeQL fixture finding and first complete local result retain their earlier scope; corrected malformed-fixture construction requires no suppression or production change.

Both original checkouts and the implementation root match main; all23 original files remain unchanged, no PR is open, and all321 compiled outputs match the tested pair. The450-file package is6,978,904 bytes under the fixed8MiB ceiling with zero dependencies. This delivers native committed-data observation and nonblocking file opens, including actual data-store/native FIFO/descriptor tests. Container/mount/process proof, host worker authority/execution, socket transport, coupled bootstrap, readiness, all-writer stop and target activation remain required. Acceptance stays **29/40**. The next working branch is `codex/provider-source-worker-admission`.

## Committed source data ownership and nonblocking file opens

Source data locations now derive from a genuine retained grant and the provider root's native committed state/fence, rather than a caller copy of prepared runtime data. The observer pins the project/data/generation/release/metadata/database identities and rechecks complete metadata bytes, canonical paths, private UID/modes, single regular-file links, inode/size and journal absence. Exact project/release/generation/capsule/fence must agree. Data leases have their own descriptor lifetime and close with the parent grant/owner; copied facades and recycled data identities refuse. This is observation support for worker admission, not a running-container/mount certificate or worker execution API. [Data ownership review](source-runtime-data-review.json).

Review of the new mutable database path found a FIFO race between regular-file inspection and open. Retained regular files now also open with O_NONBLOCK before their native identity check. A disposable bounded child confirms the old syscall blocks on an actual FIFO. Removing only that flag in a reconstructed unpublished runtime makes the regression fail on Node22/24/26; the test refuses to attempt a blocking open when the flag is absent. This is explicitly not a full old-main source launch or production exploit claim. Corrected native replacement and bounded metadata-growth checks pass.

All345 handoff/data/source/wire cases pass on Node22/24/26, including46 new data-boundary cases and actual provider data-store migrations/commits for direct/nested paths. The shared private parser reuses the complete ordinary state/project/rollback validation and preserves ordinary readState behavior. Paired builds match321 outputs, changing only the data and private handoff modules; no package files, public declarations, dependencies, schemas or host profiles are added. Types pass54 fixtures with149 inherited/zero new diagnostics against154. The first full local gate passes3,673 reported /3,636 passed /zero failures or cancellations /37 existing skips. Hosted CodeQL flags the intentionally invalid duplicate-key fixture as incomplete escaping; it now constructs the same invalid outer key explicitly, with no suppression or production change. This original check/finding remains retained; corrected full local and hosted gates remain required before protected delivery. Acceptance remains **29/40**; actual data/mount/worker admission, socket transport, coupled bootstrap and the complete handoff scope remain pending.

## Protected source grant lease delivery

[PR #377](https://github.com/nearbycoder/clank.run/pull/377) merged through normal main protection as `1b9b80a4ee2548ce2f7471f7d963f7bd54168a44`, tree `5228a7545f8c5e72f00fd25e174f8c1e2380158e`, identical to reviewed `b6471f4`. All eight hosted checks pass. The full local Node26 gate and returned Node22/Node24/package terminal summaries each report3,627 tests /3,590 passes /zero failures or cancellations /37 existing skips. Packed conformance, docs and genuine repository/history security pass. Returned hosted diagnostics are explicitly truncated summaries; no unreturned full-log bytes are claimed. Initial Node24 fixture-mode and output-collector failures remain retained and qualified.

Both original checkouts and the implementation root match main; all23 original local files remain unchanged, no PR is open, and all321 compiled outputs match the tested pair. The450-file package is6,972,036 bytes under the fixed8MiB ceiling, with zero dependencies and no new public declarations or schema/profile changes. This delivers genuine catalog grant observation support and cleanup fixes. Provider data/mount/worker authority, socket transport, coupled bootstrap, readiness, all-writer stop and target activation remain required. Acceptance stays **29/40**. The next working branch is `codex/provider-source-worker-runtime`.

## Retained source grant observations

The private provider foundation now mints a retained catalog lease only from a genuine live owner bridge, the exact started grant/version/container/binding and native control-key digest. Its separate descriptor lifetime pins the complete catalog roster; fresh schema, mirror, binding, version, UID, mode and inode checks run on every use. Domain verification holds the owner lane and probes before and after the native observation. Revocation, replacement, drift and closure permanently refuse the lease. Copies and serialized facades cannot pass the genuine lease check. No database path, worker permission, socket, readiness or all-writer stop is granted. [Lease review](source-grant-lease-review.json).

All47 native lease cases pass on Node22, Node24 and Node26; the broader290-case handoff/source/wire selection also passes on each version, with the final two cleanup cases verified afterward. Paired builds match all321 outputs and change only the private handoff module. Packed types pass54 fixtures with149 inherited/zero new diagnostics against154. Lease lifetime tests independently verify descriptor counts, owner closure, held native domain waits, final unpublished-facade refusal, queue/capacity limits and aggregation of multiple cleanup faults. Docker-domain setup and started rows remain explicitly scripted component evidence.

The first Node24 selection retains two fixture failures: copying a0700 directory produced0755, so the production guard correctly refused permissions before inode identity. A separate native probe reproduced that mode change; the corrected fixture checks identical bytes/modes before probing replacement. The initial output collector also retains its175-JS versus321-total-output assertion error; the corrected collector compares all JS/declaration files. Fresh full local release checks, hosted checks and protected delivery remain required. Feature acceptance remains **29/40**; provider data/mount/worker authority and the complete handoff path remain pending.

## Protected worker wire delivery

[PR #376](https://github.com/nearbycoder/clank.run/pull/376) merged through normal main protection as `32379212060cbea623446ea8fee5879b0a603473`, tree `1eb2d5f8eec68f4e27aee46eff0d5fbbd1baacaa`, identical to reviewed `104a509`. All eight hosted checks pass. Node22, Node24, packaged release and the complete local Node26 gate each report3,580 tests /3,543 passes /zero failures or cancellations /37 existing skips. Packed conformance and repository/history security pass. The original five stale inventory expectation failures remain retained and qualified; corrected exact inventory tests pass12/12 on all three runtimes. Returned hosted diagnostics are truncated summaries, with no unreturned full-log claim.

Both original checkouts and the implementation root match main, all23 original local files remain unchanged, and no PR was open at the delivery boundary. All321 compiled outputs match the tested pair. The450-file package is6,965,448 bytes under the fixed8MiB ceiling with zero dependencies. Independent422/449 fixtures retain previous inventories; the current manifest adds only the reviewed private wire module. This delivers formatting/correlation support, not native provider worker authority or socket transport. Coupled launch, readiness, writer stop, target activation and the other remaining verification stories remain required. Acceptance stays **29/40**.

## First-base worker authentication protocol

The shared private wire module supports the existing first-base backup, inspection and verification sequence. Request/response keys use separate HMAC contexts bound to the source digest, container, incarnation and a freshly generated server epoch. Strict canonical own-data fields, fixed task/result shapes, bounded frames, one pending request, nonces, sequence and exact request-digest correlation prevent cross-request acknowledgment and replay. A copied or foreign receipt cannot respond; refusal, uncertainty and explicit close stop further initialization. New server epochs refuse earlier authenticated requests. [Wire review](source-worker-wire-review.json).

All31 wire cases pass with coverage on Node22/24/26, including independent HMAC computation and an actual default Linux SQLite backup/inspection/verification pipeline. Native reads confirm the exact two snapshot records and unchanged source bytes. The complete103-case source-runtime selection passes on all three versions; its provider domain/catalog setup remains scripted component evidence. Wire coverage is100/94.78/100 percent lines/branches/functions. Paired builds match321 outputs; the existing private task module changes only blank lines around its shared erased type. Packed types pass54 fixtures with149 inherited/zero new diagnostics against154.

One private JavaScript module is added to the exact450-file manifest, under the unchanged8MiB ceiling and zero-dependency contract. The first complete run reports3,580 tests /3,538 passed /5 failures /zero cancellations /37 existing skips; all five failures are stale449-file test expectations. The prior protected449 inventory is now retained independently alongside the422 fixture, and the current450 inventory permits only the explicit wire-module addition. The corrected12-case budget selection passes on Node22/24/26; swapped/missing/extra-path refusal and the inclusive8MiB ceiling remain unchanged. The production budget helper is byte-identical. Original full failure evidence is retained; fresh complete checks are required. Formatting/correlation does not mint provider or filesystem authority. Genuine provider worker capability, socket transport, coupled source launch and the remaining complete handoff path still require implementation and native proof. Complete final local/hosted checks and protected merge remain required for this new source change. Acceptance remains **29/40**.

## Protected source task scope delivery

[PR #375](https://github.com/nearbycoder/clank.run/pull/375) merged through normal main protection as `31e613c95647abb0b609ac37912c7b1286bbf482`, tree `418a0e55fac54eabcc0c94970a24a04e373e660a`, identical to reviewed `dc77917`. All eight hosted checks pass. Node22, Node24 and packaged release each report3,549 tests /3,512 passes /zero failures or cancellations /37 existing skips. The final complete local Node26 gate reports the same counts and passes packed conformance/security, with91.98/82.26/90.24 percent line/branch/function coverage. Returned hosted log summaries are explicitly truncated; no unreturned full-log bytes are claimed.

Both original checkouts and the implementation root match the merged tree. All23 original local files remain unchanged; no PR was open at the delivery boundary. All320 compiled outputs still match the tested candidate. The source task projection and immutable admission inputs are delivered prerequisites; provider worker authority, authenticated transport, coupled launch, readiness, writer stop and target activation remain pending. Feature acceptance stays **29 accepted /11 pending**. The subsequent working branch continues the [integration plan](source-worker-channel-plan.md); earlier review snapshots retain their recorded pre-publication scope.

## Protected transfer delivery and source task scope review

[PR #374](https://github.com/nearbycoder/clank.run/pull/374) merged through main protection as `16350d35d496507c9e48ecf59d61d3d6e0bbee81`, tree `76af7c6317d55ee17cd15bb5afa75050061a4bae`, identical to reviewed `e05e30d`. All eight hosted checks pass. Node22, Node24 and packaged release each report3,535 tests /3,498 passes /zero failures or cancellations /37 existing skips; packed release conformance passes. Both original checkouts match, all23 original files remain unchanged, and no PR was open at this delivery boundary.

Native source review then reproduced successful inspection and backup of an unapproved sibling SQLite file through a genuine constructor-minted source token. The repair restricts source tasks to the three actual initialization operations, exact generated paths and four genuine retained directory capabilities. It checks retained directory identity, UID and mode before admission and emits a bounded internal projection with no paths, SQL or credentials. Reviewing the unpublished candidate additionally reproduced caller argument mutation during admission; frozen copies now preserve approved arguments and capabilities across awaits. [Source task review](source-task-scope-review.json).

Fourteen new scope cases and all103 source-runtime cases pass on each Node22/24/26 with default Linux namespace workers and the original captured backend. These component fixtures explicitly use scripted Docker-domain/catalog setup; they do not prove a coupled Docker source launch. Exact-byte adoption and Node22/26 builds match all320 outputs; only `sqlite-task.js` changes. The final ordinary worker/package selection passes32/32. Types pass54 fixtures with149 inherited/zero new diagnostics against154; documentation and genuine repository/history security checks pass. The449-file package is6,955,556 bytes under the unchanged8MiB ceiling, with zero dependencies.

The first candidate complete check passes3,546 reported /3,509 passed /zero failures or cancellations /37 existing skips. It precedes the mutation repair and retains that scope; the final-source complete local and hosted gates remain required before protected merge. Earlier fixture synchronization/admission failures are retained and qualified rather than counted as defect reproductions. The separate [native channel feasibility result](source-worker-channel-feasibility.json) and [integration plan](source-worker-channel-plan.md) record paired Docker clients and default host workers without claiming source authority or readiness. Provider capability reconstruction, authenticated transport, writer stop, target activation and pending browser stories remain unfinished. Feature acceptance remains **29 accepted / 11 pending**.

## Protected policy delivery and transfer metadata review

[PR #373](https://github.com/nearbycoder/clank.run/pull/373) merged through main protection as `adf7a4da0a7da61c5b0fdb817cb0b5907fc06c4a`, tree `c86b3ca56d3624805fc218bd7e7b5a2e3bcf738d`, identical to reviewed head `76d2b2a`. All eight hosted checks pass. Node22, Node24 and packaged release each report3,529 tests /3,492 passes /zero failures or cancellations /37 existing skips; packed authentication, deployment, migration, failed activation, rollback and data restore pass. Both main roots are synchronized, all23 prior local files are preserved, and no PR remained open at this delivery boundary.

The subsequent native transfer review reproduces six acknowledged metadata faults on each Node22/24/26: a receipt trigger changes the enrolled archive, initial cursor, prior receipts or capture time while the real transfer still publishes success. The repair compares the full retained enrollment, expected capture row and exact prior-plus-new receipt set before the replay transaction commits. Any alteration rolls back before publishing the stopped destination. Existing receipt, memory and deadline limits remain. [Transfer review](transfer-retained-metadata-review.json).

The adopted selection passes34/34 with experimental coverage on each runtime:32 component cases, including six new refusal/rollback/exact retry cases, and two actual default namespace integrations. Component fixtures retain their explicit trusted-process scope; namespace integrations independently inspect source/target identities and source SIGKILL continuity. All targets remain stopped. Candidate Node22/26 builds match320 outputs, and the adopted Node26 outputs match them exactly; only the transfer worker changes. Packed types pass54 fixtures /149 inherited diagnostics /zero new diagnostics against baseline154. Documentation and genuine-checkout security/history audits pass. The449-file package is6,950,588 bytes under the fixed8MiB ceiling with zero dependencies. Earlier fixture/launch/archive-audit failures are retained and qualified. Fresh final hosted checks and protected delivery remain required.

An independent Chrome check renders the actual public customer status page and its native component health. Chrome blocks the redirect to the authenticated publication form before observation; the owned server and tab were closed with zero submitted status forms. Console, discard and other browser acceptance remain pending. This repair and partial observation leave acceptance at **29/40**; supported source-worker admission, provider-wide stop and target activation remain incomplete.

## Protected focus delivery and security policy publication repair

[PR #372](https://github.com/nearbycoder/clank.run/pull/372) merged as `6081d39aa115336ef68297e988a25bacfc9a8d4c`, preserving reviewed6232efe5 tree `5cdffa95631b1b83dc40596f996da14b5e53a398`. All eight checks pass. Complete Node22, Node24 and packaged coverage each report3,513 tests/3,476 passes/zero failures or cancellations/37 existing skips; packed release conformance passes. Both main checkouts are synchronized, all23 original files remain unchanged, and no PR was open at this delivery boundary.

Native review of Feature13 then reproduced an acknowledgment defect: an audit trigger could retain no factor requirement and thirty-day sessions while the response confirmed MFA and five-minute sessions. Ignored policy/receipt/deadline writes, altered policies/receipts/enrollments and removed administrator authority also escaped final verification. Both policy changes and operator recovery now verify intent-derived native policy, replay receipt and exact tightened enrollment rows after callbacks and current authority, before commit. Uncertain publication rolls back; removing the fault permits the same intent to succeed exactly once. Recovery also requires the restored owner and passkey capability to remain current. [Publication review](organization-policy-publication-review.json).

On unchanged code, all14 new native controller cases and both real HTTP cases fail on each Node22/24/26. The adopted four-module integration selection passes66/66 on each runtime, without skips. Node22/26 produce identical320 outputs; only the policy module changes, with no declaration or schema changes. Types pass54 fixtures with149 inherited/zero new diagnostics against154; docs/security pass. The449-file package is6,949,536bytes under the fixed8MiB ceiling with zero dependencies. Initial frozen-clock fixture failures and the first before collector limitation remain qualified. Fresh hosted checks and protected delivery are still required for this repair.

A separate actual Chrome workflow on the now-delivered6232efe5 source confirms account switching during a held native object response cannot attach under Bob. Alice reopens the identical IndexedDB item, resumes actual uploads and attaches exactly once: one native record, receipt and object. At390×844, client and content widths both375px; warnings/errors are absent. Screenshot capture timed out, so no screenshot is claimed. This completed fixture was cleaned up; the earlier discard confirmation and Console launch remain failed browser boundaries. These are partial acceptance proofs: counts remain **29 accepted / 11 pending**.

## Current protected delivery and attachment focus review

[PR #370](https://github.com/nearbycoder/clank.run/pull/370) merged as `3c549a6`, tree `9fd2303efb1f023aa286782b876508ebf0ffbd08`. Its final eight hosted checks pass; Node22, Node24 and packaged coverage each report3,474 tests/3,437 passes/zero failures or cancellations/37 existing skips. The earlier retention assertion failure is retained. [PR #371](https://github.com/nearbycoder/clank.run/pull/371) then merged as `5e5121540c4927ff255639fbff1004f9883a9b84`, tree `ec0c344dc8752ceb07c453306e1fee9b2f2f8e53`, identical to reviewed975df1c. Its eight checks pass; both runtime suites and packaged coverage each report3,509 tests/3,472 passes/zero failures or cancellations/37 existing skips. Packed authentication, deployment, migration, rollback and data restore pass. Both main checkouts match5e51215 and all23 existing local files remain unchanged. No PR remained open at this delivery boundary. Grant revocation is a prerequisite, not provider-wide process stop or target activation.

Subsequent attachment review reproduced focus loss when a current snapshot failure removes the focused Retry control or disables focused Synchronize. The current-generation error path now moves that lost focus to the existing status. Settlement-time focus outside the queue is preserved; successful recovery leaves focus on status. Three of four new tests fail on unchanged code; all20 view cases pass with coverage on each Node22/24/26 in the candidate and adopted repository. Actual Chrome with native HTTP/IndexedDB confirms focused Retry→status on a declared post-read observation failure and retains status focus through recovery. No record, receipt or object was created by this check. Screenshot capture timed out; no screenshot proof is claimed. [Focus review](attachment-refresh-focus-review.json).

All320 outputs match on Node22/26; only the attachment module changes. Types pass54 packed fixtures with149 inherited/zero new diagnostics against baseline154; docs and security pass. The449-file package is6,947,319bytes under the fixed8MiB ceiling, with zero dependencies. Initial type-command and package-record collector mistakes are retained and qualified. Fresh hosted checks and protected delivery remain required for this focus repair. Current-main upload, MIME rejection, Retry focus and IndexedDB persistence work in Chrome, but discard/phone and remaining Console acceptance are unverified. Acceptance remains **29 accepted / 11 pending**; earlier evidence sections retain their historical scope.

## Durable provider grant revocation follow-up

The private handoff bridge now supports native authority revocation for issued, created and started grants. Revocation retains any observed container identity, grant secrets, binding and reserved quota. It switches the bridge to cleanup-only mode, compares the complete native preimage, verifies the grant and version/mirror again before and after commit, and holds consulted catalog/index identities through awaited native domain checks. Exact five-field retries perform no updates and can recover committed-but-uncertain synchronization or commit responses after restart. [Review evidence](provider-grant-revocation.json).

All205 provider ownership/bridge/runtime/client cases pass with experimental coverage on each Node22/24/26. The adopted repository passes all35 new revocation cases on all three runtimes. Actual isolated managed children refuse bootstrap and next write after the API commits revocation. Scripted Docker component output is not supported-host lifecycle evidence; provider-wide writer stop and target activation remain pending. The initial private25-pass/2-fail fixture serialization run is retained with its corrected local-only callback. Builds on Node22/26 produce identical320 outputs; types, docs and security pass. After rebasing onto the reviewed attachment/cadence repair, the handoff source, tests and compiled module are unchanged. Fresh Node22/26 builds still match all320outputs; the449-file package is6,947,193 bytes under the fixed8MiB ceiling, with zero dependencies. Rebased types, docs and security pass. Fresh hosted checks and protected delivery remain required. Acceptance remains29/40.

## Attachment generation and retention cadence follow-up

The initial attachment repair at `e0515ed` passed seven hosted checks. Node24 and packaged coverage each reported3,472 tests/3,435 passes/zero failures or cancellations/37 existing skips; packed release conformance passed. Node22 reported3,434 passes and one failure at the retention schedule test's `nextAt > Date.now()` assertion. The failed gate is retained. The controller schedules the first cadence point after stored execution time, which can become due before a later parent read. A declared real-clock parent wait reproduces this invalid observation assumption on all three runtimes; checking native stored execution time and its exact cadence result passes. One accepted occurrence, natural child exit, one receipt, payload retirement, version and accepted receipt checks remain. Exact hosted crossing time is unknown. [Cadence review](retention-schedule-grid-review.json).

A subsequent source review also reproduced two stale attachment failures: a rejected older snapshot erased newer subscribed/snapshotted rows and removed focused controls. The error path now uses the same current-generation/disposal guard as success. The actual compiled view passes16 model UI cases on each Node22/24/26, including both failed-before regressions. Browser acceptance remains separate. [Attachment follow-up](offline-attachment-refresh-review.json).

The adopted UI and retention modules pass34/34 with coverage on all three runtimes, with zero failures, cancellations or skips; three delayed-parent cadence faults pass separately. Complete private retention copies pass18/18 after restoring required original brand fixtures, with the earlier2failures per runtime retained. Node22/26 builds produce identical320 outputs; only the attachment module changes from the initial PR370head. Types, docs and security pass. The449-file package is6,941,860bytes under the unchanged8MiB ceiling, with zero dependencies. Build record collector failures and generated example diffs are retained and qualified. Fresh hosted checks and protected delivery remain required. Counts stay29 accepted/11 pending.

## Protected combined delivery and attachment recovery follow-up

[PR #369](https://github.com/nearbycoder/clank.run/pull/369) merged through main protection as `c191673aaf1aadfcb3426df768ce00adf1617315`, tree `735e4661dfdbe848137b2722211414640cf67d8c`, identical to reviewed delivery head `01aa7ec`. All thirteen original PRs are actually merged into the retained delivery history; their combined code reaches linear main through369. Both main checkouts match this tree, all23 existing local files are preserved, and no PR remained open at this delivery boundary. All eight hosted checks pass. Both complete runtime suites and packaged conformance report3,469 tests/3,432 passes/zero failures or cancellations/37 existing skips. Packed authentication, deployment, migration, rollback and data restore pass.

The first Node22 job on this same head reached its25minute limit without a final test summary. All179 isolated provider cases pass with actual Node22 parent and script interpreter, including the hosted reporter/default concurrency. One targeted unchanged-job retry passes the complete suite. The original cancellation is retained and its exact hosted stall remains unexplained; no code, assertions, timeout or host-profile change was made for the retry. [Delivery evidence](feature-branch-delivery.json).

Subsequent review found an attachment view recovery defect: a temporary snapshot error disables Synchronize, but a later successful current snapshot restores the rows without enabling Synchronize. A controlled existing DOM/focus model with the actual compiled view reproduces that failure. The fix restores enabled state only after a successful current snapshot, reflects a still-pending flush in aria-disabled, and marks snapshot failures consistently disabled. Generation and disposal guards remain. Tests cover recovery without stealing focus, duplicate suppression while a real action remains pending, and disposal before a late success. This is code-level proof, not outstanding native browser acceptance. [Recovery review](offline-attachment-refresh-review.json).

The adopted repository module passes all14 focused cases with experimental coverage on Node22/24/26, with zero failures, cancellations or skips. Node22/26 builds produce identical320 files and match the reviewed module. Types pass54 packed consumer fixtures with149 inherited/zero new source diagnostics against baseline154; docs and security pass. The exact449-file package is6,941,837 bytes under the unchanged8MiB ceiling, with zero dependencies. Fresh hosted checks and protected delivery remain required for this maintenance source change.

Feature acceptance remains **29 accepted / 11 pending**. Earlier historical draft/source snapshots retain their original scope; this section records their later protected delivery and the new maintenance repair.

## Combined feature branch delivery

The user authorized landing the remaining PR code before its full feature acceptance, allowing a temporarily rough production state. The delivery branch combines the incident/SLO/status, organization security/quorum/temporary access, cost, offline attachment, remote recovery/handoff and shadow traffic branches, including their reviewed fixes. Three stacked PRs (#350, #329 and #326) were merged into their original parents. The remaining ten PRs are consolidated through their actual original commits before one protected delivery to linear main. [Delivery evidence](feature-branch-delivery.json).

This is code delivery, not eleven newly accepted features. Counts stay **29 accepted / 11 remaining**. Online provider handoff and supported provider shadow/PITR certification remain incomplete, as do the remaining interactive browser workflows. The old SLO guardian failure is retained. No permissive runtime fallback, new dependency, or host profile change is included.

Protected maintenance PRs #365–#368 now supply the fixed 8 MiB exact-path package budget, current-health canary fencing, immediately observed Docker client stream failures, and Task interruption/type repairs. On the combined source, native Node22.16/26.10 each pass 363 selected checks: 2 native capture/transfer namespace cases, 265 Console/CLI cases, 27 quorum cases and 69 Task/budget/client/canary/layout/performance cases. Types pass 54 packed consumer fixtures with 149 inherited / zero new source diagnostics against baseline154; docs and security pass. The exact package has449 files /6,940,183 bytes under the fixed8MiB ceiling and zero dependencies. All320 emitted files match across runtimes.

The prior broader native26 run retains1,376 reported /1,366 passed /one fixture failure /nine explicit existing privileged skips. Its route fixture omitted the already existing temporary-access globals from its isolated VM. Native22/26 focused before runs each reproduced that ReferenceError; the corrected fixture supplies their inactive null state, preserving the actual route function and every shadow-reset assertion. Both corrected selected suites pass. Full hosted checks on the final publication remain required; standalone native capture/namespace evidence does not prove provider stop, target activation, or complete feature07.

The first combined hosted attempt at `ca92d8b` passed five checks, while both runtime jobs and packaged conformance reached their unchanged fifteen-minute limits. The retained package log shows one parallel shadow comparison instead of two, followed by stalled deadline fixtures. Explicit native scheduling/held-response faults reproduce the fixture timing assumptions; the corrected fixture observes bounded actual admission and allows setup before its configured deadline. All original primary, reservation, settlement and comparison assertions remain. The observer/lifecycle/status/platform/target selection passes 101/101 on each runtime, plus two admission-delay cases and one held-parallel case each, with zero failures/cancellations/skips. All 320 runtime outputs and production sources are unchanged. Fresh final hosted checks remain required; no acceptance count changes.

## Combined delivery capacity fixture follow-up

The second hosted head `f7d393a` passed five checks. Packaged tests completed in approximately thirteen minutes but failed two capacity fixtures: first-batch completion exceeded its five-second observation, and secondary requests expired during admission (`16 !== 15`). Node 24 was still progressing when the fifteen-minute job window expired; Node 22 stalled at an unbounded cancellation marker. Those failed and cancelled results remain recorded.

Fixture admission markers are now bounded. Setup and secondary batch deadlines allow the actual held cancellation/capacity scenario, while all 178 assertion expressions remain unchanged. Controlled six-second first-batch completion and 350 ms paced secondary admission reproduce the old failures on both runtimes and pass afterward. An initial after probe also delayed the unrelated fresh seventeenth request and failed; its corrected scope and failed log remain retained. Five observer/lifecycle/status/platform/target modules pass 101/101 with experimental coverage on each of Node 22 and 26, with no failures, cancellations or skips.

Runtime and packaged-conformance CI windows increase from fifteen to twenty-five minutes based on observed full-suite progress. Native PostgreSQL and type job windows remain ten minutes. Production source and limits, all 320 emitted outputs, exported types, package inventory, dependencies and main protection are unchanged. Feature acceptance remains 29 accepted / 11 pending; the fresh hosted complete gate and protected merge remain required. See [combined delivery evidence](feature-branch-delivery.json).

## Combined delivery native phase and close follow-up

All three complete jobs at `85c2f38` finished within the twenty-five-minute window. Node 24 reported 3,424 passes, one failure and 37 skips; Node 22 reported 3,422 passes, three failures and 37 skips; packaged coverage reported 3,419 passes, six failures and 37 skips. Each reported 3,462 tests and zero cancellations. Failed logs remain retained. The handoff parent opened its independent SQLite reader after the child reported its result but before runtime close. Native state/journal assertions now follow confirmed child exit. Shadow setup deadlines and batch completion observation also expired under full-suite load; a primary fixture request observed ECONNRESET.

The shadow fixture keeps actual two-second deadline scenarios and uses bounded ten-second observations. Primary fixture requests use dedicated native HTTP connections to avoid shared keep-alive pool dependence; the exact hosted reset cause is not established. All 298 assertions across both changed test files remain unchanged, including strict 16/15/1 capacity, independent read/cancel completion and late-header no-reader checks. Controlled 750 ms candidate admission and six-second secondary response completion fail before and pass after on Node 22, 24 and 26. A held actual rollback-journal exclusive lock likewise reproduces the pre-close reader failure and passes after confirmed exit; the initial WAL lock probe passed because WAL permits readers and remains qualified.

The complete 101-case observer/lifecycle/status/platform/target selection and 87-case native handoff runtime module pass with experimental coverage on all three runtimes, with zero failures, cancellations or skips. These are selected modules, not a fresh complete hosted pass. Production source and limits, all 320 emitted outputs, exported types, package/dependencies, twenty-five-minute CI windows and main protections are unchanged. Feature acceptance remains 29/11; fresh hosted checks and protected merge remain required. See [combined delivery evidence](feature-branch-delivery.json).

## Combined delivery final cost acknowledgment repair

All eight hosted checks passed at `64946f3`. The two runtime suites and packaged coverage each reported 3,462 tests / 3,425 passes / zero failures or cancellations / 37 explicit existing skips; packaged release conformance also passed. Those results establish the fixture follow-up at its named head. A subsequent native HTTP/SQLite review found a production cost defect: an audit-triggered update could retain budget `500` while the response acknowledged the reviewed budget `5`.

The cost controller now verifies the bounded native rows acknowledged or used by its transaction again after audit and authority callbacks, immediately before commit. An altered policy, receipt, observation, rate, override, prior observation or override-bound policy causes HTTP503 `COST_WRITE_FAILED` and rolls back the mutation, receipt and audit together. Removing the injected fault allows the exact same intent and operation ID to succeed once. All seven protections fail on the original code and pass with the fix. The initial after run exposed an incorrect new test assertion about the public client's error shape; its failed log remains retained. Corrected tests verify the actual server response code and client status.

All three cost modules pass 57/57 with experimental coverage on each of Node22.16,24.21 and26.10, with zero failures, cancellations or skips. Builds on Node22/26 produce identical320 outputs; only `dist/platform-project-costs.js` changes from the reviewed composition. Types retain149 existing/zero new diagnostics against baseline154 and54 packed consumer fixtures pass. Documentation passes109 Markdown files/375 links/104 guides/146 declarations/162 exports; security passes. The exact449-file package is6,941,695 bytes under the unchanged8MiB ceiling, with zero dependencies. Build-generated example JavaScript diffs were retained privately and excluded from the fix.

This stage changes the production cost module; prior fixture-only claims retain their historical scope. Schemas, public API, production quotas, provider profiles, CI windows and main protection are unchanged. Counts remain29 accepted/11 pending; fresh hosted checks and protected merge are required for this final source change. See [delivery evidence](feature-branch-delivery.json).

## Combined delivery fresh candidate connection follow-up

The production cost repair at `2145a92` passed seven hosted checks. Both complete runtime suites reported3,469 tests/3,432 passes/zero failures or cancellations/37 existing skips. Packaged coverage reported3,431 passes and one failure: the leader-wide capacity fixture expected a fresh seventeenth candidate server event but observed16 after that attempt settled. This failed gate remains retained; it is not reported as successful conformance.

A declared native socket-close fault reproduces the same assertion on Node22: destroying only the first batch's server sockets at fresh native fetch dispatch settles a candidate transport error before the server receives that request. Node24/26 pass the original fault and are not failed-before proof. Closing completed candidate response connections in this one capacity fixture makes its fresh-capacity check independent of those pooled sockets. The exact hosted transport cause remains unknown. The initial probe runner's incorrect expectation of failure on every runtime, its mixed results and correction are retained.

All178 observer assertion expressions remain unchanged, including strict16-slot admission, seventeenth refusal and the later actual fresh server event. The corrected controlled fault and complete40-case observer module pass with experimental coverage on Node22/24/26, with zero failures/cancellations/skips. Production source and limits, all320emitted outputs, exported types/package/dependencies, CI windows and main protection are unchanged by this follow-up. Feature acceptance remains29/11; fresh hosted checks and protected delivery are required. See [delivery evidence](feature-branch-delivery.json).

## Combined delivery peer cleanup lifetime follow-up

The next head `43057fc` passed seven hosted checks, including both runtime jobs. Packaged coverage reported3,469 tests/3,430 passes/two failures/zero cancellations/37 existing skips. Both failures were in the independent native reader/cancel completion cases: peer requests could reach their10s deadline and release slots while focal cleanup remained held. Failed terminal logs remain retained; exact hosted phase timing is not recorded.

A declared real11s delay after peer admission reproduces both old failures on each of Node22/24/26. Corrected cases retain actual peer request or cancellation outcomes through the explicit inspection gate. Native cancellation runs before the gate; release delivers its original outcome. Only those two fixtures use120s supervisor/project leases and session duration; focal2s and peer10s request deadlines remain unchanged. Completed server responses close connections before the fresh native attempt.

All178 assertion expressions remain unchanged, including fifteen peer reservations plus one held focal slot, independent read/cancel delivery, durable tombstone recovery and the actual fresh seventeenth server event. Both delayed cases and the complete40-case observer module pass with experimental coverage on all three runtimes, with zero failures/cancellations/skips. The initial collector missed newer runtimes' spec reporter prefixes and failed after successful test processes; original logs and corrected parsing remain retained. Production code, all320outputs, exported types/package/dependencies, quotas/profiles and CI/protection settings are unchanged. Counts remain29 accepted/11 pending; fresh hosted checks and protected delivery remain required. See [delivery evidence](feature-branch-delivery.json).

## Release declaration, CLI identity and typing repairs accepted

Protected PR #361 merged the release-map typing fix, and protected [PR #360](https://github.com/nearbycoder/clank.run/pull/360) merged the combined declaration spacing and linked CLI argument repairs as `53cfec2`, tree `e63b94e923ee2d12b40fbdf425d5bcdb979bd9e8`. Both main checkouts match and all 23 existing local files are preserved. Draft PR #362 is closed because its six reviewed CLI files are included exactly. These maintenance changes add no accepted feature: counts remain 29 accepted / 11 remaining. [Verification](release-repair-verification.json).

Both complete ordinary-user native PostgreSQL release gates on `6659e8a` pass 2,460 reported / 2,448 passed / zero failures or cancellations / 12 explicit privileged Docker/XFS skips each. Its source tree is identical to reviewed PR head `4705a95` and merged main `53cfec2`; all 1,175 source inputs and 293 emitted files match. All 6,038 retained coverage profiles parse and match their hashes. Packaged deploy, authentication, migration, failed activation, rollback and data restore conformance passes on both runtimes. All eight hosted checks pass on `4705a95`, with only the read Ubuntu runner migration notice. The package contains 422 files / 6,040,945 bytes under the unchanged 6 MiB ceiling and zero dependencies.

Declaration tokens and type semantics remain intact. CLI parsing remains unchanged: tests use the existing literal `--` for positional dash-prefixed release IDs and attached `--option=value` syntax. Three genuine historical CI failures and native failed-before reproductions remain retained. Inbox mapping now preserves its release type; packed contracts report 158 inherited / zero new diagnostics against unchanged baseline 163. Historical feature proofs retain their named source revisions, and the unresolved historical SLO guardian failure is not waived. Remaining feature branches still need their final release, provider and interactive acceptance evidence.

## Private provider handoff foundation accepted

Protected [PR #356](https://github.com/nearbycoder/clank.run/pull/356) merged reviewed `317e17cc38d4386c373b80d3baae1ceb587136fc` as `ca0a6646ab87d458d75d02a260592c33b22b2da5`, preserving tree `660bf277d09810df0b553590233b51725b0bd7db`. Both main checkouts match and all 23 original local files are unchanged. The private foundation binds one marked provider root to its exact Docker daemon domain and retains immutable catalog/barrier identity before ordinary startup can clean up. [Acceptance evidence](provider-handoff-foundation.json).

Both complete native PostgreSQL release gates at `775682c` pass 2,327 reported / 2,315 passed / zero failures or cancellations / 12 explicit privileged-host skips each. All 2,890/2,889 archived coverage profiles parse and match their hashes. The later `bee62e7` test-only CodeQL repair passes its 26 native module cases on each runtime; `317e17c` changes only three accepted main reports. All eight final hosted checks pass, with zero new CodeQL alerts and only the read Ubuntu runner migration notice. The repaired original thread is resolved. Author COMMENT `5482125191` records verification, not independent human approval.

Actual Docker proof on both runtimes verifies owner contention, wrong owner, unavailable or different daemon domains, actual barrier-writer SIGKILL recovery, exact replay and changed-input refusal. Cleanup removes only owned test resources and preserves the original daemon. The ordinary-startup barrier leaves the sentinel running. Source-stop, checkpoint mounting, target activation and ingress switching remain pending; this prerequisite does not complete feature 07. Counts remain 29 accepted / 11 remaining.

The incident repair candidate `749af83` passes 388/388 integration tests on each runtime at main `963006c`, including exact write receipts, grouped authority rechecks and Console retry protection. Its successor `6b6b50f` integrates main `ca0a664` and is being checked. SLO candidate `dad1be3` passes 422/422 integrated tests each at main `ca0a664`, including actual metric-loss detection and fresh session CSRF. Status candidate `18d6f20` passes 483/483 integrated tests each at that main and refuses partial retained-state loss. Packed types pass 40/41 fixtures respectively; all 300/304 runtime outputs match. Their complete release and interactive checks remain pending; these results retain their source-specific scope.

## Current ingress delivery and draft review

Protected [PR #352](https://github.com/nearbycoder/clank.run/pull/352) merged reviewed `599342de6f741c2d714e3fcdbdf800233a49daf0` as `944149c51d207a63713434eaf1c8b42b89c8355c`, preserving tree `89150d8303d5bc2f60ac2492db614f9927d3f57e`. Both main checkouts are synchronized and all 23 original local files are unchanged. All eight hosted checks pass; the analysis notice concerns Ubuntu runner migration. The focused pair passes 107/107 each with zero skips, 38 packed fixtures, 159 existing/zero new diagnostics, and 419 files/6,004,354 bytes under unchanged 6 MiB with zero dependencies. The retained conformance failure exposed a fixture race: the test now awaits actual drain cleanup and checks its captured lease identity before accepting restored deployment. Production transport bytes are unchanged by that repair. Author COMMENT 5481904130 records verification, not independent human approval. This adds no complete roadmap feature. [Delivery evidence](shadow-ingress-acceptance.json).

Temporary access PR #325 at `63af849` passes both complete native PostgreSQL-backed release gates: 2,367 reported/2,355 passed/zero failures or cancellations/12 explicit privileged skips each. All 2,667/2,668 coverage profiles parse and their archive hashes verify; coverage is 91.65/81.42/90.14 on Node26 and 91.65/81.46/90.17 on Node22. All eight current-head hosted checks pass. A reproduced partial-storage restart previously erased receipt history and let a historical operation ID bind another grant; startup now refuses incomplete retained tables before bootstrap. Cost PR #323 at `421d53d` similarly refuses incomplete retained storage and passes both full gates: 2,320 reported/2,308 passed/zero failures or cancellations/12 privileged skips each. Neither feature is accepted before its remaining Console workflow verification.

Recovery PR #316 has two additional reproduced fixes: the final restore transaction rechecks the destination lease after native publication writes, and the Console retains its exact reviewed request when a successful HTTP response is malformed or acknowledges another intent. Real SQLite trigger cases reproduce stale acceptance before the fix on both runtimes; afterward they return 409 and roll back release, receipt, audit and trigger effects. The Console pair passes 11/11 each, including real malformed HTTP parsing within a fake DOM unit boundary. These targeted results do not establish browser acceptance or the complete final-source recovery gate. Original failed and historical full-gate evidence keeps its original scope. Counts remain 29 accepted/11 remaining.

## Authenticated provider canary HTTP prerequisite accepted

Protected [PR #342](https://github.com/nearbycoder/clank.run/pull/342) merged reviewed `54764de21bc90dd67fca5e8a3a1a630801fcb2a2` as `c5814127848ca363ac68a1f32cf2dfacb6a27777`, preserving tree `938c88a075e898a691cb9ff8ff9b0229bf0716bd`. Both main checkouts match; all 23 original local files are unchanged. The authenticated bounded binding, prepare, inspect, stop and exact-retirement transport persists binding evidence before replying. Revoked credentials retain only their exact cleanup authority. Delayed preparation, lost responses and disabled restart do not erase candidate obligations.

Both complete native PostgreSQL release gates passed on the identical source tree: 2,194 reported / 2,187 passed / zero failures or cancellations / seven explicit privileged skips each. Node 26 coverage is 91.72/81.25/90.19 with 2,488 parseable, hash-verified profiles; Node 22 is 91.72/81.28/90.23 with 2,487. The immutable full evidence SHA-256 is `5d90f194006e09bdbdc45bac2d9eb482205b197568634dde41926e672c6db7da`; protected acceptance is `1ac6049de8560eba57d8421d99a402f15c9e91f98fa0e73ac11b6a2b42ba9c9a`. All eight final-head hosted checks passed with no review threads; author COMMENT `5481471637` records validation, not independent human approval. Privileged skips do not constitute Docker acceptance. This is a prerequisite; feature 08 remains pending.

## SQLite preparation guards accepted

Protected [PR #345](https://github.com/nearbycoder/clank.run/pull/345) merged reviewed `51d082132b6a9c1fcd88e618c76fea5d15e0a5ee` as `607a3169da3cc4c620dab818548e207837130734`, preserving tree `4072d8dc0a4710b67953ad90acd21ccd15a6e878`. Guarded SQL is checked before native preparation, cached invocation and capture recompilation because SQLite can apply connection-changing PRAGMAs during preparation, including EXPLAIN forms. Supported metadata reads and DML remain available.

The final focused suites pass 44/44 on Node 26 and 22; four native PITR compatibility cases pass on each in their explicit trusted-process fixture. Earlier seven-failure and EXPLAIN six-failure runs remain retained. Source/packed types pass with 35 fixtures and zero new diagnostics. Package remains 417 files / 6,045,054 bytes, zero dependencies and the unchanged 6 MiB ceiling. All eight hosted checks passed, including the complete Node 22 packaged-release gate. Evidence SHA-256 is `ced2a5fdef03904cb9e7fae51ed0874d7d9a90c2a59227f6b158476010cf2d8a`; protected acceptance is `49002ef600f51678459f58e9ee0b83de8ba6f0abe8e71a591b9afc752503ac60`. Author COMMENT `5481448686` is not independent human approval. The later combined PR #342 full gates include this repair but do not replace its original scope.

## Provider managed canaries accepted

Protected [PR #346](https://github.com/nearbycoder/clank.run/pull/346) integrates native project ownership, versioned retained operation/epoch evidence, measured stages, writer barriers, exact retirement and disabled-startup cleanup. Console status shows retained measurements and exact cleanup identity; CLI status/recovery and the Console preserve current permission, stale-response and expected-epoch checks. Reviewed `e588fe0d4b89c21533fe8124520da1e2820ec26e` merged as `996fb2f2253398e2980bc2ba2455e3b9ee426fce`, preserving tree `59a65e57e2fce5076cd47ccf1833634ba485a8fd`. Both main checkouts match; all 23 original local files are unchanged. Feature 08 is accepted within its explicit code-only/read-only candidate scope.

At source `215f5943f161c3c2409651a8b0261cec1ff42325`, ten real Docker scenarios pass with zero skips on Node 26 and 22: healthy/failed/undersampled stages, actual platform SIGKILL with held preparation and disabled restart, native project ownership loss, Docker isolation and provider crash recovery. Candidate container, checkpoint, bridge and outbound-policy absence are checked before startup cleanup can hide remnants. Native evidence SHA-256 is `be606faf87da3b737a7e55b0f237f9c8f79bfb10d3ff8a5df64fb154cdde0dab`. Earlier Host-header and response-drain failures remain retained.

Both complete native PostgreSQL release gates pass at that source: 2,270 reported / 2,258 passed / zero failures or cancellations / twelve explicit privileged skips. All 2,637 Node 26 and 2,633 Node 22 coverage profiles parse and every archive member hash verifies. Coverage is 91.54/81.21/90.03 and 91.53/81.23/90.06 respectively. Full evidence SHA-256 is `038b444c8cdb01eed0a84785acd6a0598dcb129695429f31fbf0495098bac6ef`. The separate Docker proof does not remove unrelated certificate/XFS privileged limitations.

The local drain repair retains each already admitted request's captured native authority while refusing fresh requests, withdrawn provider routes and lost leases. Its 49-case platform and 41-case ingress suites pass on both runtimes. Hosted coverage contention then exposed a fixture with no completed samples in its final short measurement stage. Four independently paced clients and longer fixture windows preserve the original two-sample, 20-percent error and 1,500-ms latency thresholds. Failed-before selections pass 4/5 on each runtime; corrected loaded selections pass 7/7 and final provider/drain suites pass 29/29 on each. All 575 source/emitted production hashes are unchanged. Fixture evidence SHA-256 is `4f8693dbcf43eb63069a6f25157e8c7f0e4f3a0645db4967bff276ddad11f460`; all eight exact-head hosted checks pass, with no review threads. Actual built Console keyboard checks now verify lost-acknowledgment/current-epoch explicit retry without automatic mutation retry, typing focus, project navigation during held cleanup, disabled repeated activation, refreshed permission revocation, read-only support, unavailable-state suppression and phone layout. This labeled synthetic API/session fixture establishes UI behavior; native/backend authority and Docker proofs remain separate. Earlier ineffective pointer actions and status evidence `a29cf142435e05afcb17ca01503f4a69fccf38c95849ec39b37402b50e09c79b` remain retained. Keyboard evidence SHA-256 is `faf5b8121e29b29f5b439fb06b86d8bfa2166ff4c35b34e96d1c0a966c64c604`. Author COMMENT `5481645711` is not independent human approval. Protected acceptance SHA-256 is `0f43808ec17628af567b2273323f7900023bb983fac037bd017a0f008f7fbcd4`; package remains 417 files / 6,120,617 bytes under unchanged 6 MiB with zero dependencies. Counts are 29 accepted / 11 remaining; production Railway and physical-host certification remain outside this evidence. See [acceptance](provider-canary-platform.json).

## Release spacing maintenance and shadow supervisor accepted

Protected [PR #348](https://github.com/nearbycoder/clank.run/pull/348) merged reviewed `7995765` as `cc9ca913`, preserving its exact reviewed tree. Both ordinary-user native PostgreSQL full gates pass at `52eb8e5`: 2,273 reported / 2,261 passed / zero failures or cancellations / twelve explicit privileged skips each. Every archived coverage member hash verifies and all 2,640 Node26 / 2,638 Node22 profiles parse. The final head changes only six separately checked HTTP-fixture lines; all 427 tracked product/build/docs/package inputs are identical. The full gate did not execute those final test bytes. Package is 417 files / 5,987,274 bytes, saving 133,343 bytes against accepted canary main while preserving workflow callback bytes and the unchanged 6 MiB ceiling. Earlier ENOSPC, fixed-port and hosted failures remain retained. All eight final-head hosted checks pass. [Protected delivery evidence](release-spacing-acceptance.json).

Protected [PR #351](https://github.com/nearbycoder/clank.run/pull/351) merged reviewed `4b05ab8` as `7c802d2`, preserving its exact tree. Protocol-3 enrollment requires strict prepared shadow schema and sentinel; older owners refuse retained enrollment, while current guardians preserve/refuse damaged state. Native guardian/process/schema/layout suites pass 35/35 without skips on Node26 and Node22, with 37 packed type fixtures each and zero new diagnostics. All eight final-head hosted checks pass. Package is 419 files / 5,993,360 bytes under unchanged 6 MiB, with zero dependencies; the two additional allowed files are the private managed-shadow helper and its declaration. Both main checkouts were synchronized and all 23 original local files verified unchanged. Author comments on both PRs record evidence, not independent human approval. [Protected delivery evidence](shadow-supervisor-acceptance.json). Feature09 still requires staging, durable controller, isolation and operator acceptance; counts remain 29 accepted / 11 remaining.

Attachment PR #318 passed both complete native PostgreSQL gates at `5dd0e4d`: 2,297 reported / 2,285 passed / zero failures or cancellations / twelve explicit privileged skips each. All 2,642 Node26 / 2,639 Node22 coverage profiles parse and every archive member hash verifies; immutable evidence SHA-256 `0a8c5616be406cc8bdc9316243e417109b95ffa2e0b56ef731f78339e4d31cac`. All eight hosted checks at that head pass. Genuine keyboard checks establish upload synchronization, account switching during a held request, failed MIME status and explicit retry; discard confirmation and phone acceptance remain pending. The current integration also includes accepted supervisor main and needs final checks. Feature30 remains unaccepted.

The CLI status review repaired malformed status acceptance, canonical policy syntax and contradictory both-complete counts; the exact three-file final repair passes 54/54 native HTTP cases and 37 packed type fixtures on both runtimes. Its local commit remains awaiting actual controller DTO integration. Shadow artifact staging tests exposed a possible cross-instance delayed ObjectStore write that can outlive a deadline and reopen; the blocking review is being reproduced before a durable contract amendment or repair. Online handoff's source/capture foundation passes 82/82 native focused checks per runtime and now fits the package ceiling; separately posted private ownership/domain/catalog/barrier work is in progress. These are prerequisites, not completed features07 or09.

## Release package spacing repair history

The following snapshots predate protected PR #348 acceptance above; their pending statements and failures retain that historical scope.

Current integration incorporates accepted canary main `996fb2f2253398e2980bc2ba2455e3b9ee426fce`. The first standalone native full run passed 2,197 reported / 2,190 tests / zero failures / seven skips but failed during coverage copying with an actual ENOSPC error and three invalid retained profiles; Node 22 was not started. Its failed artifacts remain retained (`da5756d397b36580cffe0bca1947c9e58ad4b9b83b1e8889ed4355c6cfb78727`). Only verified remote source/archive duplicates and the inactive, separately archived coverage-copy directory were removed. Fresh integrated focused suites pass 60/60 on Node 26 and 22. Current corpus proof compares all 156 emitted JavaScript modules, 155 exact token/comment/newline streams and 132 declarations against accepted main; all 288 outputs agree across runtimes, including byte-exact persisted workflow callbacks. The integrated package is 417 files / 5,987,274 bytes, saving 133,343 bytes against accepted canary main, with 304,182 bytes below the unchanged ceiling. Fresh integrated full gates are required; standalone package/hosted evidence below retains its original scope.

Draft [PR #348](https://github.com/nearbycoder/clank.run/pull/348) conservatively removes private release separator spacing. Hosted review found that changing the framework's default workflow callback also changed persisted definition revisions. The corrected build preserves the accepted indentation-only `jobs.js` byte-for-byte, including revision `d2c2d017ac196bbb`, without changing workflow hashing or its compatibility expectations. Sixty focused checks pass on each runtime; 156 emitted JavaScript files parse, 155 token/comment/newline comparisons and 132 exact declarations verify. All 288 outputs agree across runtimes. Package is 417 files / 5,929,145 bytes, saving 131,583 bytes under the unchanged zero-dependency 6 MiB limit. Evidence SHA-256 is `a840b6f843e9118a2555286c8956371e09d540df8d99f9116bde12ee08193589`; corrected-head hosted/full native gates and protected acceptance remain pending. This maintenance work adds no accepted feature.

The integrated native Node 26 attempt at `619ed1df97e76f5959dd3bddf4b3033bfde2d080` reported 2,273 tests / 2,260 passed / one failure / twelve explicit skips. All 2,603 coverage profiles parse and every archived member hash verifies. The secret-rotation fixture returned a deployment port-unavailable error on its fixed port 59280; the original error did not retain native errno or socket owner, so its precise cause remains unknown. Failed evidence SHA-256 is `d6469a86beacbe6cf45f25d7a9c7458919b4bbe5cea0c63873f5bf9bb384653a`. Node 22 was not started. The fixed port lies inside this host's observed outbound range; the fixture now uses the existing atomic port-block lease across restart and verifies runtime guardian absence before releasing its root and lease. An independently held native listener on 59280 reproduces the same failure on Node 26 and 22; the corrected fixture passes on Node 26, 22 and 24 while that listener remains bound. Final repair evidence SHA-256 is `8e1c846916e352148b91c0850c9f87498d15ffab9686b253de784164caf498a8`; all assertions and production/build source remain unchanged. All eight hosted checks passed at the earlier integrated head; corrected-head full and hosted gates remain required.

## Online handoff source foundation in review

Draft [PR #347](https://github.com/nearbycoder/clank.run/pull/347), stacked on stopped-transfer [PR #343](https://github.com/nearbycoder/clank.run/pull/343), adds retained native source ownership, an atomic terminal seal and read-only retrieval of the final tail after process loss. Frozen source `cc4b13bddd9cb99fc167c1a747e1976ab6e6cf35` has tree `849b11f56488d519d9699d4137715dbe2fe1a1c9`. Each Node 26/22 run passes 98 focused native checks, 29 ordinary PITR compatibility checks and 38 packed type fixtures. The actual prior `8183a0b` implementation rejects terminal protocol 2. A post-COMMIT SIGKILL case retrieves three bounded batches into the same stopped target and compares its final state with the acknowledged mutation ledger.

The manifest SHA-256 is `e700c3939e567d4491bb24220255e6df7b5c3546f2a2fca9e04f2a78f6c3cdde`; independent frozen review is `69686bdd099f4b25f07c0bb0e3ccf5594947553e2abb86613f526a6e87abc7d8`. Native SQLite proof uses an explicit trusted-process worker fixture and does not establish namespace isolation or provider stop. Full gates, independently durable provider barriers, target activation and ingress switching remain outstanding. The standalone package is 420 files / 6,236,432 bytes; an early combined audit with PR #346 exceeds the unchanged 6 MiB ceiling by 20,492 bytes. That integration needs a reviewed output-size repair before acceptance. Feature 07 remains pending.

## Retention-worker shutdown repair accepted

Protected [PR #344](https://github.com/nearbycoder/clank.run/pull/344) merged reviewed `34a80f989d6921968129d903b9654cc8727036e6` as `90d1eeb2928903778aa692cfde8ea0ccbd948af2`, with identical tree `23d9694f651bfd96354067c72274981353710e98`. Both main checkouts match and all 23 original files remain unchanged. Successful test workers now finish natural code-0 shutdown before cleanup; deliberate crash cases still assert actual SIGKILL. The native regression fails before and passes after on Node 26 and 22, with 18 focused checks passing on each. Only two test files changed.

Both fresh native PostgreSQL-backed full gates pass 2,175 reported / 2,168 passed / zero failures or cancellations / seven explicit privileged skips. All 2,433 Node 26 and 2,430 Node 22 profiles parse and every archived member hash verifies. Coverage, package, documentation, security and owned-cluster cleanup pass. All eight hosted checks pass and no review threads remain. Full evidence SHA-256: `63472e1138961f31cc02f42a9d3d5d8930ba8cf08391f9cec6e981a52e79611d`; acceptance SHA-256: `5eeb5c6182d8b455a55177acb474d7330840b0bee4ea31c0d619ca19fef89c3a`. Author COMMENT `5481412203` is not independent human approval. The historical truncated retention-worker profile did not record its shutdown mode, so this repair does not establish that earlier cause or resolve the separate historical policy coverage failure. Feature counts remain 28 accepted / 12 remaining.

## Provider canary retirement prerequisite accepted

Protected [PR #340](https://github.com/nearbycoder/clank.run/pull/340) merged reviewed `bd9cbe803f1ed6311004e64ab56e4cf64d5942ad` as `a7a2c9c731e15eb81a805bef19c99ec2c1edf88e`, with identical tree `1a5f5f75aba175d91ee6757f44f9cfea9d7f526d`. Both main checkouts match and all 23 original files remain unchanged. Exact durable retirement fences a delayed or lost prepare before absence is acknowledged; old epochs, conflicting identities and uncertain cleanup fail closed. This accepts a provider prerequisite only. Feature counts remain 28 accepted / 12 remaining.

Both native PostgreSQL full release gates pass 2,174 reported / 2,167 passed / zero failures or cancellations / seven explicit privileged skips. Separate real Docker isolation and preparing/running/stopping SIGKILL checks pass 5/5 without skips on both Node 26 and 22. Package, documentation, security and owned-cluster cleanup pass. All 2,429 Node 26 and 2,427 Node 22 retained coverage files parse and archived member hashes verify; measured line/branch/function coverage is 91.69/81.15/90.21 and 91.69/81.18/90.25 respectively. Full evidence SHA-256: `78530dc072e48d7b3709492052ac8e15c5cb82594e10e7278b88f30e4dcca4fe`. All eight hosted checks pass; no review threads remain. Author COMMENT `5481344818` records validation, not independent approval. The first Docker invocation stopped at the checkout ownership check before testing; its per-command correction preserved the existing host configuration.

Authenticated HTTP controls and full platform stage orchestration remain outstanding. Separate earlier malformed coverage artifacts retain their failed status. No physical-host certification or complete feature 08 acceptance is claimed.

## Supervisor startup contention repair accepted

Protected [PR #341](https://github.com/nearbycoder/clank.run/pull/341) merged reviewed `6982a01bd5cf4b750fdb485768bfd618da6e953f` as `b4df8be01813073377e6b5ff1016acd52c98c754`, with identical tree `52058777c60345ced35865be700a6981d4deca2f`. Both main checkouts match and all 23 original files remain unchanged. Initial unowned SQLite enrollment has a bounded five-second monotonic retry; active owner fencing and transaction effects are unchanged. The existing canary fixture now collects measured traffic through four independently paced clients and drains them fully. Four native regressions fail before the repair; 38 focused checks pass on each runtime.

Both final native PostgreSQL release gates pass 2,166 reported / 2,159 passed / zero failures or cancellations / seven explicit privileged skips, including package/docs/security checks and owned-cluster cleanup. All eight hosted checks pass and no review threads remain. Node 26 used the existing one allowed coverage retry after an initial all-tests-passing attempt produced a truncated `retention-worker.mjs` coverage file. That failed artifact and its actual PID/parent mapping are preserved; 4,726 of 4,727 combined Node 26 profiles parse, while all 2,383 Node 22 profiles parse. The successful measured coverage remains 91.68/81.10/90.20 on Node 26 and 91.67/81.12/90.23 on Node 22. The separate earlier policy coverage failure remains unresolved. Immutable full evidence SHA-256: `b7aa894ef8379f3917f96dae0955c81fcdb6299aea7420786540edf0670b7207`. Author COMMENT `5481292957` is not independent approval. Feature counts stay 28 accepted / 12 remaining.

## Provider canary controller prerequisite accepted

Protected [PR #337](https://github.com/nearbycoder/clank.run/pull/337) merged reviewed `ab8be32bca83ddac12b03bd29780125919886980` as `1ec192f4f7bd883f8006bdf73e31471a68e90297`, with identical tree `431aea1d5e438944b01ed05bb390443c13c3afcd`. Both main checkouts were synchronized and all 23 pre-existing local files reverified unchanged. This accepts the trusted controller prerequisite, not feature 08.

Both final native PostgreSQL-backed full release gates pass 2,162 reported / 2,155 passed / zero failures or cancellations / seven explicit privileged skips. Five real Docker isolation and preparation/running/stopping SIGKILL cases pass without skips on each runtime. Current service/data checks pass 29/29 on both. All eight hosted checks pass; the only analysis annotation is the Ubuntu runner migration notice. Source review completed with both reproduced ownership defects repaired; author COMMENT `5481240038` is not independent approval.

The immutable final full-gate evidence index SHA-256 is `5ef480ebb836d50b76056eb977558bc4dc39c7ff0cd7fd8078d9bd11e2b9c12a`. All 1,126 tracked source inputs match the frozen snapshot. All 2,384 Node 26 and 2,383 Node 22 retained coverage profiles parse and match their archived hashes. Coverage is 91.68%/91.67% lines, 81.09%/81.11% branches and 90.20%/90.23% functions. Existing canonical documentation checks retain their scope; browser button activation and physical-host certification are not claimed. Earlier failed runs below remain failed evidence; the separate policy coverage-artifact issue remains unresolved.

Durable exact retirement [PR #340](https://github.com/nearbycoder/clank.run/pull/340) was subsequently accepted above; authenticated remote controls and platform stage orchestration remain separate work. Feature counts stay 28 accepted / 12 remaining.

## Provider canary controller verification history

The opt-in trusted provider controller now prepares a separate code-only checkpoint, reserves its candidate identity, admits only approved anonymous reads and verifies complete cleanup before authoritative lifecycle changes. A native SQLite lifetime lock prevents overlapping services from running startup cleanup on the same provider root. Crash cleanup also verifies removal of the exact orphan Docker bridge and outbound policy. Five real-Docker cases now pass on Node 26 and Node 22, including controller death during preparation, serving and drain; complete release gates remain pending.

Focused native data/service suites pass 27/27 on Node 26 and Node 22, including held-preflight reservation, cross-process ownership, immutable input and actual-ingress contract regressions. The real Docker run exposed an unknown-field ingress binding bug and a private fixture ancestor ownership error; both failures are retained, followed by verified repairs. The repair evidence index SHA-256 is `ead2fd7f7b5342e0d7fa7cf4f2d5d0131396c732f0c061f9ade45f8d5964cabb`. Orphan cleanup suites pass 18/19 on both, with one explicit missing-XFS-profile skip. Packed consumer types pass 35 fixtures with zero new diagnostics. Canonical docs build, doctor, offline artifact, HTTP/MCP reads and six settled desktop/phone home/search/guide captures pass; button activation is not claimed. The earlier focused evidence index SHA-256 is `90173936a759ba420a8cf5a0e979bb60287cb3655258ef8b1b854dcc08de22b7`. Authenticated remote controls and platform stage orchestration remain outstanding; feature 08 is unaccepted and counts remain 28/12.

## Provider canary isolation prerequisites accepted

Protected [PR #336](https://github.com/nearbycoder/clank.run/pull/336) merged reviewed `3d47dc292e0915b7334fbe4996a817930ee2a65c` as `d673c4abb0ef8b3b41b15b1d2023908425a26501`, with identical tree `5b3f7cf7214127ed09f18da033b7fdbad3a4a579`. Both full native PostgreSQL-backed release gates passed 2,142 reported / 2,138 passed / zero failed or cancelled / four explicit privileged skips. Two dedicated Docker isolation cases passed without skips on both Node versions, along with native ingress/header-redaction checks, packed types and all eight hosted checks. Canonical documentation HTTP/MCP reads and six desktop/phone captures were verified; pointer/keyboard activation remains unverified. The immutable 52-file evidence index SHA-256 is `9f3db7a98f67e884fc99bb1b302de9d5eb63240e3853e19b7bec8db556eee25d`.

These prerequisites enforce read-only data, deny-all outbound networking and sanitized candidate reads. They do not enable platform provider canary orchestration or accept feature 08. Current provider-controller work still requires complete process/network recovery evidence and platform stage integration. Counts remain 28 accepted / 12 remaining.

## Provider canary review-fix history (feature 08 still pending)

Independent review reproduced a delayed journal-read race at `1cb25ee`: after candidate retirement and ordinary reuse of its project ID, the old request restored ownership and blocked the replacement runtime. Journal reads are now side-effect free; ownership reconstruction happens only in serialized cleanup. The regression fails against the original implementation and passes with the service/data suites on Node 26 and 22 (28/28 each, zero skips).

A second review reproduced destructive cleanup when a valid old running journal was partially restored after ordinary reuse of its candidate ID. Generic cleanup now checks ordinary and unrelated ownership before changing the journal or deleting candidate data. The regression observes one incorrect deletion before the fix; after the fix, both enabled and disabled startup refuse without deleting or changing the replacement project. Historical stopped journals still permit ordinary reuse. This repair is part of the provider-controller prerequisite, not feature acceptance.

The full native PostgreSQL release attempt at `1cb25ee` remains failed evidence: 2,160 reported / 2,149 passed / four failures / seven explicit Docker/XFS skips. Three newly added nft fixtures could not find Node under the deliberately restricted command environment; an existing attestation fixture collided on fixed port 55000. Coverage was measured successfully; Node 22 was not started. The nft fixtures now use the selected absolute Node executable, and attestation uses a reserved port block held until shutdown. The occupied-port reproduction fails before and passes after; all 20 selected fixture checks pass on both runtimes. Fresh complete gates remain pending, and the earlier policy coverage-artifact failure is not considered resolved. Accepted features remain 28/40.

## Typed PostgreSQL application backend accepted

[Feature 21 acceptance evidence](postgres-application.json) records the protected expected-head squash of [PR #333](https://github.com/nearbycoder/clank.run/pull/333). Accepted main `fd9a7ab638a814ebe4c3f1260933bfaf1171f3e9` exactly matches reviewed `af33523606ada6b22cb8589303b1984bd2462ae9` tree `f76e1fa1a6a77c4b7e83ab2b44d0a7800e02de5a`. Both main checkouts match it and all 23 pre-existing local files remain unchanged. Feature counts are 28 accepted / 25 batches / 12 remaining. Earlier PostgreSQL source/fixture failures retain their original qualification.

Both fresh ordinary-user native PostgreSQL full release gates pass 2,139 reported / 2,136 passed / zero failed or cancelled / three existing privileged skips, including packaged-release and security checks. All 24 shared/native cases and packed root/subpath/private-worker/generated-function consumers pass on Node 26 and 22.16. Both owned clusters are stopped and private files removed. Packed types pass 35 fixtures with 159 existing / zero new diagnostics against unchanged baseline 163. The package has 417 files / 5,996,193 unpacked bytes / zero dependencies, 295,263 bytes below the unchanged 6 MiB ceiling. Canonical docs build/audit/doctor/offline checks, eleven real HTTP/MCP reads and all six visually inspected current desktop/phone home/search/guide captures pass. All eight hosted checks are green, with no new changed-code CodeQL alerts or review threads; the actual analysis notice concerns Ubuntu runner migration. Author COMMENT `5480827487` is not independent approval. The private immutable 41-file index SHA-256 is `cc5eea3564178316437216272257c83da4ffffbbd4c219211e59994f1e1b421b`.

The documented application subset explicitly refuses unsupported SQLite-native services, history and aggregates; owner scopes remain trusted server inputs. Unknown write COMMIT responses poison the session and require explicit reconnect/native inspection without replay. Browser keyboard focus reached the docs link but did not activate navigation; physical authenticators, browser button/keyboard navigation and production/provider certification are not claimed. This report update changes no verified runtime, public declarations, canonical docs or tests.

## Typed PostgreSQL application backend verification history

[Proposal #331](https://github.com/nearbycoder/clank.run/issues/331) defines feature 21 as a documented application subset with typed tables, native transactions/revisions, trusted server owner scopes, generated public-table HTTP functions and explicit reconnect. The private Node worker uses parameterized PostgreSQL v3 messages, verified TLS, bounded printable-ASCII SCRAM credentials, fixed response/row/write/deadline limits and retained change journals. Unknown COMMIT acknowledgements poison the session without replay. History, aggregates and SQLite-native services are explicitly refused; native PostgreSQL auth/jobs/platform services and production host certification are not claimed. The source verifier creates and stops only a fresh private native cluster as an ordinary user, with separate Node 22/26 hosted jobs proposed.

The integrated source includes accepted main `abe97a9`. The actual native PostgreSQL 17.11 shared suite now passes 22/22 on both runtimes, including generated HTTP mutation/query invalidation, two-session ownership/revisions, actual writer SIGKILL, actual network COMMIT acknowledgement loss, unsupported operations, wrong TLS identity/CA and inline module entry points. The earlier 21-case owned-cluster drivers pass on both runtimes and verify actual cluster stop/private-file removal. Their earlier fresh-cluster DDL privilege failure and Node 26 explicit worker-argument failure remain recorded, followed by the public-schema qualification and conditional inline-entry correction. No failed run is relabeled. Current complete source-frozen gates, packed types/package checks, canonical docs/browser checks and protected PR review remain pending; feature 21 is not yet counted.

The source01 full native Node 26 gate at `ac92387` reports 2,138 / 2,134 passed / one failure / zero cancellations / three skips: the browser-barrel invariant rejected eager imports in the private worker. Its owned cluster was stopped and private files removed; Node 22 full verification did not run after that failure. The exact hosted packaged failure has the same retained assertion, alongside a coverage JSON warning; it remains failed. An additional unintended native verifier was discovered by ordinary test discovery. The verifier is now explicitly named `scripts/verify-postgres.mjs`, and worker imports are dynamic with an explicit module declaration; the unchanged barrel invariant passes. The earlier type diagnostic for a top-level await in a nonmodule is retained, and packed types again pass 35 fixtures / 159 existing / zero new against unchanged baseline 163.

An actual native retention race reproduces an empty selective notification after pruning between reads. Revision, retention and records now share one repeatable read snapshot. The network loss fixture waits for a real document INSERT acknowledgement before dropping the actual write COMMIT, so read-only synchronization commits cannot satisfy that fault boundary. Canonical schema hashes sort required-field sets, and elapsed callbacks are refused before another table operation or journal/commit step. All 24 native/shared cases pass on both runtimes, including the actual pruning race, field declaration reorder compatibility, real callback deadline/reconnect, auth-service startup refusal and original process/network faults. Source01 failed runs, schema-order failure, actual deadline failure, and the misconfigured unauthenticated-query fixture remain separate evidence. Source02 complete gates and current hosted checks are still required before acceptance.

## SQLite transaction-context fencing accepted

Protected [PR #332](https://github.com/nearbycoder/clank.run/pull/332) accepted `abe97a94dc76d7405f3db3bdee41a10c6e865fc7`, whose tree exactly matches reviewed `38e07a6` (`37e464d572d4bc12491d58fbc57b02d91ec551bc`). Both fresh ordinary-user Node 26/22 full gates pass 2,115 reported / 2,112 passed / zero failures or cancellations / three existing skips, including package and security checks. Packed consumer types pass 34 fixtures, 159 existing / zero new diagnostics against unchanged baseline 163. Current docs build/audit/doctor/offline checks, eleven real HTTP/MCP checks and all six visually inspected desktop/phone home/search/guide captures pass. All six hosted checks are green, with no new changed-code CodeQL alerts or review threads. Author COMMENT `5480733595` is not independent approval. Private immutable evidence index SHA-256 is `14db9abe4ed55f3b15e6bae7077be8881c5bd7067394ca19dde24a0e84b4a89d`. Both main checkouts and all 23 preserved files are verified. This maintenance repair does not change feature counts.

## SQLite transaction-context fencing verification history

Accepted main is `eb85a6d997538fabcd87e394378137083951c036`, the protected expected-head squash of [PR #330](https://github.com/nearbycoder/clank.run/pull/330). Both updated-source ordinary-user full gates pass 2,112 reported / 2,109 passed / zero failures or cancellations / three existing privileged skips; all six exact-head hosted checks pass, with no new changed-code CodeQL alerts or unresolved threads. Both main checkouts match the reviewed tree and all 23 pre-existing files remain unchanged. Feature acceptance remains 27 / 24 batches / 13 remaining. The prior guardian source snapshot and its documentation evidence keep their original qualification.

The PostgreSQL shared-contract prototype exposed a native SQLite writer escaping its callback. An actual retained insert commits a row while the global revision remains zero, bypassing the transaction journal. All three new native regressions fail against the previous unmodified compiled backend. Each writer now checks its original active transaction, captured change set and snapshot token before any of the six mutation operations or a subsequent table lookup. Retained writers cannot borrow another transaction or owner, including a real async callback resumed after rollback. Pure read builders preserve existing compatibility. All 29 backend/context regressions pass on Node 26 and Node 22; full updated-source verification and protected review remain pending. This is maintenance, not another roadmap feature.

## Supervisor guardian renewal/read race verification history

Accepted main remains `88776f32e48a370f90c9bac118e9b3436d3c0150`; feature acceptance remains 27 / 24 batches / 13 remaining. Current policy and SLO hosted gates exposed a readiness connection loss and an unexpected actual coordinator SIGKILL during shutdown. Neither failed gate is reported as passing.

An owned guardian scheduler fault delays the actual native lease read by 150 ms while its real coordinator renews. Before the correction, native evidence shows the persisted renewal timestamp advancing past the clock sampled before the read, with an unexpired five-second lease, followed by actual SIGKILL before readiness. The correction evaluates the clock after the read, preserving every identity/configuration/expiry/clock-regression fence. The same regression admits the native leader and shuts it down with exit 0; no SQL results or clock values are fabricated. The original failed assertions, timing bounds and single-attempt readiness requests remain intact, with bounded non-secret diagnostics for future failures. All 33 focused native lease, guardian, coordinator and CLI checks pass on Node 26 and minimum Node 22. Packed typing passes 34 fixtures with 159 existing and zero new diagnostics against the unchanged 163 baseline. Canonical documentation build, audit, doctor and verified offline artifact pass (101 guides); nothing is uploaded. Both complete ordinary-user Linux gates pass at the guardian repair snapshot `fa92916efd5c11c8f04210877be2e5fc2dd3d9f2`: 2,112 reported / 2,109 passed / zero failures or cancellations / three existing privileged skips. Coverage is 91.53/81.02/90.07 on Node 26 and 91.52/81.03/90.11 on Node 22. Actual desktop/phone home, hydrated search and guide reading pass, with eleven real HTTP/MCP checks; an initial phone capture with the drawer open is retained as diagnostic evidence. These results remain scoped to that snapshot. Hosted Node 22 separately exposed an existing media crash fixture whose unresolved top-level await lets the process exit with code 13 before the parent sends SIGKILL. A 150 ms committed-boundary observation reproduces the exit without changing any receipt or provider assertion. The owned fixture now explicitly references its real IPC handle until the actual kill. All three native media process cases pass separately on Node 26 and Node 22, including one provider operation/publication through crash recovery. Full updated-source verification and normal protected review remain pending; neither maintenance repair is another feature.

## Automatic supervisor leadership accepted

Protected [PR #314](https://github.com/nearbycoder/clank.run/pull/314) merged reviewed `730a464ebeb9ef539efd4d39dd71a63e54d2cc59` as `7bdb73efc3bf297c566d63814223306b047b2792`, with identical tree `dc38208285eb0c9299facad74249aa9552ec8737`. Both main checkouts and all 23 original local files were verified at acceptance. The six final hosted checks passed; the complete native gates and their source binding are retained in [the supervisor report](supervisor-leadership.json). Author COMMENT 5478557857 is not independent approval. The immutable protected-acceptance record has SHA-256 `1fd3ae7b9e57ac266c7d69c3ce208001c1f5a80200f0524d2287825edf9e4f5d`. Feature 06 is counted. The following historical paragraphs retain their original pre-merge qualifications.

## Automatic supervisor leadership verification history

[Proposal #313](https://github.com/nearbycoder/clank.run/issues/313) adds opt-in dedicated same-host Linux coordinators, a retained native SQLite ownership epoch, transaction guards before work/commit, independent coordinator guardians and automatic standby lifecycle recovery. Ordinary-mode startup refuses an enabled catalog before touching tenant cleanup. Configuration replacement, old capability expiry, malformed/missing state and unresolved cleanup fail closed; caller input changes cannot disable the captured topology during delayed activation.

All 65 combined focused checks and two additional transition drills pass: 31 new contracts/process drills and36 existing regressions, with zero failures/cancellations/skips. The additional real SIGKILL drills cover native lease commit before guardian/acknowledgement, and durable release publication before response delivery followed by exact retry on the existing standby. Actual SIGKILL/SIGSTOP preserves deployed tenant data, stops the old job writer before replacement admission, restores retained desired release and runs one due encrypted backup. Other real process drills cover guardian death, native expiry after preparing-fence publication, death during an actual application health check, configuration replacement, ordinary-mode refusal and unresolved tenant cleanup before active bootstrap. The actual packaged platform CLI takes over through HTTP. Native ownership faults are identified as persisted fault injections; no fake clock or production Docker/provider certification is claimed.

Packed types pass 34 fixtures with 159 existing/zero new diagnostics against unchanged baseline163. The package has413 files/6142287 bytes, exactly two additional internal runtime/declaration files, zero dependencies and149169 bytes below the unchanged 6 MiB ceiling. File-count allowance grows by those exact two files only. Canonical docs build/doctor/verified offline artifact, eight HTTP/MCP surfaces and actual desktop/phone home/search/guide content/layout pass; keyboard activation did not navigate and is not claimed. Both source01 complete ordinary-user Linux release gates passed 2107 reported/2104 passed/zero failures or cancellations/three existing skips. Hosted Node22 exposed valid native base64url identity prefixes being rejected by the existing budget parser; a narrowly scoped identity repair and deterministic replay/isolation regression require updated full gates. The failed packaged-release log is truncated before its assertion; no matching cause is claimed. Both updated-source full native gates pass 2108 reported/2105 passed/zero failures or cancellations/three existing skips. Node26 coverage is 91.64/81.01/90.07 and minimum Node22 coverage91.64/81.04/90.11. All six hosted checks pass at064628015bcab9b4cfc16d769f010724234efb2c, including the package check; its earlier failed assertion remains unknown because the log is truncated. No new CodeQL alerts or unresolved threads; the actual Ubuntu26 runner migration annotation was read. The 95-file private immutable index has SHA256cde1856375a32dcc284c2e68f224d08377b28afd8f6380f297ccada30f337847. Only this ledger and the supervisor report change after the verified source snapshot; all1106 other tracked inputs remain hash-identical. The report-only b222ded head passed both runtime jobs, but the complete packaged gate failed one test whose assertion lies outside its bounded TAP tail. The cause remains unknown. The runner now retains the first16 native failure blocks, at most64KiB, and emits them after forwarded output drains, preserving assertions, thresholds, exit and retry behavior. Eight diagnostic checks pass, including an actual failing child whose assertion would be absent after200KiB of later stdout; it remains failed without retry. Both diagnostic-source native gates pass2109 reported/2106 passed/zero failures or cancellations/three existing skips. The retained hosted diagnostics then expose the exact Node24/conformance failure: the encrypted backup is listed before its scheduler acknowledgment is persisted. The corrected bounded observation requires one archive, its matching lastBackupId and a released scheduler lease, preserving the strict encryption/completion/no-overlap assertions. All eight actual lifecycle drills pass. Both corrected-source full native gates at274b4b0bad46a5a62b7a11329342196254096aca pass2109 reported/2106 passed/zero failures or cancellations/three existing skips; Node26 coverage91.64/81.02/90.07 and minimum Node22 coverage91.63/81.04/90.11. All six hosted checks pass on that exact source, zero new CodeQL alerts or unresolved threads; the actual Ubuntu26 migration notice is read. Earlier truncated failures remain unclassified. The additional31-file immutable index has SHA256783a3916d178a5813e6de593c787c807b839a95c0362e0717ca2ad92d950da82 and references the unchanged earlier95-file index. Fresh final report-only checks and protected merge remain pending. Feature06 stays uncounted;26 accepted/23 batches/14 remain. See [current supervisor evidence](supervisor-leadership.json).

## Durable media processing accepted

[Proposal #311](https://github.com/nearbycoder/clank.run/issues/311) connects declared media adapters to existing native jobs. Exact source and destination generations, current originating human session and application policy, the actual worker lease and cancellation state fence publication. Metadata and bounded receipts share one native SQLite catalog; external providers must durably deduplicate a stable operation key. Retained identities are not evicted or recycled at expiry or capacity. Immediate bucket image transforms also retain their original owner/abort signal and cannot publish from replaced uploads; bucket reads verify actual byte digests.

Thirty new focused checks and 65 existing bucket/job regressions pass. Evidence includes actual SIGKILL after metadata/receipt commit before settlement, restart without a second provider request, two real Node worker processes, a dropped real HTTP provider response with two requests and one provider acceptance, held transform/storage races, identical-byte replacement, deletion/replacement, revocation, cancellation, lease loss, expiry, protocol/revision changes and bounded bytes/progress/capacity. Synthetic fake identity refusal is identified separately. Packed source and consumer checks retain 159 existing diagnostics, zero new against unchanged baseline163, with 33 positive/negative fixtures. Canonical docs build, doctor, verified offline artifact, eight HTTP/MCP surfaces and actual desktop/375px home/search/long-guide content/layout pass. No pointer/keyboard navigation, production provider codec or distributed transaction certification is claimed. Both original-source ordinary-user Node26/minimum Node22 release gates passed (2073 reported,2070 passed,zero failures,three existing skips). Hosted Node24 identified a missing bounded busy timeout in the crash fixture observer; its lock failure and the truncated Node22/conformance failures remain retained. The corrected observer preserves every crash assertion, runtime CI now prints spec failures at the end of bounded logs, and three additional persisted-input regressions refuse changed source bucket, destination and malformed generation. Both updated-source full release gates passed (2076 reported,2073 passed,zero failures/cancellations,three existing skips), with Node26 coverage91.56/80.99/90.07 and Node22 coverage91.55/81.02/90.11. All six source7971e7f hosted checks pass, with no new CodeQL alerts or unresolved threads; the actual Ubuntu runner migration notice was read. The unchanged 6 MiB ceiling contains411 files/6104927 bytes, with186529 bytes headroom and zero dependencies. The 42-file private evidence index is immutable (SHA256 dd08c96769b8afad1607ba5aee1d159910ba3b1efbe824099daa9adac67ccc40). The report-only update passed all six fresh hosted checks at ebc85636f1ac0803756815d5513e67b371d8afa3. PR312 merged through normal protected expected-head squash as0729abca3ed24743b2af1a25089071e7107a81f7, with the reviewed tree bb5decf96bf471c2178957ec6c458fe9ee3bf1cc unchanged. Author COMMENT5478195998 is not independent approval; no CodeQL alerts or unresolved threads. Both main checkouts are synchronized and all23 original files remain hash-identical. Protected acceptance SHA256a3dbfabeb0d1eac5aecb313139e92fdefcfd32cb07410272c59269e04d5cc77b records26 accepted /23 feature batches /14 remain. See [media implementation evidence](media-processing.json).

## Organization service accounts accepted

[Proposal #306](https://github.com/nearbycoder/clank.run/issues/306) and [PR #308](https://github.com/nearbycoder/clank.run/pull/308) add opt-in dedicated machine identities, explicit single-project permissions, expiring rotating credentials and recently verified human administration. Encrypted exact receipts survive an actual controller kill before HTTP response delivery, while later disabled authority stays invalid. Two native controllers admit one same-version rotation. Current machine audit, authenticated-attempt counters and agent budget identity/debit remain distinct from the responsible human and aggregate project resource usage. Machine credentials cannot satisfy human approval or administration controls.

Both full ordinary-user Linux Node26/minimum Node22 release gates pass 2,046 reported /2,043 passed /zero failed or cancelled /three existing skips. Twenty focused checks and 32 packed type fixtures pass with 159 existing /zero new diagnostics against unchanged baseline163. Package: 409 files /6,076,604 bytes /214,852 bytes below the unchanged 6 MiB ceiling, zero dependencies; exactly four deliberate runtime/declaration modules are added. Canonical docs build/doctor/verified offline artifact, eight HTTP surfaces, MCP, and actual desktop/390px home/search/guide content/layout pass. Existing pointer/keyboard navigation remains blocked by the prior confirmation and is not claimed; no new service-account console controls are included.

Source01 is `b4157d3921988ea63efbaa761ff535b6c80bb6ec`, tree `eebbdb929a346f7b7e7cb4258ba0094796f5e775`, with all 1,084 tracked inputs retained. Normal integration of accepted main preserves 1,082 other inputs; subsequent changes are these reports only. All six fresh final-head hosted checks pass at `1ec2b58d5e4be8ee644932f673394a1d40430ff3`, with no new CodeQL alerts and no unresolved threads. Non-independent author COMMENT `5477765194` precedes normal protected expected-head squash `e81ef931baff736eeb675daee3427b185644933a`, whose tree equals `0608c958bb5fe84a8f58c5d94bc7180830ac7fe6`. Both main checkouts match the accepted commit and all 23 original files are preserved. The actual runner annotation concerns the Ubuntu 26 migration; it is not a product failure. Feature 15 is counted after this acceptance: 25 accepted / 22 feature batches / 15 remain. Native signed assertion proof seeds only an enrolled public key; no registration, production identity-provider or distributed transaction certification is claimed. See [service account acceptance evidence](service-accounts.json).

## Held token authority repair verified

[PR #305](https://github.com/nearbycoder/clank.run/pull/305), under [proposal #304](https://github.com/nearbycoder/clank.run/issues/304), fences held native HTTP requests to their admitted token hash and exact grant. Rotation, reduced permissions, rebound project, revocation, expiry and disabled owner now reject at existing current-principal boundaries without secret or audit writes. The unchanged control succeeds. Before the repair, actual held requests with rotated or reduced grants incorrectly committed both effects. A private request-local fingerprint adds no public API, serialized fields or persistent schema. Durable release-window delegation retains its separately specified checks.

The freshly accepted trusted-process SQLite prerequisite (#307, main `b556cbe24e11ffa119bb665433831175c4071f4c`) is integrated normally. Both complete ordinary-user Linux Node 26/22 combined release gates pass 2,033 reported /2,030 passed /zero failed or cancelled /three existing skips. Packed types pass 31 fixtures with 159 existing /zero new diagnostics against unchanged baseline 163. The package remains 405 files /6,042,256 bytes /249,200 bytes below the unchanged 6 MiB ceiling, with zero dependencies. All 1,074 runtime inputs are retained; only this report and ledger change afterward, leaving 1,072 other tracked inputs hash-equal. Both original and combined immutable indexes remain intact. All six final-head checks pass at `c97fd19ecdabcb09c3b9c44e8bbd7b3d5d7306c0`. Protected squash `8b839a2386ed699b939dec2105e412e2be835838` exactly matches reviewed tree `1c9f1a51ed6ce471f24628ad856592dbe77967b1`; both checkouts and all 23 original files are verified. Author COMMENT `5477668835` is explicitly non-independent. This maintenance repair adds no roadmap feature. See [token authority evidence](current-token-authority.json).

## Release compaction and recursive watcher repair verified

[Proposal #298](https://github.com/nearbycoder/clank.run/issues/298) and [PR #299](https://github.com/nearbycoder/clank.run/pull/299) add a private unmapped framework release pass and repair recursive compiler watch. Only leading indentation in known code regions is removed; tokens, comments/licenses, line endings and literal bytes remain. Ambiguous modules stay entirely unchanged, with a 64-level template bound. Public compiler output, examples, declarations and mapped builds remain exact. Rebuilt columns, digests and reflective function formatting can change; retained workflows require compatible fleet definitions and binaries.

Final complete ordinary-user Node26/minimum Node22 checks each pass 2,021 reported /2,018 passed /zero failed or cancelled /three existing skips. All 150 final SDK modules exactly match the inputs whose native Node22 normalization equals their originals. Packed types retain 31 fixtures, 159 existing /zero new diagnostics against unchanged baseline163. Package: 405 files /6,038,746 bytes /252,710 bytes below the unchanged 6 MiB bound, zero dependencies. Actual reachable published-history security passes in both gates. Canonical docs build/doctor/verified offline artifact, eight HTTP surfaces, MCP and real desktop/390px home/search/current watcher guide checks pass.

The final hosted conformance failure exposed native recursive-watch ENOENT killing Node22 during directory deletion. Repeated actual failures and instrumented stderr remain evidence. Persistent callback error handling and bounded filename reconciliation now converge through the serialized build queue. Thirty repeated rename/delete and dropped-notification cycles pass; the final explicit FSWatcher ENOENT injection also passes both complete gates. Initial lexical and excessive-native-parser-nesting failures remain retained without accepting their failed checks. Source04 is `ea54bd5be1f33caf68c96331fa4cebe9d3ce25a5`, tree `c6f5ff57f08f946aeae65b964d2137c08ebdb121`; all 1,071 tracked inputs are verified before report-only edits. Fresh hosted checks, non-independent author COMMENT and protected merge remain required. This prerequisite adds no roadmap feature: 24 merged /21 feature batches /16 remaining. See [release evidence](release-layout.json).

## Workflow compensation accepted

Feature 20 declares typed idempotent cleanup jobs or bounded manual barriers beside forward jobs. Failure, cancellation, denied/timed-out waits and output failure settle forward children before reverse dependency cleanup. One stable frozen queue occurrence and provider key identify each cleanup. The original failed/cancelled result remains separate from recovery progress. Manual/exhausted/invalid cleanup stops upstream work. Current protocol/definition/owner/lease and exact frozen payload fence claims, handlers and SQLite effects. Operator retry and routine retention preserve unresolved evidence; even explicit inactive manual purge cannot remove active job references. Ordinary graph revision bytes remain exact.

Final complete ordinary-user Node 26/minimum Node 22 gates each pass 2,016 reported / 2,013 passed / zero failed or cancelled / three existing skips. All 70 focused checks and 31 packed positive/negative fixtures pass; source types remain 159 existing / zero new diagnostics against unchanged baseline 163. The actual SIGKILL occurs after an independent provider commits cleanup and before its held response; the replacement worker replays the identical receipt, with two requests and one provider operation. Four actual controller races produce one occurrence per step. Real browser keyboard progress releases dependent then predecessor resources, preserves original failure, isolates another account and restores owner history after login. Successful browser flows report not-needed and skip cleanup. Accepted phone geometry is 390/390; wrong viewport captures are not counted. Canonical docs build/doctor/offline artifact, eight HTTP surfaces, MCP and actual desktop/phone home/search/guide checks pass. The concrete cached-progress setup failure produces an explicit uncached-polling guide clarification.

Final source02 is `5e176679d1e543a2eb5abc1f9d9d33c4c238ca12`, tree `f5cb3534772d83f796f5d959dbe1ef93fc3527bd`, incorporating protected main `e058e72015f890f15858efc8f96ce2390602d542`. All 1,068 tracked source inputs, including 19 restored generated examples, are verified before report-only edits. The package remains 405 files / 6,243,086 unpacked bytes / 48,370 below the unchanged 6 MiB ceiling and zero dependencies. Four runtime regression proofs cover changed handlers, stale manual-history state, attempt resets and substituted payloads. Earlier gate/fixture failures and setup captures remain immutable evidence. All six final hosted checks pass at `f968235499389d41cc20ae65e89b892e0e6a1cf5`, with no new CodeQL alerts or unresolved threads. Non-independent author COMMENT `5476778312` precedes protected squash `d89d52514b259823b8ac28de04f95da642c905bf`, exactly matching tree `0ead1fc75dc10831b5c271c8e202127c3b97e66c`. Both main checkouts are synchronized and all 23 existing files preserved. Feature 20 is counted after this acceptance. External provider idempotency and current authorization remain application responsibilities. See [compensation evidence](workflow-compensation.json).

## Durable workflow waits accepted

Feature 19, under [proposal #293](https://github.com/nearbycoder/clank.run/issues/293) and [PR #295](https://github.com/nearbycoder/clank.run/pull/295), persists typed decision/event dependencies with bounded requests, absolute deadlines, versioned HMAC resume tokens and exact durable receipts. Waiting occupies no worker slot or job lease. A decision can resume only inside an accepted current reviewed action and the same transaction, by the run owner. External adapters must authenticate their provider. Current policy and schema, timeout, cancellation and retained receipt checks serialize one transition without reapplying later effects. Private state preserves legacy graph hashes; unknown protocols and retired live-controller signing policies fail closed.

All 56 focused checks and 30 packed positive/negative fixtures pass, with 159 existing / zero new diagnostics against unchanged baseline 163. Final complete ordinary-user Node 26/22 release gates each pass 2,002 reported / 1,999 passed / zero failed or cancelled / three existing skips. The actual controller SIGKILL occurs after committed resume and before its held HTTP response; a second controller replays the exact receipt and one downstream job. Twelve actual process races cover duplicate, cancellation and deadline ordering. Real affected-record/session revocation rejects commit; unrelated writes and restart preserve valid record-bound approval. Capacity, schema, mapper, policy, definition and purge tests pass.

Final combined source04 is `36f3a2bc632a3983be01801964945f9985d70f24`, tree `e711f7c56f844031bf164d7c2c1556a3454f3b24`, incorporating accepted mobile-navigation main `e394732d1b41309ca5c050975b20b67a7593b0a4`. Both complete release gates pass again with the same 2,002 / 1,999 / zero failed or cancelled / three skipped counts. All 1,045 tracked inputs are hash-verified before these three report-only updates. The package remains 405 files / 6,216,524 unpacked bytes / 74,932 bytes below the unchanged 6 MiB ceiling, zero dependencies. Current documentation build contains 98 guides / 171,643 words; doctor, verified offline artifact, eight HTTP surfaces, MCP reads and actual 1280px/390px home, search and guide checks pass. Actual phone keyboard approval and commit produce `succeeded/browser-approved`; revoking the approving session rejects the old plan and leaves the run waiting. Concrete phone-preview overflow and HTML-form navigation regressions are repaired. Wrong responsive captures and cookie-interference setup are retained separately. Historical source01/source02/source03 gates and immutable indexes remain unchanged. Source02 Node 22 passed every test but failed on malformed coverage JSON; it is not claimed as a complete release gate. The exact property-name diagnostic now gets only the existing single bounded retry, preserving failure, missing-measurement and threshold refusal. Seven focused guard cases pass. Fresh source03 and combined source04 gates provide acceptance.

All six hosted checks pass at `b247a5265a0881043c4c9c38561a874345fb4b14`, with no new CodeQL alerts and no unresolved threads. Non-independent author COMMENT `5476664073` precedes protected squash `e058e72015f890f15858efc8f96ce2390602d542`, whose tree exactly matches `607d47ea4580bcb193923a48f306e3035aae0cc9`. Both main checkouts and all 23 existing files are verified. Feature 19 is counted after this protected acceptance. External side effects remain at least once and need provider idempotency; production host certification is not claimed. See [wait acceptance evidence](workflow-waits.json).

## Scoped provisioning accepted

Feature 12 is implemented under [proposal #287](https://github.com/nearbycoder/clank.run/issues/287)
and merged in [PR #289](https://github.com/nearbycoder/clank.run/pull/289).
Separate expiring credentials, exact resource versions, atomic PATCH and retained retry receipts
scope Users/Groups to an organization and issuer. Signed OIDC subject proof binds/reactivates
identities; metadata cannot select accounts or transfer retained ownership. Deactivation revokes
live/browser/CLI/MCP access while preserving unrelated scopes. Native manual grants remain
independent until fresh, versioned reviewed adoption. Policy publication and membership projection
commit together, including rollback on failed or unsupported asynchronous hooks.

All 40 focused checks and all 29 packed positive/negative type fixtures pass, with 159 existing
source diagnostics and no new allowance against the unchanged 163 baseline. The actual process
drill obtains real OAuth consent/code/PKCE credentials, kills a controller after its accepted
write before the response, and replays once after restart. A second process closes an already-open
live stream and rejects old browser/CLI/MCP credentials. Historical receipts cannot reapply later
removed authority. Deleted local accounts retain subject ownership without orphan membership.

Fresh combined full Node 26/minimum Node 22 gates each pass 1,985 reported / 1,982 passed /
zero failed or cancelled / three existing skips. Coverage is 91.80/80.72/90.01 on Node 26 and
91.80/80.74/90.04 on Node 22. The immutable source04 snapshot is runtime head
`54878cab129ed29ecbe0a3c98fad81322cadb0fb`, tree `e0c6473fe7a5bc0fb95b7b1bf6de4832aaf91d9b`;
integrating merged PR #290 preserves that exact tree at `f62c1e2a05060c1fad00e7efbf6dac2f4bd3dd66`.
Subsequent edits are report metadata only. The package remains 405 files / 6,192,353 unpacked
bytes with 99,103 bytes below the unchanged 6 MiB ceiling and zero dependencies.

Documentation build, doctor, offline artifact and HTTP/MCP checks pass. Home/search/long guide and
actual SCIM content are verified at desktop/phone widths. Browser-blocked machine-format navigation
is recorded separately from successful HTTP/MCP reads. Initial browser-barrel, manually seeded
OAuth, deleted-account projection and source03 CLI/time-fixture failures are retained; each had
a concrete repair before fresh acceptance. No independent review, external enterprise IdP tenant
certification or production host certification is claimed. All six hosted checks pass at the exact final head `a79107ef9ab01da3200dab9962b8e69f1086e4a7`, with no new CodeQL alerts or unresolved threads. Non-independent author COMMENT review `5476386700` precedes the normal expected-head protected squash `1232317b74dd0f384b5416604cd4544b717d2049`. Its tree exactly matches `4eb350683ca4f3946e4af19888e97c17bbc6b54a`; both checkouts are synchronized and all 23 existing files preserved. This increases accepted features to 22 across 19 batches. See [scoped provisioning evidence](scim-provisioning.json).

## Offboarding credential rotation accepted

[PR #292](https://github.com/nearbycoder/clank.run/pull/292), under [proposal #291](https://github.com/nearbycoder/clank.run/issues/291), publishes bounded hashed credential fingerprints with provider/schema/policy/projection initialization. Already-open retired controllers reject rotated credentials, removed providers and changed issuers at admission and again after asynchronous body verification inside the revocation transaction. Failed initialization rolls back the snapshot. Dedicated and linking-disabled shared identities retain their existing behavior.

The real held numeric-loopback HTTP body returns 200 before the fix and 401 afterward with no tombstone/audit; current credentials still converge on one offboarding record. All 43 focused checks and 29 packed type fixtures pass, with 159 existing / zero new diagnostics against the unchanged 163 baseline. Complete Node 26/22 release gates each pass 1,988 reported / 1,985 passed / zero failed or cancelled / three existing skips, including packed conformance, documentation and security. Coverage is 91.81/80.73/90.01 and 91.80/80.75/90.05 respectively. Source snapshot `5309f9dcfccf10ce4f84d5a8d60354cdeecdd68c`, tree `cdc7e2602976a110aaf70887a3d284d347b5db91`, retains 1,037 other hash-equal tracked inputs after the main merge. Package remains 405 files / 6,194,050 bytes, zero dependencies. Docs build, doctor, offline artifact, HTTP/MCP reads and actual desktop/phone rotation paragraphs pass. Retained failed setup/probe captures are distinguished from acceptance. All six hosted checks pass at `0b949f8e8eef2aa72d6354960b128ecec1f2bb64`, with zero new CodeQL alerts and no unresolved threads. Non-independent author COMMENT `5476437405` precedes protected squash `9a76326bd1a8e4f7ffdc97c6d3fdf7629a6eaf2a`, whose tree exactly matches `6b6bc695c328378e77d05b9944505dfbb567fba9`. Primary/main references are updated while the concurrent original user branch is preserved. This repair adds no roadmap feature. See [credential fencing evidence](offboarding-rotation.json).

## CLI positional and signed-time repair

[PR #290](https://github.com/nearbycoder/clank.run/pull/290) merged after both complete ordinary-user
Linux Node 26/22 release gates: 1,971 reported / 1,968 passed / zero failed or cancelled / three
existing skips. All six hosted checks pass at `e42ff81a2380fa3ff0464268c2fc4bcfcd9fb861`, with no
new CodeQL alerts or unresolved threads. The expected-head protected squash is
`1f31092814d9eb2f60025796eac5b2699561c5a8`, exactly matching reviewed tree
`fbd5c20ca0b854bf712944a4e3068e3ad2444275`. Both main checkouts are synchronized and all 23 existing
files are preserved. The author COMMENT review is explicitly non-independent.

Generated IDs beginning with `--` now work after the deployment CLI option terminator; literal
help/JSON/option-looking identities remain values, while earlier invalid options still reject
before network I/O. The real managed environment CLI journey uses that escape. Signed-provider
refusal fixtures use clearly invalid timestamps so an HTTP/JWK second boundary cannot make them
valid; production freshness/skew policy is unchanged. The red regression and subsequent focused,
full and hosted evidence are retained by hash. This maintenance repair adds no roadmap feature.

## Verified organization identity linking

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
| 06 | Automatic supervisor leadership | Merged and counted | Protected PR #314 / 7bdb73e; native coordinator/process acceptance and final hosted checks; [evidence](supervisor-leadership.json). |
| 07 | Online provider node handoff | In progress; not counted | Source/capture/transfer foundations reviewed; private ownership/domain/catalog/barrier prerequisite merged in PR #356. Provider-wide stop and target activation remain pending. |
| 08 | Provider managed canaries | Implemented and merged | Proposal #335 / protected PR #346; actual Docker failure/restart/retirement and both full release gates, exact-head hosted checks, real keyboard/focus/mobile/permission UI evidence; [acceptance](provider-canary-platform.json). |
| 09 | Isolated shadow traffic | Accepted | Fresh Chrome review/start/results/expiry/stop and independent Docker cleanup/zero primary writes pass, with12 actual Node22/26 Docker cases and protected PR #400 gates. [Evidence](shadow-fresh-acceptance.json). |
| 10 | Remote PITR orchestration | Accepted | Fresh Chrome schedule/horizon and separate sequence2 restore after actual source-process/volume loss pass; suspended-before-activation, known ledger, exact retry/reopen and158 focused native cases verified. Trusted native adapter scope retained. [Evidence](recovery-fresh-acceptance.json). |
| 11 | Verified multi-organization identity linking | Implemented and merged | Proposal #283 / merged PR #285; [identity linking acceptance](identity-linking.json). |
| 12 | SCIM user and group provisioning | Implemented and merged | Proposal #287 / merged PR #289; [SCIM acceptance](scim-provisioning.json). |
| 13 | Organization security policy console | Accepted | Fresh Chrome reviewed policy/expired authentication/viewer denial and independent native SQLite are consolidated with current CLI/MCP generation gates, signed OIDC, grace/session and independent last-admin recovery cases. [Evidence](policy-fresh-acceptance.json). |
| 14 | Temporary privileged access | Accepted | Fresh native Chrome scoped grant/use/expiry/revoke, current issuer/recipient authority,390px component keyboard/focus,44 focused native cases and protected PR #395/#396 gates pass. [Evidence](temporary-fresh-acceptance.json). |
| 15 | Organization service accounts | Implemented and merged | Proposal #306 / merged PR #308; [accepted native authority, process recovery and protected delivery](service-accounts.json). |
| 16 | Agent operation budgets | Implemented | Proposal #251; 22 focused tests, actual four-process contention, atomic rollback, restart/exact replay, ownership/revocation/expiry, bounded retention, real MCP calls and 14 packed consumer fixtures. Full release gate passes. |
| 17 | Approval quorum policies | Delivered; acceptance pending | PR #326 code and policy integration delivered through protected PR #369; native browser acceptance remains pending. |
| 18 | Reviews bound to affected records | Implemented | Opt-in tracked reads, requester identity fence, affected-row/ACL changes, unrelated writes, journal gaps, restart and receipt replay tested in `tests/reviewed-actions.test.mjs`. Default remains conservative. |
| 19 | Durable human waits in workflows | Implemented | Proposal #293 / merged PR #295; [accepted runtime, browser, process and type evidence](workflow-waits.json). |
| 20 | Workflow compensation steps | Implemented and merged | Proposal #296 / merged PR #297; [accepted runtime, process, browser and protected delivery](workflow-compensation.json). |
| 21 | Typed PostgreSQL application backend | Merged and counted | Protected PR #333 / fd9a7ab; shared native SQLite/PostgreSQL contracts, both complete gates and hosted acceptance; [evidence](postgres-application.json). |
| 22 | Authorized cross-table aggregates | Implemented | Proposal #267; typed owner/policy-scoped count/sum/group, native JSON admission and selective related/ACL updates. Ten real SQLite regressions, 21 packed fixtures and full minimum-Node release gate pass. `authorized-aggregates.json`. |
| 23 | Source-linked search indexes | Implemented | Proposal #257; atomic source writes/deletes/history restore, pre-opened independent writers, two actual process crashes, resumable fenced rebuild, bounded drift diagnosis, current owner/record authorization and 16 packed consumer fixtures. Real keyboard/mobile/scope/disposal/revocation checks and full release gate pass. |
| 24 | Search facets and stable result cursors | Implemented | Proposal #263; authorized facets, pinned paging and fenced saved definitions; 51 focused tests, 19 packed fixtures, complete release gate and actual browser controls. `search-browsing.json`. |
| 25 | Import correction and upsert workflow | Implemented | Proposal #259; immutable server-verified source, separate durable corrections, version-fenced upserts, exact correction/apply receipts, two actual process crashes, lost responses/restart, ownership/current ACL and bounded admission. All 55 focused tests, 17 packed fixtures and full release gate pass; actual upload/keyboard/mobile/stale/account/disposal/revocation checks. |
| 26 | Shared document cursor coordination | Implemented | Revision-aware, session-bound ephemeral cursors; edit/deletion rebasing, expiry/capacity, per-participant owned authorization, session/ACL/email-verification revocation and restart/reconnect tested. Keyboard/browser and mobile checks pass. |
| 27 | Document suggestions and branches | Implemented | Named durable drafts, immutable proposals, before/after review, author/reviewer policies, document/branch fences, overlap/missing-history rejection, bounded payload/rebase bytes, transactional acceptance and exact restart replay tested. |
| 28 | Retained file versions and restore | Implemented | Proposal #253; 23 new feature tests and 62 focused tests, immutable owner/key-scoped history, generation fences, restart/receipt replay, bounded retention and provider cleanup, in-flight session revocation, actual keyboard/mobile/download checks and 15 packed consumer fixtures. Full release gate passes. |
| 29 | Durable media processing jobs | Merged and counted | PR312; native job/source/lease/publication fences, actual process recovery, both complete release gates and current hosted acceptance; protected merge0729abc. |
| 30 | Offline attachment queue | Implemented and merged | [Fresh native browser/storage/HTTP acceptance](offline-attachment-fresh-modal.json), including explicit synchronize/retry/discard, account/session loss, partial uploads, actual listener loss/recovery and narrow layout; protected PR #394. |
| 31 | Hydration mismatch inspector | Implemented | Optional metadata capture, pre-cleanup child paths, original TSX locations, patch/remount reasons, immutable bounded history and redacted JSON. Unit/packed consumer and real keyboard/mobile/cleanup checks pass. DOM gzip budget remains 12,000 bytes. |
| 32 | Interactive component contract harness | Implemented | PR #266 merged after all six fresh checks; 19 focused tests, 20 packed type fixtures, eight actual Chrome journeys/96 steps, minimum-Node release gate and CodeQL pass. |
| 33 | OpenAPI export for backend functions | Implemented | Runtime schemas, cookie/CSRF and replay contracts; unsupported/coercive/refined shapes rejected; actual positive/negative authenticated HTTP requests tested against the packed artifact. `tests/openapi.test.mjs`, `type-tests/openapi.ts`. |
| 34 | Local provider fleet simulator | Implemented and merged | [Actual coordinator/provider drills](fleet-simulator.json) |
| 35 | Translation extraction and review workflow | Implemented | Canonical catalog extraction, locale/source/current fences, placeholder/key/plural validation and reviewed diff acceptance. Node tests, packed types and real browser keyboard/mobile checks confirm the server/browser revision matches. |
| 36 | Project incident workspace | Accepted | Protected PR #369 code; fresh Chrome/native owner, release link, note, resolution and reopen proof plus current role/deleted-release/private-diagnostic and SIGKILL cases. See [acceptance](incident-fresh-acceptance.json). |
| 37 | SLO and error budget policies | Accepted | Protected PR #369 plus actual Chrome/managed-ingress arithmetic, burn, low-traffic and restart-gap acceptance; see [fresh SLO evidence](slo-fresh-acceptance.json). |
| 38 | Project cost attribution and budgets | Accepted | Fresh native Chrome budget/override/reconcile/uncertain retry, exact SQLite receipts, membership removal and390px iframe keyboard checks complete;60 focused cases and protected PR #393/#396 gates pass. [Evidence](cost-fresh-acceptance.json). |
| 39 | Retention administration and holds | Implemented | Scoped inventory, exact purge receipts, restart-persistent holds, protected history admission, expired-retry fencing and competing scheduled runners; 63 focused tests, 18 packed fixtures, full release gate and actual browser controls. `retention-administration.json`. |
| 40 | Customer status pages | Delivered; acceptance pending | PR #329 code delivered through protected PR #369 with complete runtime and packaged gates; native console acceptance remains pending. |

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


## Shadow Docker isolation acceptance prerequisite

The opt-in public shadow integration suite now uses the real Docker provider,
native Node HTTP adapter and independently generated per-runtime host
certificates. It verifies read-only file/SQLite writes, application uid/caps,
CPU/memory/PID limits, secret exclusion, blocked access to a test-owned host
endpoint, six sanitized comparisons, continued primary writes, exact candidate
resource retirement and session-revocation cleanup. Existing canary integration
cases use the shared fixture. The operator coordinator uses the actual root
certification profile; provider and application privileges retain their prior
bounds. Fixture signing keys use native authentication routes without claiming
physical-device or browser checks. Initial Node22 and26 results are recorded in
`shadow-docker-acceptance.json`; the final delivery gate is recorded separately.
Complete Feature09 operator/browser acceptance remains pending; this prerequisite
does not change the29/40 accepted feature count.


## Shadow Docker recovery and report bounds

The real Docker shadow suite now exercises lost native202 delivery with exact
original/historical replay, actual coordinator SIGKILL followed by disabled
shadow startup and exact candidate retirement, two-attempt reservation ceilings,
actual oversized candidate responses, and oversized primary-response withdrawal
before submission. Primary response bodies and later primary writes stay intact;
reports contain transport aggregates rather than application payloads. Node22
selected cases passed. Final complete per-runtime, full local and hosted delivery
checks remain pending in `shadow-recovery-acceptance.json`; no additional feature
credit is claimed. Browser acceptance remains pending.
