# Durable jobs and cron

Clank runs slow, failure-prone, delayed, and scheduled work outside the web request process. The
queue is durable in the application's isolated SQLite database, enqueue can share the mutation
transaction, and any number of worker processes can cooperate through fenced visibility leases.
Cron uses a separate leased scheduler process and enqueues ordinary jobs; it never executes
business logic inside the scheduler.

The delivery contract is **at least once**. A worker can perform an external side effect and crash
before recording success, so handlers must be idempotent or pass a stable idempotency key to the
external system. Clank prevents stale workers from changing queue state, but no local queue can
atomically commit an unrelated remote API's side effect.

## Define jobs beside the database

```ts
import {
  defineDatabase,
  defineJobs,
  defineTable,
  s,
} from "@clank.run/framework";

export const schema = defineDatabase({
  reports: defineTable({
    status: s.enum(["pending", "ready", "failed"]),
    downloadUrl: s.optional(s.string()),
  }).owned(),
});

export const background = defineJobs({ schema }).jobs(({ job }) => ({
  reports: {
    generate: job({
      args: {
        reportId: s.id("reports"),
        format: s.enum(["csv", "json"]),
      },
      queue: "reports",
      priority: 10,
      timeoutMs: 5 * 60_000,
      retry: {
        maxAttempts: 5,
        initialDelayMs: 1_000,
        factor: 2,
        maxDelayMs: 60_000,
        jitter: 0.2,
      },
      description: "Generate one signed-in user's report outside the request path.",
      agent: {
        title: "Generate report",
        openWorld: false,
        idempotent: true,
      },
      async handler({ db, job, signal }, { reportId, format }) {
        signal.throwIfAborted();
        const report = db.read((read) => read.table("reports").get(reportId));
        if (!report || report.status === "ready") return { skipped: true };

        const downloadUrl = await generateReport({
          reportId,
          format,
          idempotencyKey: job.id,
          signal,
        });
        db.transaction((write) => {
          write.table("reports").patch(reportId, {
            status: "ready",
            downloadUrl,
          });
        });
        return { skipped: false };
      },
    }),
  },
}));
```

Arguments are validated before persistence and again before execution. Optional `returns` validates
and bounds the stored result. Queue names, priorities, timeouts, attempts, delays, payloads, results,
and error text all have hard limits.

The handler context contains:

- `db.read()` and `db.transaction()` using the job owner's database scope;
- immutable job metadata including ID, attempt, schedule, and owner;
- `signal`, aborted on timeout, cancellation, or lease loss; and
- `jobs`, a scoped publisher for durable fan-out.

Jobs created by a signed-in mutation retain that user's owner scope. A handler cannot use its
database context to cross an `.owned()` table boundary.

## Enqueue atomically from a mutation

Attach the definition to the backend, then enqueue through the mutation context:

```ts
import { defineBackend } from "@clank.run/framework";
import { background, schema } from "./background.ts";

export const backend = defineBackend({
  schema,
  jobs: background,
}).functions(({ mutation }) => ({
  reports: {
    request: mutation({
      args: { format: s.enum(["csv", "json"]) },
      handler: ({ db, jobs }, { format }) => {
        const reportId = db.table("reports").insert({ status: "pending" });
        const queued = jobs.enqueue(
          background.jobs.reports.generate,
          { reportId, format },
          {
            idempotencyKey: `generate:${reportId}`,
            group: `report:${reportId}`,
          },
        );
        return { reportId, jobId: queued.id };
      },
    }),
  },
}));
```

The document insert, global live-data revision, and queue insert use the same `BEGIN IMMEDIATE`.
They all commit or all roll back. This is Clank's built-in transactional-outbox path: there is no
gap where the request commits but its follow-up work disappears.

`enqueue` is synchronous because it only validates and writes local durable state. It never runs
the handler in the web process.

### Enqueue options

| Option | Meaning |
| --- | --- |
| `runAt` | Earliest epoch-millisecond execution time |
| `delayMs` | Delay from enqueue; mutually exclusive with `runAt` |
| `priority` | Higher values are claimed first |
| `queue` | Route this occurrence to a queue other than the definition default |
| `idempotencyKey` | Repeated enqueue returns the retained matching job |
| `group` | Serialize active jobs with the same queue and group |

Idempotency applies while the original terminal job is retained. After an operator or retention
cleanup purges it, the key can be used again.

## Add cron schedules

Schedules live on a job definition and enqueue the same validated handler:

```ts
const background = defineJobs({ schema }).jobs(({ job }) => ({
  maintenance: {
    expireInvitations: job({
      args: { batchSize: s.number({ integer: true, min: 1, max: 1_000 }) },
      queue: "maintenance",
      schedules: [{
        name: "nightly",
        cron: "15 2 * * *",
        timezone: "America/Chicago",
        args: { batchSize: 250 },
        concurrency: "forbid",
        startingDeadlineMs: 30 * 60_000,
        maxCatchUp: 3,
      }],
      handler: expireInvitations,
    }),
  },
}));
```

Clank accepts standard five-field minute, hour, day-of-month, month, and day-of-week expressions.
Lists, ranges, steps, English month/week names, and `@hourly`, `@daily`, `@weekly`, `@monthly`, and
`@yearly` are supported. Six-field expressions with seconds are rejected. Time zones must be valid
IANA names supported by the Node runtime.

Each definition has:

- a stable schedule name;
- `allow`, `forbid`, or `replace` concurrency;
- a starting deadline for stale occurrences;
- bounded catch-up after scheduler downtime; and
- a reversible `suspended` switch.

Every occurrence gets a deterministic key from the schedule name and scheduled timestamp.
Competing schedulers therefore converge on one retained occurrence. `forbid` skips while a prior
occurrence remains queued, retrying, or running. `replace` cancels the prior occurrence and enqueues
the new one. The scheduler itself uses a renewable database lease, so multiple instances are safe.

Day-of-month and day-of-week follow traditional cron OR behavior when both are restricted. Local
times skipped or repeated by daylight-saving transitions follow actual matching UTC minutes; test
important business schedules around both transitions.

## Create the background entry

The same compiled module serves workers and the scheduler. The process role comes from
`CLANK_PROCESS_ROLE`:

```ts
import { openBackend, runJobProcess } from "@clank.run/framework";
import { backend } from "./backend.ts";

const runtime = await openBackend(backend, {
  path: process.env.CLANK_DATABASE_PATH ?? "app.sqlite",
  changePollIntervalMs: 0,
});

if (!runtime.jobs) throw new Error("No jobs are defined.");
try {
  await runJobProcess(runtime.jobs, {
    onReady(role, id) {
      console.log(`${role} ready: ${id}`);
    },
  });
} finally {
  runtime.close();
}
```

Run roles locally in separate terminals:

```sh
clank jobs worker
clank jobs worker --concurrency=4 --queues=email,reports
clank jobs scheduler
```

The command reads `clank.deploy.json`, runs its build command, refuses links or an entry outside the
project, and launches the compiled jobs entry without a shell.

## Deploy web, workers, and scheduler

```json
{
  "version": 1,
  "entry": "dist/server.js",
  "include": ["dist", "migrations"],
  "build": {
    "command": ["clank", "build", "src", "dist"]
  },
  "database": {
    "path": "app.sqlite",
    "migrations": "migrations",
    "allowUnsafeMigrations": false
  },
  "health": {
    "path": "/healthz",
    "timeoutMs": 15000
  },
  "env": {},
  "jobs": {
    "entry": "dist/jobs.js",
    "workers": 2,
    "concurrency": 4,
    "queues": [],
    "scheduler": true
  }
}
```

Hosted Clank starts one web process, the requested independent worker processes, and one scheduler.
It health-checks the web process and checks that every background process survives startup before
activation. An unexpected background exit marks the release crashed and enters bounded automatic
restart. Logs identify `worker[n]` and `scheduler` streams. Memory diagnostics attribute every role
separately.

For a code-only rolling update, Clank keeps the old web process serving while it gracefully
quiesces its workers and scheduler. It then starts the candidate process group and switches ingress
only after startup succeeds. If the candidate fails, the prior background set is resumed. This
avoids running old and new handler code at the same time.

Pending migrations still use an exclusive maintenance path so no web or background process holds
the database during migration or restore.

## Cloud-independent process contract

Clank does not depend on Railway job primitives. Any process manager can run:

```text
web        node dist/server.js
worker     CLANK_PROCESS_ROLE=worker node dist/jobs.js
scheduler  CLANK_PROCESS_ROLE=scheduler node dist/jobs.js
```

Worker replicas may set `CLANK_WORKER_CONCURRENCY` and a comma-separated
`CLANK_WORKER_QUEUES`. SIGTERM and SIGINT stop claims and wait for in-flight handlers before exit.
This works with Railway, a systemd host, Docker Compose, Kubernetes, Fly.io, Render, or another
provider that can give the process group access to the same durable application database.

The included driver coordinates through SQLite and therefore requires every role for one app to
share the same durable POSIX database files. Independent nodes with private ephemeral disks are not
a shared queue. On those platforms, keep the Clank supervisor and its per-app processes on the
volume-owning host, or implement the same lease/idempotency contract against a transactional shared
store before scaling across hosts.

## Delivery and failure semantics

1. A worker atomically claims one due job and records a random lease token, owner, expiry, and
   incremented attempt.
2. It renews the visibility lease while the handler runs.
3. Completion compares the token and worker identity. A stale worker cannot settle reclaimed work.
4. A crash leaves the job running until lease expiry. Another worker reclaims it and applies
   bounded exponential backoff.
5. Exhausted work moves to `dead`; it is never silently discarded.
6. Cancellation fences success, aborts a live handler on its next heartbeat, and leaves an explicit
   `cancelled` record.

This follows the same visibility-timeout pattern documented for
[Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html).
Cron behavior intentionally uses the familiar five-field, deadline, concurrency, and time-zone
concepts documented for [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/).
SQLite access uses Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html), so the framework adds no package dependency.

## Inspect and operate

`runtime.jobs` exposes:

```ts
runtime.jobs.stats();
runtime.jobs.list({ state: "dead", queue: "email", limit: 100 });
runtime.jobs.get(jobId);
runtime.jobs.events(jobId, { limit: 100 });
runtime.jobs.cancel(jobId);
runtime.jobs.retry(jobId, { runAt: Date.now() });
runtime.jobs.purge({
  states: ["succeeded", "cancelled"],
  before: Date.now() - 7 * 24 * 60 * 60_000,
  limit: 1_000,
});
```

Successful and cancelled history is retained for seven days by default and cleaned in bounded
batches. Dead letters are retained indefinitely by default. Override `openBackend(..., { jobs })`
or `openJobs(..., { retention })` when an application's compliance rules differ. Events are
globally bounded and are deleted with their job.

Queue stats include every state, currently due work, and the oldest due timestamp. The standard
application manifest at `/__clank/manifest` also includes job argument schemas, queues, retry
policy, schedules, descriptions, and agent metadata. A manifest entry documents a background
capability; it does not make that job remotely callable. Expose an authenticated mutation when a
person or agent should be able to request it.

### Operate a deployed queue

Every deployed project has a **Jobs** view at
`/projects/<project-slug>/jobs`. It reads the job tables in that project's isolated application
database; there is no shared cross-tenant queue. The view shows bounded operational metadata:

- counts for queued, retrying, running, succeeded, dead, cancelled, due, and overdue work;
- expired running leases and schedules with a recorded error;
- the newest 100 jobs, with name, queue, state, attempts, run/completion time, and cancellation
  state; and
- the first 100 cron schedules, with expression, time zone, concurrency rule, next run, and safe
  status.

The platform deliberately does **not** return job arguments, results, error text, owner/group
identities, worker identities, lease tokens, or schedule-error text. `hasError` says only that an
error exists. This prevents a control-plane viewer, support session, CLI transcript, or monitoring
collector from becoming a second copy of application data and credentials. Use the application's
private logs and traces when an authorized engineer needs the error body.

The same surface is available from a linked project:

```sh
clank jobs status
clank jobs list
clank jobs list --state=dead --queue=email --limit=25
clank jobs list --json
clank jobs cancel job_0123456789abcdef0123456789abcdef
clank jobs retry job_0123456789abcdef0123456789abcdef
```

`clank jobs worker|scheduler` still runs local/provider processes; `status`, `list`, `cancel`, and
`retry` operate the project linked in `.clank/project.json`. Human output is concise and `--json`
returns the bounded API contract for agents and automation.

The project API is:

```text
GET  /api/projects/<project-id>/jobs?state=<state>&queue=<queue>&limit=100
POST /api/projects/<project-id>/jobs/<job-id>/cancel
POST /api/projects/<project-id>/jobs/<job-id>/retry
```

Reads require project `read` permission. Cancellation and retry require the dedicated project
`jobs` permission and are blocked during read-only support impersonation. They hold the same
durable project lock as deployment, migration, restore, rollback, and deletion, then recheck
membership immediately before the write. Conditional SQLite updates against the live application
database ensure a concurrent worker cannot turn a stale dashboard decision into an invalid
transition. Cancellation accepts only queued, retrying, or running work. A running job receives a
cancellation request and stops cooperatively at its next lease heartbeat. Retry accepts only dead
or cancelled jobs, clears the old result/error and lease, resets attempts, and enqueues the same
validated stored payload. Both actions append a payload-free job event and a control-plane audit
event.

The API reports one of four compatibility states:

| State | Meaning |
| --- | --- |
| `ready` | Current durable job tables are available |
| `not_deployed` | The project does not have an application database yet |
| `not_configured` | The app has a database but has never opened a durable job runtime |
| `upgrade_required` | An older/incompatible queue table exists; redeploy the current framework |

The console raises an **attention** state for any dead letter, due job older than five minutes,
expired running lease, or schedule with a recorded error. Change the overdue threshold for a
self-hosted control plane with `CLANK_JOB_ALERT_DUE_AFTER_MS`; the accepted range is one second
through 30 days. This is durable state exposed to the console, CLI, and API, not an outbound paging
service. Poll `clank jobs status --json` or the authenticated endpoint from an existing monitoring
system when email, Slack, PagerDuty, or another delivery channel is required.

For telemetry, use stable job name, queue, state, and attempt fields. Do not use job IDs, user IDs,
arguments, or error messages as metric labels. The
[OpenTelemetry messaging conventions](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/)
are a useful interoperability target for traces.

## Handler security checklist

- Treat stored arguments as untrusted even though Clank revalidates them.
- Make external writes idempotent using `context.job.id` or a domain key.
- Pass `context.signal` into `fetch`, storage, and other cancellable work.
- Set an explicit timeout shorter than the provider's termination deadline.
- Keep retryable and permanent failures distinguishable in error reporting.
- Never put credentials or private payloads in queue names, group keys, idempotency keys, logs, or
  agent metadata.
- Bound fan-out and avoid a handler that can enqueue itself without a terminating condition.
- Restrict worker queue allowlists when a process has privileged network or secret access.
- Inspect and alert on dead jobs and oldest-due age.
- Back up the application database; queue state is part of that same database and restore point.
