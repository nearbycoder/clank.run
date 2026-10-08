# Implementation ledger

Base: `4b990199965204f1200fcd0fb4ca2b7eb0b02bbc`, equal to freshly fetched `origin/main` on 2026-10-08.

Proposal: [issue #244](https://github.com/nearbycoder/clank.run/issues/244). Three of the forty proposed features are implemented in the first review batch; the other thirty-seven remain planned.

A feature is complete only when its documented acceptance evidence exists. Proposed contracts do not count as implemented features. The review baseline remains historical evidence; this ledger records subsequent work.

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
| 01 | Verified Linux host certification | Planned | Pending |
| 02 | Artifact promotion across environments | Planned | Pending |
| 03 | Persistent release channels | Planned | Pending |
| 04 | Deployment dependency gates | Planned | Pending |
| 05 | Scheduled release windows | Planned | Pending |
| 06 | Automatic supervisor leadership | Planned | Pending |
| 07 | Online provider node handoff | Planned | Pending |
| 08 | Provider managed canaries | Planned | Pending |
| 09 | Isolated shadow traffic | Planned | Pending |
| 10 | Remote PITR orchestration | Planned | Pending |
| 11 | Verified multi-organization identity linking | Planned | Pending |
| 12 | SCIM user and group provisioning | Planned | Pending |
| 13 | Organization security policy console | Planned | Pending |
| 14 | Temporary privileged access | Planned | Pending |
| 15 | Organization service accounts | Planned | Pending |
| 16 | Agent operation budgets | Planned | Pending |
| 17 | Approval quorum policies | Planned | Pending |
| 18 | Reviews bound to affected records | Implemented | Opt-in tracked reads, requester identity fence, affected-row/ACL changes, unrelated writes, journal gaps, restart and receipt replay tested in `tests/reviewed-actions.test.mjs`. Default remains conservative. |
| 19 | Durable human waits in workflows | Planned | Pending |
| 20 | Workflow compensation steps | Planned | Pending |
| 21 | Typed PostgreSQL application backend | Planned | Pending |
| 22 | Authorized cross-table aggregates | Planned | Pending |
| 23 | Source-linked search indexes | Planned | Pending |
| 24 | Search facets and stable result cursors | Planned | Pending |
| 25 | Import correction and upsert workflow | Planned | Pending |
| 26 | Shared document cursor coordination | Planned | Pending |
| 27 | Document suggestions and branches | Planned | Pending |
| 28 | Retained file versions and restore | Planned | Pending |
| 29 | Durable media processing jobs | Planned | Pending |
| 30 | Offline attachment queue | Planned | Pending |
| 31 | Hydration mismatch inspector | Planned | Pending |
| 32 | Interactive component contract harness | Planned | Pending |
| 33 | OpenAPI export for backend functions | Implemented | Runtime schemas, cookie/CSRF and replay contracts; unsupported/coercive/refined shapes rejected; actual positive/negative authenticated HTTP requests tested against the packed artifact. `tests/openapi.test.mjs`, `type-tests/openapi.ts`. |
| 34 | Local provider fleet simulator | Planned | Pending |
| 35 | Translation extraction and review workflow | Implemented | Canonical catalog extraction, locale/source/current fences, placeholder/key/plural validation and reviewed diff acceptance. Node tests, packed types and real browser keyboard/mobile checks confirm the server/browser revision matches. |
| 36 | Project incident workspace | Planned | Pending |
| 37 | SLO and error budget policies | Planned | Pending |
| 38 | Project cost attribution and budgets | Planned | Pending |
| 39 | Retention administration and holds | Planned | Pending |
| 40 | Customer status pages | Planned | Pending |

## Validation and remaining work

The complete `npm run check` passed on Node 26.10.0: 1,622 tests reported, 1,619 passed, zero failed/cancelled, three skipped; coverage 91.92% lines, 79.47% branches, 89.73% functions. Documentation/export/declaration audits, zero-dependency enforcement, packed-release conformance, and package/tree/history security checks passed. Subsequent focused tests additionally verify retirement of collaboration history copies. The semantic gate passes with 290 existing source diagnostics and 11 packed consumer fixtures. See `implementation-verification.json` for log hashes and exact scope.

The publish allowlist contains 391 files. Four new distribution files for OpenAPI and translation review raise the bounded allowance from 390 to 394; the 6 MiB byte ceiling remains in force. No framework dependencies were added. Two existing published declaration errors were corrected: JSX ambient inclusion and the bucket error constructor.

The translation browser fixture (`tests/fixtures/translation-browser.mjs`) rejects invalid placeholders, prevents acceptance until review passes, supports keyboard review/acceptance, and renders the accepted catalog with the same SHA-256 revision as the server. At 390 × 844 pixels, horizontal content width equals viewport width. Browser warnings/errors were absent. Screenshots are local review evidence, not package contents.

Railway's current production runtime has `unshare` and Bubblewrap installed, but its kernel policy rejects namespace creation. This explains the worker startup failure; this branch diagnoses it and preserves fail-closed isolation. No production deployment or host policy change was performed. A disposable Linux host matching the intended Docker/XFS profile is still needed; no green host certificate, provider failover result, or remote recovery certification is claimed.

Next independent implementation batch: revision-aware ephemeral document cursors and persisted suggestions/branches (26 and 27). The roadmap's deployment/identity/backend changes require their documented contracts and acceptance evidence. Planned features do not count as delivered.
