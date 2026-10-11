import { createPointInTimeRecoveryProvider, exportPointInTimeRecovery, restorePointInTimeArchive, type PointInTimeRecovery, type PointInTimeArchive, type PointInTimeProviderBinding } from "@clank.run/framework";
import { openPlatform, restoreSQLiteBackup, type ClankPlatformOptions } from "@clank.run/framework";
declare const recovery: PointInTimeRecovery;
declare const archive: PointInTimeArchive;
const binding: PointInTimeProviderBinding = { projectId: "project", nodeId: "node", releaseId: "release", generation: 1 };
exportPointInTimeRecovery(recovery, { operationId: "checkpoint_1", maxArchiveBytes: 1024 * 1024, maxEntries: 100, binding });
createPointInTimeRecoveryProvider(recovery, { binding, token: "private-provider-control-token", assertCurrent() {} });
restorePointInTimeArchive(archive, { encryptionKey: new Uint8Array(32), targetPath: "/private/stopped.sqlite", confirmation: "restore point in time", throughSequence: 2, expectedEpoch: archive.epoch, expectedSequence: archive.sequence, expectedDigest: archive.digest, expectedBinding: binding });
restorePointInTimeArchive(archive, { encryptionKey: new Uint8Array(32), targetPath: "/private/stopped.sqlite", confirmation: "restore point in time", throughSequence: 2, expectedEpoch: archive.epoch, expectedSequence: archive.sequence, expectedDigest: archive.digest, maxDurationMs:30000,assertCurrent(){} });
restoreSQLiteBackup("/private/verified.sqlite","/private/stopped.sqlite",()=>{});
// @ts-expect-error The overall recovery budget must remain numeric.
restorePointInTimeArchive(archive, { encryptionKey: new Uint8Array(32), targetPath: "/private/stopped.sqlite", confirmation: "restore point in time", throughSequence: 2, expectedEpoch: archive.epoch, expectedSequence: archive.sequence, expectedDigest: archive.digest, maxDurationMs:"forever" });
// @ts-expect-error Publication authority must be a trusted callback.
restoreSQLiteBackup("/private/verified.sqlite","/private/stopped.sqlite","owner");
// @ts-expect-error The retained horizon cannot be inferred from an untrusted archive alone.
restorePointInTimeArchive(archive, { encryptionKey: new Uint8Array(32), targetPath: "/private/stopped.sqlite", confirmation: "restore point in time", throughSequence: 2 });
// @ts-expect-error Public archive metadata is immutable.
archive.sequence = 0;
// @ts-expect-error Provider binding is immutable.
binding.generation = 0;
// @ts-expect-error Captured key material is bytes, not a client-provided text label.
restorePointInTimeArchive(archive, { encryptionKey: "secret", targetPath: "/private/stopped.sqlite", confirmation: "restore point in time", throughSequence: 2, expectedEpoch: archive.epoch, expectedSequence: archive.sequence, expectedDigest: archive.digest });
// @ts-expect-error Provider ownership checks are required.
createPointInTimeRecoveryProvider(recovery, { binding, token: "private-provider-control-token" });
// @ts-expect-error Archive bounds cannot be arbitrary strings.
exportPointInTimeRecovery(recovery, { maxEntries: "unbounded" });
const registeredSource = async () => ({binding, origin:"https://provider.example.test", token:"private_provider_credential_0123456789", encryptionKey:new Uint8Array(32), assertCurrent(){}});
const platformOptions:ClankPlatformOptions = {dataDirectory:"/private/platform",publicUrl:"https://console.example.test",pointInTime:{source:registeredSource,restoreKey:async(project,checkpoint)=>{const projectId:string=checkpoint.binding.projectId;return new Uint8Array(32);},maxArchiveBytes:1024*1024,maxArchivesPerProject:20}};
openPlatform(platformOptions);
// @ts-expect-error Operator checkpoint capacity must remain numeric.
openPlatform({dataDirectory:"/private/platform",publicUrl:"https://console.example.test",pointInTime:{source:registeredSource,maxArchiveBytes:"unbounded"}});
// @ts-expect-error Source resolution must provide a current ownership assertion and real key bytes.
openPlatform({dataDirectory:"/private/platform",publicUrl:"https://console.example.test",pointInTime:{source:async()=>({binding,origin:"https://provider.example.test",token:"private_provider_credential_0123456789"})}});
// @ts-expect-error Independent checkpoint key resolution must return real bytes.
openPlatform({dataDirectory:"/private/platform",publicUrl:"https://console.example.test",pointInTime:{source:registeredSource,restoreKey:async()=>"key-label"}});
