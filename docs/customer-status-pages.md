# Customer status pages

Publish component health and dedicated customer updates from a production project's native status console at `/projects/:projectId/status`. The page remains a private draft until a current owner or administrator reviews its public preview and publishes it. Changes and domain verification require a native human browser session verified with a passkey or MFA in the last five minutes, even when the platform's optional global freshness setting is disabled. CLI tokens, machine credentials, impersonation and browser claims do not establish this authority.

Customers read `/status/:slug` or the strict public JSON at `/api/status/:slug` without authentication. Subscriber preferences and the account's notification inbox are available at `/status/:slug/preferences`. An organization membership is not required to subscribe. Each subscriber acts only on their own current native account. The initial delivery channel is the native in-app inbox; no email, SMS or provider notification is sent.

## Review public labels and health

A configuration contains an immutable public slug, title, description and one to twenty component keys and labels. Slugs are lowercase DNS-style names, 3–64 characters. Component keys are 1–48 characters. The public title, description and component labels are limited to 160, 1,000 and 120 UTF-8 bytes respectively. These are dedicated public fields, not copies of private project or tenant metadata. Publishers are responsible for the public text they enter.

A component selects a manual observation or an exact native [SLO policy version](service-objectives.md). A manual observation has a health value, an observation time and an expiry from one second to one hour after observation. Future observations are rejected. The public values are `operational`, `degraded`, `major-outage`, `maintenance` and `unknown`.

An SLO component projects only current native completion coverage. A complete, enabled window within its error budget projects as operational; an exhausted window projects as degraded. Missing measurements, insufficient traffic, disabled policies and stale measurements project as unknown. Its approved observation expires two minutes after the closed measurement window. The status preview reads the native SLO snapshot without transitioning its private alert.

Public reads use the stored approved snapshot; they never query a private incident or change an SLO alert. Expired health becomes unknown with incomplete coverage. Opening a replacement native status controller retires earlier health authority and pending previews. Public text, committed update history and inbox receipts remain retained. Operators review a new snapshot to publish current health after recovery.

```ts
import {createCustomerStatusClient} from "@clank.run/framework/customer-status";

const status = createCustomerStatusClient({auth});
const page = await status.create(projectId, {
  configuration: {
    slug: "customer-health",
    title: "Customer service health",
    description: "Approved information for customers.",
    components: [{
      key: "checkout",
      label: "Checkout",
      source: {
        kind: "manual",
        health: "operational",
        observedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    }],
  },
  operationId: crypto.randomUUID(),
});
const preview = await status.preview(projectId, {
  expectedVersion: page.version,
  publication: {kind: "page"},
});
const published = await status.publish(projectId, {
  expectedVersion: preview.expectedVersion,
  previewId: preview.id,
  previewDigest: preview.digest,
  operationId: crypto.randomUUID(),
});
```

The preview is native, bound to the actual actor, current page version, selected native source versions, ownership binding, account/workspace authority generations and exact public copy. It expires after five minutes. Membership/session removal and restoration retire old reviews. Ordinary session last-use updates do not retire them. Publishing rechecks these boundaries in the same SQLite transaction as the accepted page, updates, notifications, audit and exact receipt. Changing a configuration leaves the prior approved page visible until a new preview is published. Changing native ownership withdraws the old public binding until a current administrator reconfigures and reviews it.

## Publish a customer update

An update requires separate public copy. A private [incident](project-incidents.md) may be selected as provenance with its exact current version; its title, notes, resolution, links, tenant identities, trace data and internal paths are never copied automatically. The update gets an independent public identifier.

```ts
const preview = await status.preview(projectId, {
  expectedVersion: published.version,
  publication: {
    kind: "update",
    copy: {
      title: "Checkout is recovering",
      message: "Try the checkout again shortly.",
      state: "monitoring",
      components: ["checkout"],
    },
    incident: {id: privateIncident.id, expectedVersion: privateIncident.version},
  },
});
```

The public update states are investigating, identified, monitoring and resolved. Titles and messages are bounded at 160 and 4,000 UTF-8 bytes. Selected component keys must belong to the configured page. Use `incident: null` for a dedicated update without private provenance. Inspect both the public page and update in the preview, then publish its exact digest and version.

A successful publication stores at most one native notification per update/subscriber pair, within the publication transaction. Subscribers can select component keys or leave the list empty for all public components. An update with no selected components reaches all current subscribers. Notifications contain only the public update; another account cannot read them. Public history and inbox pages return at most twenty entries. Inbox cursors continue after the last returned native sequence. Unpublishing withdraws both canonical and customer-domain pages; existing subscribers can still read their own retained inbox and unsubscribe.

## Verify a customer domain

The initial contract retains at most five domain reservations per page. Begin a domain using an exact lowercase hostname and current page version. Add the returned `_clank` TXT record and point the hostname at the platform's configured custom-domain CNAME or addresses. Verify ownership and routing in the native console. DNS lookup uses the existing platform verifier and bounded timeout, then rechecks the actor, page version, native ownership and domain reservation before accepting its receipt.

Status domains have a separate native store from application domains. Each store rejects the other's reservations in its write transaction. A verified routing-ready domain serves only the public root. Administration and subscriptions use the configured canonical platform URL. TLS eligibility requires the current published binding, verified ownership and accepted routing. Forwarded-host headers do not grant routing authority. Verification is a point-in-time DNS proof; use the console to recheck routing after DNS changes. Unpublishing or changing native ownership removes eligibility. Expired pending challenges require a new challenge. Retained verified ownership is not a new DNS observation.

## Exact retries, limits and recovery

Keep the exact operation ID and input after a lost or timed-out response. A retry returns its retained receipt only to the current authorized actor and ownership binding. Reusing an ID for different input fails. A historical successful receipt does not republish a withdrawn page. The SDK bounds even a non-cooperative transport with a 100–30,000 ms timeout and rejects malformed, oversized or private-field public responses. Public SDK requests omit credentials and custom authentication headers. Mutations use the actual auth client's CSRF header.

JSON mutations are limited to 32 KiB and SDK responses to 128 KiB. Native URL-encoded forms allow 128 KiB encoded and 32 KiB decoded. Retained pages, previews, receipts, updates, subscribers and notifications have configurable bounded capacities. A page retains at most 200 subscriber records. Full capacity rejects new work without discarding history or converting unknown outcomes into success. Ignored or altered native page, preview, update, subscriber, notification, audit and receipt acknowledgments roll back the complete operation.

```ts
openPlatform({
  dataDirectory: "./platform",
  publicUrl: "https://platform.example.com",
  statusPages: {
    maxPages: 1000,
    maxReceipts: 20000,
    maxPreviews: 5000,
    maxUpdates: 10000,
    maxSubscribers: 5000,
    maxNotifications: 50000,
  },
});
```

The retained protocol is version one. Unknown versions and malformed retained clocks fail closed. Preserve native state and backups for operator recovery. A downgrade requires quiescing the new status paths first; an older runtime does not serve or reinterpret the new store. Do not delete receipts to resolve an unknown response. The native passkey fixtures and disposable process tests verify cryptographic/runtime boundaries; they do not certify a physical authenticator, external production DNS or a production hosting profile.
