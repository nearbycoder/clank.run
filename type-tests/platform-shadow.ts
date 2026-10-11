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
