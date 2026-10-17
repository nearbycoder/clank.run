# Twenty framework improvements — 2026-10-17

This change extends the existing dependency-free local-search, virtual-collection and HAR
performance APIs. Existing entry points and snapshot formats are retained. No database,
authentication or deployment migration is required.

## Delivered functionality

Search (`src/local-search.ts`):

1. Any-term matching (`mode: "any"`) alongside the default all-term mode.
2. Title-only and body-only matching (`field`).
3. Document-ID scoping before ranking/pagination (`ids`).
4. Exact normalized-token exclusions (`exclude`).
5. Consecutive phrase matching, including repeated words (`phrase`).
6. Explicit title and ID ordering (`sort`).
7. Immutable indexed-document lookup (`get`).
8. Explicit index clearing for account changes and logout (`clear`).

Large collections (`src/virtual-collections.ts`):

9. Scroll to an index with start/center/end/nearest alignment (`scrollToIndex`).
10. Scroll to a stable key (`scrollToKey`).
11. Focus a stable key and reveal its row (`focusKey`).
12. Constant-time stable-key lookup across replacements/reorders (`indexOf`).
13. Inspect the visible end-exclusive range without overscan (`visibleRange`).
14. Adjust overscan at runtime without remounting the collection (`setOverscan`).

Application performance (`src/application-performance.ts`):

15. Enforce completed-navigation load-time budgets (`maxLoadTimeMs`).
16. Enforce exact-resource byte and request limits (`resourceBudgets`).
17. Enforce absolute and percentage growth against a baseline (`regressionBudgets`).
18. Identify repeated canonical resources (`duplicateResources`).
19. Summarize requests/bytes by origin (`origins`).
20. Summarize requests/bytes by resource type (`resourceTypes`).

Optional performance policies are also accepted by the existing
`clank workbench performance <page.har> <budgets.json> --baseline=<before.har> --json`
command. Validation failures and policy violations retain the command's failing exit status.

## Security and performance changes

- Body readers copy chunks into bounded 64 KiB slabs instead of retaining arbitrary producer
  views. Tiny chunks no longer retain large backing buffers or one metadata entry per chunk.
  Empty chunks allocate nothing. Incorrect chunk types fail and release the reader lock.
- Body-size errors do not wait for an untrusted producer's cancellation promise. Cancellation
  is still requested and rejection handled. Existing request 413 and response limit error
  contracts are preserved.
- HAR URLs, MIME metadata and diagnostic counts have explicit limits. Requests predating the
  selected navigation invalidate the capture. New summaries retain no headers, cookies,
  bodies, URL credentials, query strings or fragments. Resource paths remain visible.
- Search replacement builds an independently validated index once before an atomic swap.
  Prefix searches cache a sorted vocabulary and use a lower-bound lookup; mutations invalidate
  that cache. Field-frequency storage is explicitly charged against index capacity.
- Virtual-key navigation uses the key map already built during replacement.

## Measurement

Run `npm run build`, then
`node reports/twenty-improvements-2026-10-17/benchmark.mjs` on Node 26. The script reads the
original search implementation from commit `d0efb303489a5bf430da3d84a4cb66d899dde1f3` into a
temporary file, alternates original/new runs, discards two warmups and reports seven medians.
It changes no tracked files. Synthetic fixture: 3,000 documents and 100 prefix searches per run.

The checked-in `search-benchmark.json` records 35.77 → 18.38 ms for replacement and
33.06 → 5.76 ms for 100 prefix searches (about 49% and 83% less time respectively).
Timings describe this host/fixture and are not universal latency guarantees.

## Compatibility and boundaries

The default search remains accent-folded all-term matching with title weighting and final-word
prefix completion. New search settings, collection methods and report fields are additive.
Field-aware indexing charges 96 rather than 64 bytes per term plus text/term bytes; indexes
already near their configured capacity may reject a replacement that previously fit. Such
rejections preserve the previous index. Raising the explicit byte limit is bounded to 64 MiB.

Index only authorized records. ID scopes and immutable lookups are local presentation tools,
not authorization boundaries. Phrase matching ignores punctuation and never crosses fields.
Missing virtual keys return false/-1 without changing collection state. Diagnostic duplicates
are advisory unless a request budget forbids them. HAR growth policies require a valid baseline;
a percentage limit with a zero baseline permits no growth.

No persistent migration is needed. Reverting the implementation/declarations/CLI and rebuilding
restores the earlier APIs; stored version-1 search snapshots remain readable.

## Validation

- Focused tests cover all 20 additions, invalid inputs, atomic failures, memory/body limits,
  cancellation, sanitized report output and CLI pass/fail behavior.
- Source semantic checking introduces no diagnostics; 55 packed consumer type fixtures pass,
  including the new positive/negative collection/performance contracts.
- Final focused regression run: 36/36 passed after the last source changes.
- Security audit: passed package boundaries, credential checks, current tree and complete reachable
  Git history; zero-dependency contract remains intact.
- Documentation audit: passed all 109 Markdown files, 146 declaration copies and 162 exports.
- Portable performance budgets: all six passed; see `performance-budgets.json`.
- Packaged-release conformance: passed auth, OAuth, MCP Apps/actions, live synchronization,
  isolation, deployment, migrations, failed activation, rollback and data restore.
- Full `npm run check` coverage run: **3,975 passed, 1 failed, 43 skipped** (4,019 tests).
  Coverage cleared the required thresholds: 92.04% lines, 82.51% branches, 90.29% functions.
  The gate exited nonzero because of the failure; it must not be described as fully green.
- The failed case was `existing standby restores the deployed tenant, one job writer and a due
  durable backup after actual SIGKILL` in `tests/supervisor-runtime-process.test.mjs:121`:
  a tenant probe returned HTTP 502 instead of 200 after leadership takeover. It passed both
  isolated reruns, including a run with coverage enabled after the final build (16.4 seconds).
  This is consistent with a load-sensitive failover race but does not establish its cause.
  No supervisor code or assertions were changed. The aggregate-suite failure remains an
  outstanding validation limitation. Subsequent conformance/security/docs checks were run
  separately because the aggregate gate stops on a coverage-run test failure.

## Push-time integration

Before pushing, local `main` was rebased onto `2a13854`, retaining four upstream commits.
The overlapping upstream search changes were preserved: vocabulary invalidation only on term
changes, bounded prefix lookup, atomic replacement and capacity/duplicate checks during replacement
iteration (including getter-mutated inputs). Both sets of search regression tests are retained.
Post-rebase focused checks passed **40/40**. The full-suite counts above describe the initial
implementation run before this rebase; no second full aggregate run was performed.
