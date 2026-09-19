# Performance optimization — September 19, 2026

This pass removes repeated work from SQLite document writes, platform dashboard quota resolution,
and server rendering. The baseline is security-audit commit
`7cf3674be1f38baf586706757a3d9de2ebe0ab2e`. Both builds include the security fixes.
Source hashes and machine details are in [manifest.json](manifest.json).

## Changes and deterministic checks

| Workload | Before | After |
| --- | ---: | ---: |
| Canonical document encodings per insert | 2 | 1 |
| Canonical document encodings per changed patch or replacement | 4 | 2 |
| Quota reads for 10 projects in one workspace | 46 | 4 |
| Total database reads for that dashboard | 82 | 40 |
| Synchronously allocated Promises for a static 100-row SSR list | 1,008 | 1 |
| Synchronously allocated Promises for 100 component/keyed/portal rows | 2,626 | 416 |
| Synchronously allocated Promises when every fourth component is async | 2,151 | 466 |

Document encoding reuse preserves canonical ordering, schema validation/defaults, ownership,
conflict detection, no-op behavior, revision history, and output-limit rollback. Quota maps exist
only inside one synchronous dashboard response; billing, overrides, membership, and session
authority remain fresh on the next request. Account and workspace keys use separate maps.

SSR keeps the public Promise API and asynchronous component cleanup boundaries. Native elements,
text, and synchronous arrays avoid unnecessary Promise chains. Regressions cover cleanup ordering,
pending siblings, late rejection, Promise subclasses, context, escaping, and hydration markers.

## Local measurements

Node 24.21.0 on an AMD Ryzen AI Max+ 395 Linux host. Trials ran serially without concurrent test
suites; A/B order alternated. These are local synthetic comparisons, not production capacity
estimates. Raw samples retain slower results as well as improvements.

### SQLite writes

Five rounds; 200 operations per sample at 4/64 KiB and 64 operations at 256 KiB. Each sample has
a fresh in-memory owned-data database, ten excluded warmup writes, and revision history enabled.
Correctness assertions run outside timing. Results are median milliseconds per sample.

| Payload | Operation | Baseline | Candidate | Elapsed reduction |
| --- | --- | ---: | ---: | ---: |
| 4 KiB | Insert | 23.55 | 25.84 | -9.7% |
| 4 KiB | Patch | 43.50 | 29.08 | 33.2% |
| 4 KiB | Replace | 31.40 | 30.47 | 3.0% |
| 64 KiB | Insert | 130.12 | 78.77 | 39.5% |
| 64 KiB | Patch | 194.30 | 134.78 | 30.6% |
| 64 KiB | Replace | 179.52 | 134.47 | 25.1% |
| 256 KiB | Insert | 140.18 | 112.21 | 20.0% |
| 256 KiB | Patch | 258.07 | 200.69 | 22.2% |
| 256 KiB | Replace | 261.32 | 169.34 | 35.2% |

The 4 KiB insert wall-time median was slower even though its median CPU time fell 6.6%.
Its short samples varied widely (baseline 18.10–40.94 ms; candidate 13.32–32.69 ms), so this
run does not establish a small-insert latency improvement. In-memory SQLite excludes durable disk
I/O. See [backend.json](raw/backend.json) for CPU timings and every sample.

### Server rendering

Six alternating rounds of 500 renders, 100 rows per render, after 20 excluded warmups per
implementation. Exact HTML equality is asserted for every render, and component cleanup counts
must match. The allocation hook is disabled during timing. Promise counts above cover synchronous
setup only, not all later microtasks. Results are median milliseconds per 500 renders.

| Tree | Baseline | Candidate | Elapsed reduction |
| --- | ---: | ---: | ---: |
| Static native elements | 242.25 | 184.61 | 23.8% |
| Components, keyed list, portal | 653.50 | 495.99 | 24.1% |
| Mixed asynchronous components | 673.04 | 525.38 | 21.9% |

See [ssr.json](raw/ssr.json). These timings include equality assertions and exclude HTTP/data access.

### Dashboard processing

Three alternating rounds, one authenticated account/workspace and 10 inactive projects. Each
process uses a disposable database. Quota instrumentation runs on one separate request and is
removed before timing. Each round excludes 100 warmups, then measures 1,000 requests without
metrics or 100 requests with 1,440 minute buckets per project.

| Metric history | Median elapsed/request, before | After | Elapsed reduction |
| --- | ---: | ---: | ---: |
| Empty | 1.287 ms | 1.122 ms | 12.8% |
| 24 hours | 21.918 ms | 22.176 ms | -1.2% |

Populated metric queries dominate the latter workload: fewer quota reads did not produce a
measurable latency gain there; median trial p95 increased from 29.17 to 32.30 ms. Median CPU
time fell 12.6% with empty metrics and 1.3% with full
metrics. The benchmark freezes `Date.now()` at fixture creation to prevent minute buckets aging
out during a trial; elapsed and CPU timers remain real. Time-driven session expiry/refresh is
outside this microbenchmark. Regression tests use the ordinary clock.
See [platform.json](raw/platform.json).

### HTTP workloads and tested limits

Each profile ran three alternating five-second trials per revision, with a separate loopback
server process and generator on the same host. App fixtures contain 1,000 synthetic accounts
with 20 owned records each (80% authenticated reads, 10% writes, 10% SSR). Platform fixtures
contain 100 accounts, three inactive projects each, and 432,000 metric buckets (50% dashboards,
50% project lists). These short trials include fresh connections and mostly cold user caches;
warmup is 25 requests/second for two seconds. Each user performs one fixed endpoint operation.

The table shows medians of per-trial percentiles, not pooled percentiles. Acceptance requires
no invalid/dropped requests, p95 below 500 ms, and p99 below 1,000 ms in every trial.

| Profile | Baseline p95 / p99 | Candidate p95 / p99 | Accepted rounds before / after |
| --- | ---: | ---: | ---: |
| App, 250 req/s | 8.50 / 18.10 ms | 8.49 / 19.58 ms | 3/3 / 3/3 |
| App, 1,000 req/s | 497.01 / 1,218.44 ms | 84.17 / 1,232.22 ms | 0/3 / 0/3 |
| Platform, 100 req/s | 17.33 / 26.22 ms | 18.21 / 27.31 ms | 3/3 / 3/3 |
| Platform, 250 req/s | 2,696.47 / 3,466.52 ms | 909.99 / 3,226.44 ms | 0/3 / 0/3 |

All 48,000 measured requests returned valid responses; none were dropped. Both high-rate
profiles failed the latency budget on both revisions. Faster p95 results there do not establish
acceptable capacity, and the lower-rate workloads show essentially unchanged end-to-end
latency. The aggregate data cannot attribute long tails to specific endpoints or connection,
disk, and server queues. No login burst, external network, or running-project capacity is claimed.

Raw results: [app 250](raw/http-app-250.json), [app 1,000](raw/http-app.json),
[platform 100](raw/http-platform-100.json), [platform 250](raw/http-platform.json).

## Reproduction

Use Node 24 and build the baseline in a separate checkout:

```sh
git worktree add --detach /tmp/clank-perf-before 7cf3674be1f38baf586706757a3d9de2ebe0ab2e
(cd /tmp/clank-perf-before && npm run build)
npm run build

node --expose-gc scripts/load/performance-backend.mjs \
  --baseline=/tmp/clank-perf-before/dist --candidate=dist \
  --rounds=5 --iterations=200 --sizes=4096,65536,262144 --output=/tmp/backend.json

node scripts/load/performance-ssr.mjs /tmp/clank-perf-before/dist dist 100 500 6 > /tmp/ssr.json

node scripts/load/performance-platform.mjs --dist=/tmp/clank-perf-before/dist \
  --projects=10 --metricBuckets=0 --iterations=1000 --warmup=100
node scripts/load/performance-platform.mjs --dist=dist \
  --projects=10 --metricBuckets=0 --iterations=1000 --warmup=100
```

Repeat the dashboard pair three times, reversing order on round two. Repeat with
`--metricBuckets=1440 --iterations=100`. Keep the baseline's adjacent `brand` directory.
The original measurements used a copied baseline distribution at the path recorded in the
manifest; a separate checkout reproduces the same source/build and resource layout.

The load scripts' [methodology](../../scripts/load/README.md) describes workload bounds and
correctness assertions. Do not run load generators concurrently with the test suite.

```sh
node scripts/load/run.mjs --kind=app --users=1000 --rates=250 --seconds=5 --rounds=3 \
  --baseline=/tmp/clank-perf-before/dist --candidate=dist --output=/tmp/http-app-250.json --assert=true
node scripts/load/run.mjs --kind=platform --users=100 --metricBuckets=1440 --rates=100 \
  --seconds=5 --rounds=3 --baseline=/tmp/clank-perf-before/dist --candidate=dist \
  --output=/tmp/http-platform-100.json --assert=true
```

Repeat at `--rates=1000` for app and `--rates=250` for platform to reproduce the high-rate
profiles. Their latency acceptance checks failed in this run; retain that result rather than
loosening the acceptance thresholds.

## Validation and compatibility

`npm run check` passed on Node 24.21.0: **856 tests, zero failures/skips**, all framework/docs/design/
Synth builds, documentation/declaration/package audits, the complete packaged-release conformance
journey, and the security audit. Measured coverage is 86.51% lines, 77.66% branches, and 85.06%
functions. Existing performance budgets passed with unchanged limits; core/DOM/router/forms gzip
sizes are unchanged. See [validation.json](raw/validation.json),
[before budgets](raw/budgets-before.json), and [after budgets](raw/budgets-after.json).

Public APIs and persistent schemas are unchanged. No migration is required. Reverting this
performance commit restores prior execution paths while retaining the preceding security fixes.
