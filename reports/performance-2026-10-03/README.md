# Performance enhancements — October 3, 2026

Baseline: `e1447fbb0ec7bff14a569293c804939c380f1a5d` (PR #239). Builds use Node 22.16.0;
server benchmarks use Node 24.21.0 and browser trials use Chromium 154. Source and harness
hashes are recorded in [manifest.json](manifest.json). No production data, load, hosting
configuration, password strength, or sandbox policy changed.

## Removed work

| Workload | Baseline | Candidate |
| --- | ---: | ---: |
| DOM insertions for a retained 1,000-row last-to-first rotation | 999 | 1 |
| DOM insertions for a 1,000-row prepend/removal | 1,000 | 2, including initial insertion |
| Changed-record table accesses, 64 writes / 1,000 live readers | 63,176 | 192 |
| Changed-record table accesses, one write / 100 cached readers | 102 | 3 |
| Database reads, 100-project empty-history dashboard | 410 | 112 |
| Domain/release aggregate reads, 39 visible projects | 78 | 2 |

Keyed lists preserve the longest retained sequence and calculate it only when order changes.
Rendering and hydration share the same ordering helper; retained elements, reactive row fields
and indexes, empty/fragment ranges, and disposal remain covered by tests. An independent
quadratic oracle checks all five-row permutations. Baseline negative controls fail at 999 moves.

Backend invalidation creates one per-commit table/owner/ID index and one diagnostic reason.
Singleton writes have a direct matcher; no-reader backends do not build an index. Cached and
evicted live readers retain exact owner, table, record, and dynamic-dependency matching. Auth
notifications, replay invalidation, and refreshed session authority remain live. The regression
fails against baseline at 16,513 metadata reads where the limit is 256.

Project enumeration joins current workspace roles and project restrictions into the indexed
visibility query. Domain/release summaries read only freshly authorized project IDs, using the
existing per-project indexes. No authority is cached across requests. Tests cover immediate
role/restriction/membership/token revocation, inherited preview permissions, malformed stored
restrictions, unrelated tenants, and summary equivalence. Both new query-count tests fail
against baseline. Populated metric aggregation still executes per project.

## Methodology and measured changes

Synthetic fixtures run locally on an AMD Ryzen AI Max+ 395 Linux workstation. This task runs its
timed profiles serially, alternates baseline/candidate order, excludes setup/warmup, and checks
results. Other activity on this shared workstation is not controlled. Timings are diagnostic;
deterministic work, security, byte, and correctness budgets enforce regressions. These are
bounded workload comparisons, not production capacity guarantees or exhaustive leak tests.

### SQLite writes with live readers

Five alternating rounds, 100 transactions/sample, 10 excluded warmup transactions. Each sample
uses a fresh in-memory database with four retained revisions/document. Timing includes writes,
invalidation, and synchronous notification delivery. Work-count instrumentation runs separately.

| Profile | Baseline median / 100 transactions | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| One write, no readers | 2.387 ms | 2.285 ms | 4.3% |
| One write, 100 cached readers | 5.196 ms | 4.439 ms | 14.6% |
| 64 writes, 1,000 live readers, 32 cached results | 293.319 ms | 99.589 ms | 66.0% |

Every trial checks the final values, notification count, cache bound, and unrelated-reader
silence. These timings exclude HTTP, authentication, and persistent-disk I/O. Raw samples:
[invalidation.json](raw/invalidation.json).

### Real-browser keyed updates

Five alternating rounds of 10 updates, 1,000 or 10,000 actual DOM rows; three warmup updates per
implementation/profile. The measurements include synchronous updates and forced layout, with
construction and correctness checks outside timing. Insertion counts use separate probes.

| Desktop profile | Baseline median / 10 updates | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| 1,000-row rotation | 67.4 ms | 49.7 ms | 26.3% |
| 1,000-row prepend | 68.9 ms | 50.3 ms | 27.0% |
| 1,000-row same-order edit | 2.8 ms | 2.6 ms | 7.1% |
| 10,000-row rotation | 831.6 ms | 679.1 ms | 18.3% |
| 10,000-row prepend | 896.4 ms | 743.1 ms | 17.1% |
| 10,000-row same-order edit | 36.1 ms | 33.5 ms | 7.2% |

Order, labels/indexes, identity, and cleanup pass at 1280×633 and 390×844. A narrow desktop viewport
does not emulate mobile CPU/network constraints. Even after improvement, changing every bound
index in a fully mounted 10,000-row list is expensive: use the virtual collection for that scale.
The existing virtual-list browser fixture passes keyboard End, checkbox interaction, fewer than 50
mounted rows, and no horizontal overflow before/after at both widths.

Raw results: [desktop keyed](raw/dom-desktop.json), [phone-width keyed](raw/dom-mobile.json),
[desktop virtual list](raw/virtual-desktop-after.json), [phone-width virtual list](raw/virtual-mobile-after.json).
The compiled DOM module grows 10,329→10,560 gzip bytes (+231), within the unchanged 12,000-byte budget.

### Dashboard microbenchmark

Three alternating pairs, fresh authenticated workspace/SQLite database per process, 20 excluded
warmups. Empty-history trials have 100 projects and 200 measured requests; populated-history trials
have 10 projects, 1,440 minute buckets/project, and 30 measured requests. Date.now is fixed for the
synthetic metrics window; elapsed/CPU clocks remain real. Tables show medians of trial percentiles.

| History | Reads before / after | p50 before / after | p95 before / after |
| --- | ---: | ---: | ---: |
| Empty, 100 projects | 410 / 112 | 2.677 / 2.483 ms | 3.577 / 3.613 ms |
| 24h, 10 projects | 50 / 22 | 6.454 / 6.467 ms | 6.781 / 6.646 ms |

Fewer queries give a modest empty-history median improvement. There is no demonstrated populated
history latency improvement; per-project metric scans dominate. Raw [dashboard.json](raw/dashboard.json).

### Unchanged-path controls

Existing SSR and standalone SQLite-write benchmarks also ran. SSR performs 300 renders/sample,
100 rows, six alternating rounds, checking exact HTML and complete component cleanup. Median
static/component/mixed times are 33.18/94.97/101.21 ms before and 34.93/95.66/99.23 ms after. No SSR
speedup is claimed. See [ssr.json](raw/ssr.json).

Standalone write controls retain all slower samples, including a 13.8% slower 64 KiB replacement
median in the initial three short trials. That benchmark never calls openBackend or the modified
invalidation listener; its 45,261-byte compiled SQLite implementation is byte-identical between
revisions (SHA256 `34c0f68f4f62460ae8195dae0f4f069a58f1614b32f8c8c43fedd1cbb96e71ea`).
See [backend-writes.json](raw/backend-writes.json). A bounded longer repeat is recorded separately.

The longer repeat uses nine alternating rounds and 256 operations/sample at 64 KiB. Insert/patch/
replace medians are 35.294/47.493/46.597 ms before and 34.655/47.287/47.008 ms after; replacement
is 0.9% slower. The initial short result is not established as a causal runtime regression.
Both runs are retained: [backend-control-repeat.json](raw/backend-control-repeat.json).

### End-to-end HTTP, authentication, ingress, and memory

Each loopback trial runs a separate server and generator process, fresh synthetic data, five
measured seconds, and two seconds of warmup. App/platform profiles use three alternating rounds
per revision; ingress/login use two. Latency includes generator scheduling delay. The table shows
medians of per-trial percentiles, not pooled percentiles. Acceptance requires all offered requests
to be valid, zero drops, p95 < 500 ms and p99 < 1,000 ms in each trial.

- App: 1,000 accounts, 20 owned records each; 80% authenticated reads, 10% writes, 10% SSR.
- Platform: 100 accounts, three inactive projects each, 432,000 nonempty minute metric buckets;
  equal dashboard/project-list reads.
- Ingress: three real local application processes among 1,000 synthetic accounts; fixture-only
  quota 100,000 requests/project/minute, no change to production limits.
- Login: 100 accounts, real default-cost password hashes; default 2 concurrent workers unless stated.

| Workload / offered rate | Baseline median p95 / p99 | Candidate | Accepted rounds before / after |
| --- | ---: | ---: | ---: |
| App, 250/s | 2.09 / 2.55 ms | 2.08 / 2.36 ms | 3/3 / 3/3 |
| App, 1000/s | 2.02 / 2.39 ms | 1.84 / 2.36 ms | 2/3 / 3/3 |
| Dashboard/list, 100/s | 4.38 / 5.05 ms | 5.81 / 6.48 ms | 3/3 / 3/3 |
| Dashboard/list, 250/s | 4.14 / 4.88 ms | 4.68 / 5.20 ms | 3/3 / 2/3 |
| Ingress, 500/s | 2.15 / 2.86 ms | 2.12 / 2.68 ms | 2/2 / 2/2 |
| Login, 2 workers, 10/s | 176.86 / 204.06 ms | 180.64 / 199.80 ms | 2/2 / 2/2 |
| Login, 2 workers, 25/s | 1450.56 / 1460.04 ms | 1445.53 / 1449.35 ms | 0/2 / 0/2 |

All 58,000 app/platform/ingress requests returned validated 200 responses with no dropped work.
The original app at 1,000/s missed p95 in one round (763.65 ms, generator scheduling p99 444.51 ms).
The candidate populated dashboard at 250/s also missed p95 in one round (681.18 ms, generator
scheduling p99 81.32 ms). Both outliers remain in the report. The dashboard HTTP medians are
slower despite fewer queries; this pass does not establish end-to-end dashboard acceleration.
Shared-workstation trials are insufficient to certify production capacity or attribute every
long-tail stall. Raw CPU, sampled RSS/heap, event-loop delay, status, bytes, and scheduling
measurements are retained alongside all successful and slower trials.

Password hashing is a separate capacity limit. With 2 workers, both revisions accept 10 offered
logins/s. At 25/s, each 125-request trial returns 78 successes and 47 bounded 503 load-shedding
responses (approximately 12.2–12.3 successful logins/s including drain). No hash strength or
admission limit was weakened. An explicit 4-worker candidate-only trial accepts all 125 requests
at 25/s in both rounds, with p95 382.4/411.7 ms. Peak sampled RSS is 612–624 MB (584–595 MiB),
versus approximately 367–368 MB (350–351 MiB) for 2 workers at that offered rate. Tune
`password.concurrency` / `CLANK_AUTH_CONCURRENCY` only within the deployment's CPU/memory budget;
the default stays 2. This is a fixture tuning experiment, not an automatic deployment change.

Raw reports: [app](raw/http-app.json), [platform](raw/http-platform.json),
[ingress](raw/http-ingress.json), [default login](raw/http-login.json),
[four-worker login](raw/http-login-workers4.json). The load fixture now includes the final RSS
observation in its sampled peak, so peak cannot be reported below the accompanying current RSS.
The 100 ms sampling interval still cannot capture every instantaneous allocation peak.

### Live delivery, retained resources, and recovery

The candidate admits 1,000 live streams and rejects excess connections at the default limit.
A 15-second run performs 300 writes with 1,499 successful concurrent reads at a target 100/s:
no dropped/failed reads, no premature stream closures, and delivery p95 24.21 ms. All matching
updates arrive with tenant isolation. Disconnecting all streams leaves zero subscriptions;
heap falls from 76.73 MB to 22.66 MB after collection, while RSS can remain reserved by the runtime.
This is a short resource/recovery check, not a long-duration memory-leak certification.

Fifty simultaneous retries commit exactly once. Killing only the disposable server, restarting,
and replaying 50 ambiguous writes produces exactly 50 committed records (14 acknowledged before
the crash), with measured recovery 441 ms. Session revocation closes the stream and rejects reads.
See [live-recovery.json](raw/live-recovery.json).

## Local release validation

The complete local release gate passes on Node 22.16.0, 24.21.0, and 26.10.0:
1,598 tests, 1,595 passed, zero failed/cancelled, and three privileged-environment skips per run.
The skipped checks need a disposable XFS mount or Docker integration VM. Builds, documentation
examples/audit, coverage thresholds, package conformance, dependency checks, and security scans pass.

Final validation also resolved an existing bulk-edit test's insertion-order assumption: equal
creation timestamps sort by random ID. The fixture now forces the tie and checks rollback/success
by record ID; the original assertion fails against baseline, and all eight durable-feature tests
pass on each Node version. Node 22/24 full gates preceded this test-only correction; their final
focused reruns pass. Node 26's final complete gate includes it.

Node 26 preserves source comments in native output. Condensing six comments brings DOM gzip to
11,929 bytes under the unchanged 12,000-byte budget. Node 22/24 compiled runtime is byte-identical
to the benchmarked candidate. Final source, distribution, and harness hashes match the manifest.
See [verification.json](verification.json) for gate counts, coverage, local log hashes, negative
controls, independent reviews, and the two resolved validation failures.

## Reproduction

Use the same Node version and build both revisions before timing. A baseline distribution must
retain adjacent package.json/brand files. Run these serially, with no test suites or browser
benchmarks active at the same time. See [load harness documentation](../../scripts/load/README.md)
for dataset bounds, assertions, and interpretation.

```sh
node --expose-gc scripts/load/performance-invalidation.mjs \
  --baseline=/path/to/baseline/dist --candidate=dist --rounds=5 --iterations=100
node scripts/load/performance-dom.mjs /path/to/baseline/dist dist
node scripts/load/performance-platform.mjs --dist=dist --projects=100 --iterations=200 --warmup=20
node scripts/load/performance-platform.mjs --dist=dist --projects=10 --metricBuckets=1440 --iterations=30 --warmup=20
node --expose-gc scripts/load/performance-backend.mjs \
  --baseline=/path/to/baseline/dist --candidate=dist --rounds=9 --iterations=256 --sizes=65536
node scripts/load/performance-ssr.mjs /path/to/baseline/dist dist 100 300 6
node scripts/load/run.mjs --kind=app --users=1000 --rates=250,1000 --seconds=5 --rounds=3 \
  --baseline=/path/to/baseline/dist --candidate=dist
node scripts/load/run.mjs --kind=platform --users=100 --metricBuckets=1440 --rates=100,250 \
  --seconds=5 --rounds=3 --baseline=/path/to/baseline/dist --candidate=dist
node scripts/load/run.mjs --kind=ingress --users=1000 --ingressRpm=100000 --rates=500 \
  --seconds=5 --rounds=2 --baseline=/path/to/baseline/dist --candidate=dist
node scripts/load/run.mjs --kind=app --mode=login --users=100 --rates=10,25 \
  --seconds=5 --rounds=2 --baseline=/path/to/baseline/dist --candidate=dist
node scripts/load/run.mjs --kind=app --mode=login --users=100 --rates=10,25 \
  --seconds=5 --rounds=2 --authConcurrency=4 --candidate=dist
node scripts/load/reliability.mjs --dist=dist --users=1000 --connections=1001 --readRate=100 --batches=15
```

Existing performance budgets remain unchanged. No production rollout is claimed by these
measurements. The previously confirmed Railway namespace restriction still blocks database-worker
deployment operations; this performance change neither removes nor bypasses that security boundary.
