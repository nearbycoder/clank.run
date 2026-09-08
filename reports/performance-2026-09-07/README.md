# Capacity and reliability test report — September 7, 2026

The local tests found and reproduced two defects: live subscriptions could stop receiving
updates after their result-cache entry was evicted, and platform dashboards/project lists
scanned unrelated tenants' projects. Both have targeted fixes and regression tests in this
change. The results support further staging validation; they do not certify a public launch
for an arbitrary number of users or hosted applications.

## Method and provenance

- Host: AMD Ryzen AI Max+ 395, 32 logical CPUs, approximately 110 GiB RAM; Node 24.20.0.
- One isolated Node server and a separate generator on the same host, loopback HTTP and
  disposable local SQLite. No production load, customer data, or production configuration changes.
- Synthetic authenticated accounts have distinct sessions, CSRF tokens and owned records.
  A real default-cost password registration seeds the fixture; setup is outside measured time.
- Initial A/B: published framework 0.20.0 versus unmodified 0.22.0 at
  `22bf8d89fadd62bd7741a08b8640334b2cdf8d6c`. Optimization A/B: published 0.22.0 versus
  the two fixes in this change. Candidate package metadata still says 0.22.0; that label alone
  does **not** identify whether the fix is present.
- Candidate source SHA-256: `src/backend.ts`
  `dffb200466903edd03f1443bacc5c69a5016c46d4301535dcce5cbeba10337a0`;
  `src/platform.ts` `9de04e84c4e332212c929246df55fed8228b83ffb01142ed033cf6652161585d`.
- Repeated A/B trials alternate order and recreate databases. Each trial warms up for two
  seconds, then runs each listed rate for eight seconds unless specified below. Rates increase
  within a trial; databases are not reset between rates. CPU-heavy checks and browser timings
  run separately from HTTP measurements.
- Open-loop arrivals include scheduling delay in latency. The client counts backpressure drops,
  caps in-flight requests at 1,000, and uses five-second request deadlines. Tables use the
  **median of trial p95s**, not a pooled percentile or a confidence interval. CPU 100% means
  one core. RSS peaks are sampled, not an allocation-level memory profile.
- Provisional HTTP acceptance: every offered request succeeds and validates, zero drops,
  p95 < 500 ms and p99 < 1,000 ms. Intentional saturation/quota runs retain failed samples.

The reusable commands and workload definitions are in [scripts/load](../../scripts/load/README.md).
Raw JSON is in [raw](raw). The manifest maps reports to code variants; SHA256SUMS identifies
the retained report bytes. Early HTTP reports check ownership on query/mutation and project-list
responses; dashboard response isolation was subsequently added to the harness and passed its
final smoke check. The dedicated platform regression test checks both endpoints.

## Repeated HTTP A/B results

| Workload | Offered rate | Before p95 | After p95 | Result |
| --- | ---: | ---: | ---: | --- |
| 1,000 app accounts, 20 owned records each; 80% reads / 10% writes / 10% SSR, 0.20 → 0.22 | 1,000/s | 2.06 ms | 2.10 ms | All 24,000 requests per version passed; no material regression demonstrated |
| 1,000 platform accounts / 3,000 projects without metrics, 0.20 → 0.22 | 250/s | 3.18 ms | 3.18 ms | All 6,000 per version passed |
| Three actual hosted processes amongst 3,000 project records, 0.20 → 0.22 | 1,000/s | 4.33 ms | 4.59 ms | All 24,000 per version reached the correct upstream; fixture quota raised for throughput |
| 1,000 platform accounts / 3,000 projects, 0.22 → indexed fix | 1,000/s | 16.90 ms | 2.35 ms | All 24,000 per version passed; about 86% lower p95 |
| Same indexed comparison | 1,500/s | 5,000 ms | 2.42 ms | Before: 30,012/36,000 valid, 2,675 timeouts, 3,313 drops. After: all 36,000 valid |
| 5,000 platform accounts / 15,000 projects, 0.22 → indexed fix | 500/s | 5,001 ms | 2.19 ms | Before: 8,368/12,000 valid, 3,308 timeouts, 324 drops. After: all 12,000 valid |
| 100 accounts / 300 projects, 432,000 minute-metric rows (up to 24 hours), 0.22 → indexed fix | 50/s | 9.99 ms | 10.00 ms | Two trials, all 800 requests per version passed; this workload is dominated by metrics work |

The platform mix is 50% dashboard and 50% project-list reads, with three projects visible per
account. Project records are inactive except the three ingress fixtures. These tests do not
represent 15,000 running application processes, large release histories, or accounts with
thousands of projects each. The ingress fixture's tiny upstream isolates platform routing cost.

## Saturation, admission and bursts

- The released app fixture completed 50,000 requests at 5,000/s over ten seconds, p95 15.59 ms.
  This was the highest tested rate, not a discovered capacity ceiling or 5,000 simultaneous users.
- With populated metric histories, the fixed platform completed 1,250/1,250 at 250/s over
  five seconds, p95 7.82 ms. At 500/s all 2,500 eventually completed, but p95 reached 4.27 seconds.
  The short samples need a longer staging repeat before choosing an operating rate.
- Simultaneous app bursts of 100/500/1,000 requests all completed; p95 was 82/358/525 ms.
  Fixed platform bursts all completed; p95 was 82/321/1,163 ms. A 1,000-request dashboard burst
  exceeded the provisional latency target despite returning no errors.
- Default-cost password hashing with two workers passed 10 logins/s (80 attempts), p95 179 ms.
  At 25/s, 114/200 succeeded and 86 received `503 AUTH_BUSY`. Four workers, unchanged hash cost,
  admitted 362/400 across two 25/s trials but still rejected 38; p95 was about 981 ms and sampled
  RSS peaked near 636 MiB. More workers improved throughput at a memory/CPU cost; no production
  authentication settings were changed.
- Default hosted ingress quota is 3,000 requests per project per UTC minute. The 15-second,
  1,000/s test against three applications returned 8,950 successes and 6,050 expected `429`s
  after 50 warmup requests. Exactly 9,000 total requests were admitted. Quota rejections are
  not server capacity successes, and the limit is a minute bucket rather than smooth 50/s pacing.

## Live data and crash reliability

The released version accepted 1,000 default-limit streams and rejected excess connections with
`503`. A separate run with an explicitly raised fixture limit held 3,000 streams across 1,000
accounts. Both one-minute runs delivered 1,200 writes without premature disconnects; delivery
p95 was 24.70 ms and 26.02 ms respectively. Retry, crash/replay, cleanup and revocation checks passed.

With 5,000 distinct accounts/streams, a 6,000 connection limit and the default 1,000-entry result
cache, the released version missed live updates and failed the delivery deadline. The fix keeps
subscription dependency metadata after cached payload eviction, without enlarging the result
cache or notifying unrelated tenants. A regression test also checks changing dependencies,
warm-cache subscription creation and disposal.

The fixed one-minute run passed with 5,000 streams, 1,200 writes and 29,987 reads paced at 500/s.
There were no read failures, drops or premature stream closures. Live delivery p95 was 47.44 ms,
read p95 25.49 ms, and sampled peak RSS about 495 MiB. All subscriptions were released after
disconnect. Fifty simultaneous retries committed once. After killing the disposable server during
writes, replaying all 50 ambiguous requests committed exactly 50 changes and preserved every
acknowledged write; restart plus replay took 777 ms. Session revocation closed its stream and
subsequent reads returned `401`.

The extended five-minute candidate run passed with the same 5,000 streams and 500 reads/s:
6,000 writes reached every test account, 149,952 reads completed, live delivery p95 was 45.02 ms,
and read p95 was 25.33 ms. There were zero read failures/drops or premature disconnects.
Retry, cleanup, crash/replay (751 ms) and session-revocation checks passed again. Sampled peak
RSS was 600.4 MiB; minute checkpoints were 532.0, 559.7, 557.3, 578.6 and 584.4 MiB.
That upward residency trend needs a longer staging soak and allocation analysis before claiming
steady-state memory stability. Five minutes does not establish that a process is leak-free.

## Browser usability

Headless Chromium 152 ran three alternating full/virtual rendering comparisons at each list
size and viewport width, using the candidate's unchanged DOM/virtual-collection implementation.
The measurements include initial mounting and forced layout, and exclude prior-view disposal.
They compare two supported rendering patterns, not a new renderer optimization.

| Viewport | Rows | Full-render median | Virtualized median | Mounted virtual rows |
| --- | ---: | ---: | ---: | ---: |
| 1,440 px desktop | 1,000 | 24.4 ms | 1.2 ms | 19 |
| 1,440 px desktop | 10,000 | 190.7 ms | 1.6 ms | 19 |
| 390 px phone width | 1,000 | 18.4 ms | 1.1 ms | 19 |
| 390 px phone width | 10,000 | 200.7 ms | 1.4 ms | 19 |

Both widths passed End-key navigation to index 9,999, bounded DOM size, checkbox interaction
and no horizontal overflow. Browser automation additionally pressed Home/End and checked the
last visible checkbox. Screenshots were visually reviewed and neither run reported browser
errors. Use virtualized collections for long lists. These desktop Chromium results at a narrow
viewport do not simulate mobile CPU/memory, network conditions, or complete application usability.

## Launch implications and remaining validation

1. Ship the fixes through the normal checked PR/deployment path. Existing immutable hosted
   application releases and npm consumers require a framework patch release/adoption and rebuild
   to receive the live-query fix; merging platform source alone does not update every application.
2. Set an explicit traffic model: authenticated active users, tabs/live subscriptions per user,
   read/write rates, peak password logins and concurrent hosted application processes. The default
   live limit is 1,000 streams per backend runtime; each tab/query can consume a connection.
3. Repeat on isolated staging with production-equivalent Node/container resources, persistent
   volume and actual application data, driven externally through TLS. Include at least a longer
   steady-state soak, reconnect/login surge, populated dashboard histories and deployment/restart
   during traffic. Set a target operating rate with headroom below the first failed latency target.
4. Confirm actual project/workspace quota overrides and launch configuration. Read-only production
   inspection found the global request-limit overrides unset (defaults 3,000/min/project and
   5 million/month/organization), signup set to `bootstrap`, and hosting profile `trusted`.
   Public developer hosting needs its own isolation/configuration review. Nothing here changes
   those settings or validates thousands of independent hosted processes.

Production's observed low traffic (hourly maximum about 0.092 vCPU and 425 MB memory, configured
limits 32 vCPU/32 GiB) was a health snapshot, not a load test. The local machine has different
resources, uses Node 24 while the platform Dockerfile selects Node 22, and shares a host with its
generator. Internet latency, edge behavior, CPU throttling, volume/host loss, cold starts,
multi-node contention and application-specific queries remain outside these measurements.

Both new regression tests fail against published 0.22.0 for the reproduced reasons and pass
against the candidate. Local `npm run check` passed all 815 tests, coverage, documentation and
design/demo builds, packaged deployment/migration/rollback conformance, and the security audit.
The published allowlist remains 328 files. CI and deployment results are recorded in the PR.
