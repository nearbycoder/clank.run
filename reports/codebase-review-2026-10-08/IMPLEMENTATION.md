# Implementation ledger

Base: `4b990199965204f1200fcd0fb4ca2b7eb0b02bbc`, equal to freshly fetched `origin/main` on 2026-10-08.

Proposal: [issue #244](https://github.com/nearbycoder/clank.run/issues/244). Twenty-nine features are merged across twenty-six feature batches; eleven remain. Latest verified synchronized main (2026-10-10) is `996fb2f2253398e2980bc2ba2455e3b9ee426fce`, including provider managed canaries [PR #346](https://github.com/nearbycoder/clank.run/pull/346), authenticated canary HTTP controls [PR #342](https://github.com/nearbycoder/clank.run/pull/342), SQLite preparation guards [PR #345](https://github.com/nearbycoder/clank.run/pull/345), retention-worker shutdown maintenance [PR #344](https://github.com/nearbycoder/clank.run/pull/344), durable canary retirement [PR #340](https://github.com/nearbycoder/clank.run/pull/340), startup-contention maintenance [PR #341](https://github.com/nearbycoder/clank.run/pull/341), the protected provider-controller prerequisite [PR #337](https://github.com/nearbycoder/clank.run/pull/337), provider-isolation prerequisite [PR #336](https://github.com/nearbycoder/clank.run/pull/336), protected [PostgreSQL feature 21 PR #333](https://github.com/nearbycoder/clank.run/pull/333) and maintenance merges [#330](https://github.com/nearbycoder/clank.run/pull/330) and [#332](https://github.com/nearbycoder/clank.run/pull/332). Both main checkouts match its reviewed tree and all 23 pre-existing local files are preserved. Earlier feature snapshots and their immutable evidence retain their original scope; production Railway remains uncertified.

A feature is complete only when its documented acceptance evidence exists. Proposed contracts do not count as implemented features. The review baseline remains historical evidence; this ledger records subsequent work.

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

## Release package spacing compatibility repair in review

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

## Offline attachment queue verified; browser activation pending

[Proposal #317](https://github.com/nearbycoder/clank.run/issues/317) adds bounded native IndexedDB Blobs, account-scoped upload/replay identity, Web Locks, current account fences and exact private object generation checks in the application record transaction. An ignored or altered native receipt insertion now rolls back its row write. Twelve new native regressions pass; both complete ordinary-user Node26/22 release checks pass2,121 reported/2,118 passed/zero failures or cancellations/three existing skips at f477b0dc0fedbd4b846722af97ac714b9500b97e. Native browser automatic HTTP upload/download/reopen/replay/logout checks establish one object, one record and one receipt. Six separate storage checks use controlled transports. Types35 fixtures/159 existing/zero new against unchanged baseline163; package415 files/6,165,113 bytes/126,343 below unchanged6MiB, zero dependencies. Canonical docs and eight HTTP/MCP surfaces pass; actual375px phone layout has no horizontal overflow. Explicit Synchronize click/Return activation remains unverified, despite correct keyboard focus. Feature30 remains uncounted pending interactive acceptance, current hosted checks, review and protected merge. See [attachment evidence](offline-attachments.json).

## Automatic supervisor leadership accepted

Protected [PR #314](https://github.com/nearbycoder/clank.run/pull/314) merged reviewed `730a464ebeb9ef539efd4d39dd71a63e54d2cc59` as `7bdb73efc3bf297c566d63814223306b047b2792`, with identical tree `dc38208285eb0c9299facad74249aa9552ec8737`. Both main checkouts and all 23 original local files were verified at acceptance. The six final hosted checks passed; the complete native gates and their source binding are retained in [the supervisor report](supervisor-leadership.json). Author COMMENT 5478557857 is not independent approval. The immutable protected-acceptance record has SHA-256 `1fd3ae7b9e57ac266c7d69c3ce208001c1f5a80200f0524d2287825edf9e4f5d`. Feature 06 is counted. The following historical paragraphs retain their original pre-merge qualifications.

## Automatic supervisor leadership verification history

[Proposal #313](https://github.com/nearbycoder/clank.run/issues/313) adds opt-in dedicated same-host Linux coordinators, a retained native SQLite ownership epoch, transaction guards before work/commit, independent coordinator guardians and automatic standby lifecycle recovery. Ordinary-mode startup refuses an enabled catalog before touching tenant cleanup. Configuration replacement, old capability expiry, malformed/missing state and unresolved cleanup fail closed; caller input changes cannot disable the captured topology during delayed activation.

All 65 combined focused checks and two additional transition drills pass: 31 new contracts/process drills and36 existing regressions, with zero failures/cancellations/skips. The additional real SIGKILL drills cover native lease commit before guardian/acknowledgement, and durable release publication before response delivery followed by exact retry on the existing standby. Actual SIGKILL/SIGSTOP preserves deployed tenant data, stops the old job writer before replacement admission, restores retained desired release and runs one due encrypted backup. Other real process drills cover guardian death, native expiry after preparing-fence publication, death during an actual application health check, configuration replacement, ordinary-mode refusal and unresolved tenant cleanup before active bootstrap. The actual packaged platform CLI takes over through HTTP. Native ownership faults are identified as persisted fault injections; no fake clock or production Docker/provider certification is claimed.

Packed types pass 34 fixtures with 159 existing/zero new diagnostics against unchanged baseline163. The package has413 files/6142287 bytes, exactly two additional internal runtime/declaration files, zero dependencies and149169 bytes below the unchanged6MiB ceiling. File-count allowance grows by those exact two files only. Canonical docs build/doctor/verified offline artifact, eight HTTP/MCP surfaces and actual desktop/phone home/search/guide content/layout pass; keyboard activation did not navigate and is not claimed. Both source01 complete ordinary-user Linux release gates passed 2107 reported/2104 passed/zero failures or cancellations/three existing skips. Hosted Node22 exposed valid native base64url identity prefixes being rejected by the existing budget parser; a narrowly scoped identity repair and deterministic replay/isolation regression require updated full gates. The failed packaged-release log is truncated before its assertion; no matching cause is claimed. Both updated-source full native gates pass 2108 reported/2105 passed/zero failures or cancellations/three existing skips. Node26 coverage is91.64/81.01/90.07 and minimum Node22 coverage91.64/81.04/90.11. All six hosted checks pass at064628015bcab9b4cfc16d769f010724234efb2c, including the package check; its earlier failed assertion remains unknown because the log is truncated. No new CodeQL alerts or unresolved threads; the actual Ubuntu26 runner migration annotation was read. The 95-file private immutable index has SHA256cde1856375a32dcc284c2e68f224d08377b28afd8f6380f297ccada30f337847. Only this ledger and the supervisor report change after the verified source snapshot; all1106 other tracked inputs remain hash-identical. The report-only b222ded head passed both runtime jobs, but the complete packaged gate failed one test whose assertion lies outside its bounded TAP tail. The cause remains unknown. The runner now retains the first16 native failure blocks, at most64KiB, and emits them after forwarded output drains, preserving assertions, thresholds, exit and retry behavior. Eight diagnostic checks pass, including an actual failing child whose assertion would be absent after200KiB of later stdout; it remains failed without retry. Both diagnostic-source native gates pass2109 reported/2106 passed/zero failures or cancellations/three existing skips. The retained hosted diagnostics then expose the exact Node24/conformance failure: the encrypted backup is listed before its scheduler acknowledgment is persisted. The corrected bounded observation requires one archive, its matching lastBackupId and a released scheduler lease, preserving the strict encryption/completion/no-overlap assertions. All eight actual lifecycle drills pass. Both corrected-source full native gates at274b4b0bad46a5a62b7a11329342196254096aca pass2109 reported/2106 passed/zero failures or cancellations/three existing skips; Node26 coverage91.64/81.02/90.07 and minimum Node22 coverage91.63/81.04/90.11. All six hosted checks pass on that exact source, zero new CodeQL alerts or unresolved threads; the actual Ubuntu26 migration notice is read. Earlier truncated failures remain unclassified. The additional31-file immutable index has SHA256783a3916d178a5813e6de593c787c807b839a95c0362e0717ca2ad92d950da82 and references the unchanged earlier95-file index. All six final hosted checks pass at730a464ebeb9ef539efd4d39dd71a63e54d2cc59. Protected expected-head squash7bdb73efc3bf297c566d63814223306b047b2792 exactly matches reviewed tree dc38208285eb0c9299facad74249aa9552ec8737. Both main checkouts and all23 original files are verified. Author COMMENT5478557857 is explicitly not independent approval. Feature06 is accepted;27 accepted/24 batches/13 remain. See [current supervisor evidence](supervisor-leadership.json).

## Durable media processing accepted

[Proposal #311](https://github.com/nearbycoder/clank.run/issues/311) connects declared media adapters to existing native jobs. Exact source and destination generations, current originating human session and application policy, the actual worker lease and cancellation state fence publication. Metadata and bounded receipts share one native SQLite catalog; external providers must durably deduplicate a stable operation key. Retained identities are not evicted or recycled at expiry or capacity. Immediate bucket image transforms also retain their original owner/abort signal and cannot publish from replaced uploads; bucket reads verify actual byte digests.

Thirty new focused checks and 65 existing bucket/job regressions pass. Evidence includes actual SIGKILL after metadata/receipt commit before settlement, restart without a second provider request, two real Node worker processes, a dropped real HTTP provider response with two requests and one provider acceptance, held transform/storage races, identical-byte replacement, deletion/replacement, revocation, cancellation, lease loss, expiry, protocol/revision changes and bounded bytes/progress/capacity. Synthetic fake identity refusal is identified separately. Packed source and consumer checks retain 159 existing diagnostics, zero new against unchanged baseline163, with 33 positive/negative fixtures. Canonical docs build, doctor, verified offline artifact, eight HTTP/MCP surfaces and actual desktop/375px home/search/long-guide content/layout pass. No pointer/keyboard navigation, production provider codec or distributed transaction certification is claimed. Both original-source ordinary-user Node26/minimum Node22 release gates passed (2073 reported,2070 passed,zero failures,three existing skips). Hosted Node24 identified a missing bounded busy timeout in the crash fixture observer; its lock failure and the truncated Node22/conformance failures remain retained. The corrected observer preserves every crash assertion, runtime CI now prints spec failures at the end of bounded logs, and three additional persisted-input regressions refuse changed source bucket, destination and malformed generation. Both updated-source full release gates passed (2076 reported,2073 passed,zero failures/cancellations,three existing skips), with Node26 coverage91.56/80.99/90.07 and Node22 coverage91.55/81.02/90.11. All six source7971e7f hosted checks pass, with no new CodeQL alerts or unresolved threads; the actual Ubuntu runner migration notice was read. The unchanged6MiB ceiling contains411 files/6104927 bytes, with186529 bytes headroom and zero dependencies. The 42-file private evidence index is immutable (SHA256 dd08c96769b8afad1607ba5aee1d159910ba3b1efbe824099daa9adac67ccc40). The report-only update passed all six fresh hosted checks at ebc85636f1ac0803756815d5513e67b371d8afa3. PR312 merged through normal protected expected-head squash as0729abca3ed24743b2af1a25089071e7107a81f7, with the reviewed tree bb5decf96bf471c2178957ec6c458fe9ee3bf1cc unchanged. Author COMMENT5478195998 is not independent approval; no CodeQL alerts or unresolved threads. Both main checkouts are synchronized and all23 original files remain hash-identical. Protected acceptance SHA256a3dbfabeb0d1eac5aecb313139e92fdefcfd32cb07410272c59269e04d5cc77b records26 accepted /23 feature batches /14 remain. See [media implementation evidence](media-processing.json).

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
| 07 | Online provider node handoff | Planned | Pending |
| 08 | Provider managed canaries | Implemented and merged | Proposal #335 / protected PR #346; actual Docker failure/restart/retirement and both full release gates, exact-head hosted checks, real keyboard/focus/mobile/permission UI evidence; [acceptance](provider-canary-platform.json). |
| 09 | Isolated shadow traffic | Planned | Pending |
| 10 | Remote PITR orchestration | Draft; not counted | PR #316; current-main integration, native recovery acceptance and console interactions remain pending. |
| 11 | Verified multi-organization identity linking | Implemented and merged | Proposal #283 / merged PR #285; [identity linking acceptance](identity-linking.json). |
| 12 | SCIM user and group provisioning | Implemented and merged | Proposal #287 / merged PR #289; [SCIM acceptance](scim-provisioning.json). |
| 13 | Organization security policy console | Draft; not counted | Proposal #309 / PR #310; client deadline review fix at 344f63f passes focused/type checks. Complete current-head gates and actual native policy-panel acceptance remain pending. |
| 14 | Temporary privileged access | Draft; not counted | PR #325; exact prior-head release gates passed; policy-base integration and native browser acceptance remain pending. |
| 15 | Organization service accounts | Implemented and merged | Proposal #306 / merged PR #308; [accepted native authority, process recovery and protected delivery](service-accounts.json). |
| 16 | Agent operation budgets | Implemented | Proposal #251; 22 focused tests, actual four-process contention, atomic rollback, restart/exact replay, ownership/revocation/expiry, bounded retention, real MCP calls and 14 packed consumer fixtures. Full release gate passes. |
| 17 | Approval quorum policies | Draft; not counted | PR #326; policy-base integration and native browser acceptance remain pending. |
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
| 30 | Offline attachment queue | Draft; not counted | Proposal #317 / draft PR #318; [historical attachment evidence](offline-attachments.json). Accepted main `b4df8be` integrated locally; current full release, interactive browser, hosted and protected merge acceptance remain pending. |
| 31 | Hydration mismatch inspector | Implemented | Optional metadata capture, pre-cleanup child paths, original TSX locations, patch/remount reasons, immutable bounded history and redacted JSON. Unit/packed consumer and real keyboard/mobile/cleanup checks pass. DOM gzip budget remains 12,000 bytes. |
| 32 | Interactive component contract harness | Implemented | PR #266 merged after all six fresh checks; 19 focused tests, 20 packed type fixtures, eight actual Chrome journeys/96 steps, minimum-Node release gate and CodeQL pass. |
| 33 | OpenAPI export for backend functions | Implemented | Runtime schemas, cookie/CSRF and replay contracts; unsupported/coercive/refined shapes rejected; actual positive/negative authenticated HTTP requests tested against the packed artifact. `tests/openapi.test.mjs`, `type-tests/openapi.ts`. |
| 34 | Local provider fleet simulator | Implemented and merged | [Actual coordinator/provider drills](fleet-simulator.json) |
| 35 | Translation extraction and review workflow | Implemented | Canonical catalog extraction, locale/source/current fences, placeholder/key/plural validation and reviewed diff acceptance. Node tests, packed types and real browser keyboard/mobile checks confirm the server/browser revision matches. |
| 36 | Project incident workspace | Draft; not counted | Proposal #300 / draft PR #301; runtime/process/types checked; current-main integration and actual native console acceptance pending. |
| 37 | SLO and error budget policies | Draft; not counted | Proposal #302 / draft PR #303; arithmetic/process/types checked; current-main integration and actual native console acceptance pending. |
| 38 | Project cost attribution and budgets | Draft; not counted | PR #323; current-main integration and native console acceptance remain pending. |
| 39 | Retention administration and holds | Implemented | Scoped inventory, exact purge receipts, restart-persistent holds, protected history admission, expired-retry fencing and competing scheduled runners; 63 focused tests, 18 packed fixtures, full release gate and actual browser controls. `retention-administration.json`. |
| 40 | Customer status pages | Draft; not counted | PR #329; complete updated-source gates, current-main integration and native console acceptance remain pending. |

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
