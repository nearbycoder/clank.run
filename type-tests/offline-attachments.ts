import { openOfflineAttachmentQueue, mountOfflineAttachmentQueue, resolveBucketAttachment, createBucketClient, createSyncClient,
  type FunctionReference, type MutationContext, type QueryContext, type BucketAttachmentReference, type OfflineAttachmentQueue } from "@clank.run/framework";
declare const queue: OfflineAttachmentQueue;
declare const attach: FunctionReference<"mutation", {id:string;attachment:BucketAttachmentReference}, string>;
declare const ordinary: FunctionReference<"mutation", {id:string}, string>;
declare const query: FunctionReference<"query", {id:string;attachment:BucketAttachmentReference}, string>;
declare const context: MutationContext<any>;
declare const queryContext: QueryContext<any>;
const attachment: BucketAttachmentReference = {bucket:"files",key:"offline-example",objectId:"object",generation:"generation",sha256:"a".repeat(64)};
queue.enqueue(attach,{id:"record"},new Blob(["content"],{type:"text/plain"}));
queue.retry("receipt");queue.discard("receipt");queue.snapshot();queue.flush();queue.dispose();
resolveBucketAttachment(context,attachment);
const bucket=createBucketClient("files");
bucket.upload({key:"offline-example",value:new Blob(["content"]),ifSha256:null,expectedSha256:attachment.sha256,signal:new AbortController().signal,assertCurrent(){}});
const client=createSyncClient();client.mutateOnce(attach,{id:"record",attachment},{key:"receipt",userId:"account",signal:new AbortController().signal});
openOfflineAttachmentQueue({namespace:"app",userId:"account",bucketName:"files",bucket,client,currentUser:()=>"account",maxBlobBytes:1024,maxTotalBytes:4096});
mountOfflineAttachmentQueue(document.body,queue);
// @ts-expect-error Only an attachment mutation is eligible for binary replay.
queue.enqueue(ordinary,{id:"record"},new Blob());
// @ts-expect-error Queries cannot attach records.
queue.enqueue(query,{id:"record"},new Blob());
// @ts-expect-error References are produced after upload; input cannot substitute one.
queue.enqueue(attach,{id:"record",attachment},new Blob());
// @ts-expect-error Binary persistence requires an immutable Blob.
queue.enqueue(attach,{id:"record"},"content");
// @ts-expect-error The exact opaque generation is required.
resolveBucketAttachment(context,{bucket:"files",key:"key",objectId:"object",sha256:attachment.sha256});
// @ts-expect-error No mutation capability exists in a query context.
resolveBucketAttachment(queryContext,attachment);
