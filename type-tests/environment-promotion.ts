import type {
  PlatformEnvironmentName, PlatformEnvironmentMigrationPolicy, PlatformEnvironment,
  PlatformEnvironmentBindingRequest, PlatformPromotionRequest, PlatformPromotion, ClankPlatformOptions,
} from '@clank.run/framework/platform';
const name: PlatformEnvironmentName = 'production';
const policy: PlatformEnvironmentMigrationPolicy = 'code-only';
const binding: PlatformEnvironmentBindingRequest = { projectId: 'target_project', expectedVersion: 0, migrationPolicy: policy };
const environment: PlatformEnvironment = { name, projectId: binding.projectId, version: 1, migrationPolicy: policy, updatedAt: 100 };
const request: PlatformPromotionRequest = { sourceEnvironment: 'staging', releaseId: 'source_release', digest: 'a'.repeat(64), expectedVersion: environment.version, expectedActiveReleaseId: null, idempotencyKey: 'exact_request_key' };
const receipt: PlatformPromotion = { ...request, sourceProjectId: 'source_project', sourceReleaseId: request.releaseId, targetEnvironment: name, targetProjectId: binding.projectId, environmentVersion: environment.version, targetReleaseId: null, state: 'recovery-required', createdAt: 100, updatedAt: 101 };
// @ts-expect-error Previews never identify a persistent environment.
const invalidName: PlatformEnvironmentName = 'preview';
// @ts-expect-error Unsafe SQL cannot be an environment migration policy.
const unsafe: PlatformEnvironmentMigrationPolicy = 'allow-unsafe';
// @ts-expect-error An active-release expectation must be explicit, including null.
const incomplete: PlatformPromotionRequest = { sourceEnvironment: 'development', releaseId: 'source_release', digest: request.digest, expectedVersion: 1, idempotencyKey: 'missing_expectation' };
// @ts-expect-error Receipts are immutable observations.
receipt.state = 'accepted';
// @ts-expect-error Ambiguous activation is a recovery requirement, never success.
const pendingState: PlatformPromotion['state'] = 'success';
void [invalidName, unsafe, incomplete, pendingState, receipt];
const providerHosts: ClankPlatformOptions['providerPromotionHosts'] = {
  certified_node: { directory: '/operator/certificates/node', profile: {
    mode: 'docker-isolated', image: 'node@sha256:' + 'a'.repeat(64), user: '1000:1000',
    diskQuota: { mountDirectory: '/disposable-xfs', hardBytes: 32 * 1024 * 1024, hardFiles: 64 },
    outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '9.9.9.9' },
  } },
};
// @ts-expect-error A node label cannot substitute for an operator-owned host certificate.
const fakeHost: ClankPlatformOptions['providerPromotionHosts'] = { node: true };
void [providerHosts, fakeHost];
