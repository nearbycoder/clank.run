# Capacity and reliability testing

Use Node 24 and build the selected framework revision first. These scripts create disposable
SQLite databases and loopback-only servers by default. The explicit staging mode described below
accepts only a separately provisioned synthetic Railway fixture. Neither mode loads production
accounts or credentials. Keep CPU-heavy test suites and browser timing
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

## Isolated Railway staging

The staging server is deliberately excluded from package exports and application deployment
commands. Provision it only in a separate disposable Railway project with its own empty volume.
It boots a 5,000-account application fixture and two 100-account platform fixtures with 432,000
nonempty metric buckets each. Use the same Node major, region, and volume type as the deployment
being assessed. The authenticated streaming proxy adds a network hop that production may not have.

Prepare a deployment directory containing `dist`, `package.json`, `brand`, `LICENSE`, and
`scripts/load`. Include the comparison revision at `baseline/{dist,package.json,brand,LICENSE}`.
Use Node 22 or 24, set the start command to `node scripts/load/staging-server.mjs`, mount an empty
volume at `/data`, configure `/healthz` as the readiness path, and set restart policy to `NEVER`.
The fixture exits after two hours; explicitly remove its deployment after testing.

Required environment: `CLANK_CAPACITY_ENABLED=synthetic-only`, `CLANK_CAPACITY_TOKEN` containing
64 cryptographically random hexadecimal characters, `UV_THREADPOOL_SIZE=16`, and `PORT=8080`.
Keep the token outside the deployment directory and source control. The access file (mode 0600)
contains `{"url":"https://YOUR-FIXTURE.up.railway.app/","token":"YOUR-64-HEX-TOKEN"}`.
All workload and control routes require the token; only the cheap health route is public.

```sh
node scripts/load/run.mjs --staging=/private/staging-access.json --kind=platform \
  --users=100 --metricBuckets=1440 --baseline=baseline --rates=100,250,500 \
  --seconds=15 --rounds=2 --output=/tmp/staging-dashboard.json
node scripts/load/run.mjs --staging=/private/staging-access.json --kind=app \
  --users=5000 --mode=login --rates=10,25,40 --seconds=10 --rounds=2 \
  --output=/tmp/staging-login.json
node scripts/load/reliability.mjs --staging=/private/staging-access.json \
  --users=5000 --connections=5000 --liveLimit=6000 --readRate=500 \
  --batches=900 --connectBatch=10 --output=/tmp/staging-live.json
```

Remote HTTP trials share at most 128 pooled business connections across a five-second warmup
and the measured rates. A/B order alternates, but synthetic database state persists between
remote rounds; this is different from the fresh databases used by local rounds. There are no
hidden business-request retries. Only login tests assign distinct synthetic source addresses.
Ordinary proxy traffic uses kernel-selected addresses and separate bounded business/live pools.
Report server configuration from `serverProfile`, not CLI defaults that cannot reconfigure an
already deployed fixture. Proxy RSS, pool counts, and the host's ephemeral-port range accompany
runtime metrics. The tested Railway port range contained only 6,000 ports; long-lived streams
need room for ordinary requests and connection churn as well as application admission slots.

Reliability ramps in `--connectBatch` groups and warms the business pool before measured reads.
It saves minute checkpoints and partial progress on failure. Its crash command kills only the
named synthetic child and restarts it against the same synthetic volume. Session revocation is
last and invalidates the first fixture account's saved session; re-seed a disposable fixture before
repeating after a fully completed run. An interrupted report without a finish time is incomplete.
A passed short trial does not establish a sustained capacity guarantee; retain failed and
interrupted trials alongside successful ones.
