import { certifyLinuxHost, inspectLinuxHostCertification, requireCurrentLinuxHostCertification, type LinuxHostCertificationProfile } from '../src/host-certification.ts';
const profile: LinuxHostCertificationProfile = { mode: 'docker-isolated', image: 'node@sha256:abc', user: '1000:1000', diskQuota: { mountDirectory: '/disposable-xfs', hardBytes: 33554432, hardFiles: 64 }, outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '9.9.9.9' } };
const options = { directory: '/operator/certification', profile };
certifyLinuxHost({ ...options, disposable: true, quotaId: 1001 }).then(report => {
  const status: 'passed' | 'blocked' = report.status;
  const version: 'clank-linux-host-certification/1' = report.protocol;
  // @ts-expect-error reports are immutable
  report.expiresAt = 0;
  // @ts-expect-error checks are immutable
  report.checks.push({ capability: 'runner', status: 'passed', reason: 'verified' });
  return [status, version];
});
inspectLinuxHostCertification(options).then(result => result.current);
requireCurrentLinuxHostCertification(options).then(report => report.policyDigest);
// @ts-expect-error explicit disposable authorization is mandatory
certifyLinuxHost({ ...options, quotaId: 1 });
// @ts-expect-error no implicit trusted process fallback
certifyLinuxHost({ ...options, disposable: false, quotaId: 1 });
// @ts-expect-error no caller-supplied probe callbacks
certifyLinuxHost({ ...options, disposable: true, quotaId: 1, probe: () => true });
// @ts-expect-error quota IDs are numbers
certifyLinuxHost({ ...options, disposable: true, quotaId: '1' });
// @ts-expect-error unsupported profile mode
const processProfile: LinuxHostCertificationProfile = { ...profile, mode: 'process' };
// @ts-expect-error disk quota capabilities cannot be omitted
const missingQuota: LinuxHostCertificationProfile = { mode: 'docker-isolated', image: 'node', user: '1:1', outboundNetwork: { allowCidrs: [] }, networkProbe: { deniedAddress: '9.9.9.9' } };
// @ts-expect-error operators cannot configure arbitrary shell executables
const executable: LinuxHostCertificationProfile = { ...profile, executable: '/bin/true' };
