# Implementation ledger

Base: `4b990199965204f1200fcd0fb4ca2b7eb0b02bbc`, equal to freshly fetched `origin/main` on 2026-10-08.

Proposal: [issue #244](https://github.com/nearbycoder/clank.run/issues/244). Six of the forty proposed features are implemented across three review batches; the other thirty-four remain planned. The first batch is [PR #245](https://github.com/nearbycoder/clank.run/pull/245); the document batch is [PR #246](https://github.com/nearbycoder/clank.run/pull/246) and depends on it. Hydration inspection is [PR #247](https://github.com/nearbycoder/clank.run/pull/247) on `codex/hydration-mismatch-inspection` and depends on the document batch.

A feature is complete only when its documented acceptance evidence exists. Proposed contracts do not count as implemented features. The review baseline remains historical evidence; this ledger records subsequent work.

## Merged main and follow-up maintenance

PRs #245, #246 and #247 are merged. The subsequent maintenance review starts from main commit `1e6e62acbf2e59400c023bd3a33125fe1fc2c7d4` and fixes Task failure/cleanup/listener behavior, account-screen isolation, anonymous verification guards, HTTP error observers and durable delivery retries/revocation. It also corrects canary worker-readiness and kernel-probe timing fixtures. No additional roadmap feature is counted as delivered.

The complete maintenance gate passes with 1,657 tests reported, 1,654 passed, zero failures/cancellations and three privileged-host skips. Coverage is 91.96% lines, 79.69% branches and 89.86% functions. All 126 focused tests and 13 packed consumer fixtures pass; source diagnostics are reduced from 290 to 278 without increasing baseline allowances. The existing 393-file package, dependency contract, documentation, conformance and security gates pass. Production host certification remains unavailable because the current Railway host denies required Linux namespaces. See [maintenance review](maintenance-review.json) for findings, source/log hashes, reproduction evidence and remaining debt. The earlier sections below preserve their original batch evidence.

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
| 26 | Shared document cursor coordination | Implemented | Revision-aware, session-bound ephemeral cursors; edit/deletion rebasing, expiry/capacity, per-participant owned authorization, session/ACL/email-verification revocation and restart/reconnect tested. Keyboard/browser and mobile checks pass. |
| 27 | Document suggestions and branches | Implemented | Named durable drafts, immutable proposals, before/after review, author/reviewer policies, document/branch fences, overlap/missing-history rejection, bounded payload/rebase bytes, transactional acceptance and exact restart replay tested. |
| 28 | Retained file versions and restore | Planned | Pending |
| 29 | Durable media processing jobs | Planned | Pending |
| 30 | Offline attachment queue | Planned | Pending |
| 31 | Hydration mismatch inspector | Implemented | Optional metadata capture, pre-cleanup child paths, original TSX locations, patch/remount reasons, immutable bounded history and redacted JSON. Unit/packed consumer and real keyboard/mobile/cleanup checks pass. DOM gzip budget remains 12,000 bytes. |
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
