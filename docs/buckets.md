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

Large uploads use sequential offset-checked `PATCH` chunks. `HEAD` reports the durable offset, so a
client can continue after a lost response. A wrong offset cannot overwrite an earlier chunk.
`DELETE` cancels the reservation. Completion verifies declared length, optional SHA-256, allowed
media type, image signature and dimensions, and the metadata returned by the object provider before
publishing the new generation. The prior generation remains current until that commit succeeds.

`list`, `stat`, `delete`, and `createReadIntent` use the same client. Private reads use an expiring
read capability. Public objects receive an opaque ID plus digest URL that changes with each
generation and the bucket's `cacheControl` policy. Responses set an exact type and length,
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
objects. The response is non-cacheable, cannot be framed, sends no referrer, contains no script,
and uses a restrictive content security policy. It is intentionally read-only; application UI,
server actions, the browser client, or MCP tools perform uploads and deletion with their normal
CSRF/scope checks.

## Failure and security model

- The SQLite catalog is authoritative for visibility, ownership, quota, and the active generation.
- An object-store write is not visible until its size, SHA-256, type, and key match the reservation.
- Reservations count against quota, preventing concurrent uploads from overcommitting capacity.
- Replacements reserve only their byte delta and use compare-and-set SHA-256 when requested.
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
