# Durable media processing

Queue declared file and image transforms through Clank's native job system. Publish a result only while its source generation, worker attempt and current authorization still match.

`openMediaProcessing` connects durable jobs to managed buckets with a retained publication receipt. An application can enqueue a thumbnail, inspect progress, cancel it, and recover after a worker crash without silently publishing bytes from an older upload. Install no extra framework dependencies: the transform adapter belongs to your server application.

## Open one processing catalog

Use one persistent SQLite catalog for processing jobs, authentication, bucket metadata and publication receipts. Create the native `AuthRuntime` on the exact `SQLiteDatabase` passed to the service. Give `openBucketManager` that same absolute catalog path. Both services use SQLite's normal locking and full synchronous commits.

```ts
import { defineAuth, defineDatabase, openAuth, openSQLite } from "@clank.run/framework";
import { defineBucket, openBucketManager } from "@clank.run/framework/buckets";
import { openLocalObjectStore } from "@clank.run/framework/object-storage";
import { openMediaProcessing } from "@clank.run/framework/media-processing";

const catalogPath = "/srv/app/media/catalog.sqlite";
const database = await openSQLite(defineDatabase({}), { path: catalogPath });
const auth = await openAuth(defineAuth(), database);
const files = defineBucket({
  name: "media", ownership: "user", allowedContentTypes: ["text/plain"],
  maxObjectBytes: 1024 * 1024, maxBytes: 64 * 1024 * 1024,
});
const buckets = await openBucketManager({
  definitions: [files], databasePath: catalogPath,
  stagingDirectory: "/srv/app/media/staging",
  signingKey: process.env.MEDIA_BUCKET_SIGNING_KEY!,
  store: await openLocalObjectStore({ directory: "/srv/app/media/objects" }),
});
const processing = await openMediaProcessing({
  database, auth, buckets, policyRevision: 1,
  authorize(caller) { caller.requireRole("user"); },
  transforms: [{
    name: "uppercase", revision: "1", sourceBucket: "media", destinationBucket: "media",
    maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024,
    handler({ source, signal, progress }) {
      signal.throwIfAborted();
      progress(20);
      const text = new TextDecoder().decode(source.bytes).toUpperCase();
      return { bytes: new TextEncoder().encode(text), contentType: "text/plain" };
    },
  }],
});
```

The example performs a real bounded text transform. An image adapter can use your approved codec or media provider, the image bucket's declared variant specification, and the same handler contract. Clank validates bucket image signatures, dimensions and media policy when publishing; it does not bundle an image decoder or certify a provider's visual output.

The service rejects memory databases, unrelated authentication stores, alternate catalog aliases and hard links. Use a dedicated catalog with normal filesystem locking. The bucket connection writes its own metadata and receipts; attaching point-in-time capture to a separate application connection does not capture those writes. Coordinate backup of this catalog and its object namespace using the storage provider's supported procedure.

## Enqueue with current request authority

Resolve the incoming request through the configured `AuthRuntime`. Supply that server request authority, a declared transform, an exact operation ID, an original source key and a separate destination key.

```ts
const caller = await auth.resolve(request);
const queued = processing.enqueue(caller, {
  operationId: "file-preview-2026-01",
  transform: "uppercase", sourceKey: "original.txt", destinationKey: "preview.txt",
});
const current = processing.get(caller, queued.id);
```

Your HTTP handler must apply the normal CSRF and origin checks before enqueue or cancellation. Do not expose arbitrary session IDs as a way to obtain `AuthRequest`. Serialized `AuthState` and copied runtime objects do not supply native authentication capabilities.

The service refreshes the actual session and enabled user at admission, reads, cancellation, transform execution, progress and publication. The synchronous `authorize` hook must check current application roles, membership and security policy and return `undefined` on success. Returning a promise or another value refuses the operation. All compatible workers must use the same hook and policy revision.

User buckets retain the originating owner's namespace. App-owned buckets require an application-specific authorization hook for shared files. Source and destination must use compatible ownership, and a private source cannot publish into a public bucket. A transform cannot overwrite its original key in the same bucket.

## Freeze each generation

Admission captures an opaque source generation and the destination's exact current generation or absence. It also retains the originating session, transform revision, processing policy, job identity and operation fingerprint. Replacing a file with identical bytes still creates a different generation. Deleting, replacing and restoring the original digest cannot reactivate an earlier transform.

Original bytes are copied and checked against their native metadata and actual SHA-256 before the adapter runs. The service checks the source again after reads and asynchronous callbacks. Publication checks the current source, destination, cancellation flag and exact worker lease under the catalog's SQLite write lock. The metadata change and receipt commit together.

The existing immediate bucket `transform` method also checks its original source generation at publication and keeps the invocation's owner and abort signal. A slow immediate transform can no longer overwrite a variant using an upload that was replaced during its callback.

## Run compatible workers and inspect progress

```ts
const worker = processing.startWorker({
  workerId: "media-worker-1", concurrency: 2, leaseMs: 30_000,
});
const status = processing.get(caller, queued.id);
processing.cancel(caller, queued.id);
await worker.stop();
processing.close();
```

Processing reserves the `clank-media` queue and `media.run` job name. Its workers always select that queue. Other job runtimes sharing the catalog must select their own queues and must not claim media jobs using missing or incompatible definitions. Two compatible processes contend through the existing native job leases, rather than a second queue implementation.

Progress is a monotonic integer from 0 to 100, with at most 100 persisted updates by default. Inspect the job attempt, progress, creation time and expiry through the owner-scoped status. Successful publication appears as `published` even during the short interval before its job settles. A committed publication cannot be retroactively cancelled.

`outputCurrent` becomes false and `object` becomes null when the source or accepted destination is replaced, or its processing policy retires. An exact enqueue retry then refuses to publish over the newer generation. A receipt acknowledges accepted publication; it does not turn historical bytes into the current file.

## Recover provider calls and process death

Every attempt receives the same `operationKey`. An external provider must durably deduplicate that key with the exact request fingerprint. Persist it at the provider's acceptance boundary. A dropped HTTP response or crash before publication may require another provider request; that request must return the same accepted result rather than repeat an external side effect.

Provider calls and object writes happen outside the SQLite transaction. Object bytes stage under a unique storage generation. If current authority or a generation changes during an asynchronous object write, publication is refused and the staged bytes enter normal garbage collection. This is not a distributed transaction with the provider.

If a process dies after metadata and receipt commit but before job settlement, the normal job lease expires and retry backoff applies. A compatible attempt checks the receipt and current generations, then settles the job without invoking the transform again. Original session revocation, expiry or changed policy still refuses retry authority.

## Bounds, revisions and rollback

Declare input and output byte budgets; both are limited by their bucket policy and an absolute 100 MiB ceiling. Defaults are three attempts, a 30-second attempt timeout, 1,000 retained operations and a 24-hour receipt lifetime. Configurable ceilings are ten attempts, one hour per attempt, 100,000 operations, 1,000 progress updates and seven days of retry authority.

At capacity, admission refuses new work instead of evicting retained identities. Expired operation IDs remain tombstones and cannot become fresh work. This initial protocol does not automatically purge or recycle operation identities. Plan catalog lifecycle and explicit offline archival before reaching the configured limit; increasing capacity is a policy change.

Increase `policyRevision` when configuration, authorization behavior or provider policy changes. Change each transform's revision for changed codec settings or provider semantics. The fingerprint also includes declared bucket policy and implementation text; closed-over settings and provider behavior still require explicit revisions. Old controllers and in-flight attempts cannot publish after the persisted revision changes. Unknown native protocols refuse startup and live operations.

Roll back with a compatible worker that understands retained state, or disable new admission while keeping current enforcement for retained jobs. Do not expect an older binary to enforce newly introduced fences. Close processing workers before shared auth, buckets and database resources. Keep old receipts and operation records until their lifecycle is explicitly handled.
