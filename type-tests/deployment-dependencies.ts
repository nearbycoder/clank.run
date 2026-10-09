import type { PlatformDependencyRequirement, PlatformDependencyConfiguration, PlatformDependencyUpdate, PlatformDependencyOverride, PlatformDependencyCheck, PlatformRollbackRequest, PlatformPromotionRequest, PlatformChannelActivationRequest } from '../src/platform.ts';
const requirement: PlatformDependencyRequirement = { projectId: 'managed_service_01', readiness: 'healthy', digest: 'a'.repeat(64) };
const configuration: PlatformDependencyConfiguration = { version: 1, requirements: [requirement], timeoutMs: 5000, overridePolicy: 'deny', updatedAt: 1 };
const update: PlatformDependencyUpdate = { expectedVersion: configuration.version, requirements: [], timeoutMs: 1000, overridePolicy: 'administrator' };
const override: PlatformDependencyOverride = { expectedVersion: 1, reason: 'Approved maintenance', confirmation: 'override-dependencies staging 1' };
const rollback: PlatformRollbackRequest = { releaseId: 'release_01', idempotencyKey: 'rollback_request_01', expectedActiveReleaseId: 'current_release_01', expectedActivationSequence: 2, dependencyOverride: override, expectedDependencyVersion: configuration.version, dependencyCheckId: 'check_review_01' };
const promotion: PlatformPromotionRequest = { sourceEnvironment: 'development', releaseId: 'release_01', digest: 'a'.repeat(64), expectedVersion: 1, expectedActiveReleaseId: null, idempotencyKey: 'promotion_request_01', dependencyOverride: override, expectedDependencyVersion: configuration.version, dependencyCheckId: 'check_review_01' };
const channel: PlatformChannelActivationRequest = { targetEnvironment: 'staging', expectedVersion: 1, expectedEnvironmentVersion: 1, expectedActiveReleaseId: null, idempotencyKey: 'channel_request_01', dependencyOverride: override, expectedDependencyVersion: configuration.version, dependencyCheckId: 'check_review_01' };
void [update, rollback, promotion, channel];
// @ts-expect-error external readiness URLs are not a managed dependency requirement
const external: PlatformDependencyRequirement = { projectId: 'managed_service_01', readiness: 'healthy', url: 'https://example.test/health' };
// @ts-expect-error readiness names are explicit
const arbitrary: PlatformDependencyRequirement = { projectId: 'managed_service_01', readiness: 'run-script' };
// @ts-expect-error administrator override policy is opt-in and explicit
const policy: PlatformDependencyUpdate = { expectedVersion: 1, requirements: [], timeoutMs: 1000, overridePolicy: 'always' };
// @ts-expect-error configurations are immutable consumer results
configuration.version = 2;
// @ts-expect-error retained requirement arrays cannot be mutated
configuration.requirements.push(requirement);
declare const check: PlatformDependencyCheck;
// @ts-expect-error observations are immutable consumer results
check.observations[0]!.ready = true;
// @ts-expect-error overrides need the captured version
const incomplete: PlatformDependencyOverride = { reason: 'Approved maintenance', confirmation: 'override-dependencies staging 1' };
void [external, arbitrary, policy, incomplete];

// @ts-expect-error retained check IDs are strings
const invalidCheck: PlatformRollbackRequest = { releaseId: 'release_01', dependencyCheckId: 1 };
// @ts-expect-error consumers cannot replace a retained review ID
check.id = 'another_check_01';
void invalidCheck;
