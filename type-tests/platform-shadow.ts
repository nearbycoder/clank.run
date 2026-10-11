import type { ClankPlatformOptions } from '../src/platform.ts';

const shadowTraffic: NonNullable<ClankPlatformOptions['shadowTraffic']> = {
  revision: 1, readPaths: ['/', '/healthz'], methods: ['GET', 'HEAD'], maxSamplePercent: 0.01,
  maxDurationMs: 30_000, maxAttempts: 10, maxConcurrent: 2, maxResponseBytes: 1024,
  maxRequestMs: 1000, maxReports: 2,
};
const configured: Pick<ClankPlatformOptions, 'shadowTraffic'> = { shadowTraffic };
// @ts-expect-error Observation policy permits only anonymous read methods.
const write: typeof shadowTraffic = { ...shadowTraffic, methods: ['POST'] };
// @ts-expect-error Platform policy uses the explicit shadowTraffic option, without an alias.
const alias: Pick<ClankPlatformOptions, 'shadowTraffic'> = { shadow: shadowTraffic };
// @ts-expect-error A platform maximum is required; session limits cannot implicitly enable it.
const missing: typeof shadowTraffic = { revision: 1, readPaths: ['/'], methods: ['GET'] };
void [configured, write, alias, missing];

import type { PlatformShadowSession, PlatformShadowPreview, PlatformShadowResponse } from '../src/platform.ts';
declare const response: PlatformShadowResponse;
const receipt: PlatformShadowSession = response.session;
const localElapsed: number | null = receipt.snapshot?.elapsedSinceObservationMs ?? null;
declare const preview: PlatformShadowPreview;
const primary: number = preview.review.primary.generation;
// @ts-expect-error Safe shadow receipts contain no provider route credential.
const secret = receipt.token;
// @ts-expect-error The protocol does not claim cross-host wall-clock freshness.
const crossHost: 'verified' = receipt.snapshot!.crossHostFreshness;
// @ts-expect-error The public stop uses a retained original integer epoch, never a string timestamp.
const epoch: string = receipt.controllerEpoch;
void [localElapsed, primary, secret, crossHost, epoch];

if(receipt.report?.protocol===2){
  const skips:number=receipt.report.skips['handoff-timeout'];
  // @ts-expect-error Skip vocabulary is closed, never a persisted arbitrary map.
  const unknown=receipt.report.skips['tenant-secret'];
  void [skips,unknown];
}else if(receipt.report){
  // @ts-expect-error Historical reports have no fabricated version-two skips.
  const fabricated:number=receipt.report.skips.ineligible;
  void fabricated;
}
// @ts-expect-error Only legacy absent version and explicit protocol2 are valid report formats.
const future:NonNullable<PlatformShadowSession['report']>={protocol:3,counters:receipt.report!.counters,latency:receipt.report!.latency};
void future;
