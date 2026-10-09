import type { PlatformReleaseWindowRequest, PlatformReleaseWindow, PlatformReleaseWindowCancelRequest, PlatformReleaseWindowRecoveryRequest, ClankPlatformOptions } from '../src/platform.ts';
const request: PlatformReleaseWindowRequest = { channel: 'stable', targetEnvironment: 'staging', expectedVersion: 1, expectedEnvironmentVersion: 1, expectedActiveReleaseId: null, expectedDependencyVersion: 0, idempotencyKey: 'scheduled_exact_request_01', startsAt: '2026-11-01T01:30:00-05:00', expiresAt: '2026-11-01T01:45:00-05:00', timeZone: 'America/Chicago' };
const cancel: PlatformReleaseWindowCancelRequest = { expectedVersion: 1 };
const recovery: PlatformReleaseWindowRecoveryRequest = { expectedVersion: 2, confirmation: 'recover-release-window project window_id' };
const options: ClankPlatformOptions = { dataDirectory: '/tmp/owned-platform', publicUrl: 'http://127.0.0.1:4200', releaseWindows: { intervalMs: false } };
declare const result: PlatformReleaseWindow;
const state: 'pending' | 'running' | 'cancelling' | 'accepted' | 'failed' | 'cancelled' | 'expired' | 'recovery-required' = result.state;
// @ts-expect-error scheduling does not approve a readiness override
const override: PlatformReleaseWindowRequest = { ...request, dependencyOverride: { expectedVersion: 1, reason: 'override', confirmation: 'override' } };
// @ts-expect-error scheduling never stores a queue-time health approval
const expiredCheck: PlatformReleaseWindowRequest = { ...request, dependencyCheckId: 'check_old_01' };
// @ts-expect-error the reviewed dependency version is required
const incomplete: PlatformReleaseWindowRequest = { channel: 'stable', targetEnvironment: 'staging', expectedVersion: 1, expectedEnvironmentVersion: 1, expectedActiveReleaseId: null, idempotencyKey: 'scheduled_request_01', startsAt: '2026-11-01T06:30:00Z', expiresAt: '2026-11-01T06:45:00Z', timeZone: 'UTC' };
// @ts-expect-error schedule results are immutable
result.targetReleaseId = 'changed';
// @ts-expect-error private credential references are not public results
result.sessionId;
// @ts-expect-error cancellation needs the exact version
const unfenced: PlatformReleaseWindowCancelRequest = {};
void [request, cancel, recovery, options, state, override, expiredCheck, incomplete, unfenced];
