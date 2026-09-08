# Local capacity and reliability testing

Use Node 24 and build the selected framework revision first. These scripts create disposable
SQLite databases and loopback-only servers; they do not accept an external target URL. They
never load production accounts or credentials. Keep CPU-heavy test suites and browser timing
runs separate from server benchmarks.

## A/B HTTP workloads

```sh
npm run build
node scripts/load/run.mjs --kind=app --users=1000 --rates=100,500,1000 \
  --seconds=10 --rounds=3 --baseline=/path/to/previous/package/dist \
  --candidate=dist --output=/tmp/app-ab.json
node scripts/load/run.mjs --kind=platform --users=5000 --rates=100,250,500 \
  --seconds=10 --rounds=3 --baseline=/path/to/previous/package/dist \
  --candidate=dist --output=/tmp/platform-ab.json
```

The generator and server run in separate processes on the same machine. Each round gets a new
database; A/B order alternates. Synthetic seeding and a two-second warmup are excluded. One real
registration produces a default-cost password hash; fixture accounts receive distinct user IDs,
sessions, CSRF tokens, and owned records. This avoids timing registration as fixture setup.

- `app`: 20 records per account; 80% authenticated reads, 10% writes, 10% rendered HTML.
- `platform`: three inactive projects per account; equal dashboard and project-list reads.
  Add `--metricBuckets=1440` for up to 24 hours of nonempty minute metrics per project. Metric
  populations are bounded to two million buckets; use fewer accounts for that profile.
- `ingress`: three real local application processes deployed through the platform, amongst the
  fixture's project records. Requests use three explicit synthetic hosts and verify the selected
  upstream. The tiny upstream isolates routing/admission cost; it is not a complete hosted app.
  `--ingressRpm=100000` raises **only the disposable fixture's** per-project quota for throughput
  measurement. Omit it to test the default 3,000 requests per project per UTC minute.
- `--mode=login`: real default-cost password checks from distinct loopback source addresses.
  `--authConcurrency=4` compares a different worker count without weakening password hashing.
- `--mode=burst --seconds=1 --rates=100,500,1000`: simultaneous arrivals instead of paced load.

Paced tests schedule arrivals independently of request completion. Latency includes generator
scheduling delay; the report also separates socket-service latency and generator delay. At most
1,000 requests remain in flight, and each has a five-second deadline. Requests the generator cannot
admit count as dropped, rather than disappearing from the denominator. Successful RPS uses the
whole measurement/drain period. Review status counts and dropped work alongside percentiles:
fast overload rejections are not successful capacity.

`--assert=true` exits nonzero unless every sample has no dropped work or failed validation,
every offered request succeeds, p95 is below 500 ms, and p99 is below 1,000 ms. Omit it for
intentional saturation/quota exploration. These are provisional application SLOs, not a guarantee
about all workloads. Raw reports include server CPU, sampled peak RSS, heap, event-loop delay,
query diagnostics, response bytes, and synthetic error examples.

## Live connections, recovery, and isolation

```sh
node scripts/load/reliability.mjs --dist=dist --users=1000 --connections=1001 \
  --batches=60 --output=/tmp/live-default.json
node scripts/load/reliability.mjs --dist=dist --users=5000 --connections=5000 \
  --liveLimit=6000 --batches=60 --readRate=500 --output=/tmp/live-5000.json
```

The first profile exercises default admission limits. The second explicitly increases the
fixture's connection limit and holds 5,000 distinct authenticated subscriptions while sending
owned writes and concurrent reads. Twenty writes run each second; every matching stream must
receive its update and retain tenant isolation. `--batches` controls the soak length in seconds.
Reports include delivery latency and retained subscriptions after disconnect. The test also
checks simultaneous idempotent retries, kills only its own disposable server during writes,
restarts against the same database, replays ambiguous outcomes, and checks session revocation.
A failing invariant or recovery deadline exits nonzero. This validates local crash recovery;
it does not simulate losing the host or persistent volume.

## Browser usability

```sh
node scripts/load/browser.mjs
```

Open `http://127.0.0.1:33940` and choose **Run A/B comparison**. It alternates full and virtualized
rendering for 1,000 and 10,000 synthetic rows, forces layout, and records mounted DOM counts.
It checks keyboard navigation to the last row, checkbox usability, and horizontal overflow.
Repeat at desktop and phone widths. A narrow viewport does not simulate a phone's CPU, network,
or browser memory limit. Save `window.benchmarkResult` for the report, then stop the server.

## Reading results

Record the revision, hardware, dataset, settings, duration, and workload. Compare repeated
samples, not isolated fastest timings. A request rate is not a simultaneous user count, and
idle streams are not active requests. Empty project metadata does not represent projects with
large metrics/release histories. Loopback omits internet latency, TLS, edge throttling, multi-node
contention, storage failures, and application-specific work. Before a public launch, repeat the
chosen workload against an isolated staging deployment with production-equivalent resources and
external generators, and check existing application/runtime quotas against that workload.
