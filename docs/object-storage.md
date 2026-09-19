# Object storage

Clank exposes one small object contract for application files, release archives, and encrypted
backup envelopes. The framework includes an atomic local implementation and a zero-dependency
S3-compatible implementation. Local storage remains the development and single-host default; S3
compatibility is the portability boundary for independent compute nodes.

## Contract

```ts
import type { ObjectStore } from "@clank.run/framework/object-storage";

async function retainRelease(
  objects: ObjectStore,
  projectId: string,
  releaseId: string,
  bytes: Uint8Array,
) {
  return objects.put(
    `releases/${projectId}/${releaseId}.clank.gz`,
    bytes,
    { contentType: "application/vnd.clank.deploy+gzip" },
  );
}
```

`ObjectStore` has four operations:

| Operation | Result |
| --- | --- |
| `put(key, bytes, { contentType? })` | Immutable metadata for the completed replacement |
| `get(key)` | Verified metadata and a copied byte array, or `null` |
| `stat(key)` | Validated metadata without downloading the object, or `null` |
| `delete(key)` | Whether a current object was removed |

Metadata includes the logical key, size, SHA-256, normalized media type, creation time, and update
time. Logical keys use bounded portable segments; they are never interpolated as raw filesystem
paths or unsigned URLs. `put` snapshots a mutable input before returning.

The low-level contract deliberately buffers one bounded object. It is intended for release archives,
bounded encrypted-backup chunks, and storage adapters—not multi-gigabyte media ingest as one object.
Application code normally uses [managed buckets](buckets.md), which add owner isolation,
metadata listing, quotas, signed browser access, resumable chunks, public/private delivery, image
validation, declared variants, and MCP tools over this provider-neutral boundary.

## Atomic local storage

```ts
import { openLocalObjectStore } from "@clank.run/framework/object-storage";

const objects = await openLocalObjectStore({
  directory: ".data/objects",
  maxObjectBytes: 100 * 1024 * 1024,
});
```

Each object is stored as one owner-only envelope containing integrity metadata and bytes.
Updates write a new same-directory temporary file and replace the prior generation atomically.
Reads use a no-follow descriptor and compare the opened file with its current path, type, owner,
mode, and size. `get` then checks the exact byte length and SHA-256.

Local object storage is one-host durability. It does not protect against volume or region loss.

## S3-compatible storage

```ts
import { createS3ObjectStore } from "@clank.run/framework/object-storage";

const objects = createS3ObjectStore({
  endpoint: process.env.AWS_ENDPOINT_URL!,
  region: process.env.AWS_DEFAULT_REGION ?? "auto",
  bucket: process.env.AWS_S3_BUCKET_NAME!,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  prefix: "clank-production",
  maxObjectBytes: 100 * 1024 * 1024,
});
```

The adapter implements the portable `HEAD`, `GET`, `PUT`, and `DELETE` object subset through native
`fetch`. It works with virtual-hosted endpoints by default. Set `pathStyle: true` for a loopback
MinIO-compatible server or an older endpoint that requires bucket names in the URL path. Dotted
bucket names require path style so TLS hostname matching is unambiguous.

Every request:

- requires HTTPS except for explicit loopback development;
- refuses endpoint credentials, query strings, fragments, and redirects;
- uses AWS Signature Version 4 with the exact single-chunk SHA-256;
- signs the host, payload hash, date, session token, content type, and Clank integrity metadata;
- retries only the identical idempotent request after network, `429`, or `5xx` failures;
- applies a deadline across response-body consumption;
- bounds provider error bodies before discarding them; and
- returns stable public error codes without provider XML, bucket names, object keys, or credentials.

`get` does not treat an ETag as a content digest. It requires Clank's stored SHA-256, size, media
type, and timestamps, bounds the response independently, and hashes the bytes again. Objects
created outside Clank without that metadata fail closed.

The signing behavior follows the official [AWS Signature Version 4 single-chunk
contract](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html).
Railway Buckets expose S3-compatible credentials and virtual-hosted URLs; the
[Railway bucket reference](https://docs.railway.com/storage-buckets) documents its current variable
names and billing. Cloudflare publishes the supported subset for
[R2's S3 API](https://developers.cloudflare.com/r2/api/s3/api/). MinIO and other self-hosted
implementations can use the same contract.

## Control-plane release uploads

When authenticated remote deployment nodes are enabled, `clank-platform` retains every new
original upload so the exact leased release can be downloaded by its assigned node. Local
owner-only files remain the default. Select object storage explicitly:

```sh
export CLANK_RUNNER_COORDINATOR=1
export CLANK_RUNNER_ARTIFACT_STORE=s3
export CLANK_RUNNER_ARTIFACT_NAMESPACE=production-releases-v1
export CLANK_OBJECT_ENDPOINT=https://objects.example.com
export CLANK_OBJECT_REGION=auto
export CLANK_OBJECT_BUCKET=clank-releases
export CLANK_OBJECT_ACCESS_KEY_ID="$(your-secret-manager read object-access-key)"
export CLANK_OBJECT_SECRET_ACCESS_KEY="$(your-secret-manager read object-secret-key)"
export CLANK_OBJECT_PREFIX=installation-01
```

Standard `AWS_ENDPOINT_URL`, `AWS_DEFAULT_REGION`, `AWS_S3_BUCKET_NAME`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` variables are fallback names,
including Railway Bucket references. Explicit `CLANK_OBJECT_*` values take precedence.

Each release persists:

- the operator-selected repository namespace;
- an exact `runner-artifacts/<project>/<release>/<sha256>.clank.gz` key;
- the original byte length and SHA-256; and
- whether its runner copy is local or object-backed in the release API.

The platform checks the metadata returned by `put`, rehashes each leased `get`, and removes the
exact object during release cleanup and site deletion. A failed or ambiguous write is cleaned
before its quota reservation is released. A namespace or key mismatch refuses reads and deletion;
restore the original repository configuration rather than reusing an identity for a different
bucket. Existing local releases never move implicitly.

## Encrypted recovery backups

The framework and deployment platform can store completed encrypted recovery points through the
same object contract:

```ts
import { createS3ObjectStore } from "@clank.run/framework/object-storage";
import { openBackupManager } from "@clank.run/framework/recovery";

const store = createS3ObjectStore({
  endpoint: process.env.AWS_ENDPOINT_URL!,
  region: process.env.AWS_DEFAULT_REGION ?? "auto",
  bucket: process.env.AWS_S3_BUCKET_NAME!,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  maxObjectBytes: 32 * 1024 * 1024,
});

const backups = await openBackupManager({
  databasePath: "app.sqlite",
  repositoryDirectory: ".data/recovery",
  encryptionKey: process.env.BACKUP_KEY!,
  objects: {
    store,
    namespace: "production-recovery-v1",
    repositoryId: "orbit-tasks",
    chunkBytes: 8 * 1024 * 1024,
  },
});
```

The local directory remains an owner-only staging and compatibility area. The manager:

1. creates a consistent SQLite snapshot and AES-256-GCM envelope locally;
2. records an authenticated `uploading` catalog entry before uploading deterministic chunk keys;
3. verifies every returned key, size, media type, and SHA-256;
4. downloads, reassembles, decrypts, hashes, and runs SQLite `integrity_check` when verification is
   enabled;
5. publishes the catalog entry as `active`; and
6. removes the completed local copy only after the remote recovery point is usable.

A failed upload leaves the encrypted local copy available and retries its promotion before the next
new backup. Existing local backups are promoted the same way. Retention spans both locations while
that transition is in progress. Restore never trusts provider metadata alone: it checks the
catalog HMAC, per-chunk digest, AES-GCM tag, plaintext digest and length, then SQLite integrity.

The namespace is the durable identity of the physical repository. Do not reuse it for a different
bucket. `repositoryId` isolates one database's catalog and keys; the platform supplies its project
ID automatically. A prefix separates installations, but provider credentials and bucket policy
remain the authorization boundary.

For `clank-platform`, select the backend explicitly:

```sh
export CLANK_BACKUP_STORE=s3
export CLANK_BACKUP_NAMESPACE=production-recovery-v1
export CLANK_BACKUP_PREFIX=backups
export CLANK_BACKUP_CHUNK_BYTES=8388608
```

These settings use the same `CLANK_OBJECT_*` or fallback `AWS_*` connection variables shown above.
The control database binds the namespace and backup root on first use. Startup fails if either is
removed or changed, preventing a typo from presenting an empty backup history. Move or copy all
keys first and preserve the identity when intentionally changing provider credentials or
endpoints.

## Railway without surprise cost

Creating this adapter does not create a bucket. Provision one only when its failure-domain benefit
is worth the added resource:

```sh
railway bucket create
railway bucket credentials --bucket <name>
```

Use Railway variable references so credentials stay out of Git and local shell history. Give each
environment a separate bucket or at least a unique high-entropy prefix. Use an IAM/bucket policy
limited to the required bucket and prefix when the provider supports it.

As of July 2026, Railway documents bucket storage at `$0.015/GB-month`, with bucket egress and S3
operations included. Service-to-bucket traffic can still count as service egress, so monitor both
the bucket and service. The local adapter costs no additional managed resource and remains the
right default for development.

## Security and operations

- Keep access keys only in the control plane or trusted worker environment, never in application
  HTML, operation payloads, logs, or release archives.
- Use temporary credentials and `sessionToken` where the provider supports them.
- Separate production, preview, and test namespaces. A prefix is a routing boundary only when the
  provider policy also restricts credentials to it.
- Encrypt sensitive data before upload. Clank recovery backups are already AES-256-GCM envelopes;
  release archives intentionally exclude managed secrets and application databases.
- Alert on denied requests, repeated integrity failures, timeouts, and storage growth.
- Exercise restore and provider-outage drills. Remote existence is not proof that an object can be
  decrypted, verified, and used.

Runtime directories, live databases, and migration rollback snapshots remain local. New
remote-runner uploads and encrypted recovery backups can independently opt into the object
contract; both remain local by default. Provider-backed storage is not a substitute for control
database and key recovery.
