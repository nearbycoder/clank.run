import { parseLocalProviderFleetScenario, exportLocalProviderFleetScenario, runLocalProviderFleetScenario, type LocalProviderFleetOptions, type LocalProviderFleetScenario } from '../src/fleet-simulator.ts';
import type { LinuxHostCertificationProfile } from '../src/host-certification.ts';
const profile: LinuxHostCertificationProfile = { mode: 'docker-isolated', image: 'node@sha256:abc', user: '1000:1000', diskQuota: { mountDirectory: '/disposable-xfs', hardBytes: 33554432, hardFiles: 64 }, outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '9.9.9.9' } };
const scenario: LocalProviderFleetScenario = { protocol: 'clank-fleet-scenario/1', kind: 'takeover' };
const options: LocalProviderFleetOptions = { certificate: { directory: '/operator/certification', profile }, scenario, disposable: true, quotaIds: [1, 2], portStart: 47000 };
exportLocalProviderFleetScenario(scenario);
const normalized = parseLocalProviderFleetScenario(scenario);
const delay: number = normalized.transportDelayMs;
// @ts-expect-error normalized scenarios are immutable
normalized.kind = 'lease-loss';
runLocalProviderFleetScenario(options).then(report => {
  const version: 'clank-fleet-report/1' = report.protocol;
  const status: 'passed' | 'blocked' = report.status;
  const artifact: string | null = report.artifactSha256;
  // @ts-expect-error reports cannot become a write channel
  report.timeline.push({ sequence: 1, elapsedMs: 0, node: 'fleet', event: 'fault' });
  // @ts-expect-error checks are immutable
  report.checks[0].status = 'passed';
  return [version, status, artifact, delay];
});
// @ts-expect-error explicit disposable permission is mandatory
runLocalProviderFleetScenario({ certificate: options.certificate, scenario, quotaIds: [1, 2], portStart: 47000 });
// @ts-expect-error no implicit ordinary-host mutation
runLocalProviderFleetScenario({ ...options, disposable: false });
// @ts-expect-error exactly two reserved IDs
runLocalProviderFleetScenario({ ...options, quotaIds: [1] });
// @ts-expect-error identifiers are numeric
runLocalProviderFleetScenario({ ...options, quotaIds: ['1', 2] });
// @ts-expect-error no executable injection
runLocalProviderFleetScenario({ ...options, executable: '/bin/true' });
// @ts-expect-error no arbitrary drill callbacks
const callback: LocalProviderFleetScenario = { ...scenario, execute: () => true };
// @ts-expect-error scenarios contain no credentials
const secret: LocalProviderFleetScenario = { ...scenario, token: 'private' };
// @ts-expect-error unsupported fault
const invalid: LocalProviderFleetScenario = { ...scenario, kind: 'delete-production' };
