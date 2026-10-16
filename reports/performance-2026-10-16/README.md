# Workspace policy performance review — October 16, 2026

Baseline: `56f09f94ad32cc5c5720ea7f6ef6ff4ae6d0fa10` (merged main through PR #413).
Both distributions were built and measured with Node 26.10.0. This review inspected the existing
reactive/SSR/module-byte budgets and project discovery/database hot paths. The budgets pass.

Project-list and dashboard responses repeatedly checked the same workspace security policy for
every project, plus workspace/usage discovery. The fix shares each allowed or denied result only
inside one synchronous response build. The existing native policy/session checks still run for
each distinct workspace. No lookup crosses an await, response, request, or mutation boundary.

## Measurements

Five alternating baseline/candidate rounds per profile, with a fresh disposable SQLite database
and registered browser session per invocation. All multi-project profiles have 100 projects in
one workspace. `one-project-policy` is the small-workspace control. `policy` profiles enable the
native security controller and seed a synthetic `factor: none`, no-SSO, one-hour session policy.
The populated profile has 1,440 minute buckets per project (144,000 rows total).

| Profile | Requests per sample | Database reads per request | Median request p50, ms | Sample elapsed reduction |
| --- | ---: | ---: | ---: | ---: |
| one-project-policy | 500 | 37 → 23 | 0.169 → 0.141 | 19.8% |
| projects-no-policy | 500 | 207 → 7 | 1.971 → 0.478 | 75.5% |
| projects-policy | 500 | 1,423 → 23 | 4.031 → 0.522 | 86.5% |
| dashboard-no-policy | 300 | 314 → 114 | 3.371 → 1.940 | 40.3% |
| dashboard-policy | 300 | 1,530 → 130 | 5.167 → 1.879 | 63.9% |
| dashboard-policy-populated | 50 | 1,530 → 130 | 76.614 → 68.194 | 10.5% |

Read counts are from a separate instrumented first request. Timings exclude fixture setup,
registration, policy enrollment on that first request, instrumentation, and warmup. Empty-history
project-list profiles use 50 excluded warmup requests; empty dashboards use 30 and populated
dashboards use 10. Every timed request validates the project count; dashboard requests also
validate metric totals. Timing includes in-process request handling and JSON decoding, without
HTTP transport, external services, physical-authenticator latency, or production workloads.

The runtime is Linux on AMD RYZEN AI MAX+ 395 w/ Radeon 8060S. Trials ran serially; other activity on the workstation is not
controlled. Wall-clock results are diagnostic, not CI limits. The deterministic query-count and
authority regressions are enforced by tests. Populated metric aggregation remains indexed per
project and still dominates that profile. Raw trials are in [platform-ab-node26.json](platform-ab-node26.json).

## Correctness and regression control

The new native regression creates 43 shared projects plus an unrelated personal project. Both
endpoints evaluate two workspace policies, rather than repeating the shared policy for every
project. It checks policy tightening, successful passkey reauthentication, loss of passkey
assurance, membership removal, and session revocation on successive requests. Allowed and denied
decisions both expire after each response; the unrelated personal project remains visible.

The new test fails against the baseline runtime at **46 policy probes instead of 2**; see
[baseline-regression.txt](baseline-regression.txt). The candidate passes 46 focused tests on both
Node 22.16.0 and Node 26.10.0, including tenant permissions, metric equivalence, native organization
security races/crash recovery, core propagation, SSR cleanup, live invalidation, and existing work
and module-byte budgets. The repository security audit also passes. Local validation and source
hashes are recorded in [verification.json](verification.json).

## Reproduction

Build the baseline and candidate with the same Node version, retaining each distribution's
adjacent `brand` directory. Run the candidate harness once for each `--dist`, alternating order
for five rounds. For a configured-policy project list:

```sh
node scripts/load/performance-platform.mjs --dist=/path/to/baseline/dist \
  --endpoint=projects --projects=100 --securityPolicy=true --iterations=500 --warmup=50
node scripts/load/performance-platform.mjs --dist=dist \
  --endpoint=projects --projects=100 --securityPolicy=true --iterations=500 --warmup=50
```

The JSON file records all other profile options. Use `--securityPolicy=false` for the unconfigured
control, `--projects=1` for the small-workspace control, and `--endpoint=dashboard` for dashboard
responses. The populated dashboard uses `--metricBuckets=1440 --iterations=50 --warmup=10`.
