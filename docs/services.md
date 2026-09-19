# Service drivers

Clank keeps external services behind explicit, inspectable drivers. Generated blueprints write `src/service-requirements.ts`, which records every named service, kind, capability, and whether production startup should require it.

```ts
import {
  createServiceRegistry,
  defineServiceDriver,
  openJobQueue,
  openLocalFileStore,
} from "@clank.run/framework/services";
import { assertServices } from "./service-requirements.ts";

const files = await openLocalFileStore({
  directory: ".data/files",
  signingKey: process.env.FILE_SIGNING_KEY!,
});

const services = createServiceRegistry([
  defineServiceDriver({
    name: "uploads",
    kind: "files",
    capabilities: ["signed-read", "signed-write"],
    service: files,
  }),
]);

assertServices(services);
```

The registry gives humans and agents one deterministic place to inspect configuration, validate blueprint requirements, run health checks, and close resources.

## Files

`openLocalFileStore` provides integrity-checked local object storage:

- logical keys never become filesystem paths;
- data and metadata are owner-only and written atomically;
- every read verifies size and SHA-256;
- upload size and content type are bounded;
- signed capabilities bind one key, one operation, and one expiry; and
- the built-in HTTP handler supports signed `PUT`, `GET`, and `HEAD`.

Application code should store file keys and metadata, not local paths. The lower-level
`ObjectStore` contract now has both atomic local and S3-compatible implementations; use it for
provider-neutral server storage and read [Object storage](object-storage.md) for setup, integrity,
cost, and threat boundaries. `FileStore` adds expiring application HTTP capabilities on top of the
same key-oriented model.

## Email

`openFileEmailService` writes a development outbox without sending mail.
`createHttpEmailService` sends a normalized JSON envelope to any HTTPS delivery gateway with
timeouts, bounded retries, bearer credentials, and idempotency keys.
`createResendEmailService` maps the same envelope to Resend's HTTPS API directly, including
provider-specific recipient and tag bounds, without adding its SDK as a dependency.

Email validation rejects header injection and reserved transport headers. Verification, recovery, and MFA callbacks from `defineAuth` can call either driver.

The deployment control plane can use the same contract for its durable invitation outbox. Read
[Invitations and email delivery](invitations.md) for provider setup, recipient behavior, retry
leases, encrypted pending tokens, and the manual fallback.

## Durable jobs and cron

Use `defineJobs`, mutation-scoped `jobs.enqueue`, and `runJobProcess` for new applications. They add
inferred argument types, transactional enqueue with application writes, fenced renewable leases,
owner scope, queues and groups, result validation, explicit cancellation, bounded retention,
time-zone-aware cron, and independently supervised worker/scheduler processes.

The older `openJobQueue(database, handlers)` service API remains available for compatibility. Its
storage is isolated under `clank_service_jobs`, so it can coexist during a gradual migration, but it
does not gain the typed backend and deployment integration of the current job system.

Read [Durable jobs and cron](jobs-and-cron.md) for the complete API, delivery guarantees, cloud
process contract, deployment configuration, failure behavior, and operations guide.

## Webhooks

`signWebhook` and `verifyWebhook` bind the exact body to a timestamped HMAC-SHA256 signature and enforce a replay window. `createWebhookSender` uses HTTPS, rejects redirects, preserves one delivery ID across retries, and retries only transient responses.

## Production boundaries

Local files and a SQLite job database are appropriate when every role shares one durable host
volume. Independent nodes with private disks can use `createS3ObjectStore` for durable objects, but
still need a shared transactional job/database topology. Service capabilities are part of the
blueprint so the deployment platform can refuse an incomplete production plan instead of silently
degrading.

## Durable webhook outbox

`openWebhookOutbox()` from `@clank.run/framework/webhook-outbox` shares an application's SQLite
auth database and runs delivery through Clank's fenced durable jobs. Declare destinations in
trusted server configuration, then publish from server-side business logic:

```ts
const outbox = await openWebhookOutbox({
  path: "./data/app.sqlite",
  auth,
  endpoints: {
    partner: {
      url: "https://partner.example/webhooks",
      secret: () => ({ version: "2026-09", value: process.env.PARTNER_WEBHOOK_SECRET! }),
    },
  },
});
outbox.publish({ userId, key: "ticket-created:123", endpoint: "partner",
  event: "ticket.created", payload: { ticketId: "123" } });
const worker = outbox.startWorker();
```

Route `/__clank/webhooks/*` to `outbox.handle(request)` and use
`createWebhookClient()` with the same session/CSRF integration as other backend clients.
`mountWebhookConsole(container, client)` supplies refresh, attempt inspection, and controlled
replay. Only the owner can list, inspect, or replay a delivery. Publishing is a trusted server
API; clients cannot select arbitrary destination URLs or signing keys. Endpoint configuration
must come from the operator, including any private-network destinations. Requests require HTTPS
and reject redirects; production network egress policy remains the operator's responsibility.

Each delivery has a stable `x-clank-delivery` identity across automatic retries and manual replay.
Signatures bind exact JSON bytes and timestamp, and each attempt resolves the current key and
sends `x-clank-webhook-key-version`. Keep the previous verification key at the receiver during
rotation. Receivers must deduplicate delivery IDs: delivery is at least once, including when a
worker stops after the remote service accepts a request. Five attempts retry network failures,
429 responses, and 5xx responses; other HTTP failures require explicit replay.

The outbox stores up to 100 metadata-only completed attempt records per delivery, across replay
generations. Payloads are persisted privately for retries (64 KiB maximum), but never returned
by inspection. Each user retains up to 1,000 deliveries by default; terminal deliveries are evicted
oldest first and a full queue of pending work rejects new publishes. Idempotency lasts while the
delivery remains retained. Manual replay requires the current job ID, rejects active or successful
deliveries, and admits at most 100 replay generations. Missing job evidence fails closed.
List/inspect clients use a fresh query key so job state cannot be masked by a cached query result.
Stop the worker before closing the outbox. `publish()` atomically enqueues its own delivery and job;
it is not an atomic transaction with an earlier, separate application mutation.
