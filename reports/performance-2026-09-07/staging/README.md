# Capacity follow-through — 2026-09-07

Testing stopped at the user's request. The temporary Railway deployment was removed, and no
load generator remains running. **The sustained staging acceptance gate did not pass.** The
short successful trials below must not be presented as assurance of trouble-free operation for
thousands of active users.

## Shipped changes

- [PR 225](https://github.com/nearbycoder/clank.run/pull/225): preserve live-query invalidation
  after result-cache eviction; use indexed ownership/workspace lookups for project listing.
- [PR 226](https://github.com/nearbycoder/clank.run/pull/226): aggregate dashboard metric
  summaries in one current-period query; expose bounded authentication and live-connection
  settings. Existing defaults and password-hash strength remain unchanged. All 819 local tests
  and all five PR checks passed before merge. Railway deployed the merged revision successfully.
- [PR 227](https://github.com/nearbycoder/clank.run/pull/227): framework 0.22.1 release.
  All five PR checks and the independent release gate passed. The public registry tarball matches
  the GitHub-attested release exactly: SHA-256
  `ef0d90dac51cc2e53f7f8fba9a03f0af214641530b36f88b3f63d702e9e1b872`.
- [PR 228](https://github.com/nearbycoder/clank.run/pull/228): Synth reports its actual bundled
  framework version in SSR, hydration state, health, and information responses. All five PR checks
  passed before merge; the existing Synth contract and browser interactions passed locally.

## Workload and topology

An external Node 24.20.0 generator targeted a separate synthetic Railway project in us-west2.
The server used Node 22.23.2, a persistent volume, and an authenticated streaming proxy to
independent application, candidate-platform, and baseline-platform child processes. No customer
accounts, databases, or secrets were copied into the fixture. The platform dataset contained
100 users, three projects each, and 1,440 nonempty minute-metric buckets per project (432,000
buckets). The application contained 5,000 users with 20 owned records each.

The baseline was PR 225 / `a8b7a0e`; the candidate included PR 226 (`0e956c0`, merged as
`28247ce`). Their fixture package labels both say 0.22.0 because the patch version was assigned
later; use these revisions to identify the A/B code. The published 0.22.1 contains both fixes.

Requests use open-loop arrival scheduling, include scheduling delay in latency, have five-second
HTTP deadlines, and count dropped work and unsuccessful status codes. Staging trials alternate
A/B order and retain database state across rounds. Warmed business connection pools differ from
cold browser arrival behavior. HTTP samples are only 10–20 seconds each. CPU percent in child
reports is relative to one CPU core (e.g. 750% means about 7.5 cores), not total host utilization.

## Findings

| Workload | Result |
| --- | --- |
| Populated dashboard, 500 RPS, baseline, two trials | p95 3,323 / 3,230 ms; 175 / 148 timeouts, plus dropped work. Saturated. |
| Populated dashboard, 500 RPS, candidate, two trials | All 7,500 requests succeeded per trial; p95 99 / 116 ms; both met the provisional p95 <500 ms and p99 <1,000 ms SLO. |
| Login, eight concurrent password checks, 25 arrivals/s, two trials | All 250 requests succeeded per trial; p95 387 / 380 ms. Default scrypt strength retained. Peak child RSS about 0.9 GB. |
| Login, 40 arrivals/s, two trials | 69 / 63 bounded-queue HTTP 503 responses; p95 about 1.45 seconds. This rate is not accepted capacity. |
| Mixed app traffic: 80% reads, 10% writes, 10% SSR | Initial 1,000-RPS trial completed all 20,000 requests, p95 155 ms. Its earlier 500-RPS trial had 42 timeouts and p95 1,924 ms. |
| Mixed app rerun after proxy changes | Round 1: 500 RPS still failed (53 timeouts, dropped work, p95 2,538 ms); 1,000 RPS passed all 15,000 requests, p95 292 ms. Round 2: 500 RPS passed all 7,500 requests, p95 112 ms. The user stopped testing before this run finished. The intermittent tail problem remains unresolved. |
| 5,000 live subscriptions plus 500 reads/s and 20 writes/s | All 5,000 subscriptions were admitted. The first minute reported 1,200 writes and 28,627 successful reads; the run subsequently failed on a socket hang-up. It did not reach its 15-minute soak, crash/replay, or revocation gates. |

Early connection-churn and control-channel failures are retained as `early-*.json`. The local
dashboard A/B report also contains a slow first candidate trial; later fast trials do not erase it.

Railway logged high ephemeral-port use during the failed live run. The synthetic container's
range was `32768–38768` (about 6,000 ports). Investigation found that the test proxy unnecessarily
bound ordinary requests to one source address. The final harness omits that binding except for
synthetic login identities, uses separate bounded business/live pools, exposes pool diagnostics,
and saves partial reliability progress. These are harness corrections, not proof that the
observed failure has been eliminated: the follow-up sustained run was not completed. The final
mixed rerun still had an intermittent slow sample.

## App compatibility and remaining rollout

The attested 0.22.1 package passed a fresh consumer's tests, doctor, deployment dry-run, and all
20 feature-module imports. Five isolated copies of older hosted applications passed health,
SSR, and framework asset checks. The four authenticated apps additionally retained synthetic
rows, existing sessions, old password-hash login, tenant isolation, new writes, and live delivery
across dependency replacement. Browser rendering and hydration were checked for these apps and
Synth; local theme/sequencer interactions worked without recorded console errors. See
`app-upgrade-compatibility.json`.

These compatibility checks used synthetic local databases. Six app deployment artifacts were
prepared locally but **were not uploaded or activated**. No workspace quota override or production
capacity-variable change was applied. The platform itself already runs the merged fixes; its
docs/design workflows rebuild independently. Existing immutable application releases require a
separate verified adoption step to use the new framework.

npm version 0.22.1 is public, and its `latest` tag was corrected and verified as 0.22.1 after
interactive account authentication completed.

The stopped synthetic Railway project retains its inert volume/configuration for reproducibility.
It has no active deployment. No production load testing should resume without a new request.
