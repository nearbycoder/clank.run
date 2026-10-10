import { createPointInTimeRecoveryProvider, exportPointInTimeRecovery, restorePointInTimeArchive, type PointInTimeRecovery, type PointInTimeArchive, type PointInTimeProviderBinding } from "@clank.run/framework";
declare const recovery: PointInTimeRecovery;
declare const archive: PointInTimeArchive;
const binding: PointInTimeProviderBinding = { projectId: "project", nodeId: "node", releaseId: "release", generation: 1 };
exportPointInTimeRecovery(recovery, { operationId: "checkpoint_1", maxArchiveBytes: 1024 * 1024, maxEntries: 100, binding });
createPointInTimeRecoveryProvider(recovery, { binding, token: "private-provider-control-token", assertCurrent() {} });
restorePointInTimeArchive(archive, { encryptionKey: new Uint8Array(32), targetPath: "/private/stopped.sqlite", confirmation: "restore point in time", throughSequence: 2, expectedEpoch: archive.epoch, expectedSequence: archive.sequence, expectedDigest: archive.digest, expectedBinding: binding });
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
