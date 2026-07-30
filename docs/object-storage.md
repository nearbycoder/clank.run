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

The current contract deliberately buffers one bounded object. It is intended for release archives,
backup envelopes, and ordinary application files up to 1 GiB—not multi-gigabyte media ingest.
Multipart upload, public bucket administration, CDN policy, browser presigning, and lifecycle rules
remain explicit provider integrations.

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

This phase provides and verifies the storage adapters. The control plane continues to use its local
release and backup repositories until the corresponding platform options are configured in the
next incremental storage phases.
