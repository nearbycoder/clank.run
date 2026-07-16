# Service drivers

Clank keeps external services behind explicit, inspectable drivers. Generated blueprints write `src/service-requirements.ts`, which records every named service, kind, capability, and whether production startup should require it.

```ts
import {
  createServiceRegistry,
  defineServiceDriver,
  openJobQueue,
  openLocalFileStore,
} from "clank.run/services";
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

The `FileStore` interface is the compatibility target for a future remote object-storage driver. Application code should store file keys and metadata, not local paths.

## Email

`openFileEmailService` writes a development outbox without sending mail. `createHttpEmailService` sends a normalized JSON envelope to an HTTPS delivery service with timeouts, bounded retries, bearer credentials, and idempotency keys.

Email validation rejects header injection and reserved transport headers. Verification, recovery, and MFA callbacks from `defineAuth` can call either driver.

## Durable jobs and cron

`openJobQueue(database, handlers)` stores jobs in SQLite and implements:

- JSON payload validation;
- unique idempotency keys;
- scheduled `runAt` execution;
- transactional worker leases and expired-lease recovery;
- handler timeouts and abort signals;
- exponential bounded retries;
- dead-letter state and explicit retry; and
- multiple cooperating workers against the same database.

Cron schedules should enqueue jobs with stable unique keys such as `daily-report:2026-07-16`. The queue owns delivery state; business handlers remain ordinary async functions.

## Webhooks

`signWebhook` and `verifyWebhook` bind the exact body to a timestamped HMAC-SHA256 signature and enforce a replay window. `createWebhookSender` uses HTTPS, rejects redirects, preserves one delivery ID across retries, and retries only transient responses.

## Production boundaries

Local files and a single SQLite job database are appropriate for a single-node deployment. Horizontal deployments must bind compatible remote object storage and a shared job/database topology. Service capabilities are part of the blueprint so the deployment platform can refuse an incomplete production plan instead of silently degrading.

