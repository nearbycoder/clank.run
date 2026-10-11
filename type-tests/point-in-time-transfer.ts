import {exportPointInTimeTransfer,stagePointInTimeTransfer,type PointInTimeRecovery,type PointInTimeArchive,type PointInTimeTransferIdentity,type PointInTimeTransferBatch,type PointInTimeTransferCursor} from "@clank.run/framework";
import {applyPointInTimeTransfer} from "@clank.run/framework/point-in-time";
declare const recovery:PointInTimeRecovery,archive:PointInTimeArchive,batch:PointInTimeTransferBatch;
const identity:PointInTimeTransferIdentity={handoffId:"handoff",source:{projectId:"project",nodeId:"source",releaseId:"release",generation:1},targetNodeId:"target",targetGeneration:2,artifactSha256:"a".repeat(64)};
const cursor:PointInTimeTransferCursor={epoch:archive.epoch,sequence:archive.sequence,digest:archive.digest};
const authority={assertSourceCurrent(){},assertTargetCurrent(){}};
const options={...authority,identity,encryptionKey:new Uint8Array(32),targetPath:"/private/stopped.sqlite"};
exportPointInTimeTransfer(recovery,{identity,after:cursor,throughSequence:10,maxEntries:100,maxBatchBytes:65536});
stagePointInTimeTransfer(archive,{...options,expectedEpoch:cursor.epoch,expectedSequence:cursor.sequence,expectedDigest:cursor.digest});
applyPointInTimeTransfer(batch,{...options,expectedCursor:cursor}).then(result=>{const replayed:boolean=result.replayed;const accepted:PointInTimeTransferCursor=result.cursor;});
// @ts-expect-error Transfer identity is immutable.
identity.artifactSha256="changed";
// @ts-expect-error The predecessor must be independently supplied.
applyPointInTimeTransfer(batch,options);
// @ts-expect-error Both current ownership assertions are required.
stagePointInTimeTransfer(archive,{identity,encryptionKey:new Uint8Array(32),targetPath:"/stopped.sqlite",expectedEpoch:cursor.epoch,expectedSequence:0,expectedDigest:cursor.digest,assertSourceCurrent(){}});
// @ts-expect-error Numeric provider generation is metadata, not an ownership capability.
applyPointInTimeTransfer(batch,{...options,expectedCursor:cursor,assertTargetCurrent:2});
// @ts-expect-error Fixed range export requires an explicit committed end.
exportPointInTimeTransfer(recovery,{identity,after:cursor});
// @ts-expect-error Batch entries cannot be rewritten by typed consumers.
batch.envelopes.push("changed");
