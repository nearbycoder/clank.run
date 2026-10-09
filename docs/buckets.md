# Managed buckets

Managed buckets are Clank's first-class application file and image layer. Declare what an app may
store once; the server, browser, deployment platform, and every app's MCP server use that same
contract. Local development needs no service account. A deployment receives an isolated catalog,
object namespace, signing key, and administrator-controlled project quota automatically.

## Declare a bucket

For an AI-generated app, put buckets in `clank.app.ts` beside entities and actions:

```ts
import type { AppBlueprintInput } from "@clank.run/framework/blueprint";

export default {
  name: "Field Notes",
  description: "Shared field observations.",
  entities: {},
  routes: [{ path: "/", view: "notes" }],
  buckets: {
    attachments: {
      description: "Files owned by one signed-in user.",
      ownership: "user",
      visibility: "private",
      browserAccess: "authenticated",
      allowedContentTypes: ["image/*", "application/pdf", "text/plain"],
      maxObjectBytes: 25 * 1024 * 1024,
      maxObjects: 10_000,
      maxBytes: 1024 * 1024 * 1024,
      perOwnerMaxObjects: 500,
      perOwnerMaxBytes: 100 * 1024 * 1024,
      resumable: true,
      maxChunkBytes: 4 * 1024 * 1024,
    },
  },
} satisfies AppBlueprintInput;
```

Run `clank generate .`. The generated `src/buckets.ts` opens local object storage under
`.clank/buckets` during development, passes the manager into `openBackend`, and accepts the
project-scoped managed environment in production. There is no bucket SDK to install.

Use `defineBucket` directly when an app is not generated from a blueprint:

```ts
import { defineBucket, openBucketManager } from "@clank.run/framework/buckets";
import { openLocalObjectStore } from "@clank.run/framework/object-storage";

const photos = defineBucket({
  name: "photos",
  ownership: "user",
  visibility: "private",
  browserAccess: "authenticated",
  maxObjectBytes: 10 * 1024 * 1024,
  maxObjects: 50_000,
  maxBytes: 5 * 1024 * 1024 * 1024,
  image: {
    maxWidth: 8000,
    maxHeight: 8000,
    maxPixels: 40_000_000,
    formats: ["png", "jpeg", "webp", "avif"],
    variants: {
      thumbnail: { width: 320, height: 320, fit: "cover", format: "webp", quality: 82 },
    },
  },
});

const objects = await openLocalObjectStore({ directory: ".data/objects" });
const buckets = await openBucketManager({
  definitions: [photos],
  store: objects,
  databasePath: ".data/buckets.sqlite",
  stagingDirectory: ".data/uploads",
  signingKey: process.env.CLANK_BUCKET_SIGNING_KEY!,
});

const backend = await openBackend(definition, { path: "app.sqlite", buckets });
```

`openBackend.close()` closes the bucket catalog it owns.

## Browser uploads

The browser asks the authenticated backend for a short-lived, resource-bound upload capability.
It never receives object-store credentials. The capability contains the bucket, owner, operation,
reservation, and expiry under HMAC; changing any byte invalidates it. The initiating management
request uses the application's normal origin, session, and CSRF checks.

```ts
import { createBucketClient } from "@clank.run/framework/buckets";

const attachments = createBucketClient("attachments", {
  csrfToken: () => document.querySelector('meta[name="clank-csrf"]')?.content,
});

const object = await attachments.upload({
  key: `receipts/${crypto.randomUUID()}.pdf`,
  value: file,
  contentType: file.type,
  resumable: true,
  onProgress(uploaded, total) {
    console.log(`${uploaded} / ${total}`);
  },
});
```

The browser client captures the upload key, options, progress callback and CSRF header when
`upload()` is called, before asynchronously buffering a `Blob`. Changing those inputs while the
file is read cannot redirect the pending upload. The server still validates the initiating session
and CSRF token.

Large uploads use sequential offset-checked `PATCH` chunks. The client rejects invalid resumable
state before sending a chunk and requires each intermediate response's `Upload-Offset` to equal
the end of the chunk just sent; missing, malformed or unexpected offsets stop the upload.
`HEAD` reports the durable offset, so a
client can continue after a lost response. A wrong offset cannot overwrite an earlier chunk.
`DELETE` cancels the reservation. Completion verifies declared length, optional SHA-256, allowed
media type, image signature and dimensions, and the metadata returned by the object provider before
publishing the new generation. The prior generation remains current until that commit succeeds.

`list`, `stat`, `delete`, and `createReadIntent` use the same client. Private reads use an expiring
read capability bound to the exact current generation. Replacing a file invalidates that capability,
even when the replacement has identical bytes. Public objects receive an opaque ID plus digest URL
that changes when their bytes change, and the bucket's `cacheControl` policy. Responses set an exact type and length,
`nosniff`, a digest ETag, safe content disposition,
and a sandbox content security policy.

## Ownership and access

These settings are independent:

| Setting | Meaning |
| --- | --- |
| `ownership: "user"` | A key is resolved inside the authenticated user's partition. Two users may safely use the same key. |
| `ownership: "app"` | One application-wide keyspace, useful for public assets and generated reports. |
| `visibility: "private"` | Bytes require a server call or signed read capability. |
| `visibility: "public"` | Opaque public URLs may be cached according to `cacheControl`. |
| `browserAccess: "authenticated"` | Browser management requires the application session. |
| `browserAccess: "public"` | Anonymous reads/listing are allowed only when ownership and visibility are both app-wide/public; writes still require authentication and CSRF. |
| `browserAccess: "server"` | HTTP management is closed; server actions and MCP tools remain available. |

Never treat a public URL as authorization. Use a private bucket for access-controlled material.

## Retained generations and restore

Retention is disabled by default. Enable it explicitly on a bucket, including a generated app's
bucket declaration:

```ts
const attachments = defineBucket({
  name: "attachments",
  ownership: "user",
  allowedContentTypes: ["text/plain", "application/pdf"],
  versions: {
    maxAgeMs: 7 * 24 * 60 * 60_000,
    maxPerObject: 5,
    maxVersions: 500,
    maxBytes: 100 * 1024 * 1024,
    perOwnerMaxBytes: 20 * 1024 * 1024,
  },
});
```

Each successful replacement or deletion retires the previous immutable provider generation.
History contains opaque generation IDs, original digests/types and retention deadlines; it contains
no provider keys or permanent public URLs. Identical uploads remain separate generations.
`maxPerObject` is bounded at 100, `maxVersions` at 1,000 per bucket, and age at one year.
Retained bytes have separate bucket and owner ceilings. Existing `usage()` continues to describe
current objects and pending uploads; reserve the configured history allowance when sizing storage.

Newest generations have priority. An expired or excess generation loses catalog visibility and
enters the existing durable cleanup queue. A generation larger than the retained byte allowance
cannot be retained. Startup, new reservations and history inspection enforce the operator's policy;
tightening age never extends a stored deadline. Disabling retention or removing a bucket definition
retires its history and restore receipts during the next sweep. Provider deletion failures remain
retryable; inaccessible garbage still consumes physical storage until the provider recovers.

Use trusted current identity for server calls:

```ts
const files = buckets.bucket("attachments");
const identity = { userId: currentAuthenticatedUser.id };
const current = files.stat("report.pdf", identity);
const history = files.listVersions("report.pdf", identity);
const generation = history[0];
if (generation) {
  const stored = await files.getVersion("report.pdf", generation.id, identity);
  const restored = await files.restoreVersion("report.pdf", generation.id, {
    ...identity,
    operationId: crypto.randomUUID(),
    ifSha256: current?.sha256 ?? null,
  });
}
```

`ifSha256` is required; `null` requires an absent destination. Restore verifies retained bytes and
reserves current-object quota through the normal upload path. It fences the destination's exact
provider generation across asynchronous I/O, including same-digest replacements, and rechecks the
source's visibility and expiry inside the catalog commit. Failed validation, quota admission,
cancellation or provider writes leave the current file unchanged.

Keep the operation ID and original input until the response is known. An accepted write and its
receipt commit together. Exact retries return the original metadata without another write;
different input conflicts. The receipt remains private to the bucket/owner and survives source
eviction through its original age deadline, allowing replay after restart or a lost response.
There are at most 10,000 live restore receipts per manager; full capacity rejects new restores.
Expired source IDs cannot execute again. Receipts describe the accepted generation, which a later
upload may already have replaced. Use new operation IDs for new work.

The browser client exposes `listVersions`, `createVersionReadIntent` and `restoreVersion` without a
caller-selectable owner. The history and restore endpoints require a current application session,
even for public app-owned buckets. User-owned history stays in the authenticated partition;
app-owned history uses the shared application keyspace. Use `browserAccess: "server"` and protected
server actions when an app-wide restore needs additional roles.

History download capabilities are private, operation-specific bearer credentials, capped by both
capability lifetime and retention expiry. They never switch to a current or foreign generation.
Revalidate retention after provider I/O before sending bytes. As with existing capabilities,
already issued credentials can be used until they expire; revoking a human session closes new
history/restore access rather than revoking independently delegated download credentials.

`openBackend` supplies current-session checks before history responses, after request bodies and
inside restore commits. It closes in-flight restores when another connection revokes that session.
Standalone HTTP adapters must supply `BucketRequestContext.verifyCurrent`, a synchronous trusted
credential refresh, plus `verifyWrite` for CSRF. Direct server calls and custom MCP identity
adapters must authorize the current principal themselves; request-supplied IDs are not credentials.

Version-enabled buckets add `bucket_<name>_versions`, `bucket_<name>_read_version` and
`bucket_<name>_restore_version`. Reads require `agent:read`, restores require `agent:write`, and
larger reads return a bounded download capability instead of unbounded inline bytes.

The catalog migration adds generation and restore-receipt tables without rewriting provider bytes.
Back up those tables with the provider. Upgrading invalidates legacy current-read tokens that
did not bind a generation; mint fresh read intents. To roll back retention, set `versions: false`
with the upgraded manager and sweep. Stop it before reverting to an older binary, disable history
and restore entry points, and rotate the signing key because older code cannot enforce the new
generation binding. Reverting code alone does not reclaim retained bytes.

## Images and variants

Image buckets inspect file signatures rather than trusting an extension or `Content-Type`. PNG,
JPEG, GIF, WebP, and AVIF dimensions are parsed before commit and checked against format, width,
height, and pixel limits. This blocks simple content-type spoofing and decompression-bomb dimensions
before an image decoder receives the file.

Variant names and geometry are part of the immutable bucket contract. Supply an
`imageTransformer` to `openBucketManager` for the codec available in your runtime. The callback
receives only verified source bytes and the declared variant; its output passes the full upload
policy again. Clank intentionally does not hide a native image binary or billable transformation
service inside its zero-dependency package.

## Every bucket is available to agents

Passing the manager to `openBackend` adds current tools to that app's MCP contract:

```text
bucket_attachments_list
bucket_attachments_read
bucket_attachments_put
bucket_attachments_delete
```

An image bucket with variants also gets `bucket_<name>_transform`. Read tools require
`agent:read`; writes and deletes require `agent:write`. OAuth resolves the same application user as
the UI, so a tool cannot list or mutate another user's partition. Small objects travel as bounded
base64. Larger reads return a short-lived resource-bound URL instead of overflowing the MCP
response. Bucket definitions are included in `clank://actions`, `GET /__clank/manifest`, and the
public Clank discovery document, so an agent sees policy changes with the same contract revision as
server actions.

## S3-compatible production storage

Generated apps select S3-compatible storage when `CLANK_BUCKET_S3_ENDPOINT` is present:

```sh
CLANK_BUCKET_S3_ENDPOINT=https://objects.example.com
CLANK_BUCKET_S3_REGION=auto
CLANK_BUCKET_S3_BUCKET=application-objects
CLANK_BUCKET_S3_ACCESS_KEY_ID=...
CLANK_BUCKET_S3_SECRET_ACCESS_KEY=...
CLANK_BUCKET_PREFIX=project_01
```

Optional variables are `CLANK_BUCKET_S3_SESSION_TOKEN` and
`CLANK_BUCKET_S3_PATH_STYLE=1`. The application protocol is unchanged: browser capabilities are
served by the app while verified generations are retained in S3. This works with AWS S3, Railway
Buckets, Cloudflare R2, and compatible self-hosted services through the low-level `ObjectStore`
contract.

On Clank's deployment platform, each project receives:

- an isolated local volume directory and catalog;
- a stable project-derived signing key that is never returned through an API;
- a unique logical object prefix for shared S3-compatible storage;
- account/workspace administrator limits for total bucket bytes and object count; and
- cleanup with the project's managed data boundary.

Local managed bytes are removed with that project boundary. When operators attach an external
S3-compatible bucket, they must also configure provider lifecycle/deletion for the project's exact
`CLANK_BUCKET_PREFIX`; Clank never scans or bulk-deletes an unbounded shared provider namespace by
guessing keys after its catalog is gone.

The environment also supplies `CLANK_BUCKET_MAX_BYTES` and `CLANK_BUCKET_MAX_OBJECTS`. These are
deployment-wide ceilings across every declared bucket and cannot be raised by application code.
Definition limits and per-owner limits still apply, so the strictest relevant limit wins.
Server observability can call `buckets.usage()` for aggregate active and reserved project totals;
individual runtimes return the corresponding bucket/owner usage from `bucket.usage(identity)` and
every list response includes its scoped usage.

## Inspect storage in a deployed app

The project's **Storage** page in the Clank control plane shows the enforced byte/object ceilings.
For locally placed apps it also samples aggregate active and reserved usage from the bucket catalog
through a read-only SQLite connection. Provider volumes remain outside the control-plane trust
boundary, so the page does not mint a privileged storage credential or impersonate an app user.

Use **Open file browser** or visit `https://your-app.example/__clank/buckets`. That inventory is
served by the application itself and requires its normal signed-in session. It lists at most 100
objects per page, supports bucket and key-prefix navigation, partitions user-owned buckets by the
current user, omits server-only buckets, and mints five-minute download capabilities for private
objects. Version-enabled buckets show a **History** link with retained downloads and restore
buttons. Restores use the current session's CSRF token, preserve keyboard focus, report failures
through a live status region and reject a changed current file. A standalone adapter without a
trusted CSRF token/write verifier exposes history downloads without restore buttons. The response
is non-cacheable, cannot be framed and sends no referrer. Its narrowly scoped restore script uses
a CSP nonce and same-origin connections. Application UI, server actions, the browser client or MCP
tools perform uploads and deletion with their normal CSRF/scope checks.

## Failure and security model

- The SQLite catalog is authoritative for visibility, ownership, quota, and the active generation.
- An object-store write is not visible until its size, SHA-256, type, and key match the reservation.
- Reservations count against quota, preventing concurrent uploads from overcommitting capacity.
- Replacements reserve only additional bytes; smaller replacements release capacity when they commit,
  and compare-and-set SHA-256 is enforced when requested.
- Each upload reservation permits one finalizer to write provider bytes. Duplicate completions fail
  without overwriting or deleting the winning generation.
- Deleting a key also cancels its pending upload, including a replacement already writing provider
  bytes. Canceled capabilities cannot restore the key or retain replacement quota credit.
- Expired reservations and staging files are swept on startup and before new reservations.
- Provider deletions enter a durable garbage ledger before catalog visibility is removed; failures
  retry across sweeps/restarts without resurrecting the object or losing its cleanup key.
- Object bytes missing from or changed behind the catalog fail closed as integrity errors.
- Signed capabilities expire within 24 hours, are operation-specific, and become unusable after a
  write reservation commits or is cancelled.
- User IDs are supplied by Clank auth or OAuth context, never from a browser query or MCP argument.
- Public delivery addresses objects by opaque ID rather than exposing storage keys or provider URLs.
- The local catalog is required to be a regular non-symlink file and is permissioned to its owner.

Back up both the bucket catalog and object provider. The catalog alone cannot recreate bytes, and
orphaned provider bytes are deliberately not made visible by discovery.
