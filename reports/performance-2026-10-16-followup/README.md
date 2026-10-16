# Search and status performance review — October 16, 2026

Baseline: `a25395c72e2044dbc25dc95459337f6b699aaef9` (main after PR #414).
Both distributions were built and measured with Node 26.10.0. The report includes 90 raw trials
across nine profiles, alternating baseline/candidate order over five rounds.

## Fixes and deterministic evidence

- **Replacement indexing:** build validated replacement maps once, then atomically swap them in.
  Previously a temporary validation index was built and discarded before rebuilding the same data.
  The regression normalizes 400 tokens instead of 800 for 100 four-token documents. Duplicate,
  document-count, byte, validation, restore and rollback behavior remains bounded, including an
  input getter that grows its own array while replacement is being validated.
- **Prefix vocabulary:** sort vocabulary lazily once per vocabulary change, seek the prefix with
  binary search, then inspect only its bounded expansion range. A 1,000-document fixture examines
  at most 51 vocabulary entries for a selective prefix, instead of 951. The existing 50-expansion
  rule, truncation evidence, ranking, Unicode normalization, highlights and pagination stay intact.
  Additions, removals, replacements and snapshot restores invalidate the sorted vocabulary.
- **Status histories:** add `(page_id, scope, sequence)` and `(page_id, subscriber_id, sequence)`
  indexes for public updates and inbox pages. Captured native queries use scoped ordered index
  searches instead of a global update scan or an inbox rowid range across unrelated accounts.
  Reopening a pre-index catalog adds the indexes without rewriting approved updates or inbox data.
  Ownership scope filtering, subscriber isolation, cursors, and ordering remain covered.

All three new work/query-plan regressions fail against the baseline; see
[baseline-regressions.txt](baseline-regressions.txt). The candidate passes 68 focused tests on both
Node 22.16.0 and Node 26.10.0, including native status protocol tampering, audit rollback, privacy,
recent assurance, controller replacement, SIGKILL/replay, domain routing, subscriber pagination,
and existing reactive/SSR/module-byte budgets. Source/harness hashes and validation are recorded
in [verification.json](verification.json).

## Measurements

| Profile | Operations/sample | Baseline median p50, ms | Candidate median p50, ms | Sample elapsed reduction |
| --- | ---: | ---: | ---: | ---: |
| replace-1000 | 10 | 12.127 | 5.084 | 55.8% |
| replace-10000 | 10 | 114.987 | 57.402 | 49.2% |
| warm-prefix-10000 | 300 | 1.568 | 0.044 | 97.2% |
| cold-prefix-10000 | 10 | 1.852 | 1.713 | 8.9% |
| public-history-small | 200 | 0.182 | 0.182 | -0.1% |
| public-history-populated | 200 | 0.447 | 0.185 | 57.6% |
| inbox-tail-small | 200 | 0.155 | 0.157 | -1.2% |
| inbox-tail-populated | 200 | 1.737 | 0.153 | 91.3% |
| inbox-empty-populated | 200 | 1.665 | 0.133 | 91.9% |

Raw samples, CPU measurements, checksums, distributions' compiled-module hashes and query plans:
[search-status-ab-node26.json](search-status-ab-node26.json).

The machine is Linux on AMD RYZEN AI MAX+ 395 w/ Radeon 8060S. Profiles run serially, while unrelated workstation
activity is not controlled. Wall-clock measurements are diagnostic; deterministic work budgets,
query plans and correctness checks enforce regressions. Small-history controls are approximately
unchanged; their sub-millisecond timing differences should not be treated as meaningful gains.

Search fixtures contain 1,000 or 10,000 synthetic documents with weighted common and unique terms.
Each replacement sample has three excluded warmups and ten measured replacements. Warm prefix
samples execute 300 selective queries after excluded setup/warmup; cold samples execute ten queries,
each after an excluded full replacement, so they include vocabulary rebuilding. All six query
results, scores, highlights and ordering are compared between variants outside timing. Common-word
postings and ranking costs can still dominate queries matching most documents.

Status fixtures use in-memory SQLite and the actual status controller with synthetic authority.
Each public target page has 40 approved updates; inbox readers have 25 notifications. Large
catalogs add unrelated data up to 10,000 updates and 50,000 notifications. Public reads return the
latest 20 updates; tail inbox reads seek after the first 20 and return five, while empty readers
must return zero. Each sample has ten excluded warmups and 200 measured reads; result order,
page/account isolation and continuation cursors are checked outside timing. There is no HTTP,
browser, physical authenticator, production account, or persistent-disk load in these profiles.

The indexes add storage and write work. For the populated public-history profile, the median bulk
fixture seed (10,000 updates plus 50,000 notifications in one transaction) took about 156 ms without
these indexes and 175 ms with them. This is synthetic bulk insertion, not a publication latency
measurement; seed costs are recorded separately and excluded from read timings. Existing-catalog
index creation runs once when that controller reopens.

## Reproduction

Build both revisions with the same Node version, then run the candidate harness:

```sh
node scripts/load/performance-search-status.mjs --baseline=/path/to/baseline/dist \
  --candidate=dist --rounds=5 --output=/tmp/search-status-ab.json
```

Fixtures are disposable and create no network listener. `--rounds=1` performs a shorter harness
check; use alternating repeated trials for timing comparisons. The benchmark exits nonzero for
invalid data, different search results, incorrect status history, or broken inbox pagination.
