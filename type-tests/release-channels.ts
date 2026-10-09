import type {
  PlatformReleaseChannelEntry, PlatformReleaseChannel, PlatformChannelPinRequest,
  PlatformChannelActivationRequest, PlatformChannelRollbackRequest, PlatformChannelAction,
} from '@clank.run/framework/platform';

const entry: PlatformReleaseChannelEntry = { version: 1, sourceEnvironment: 'development', sourceProjectId: 'source_project', sourceReleaseId: 'source_release', digest: 'a'.repeat(64), createdAt: 100 };
const channel: PlatformReleaseChannel = { name: 'stable', version: 1, current: entry, updatedAt: 100 };
const retired: PlatformReleaseChannel = { ...channel, version: 2, current: null };
const pin: PlatformChannelPinRequest = { sourceEnvironment: entry.sourceEnvironment, releaseId: entry.sourceReleaseId, digest: entry.digest, expectedVersion: 0 };
const activation: PlatformChannelActivationRequest = { targetEnvironment: 'staging', expectedVersion: 2, expectedEnvironmentVersion: 1, expectedActiveReleaseId: null, idempotencyKey: 'exact_action_key_01' };
const rollback: PlatformChannelRollbackRequest = { ...activation, fromVersion: 1 };
const action: PlatformChannelAction = { name: channel.name, idempotencyKey: activation.idempotencyKey, kind: 'rollback', entryVersion: 1, appliedVersion: null, targetEnvironment: activation.targetEnvironment, targetReleaseId: null, state: 'recovery-required' };
// @ts-expect-error A channel entry cannot be rewritten.
entry.digest = 'b'.repeat(64);
// @ts-expect-error A current channel observation is immutable.
channel.version = 2;
// @ts-expect-error Preview projects cannot identify an environment source.
const preview: PlatformChannelPinRequest = { ...pin, sourceEnvironment: 'preview' };
// @ts-expect-error Explicit active-target state is required, including null.
const incomplete: PlatformChannelActivationRequest = { targetEnvironment: 'staging', expectedVersion: 1, expectedEnvironmentVersion: 1, idempotencyKey: 'exact_action_key_02' };
// @ts-expect-error Rollback must identify an immutable historical version.
const missingHistory: PlatformChannelRollbackRequest = activation;
// @ts-expect-error An action receipt cannot invent an accepted state.
const invalidState: PlatformChannelAction = { ...action, state: 'success' };
void [retired, rollback, preview, incomplete, missingHistory, invalidState];
