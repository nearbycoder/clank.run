import { defineBucket, createBucketClient, openBucketManager, type BucketVersion, type BucketRestoreOptions } from "../src/buckets.ts";
import { type AppBucketDefinition } from "../src/blueprint.ts";

const policy = { maxAgeMs: 60000, maxPerObject: 5, maxVersions: 20, maxBytes: 100000, perOwnerMaxBytes: 50000 };
const files = defineBucket({ name: "files", versions: policy });
const client = createBucketClient("files");
void client.listVersions("notes");
void client.createVersionReadIntent("notes", "version-id", 60000);
void client.restoreVersion("notes", "version-id", { operationId: "one", ifSha256: null });
// @ts-expect-error Restore requires an expected current digest or expected absence.
void client.restoreVersion("notes", "version-id", { operationId: "one" });
// @ts-expect-error Browser callers cannot select another owner.
void client.restoreVersion("notes", "version-id", { operationId: "one", ifSha256: null, userId: "other" });
// @ts-expect-error A replay-safe operation ID is mandatory.
const invalid: BucketRestoreOptions = { ifSha256: "digest" };
// @ts-expect-error All retention dimensions are required.
defineBucket({ name: "files", versions: { maxAgeMs: 60000 } });
declare const generation: BucketVersion;
generation.sha256 satisfies string;
generation.expiresAt satisfies number;
// @ts-expect-error Retained history exposes no permanent public URL.
generation.url;
// @ts-expect-error Generation metadata is immutable.
generation.id = "different";
void invalid;
void openBucketManager;
const appBucket: AppBucketDefinition = { versions: policy };
void appBucket;
void files;
