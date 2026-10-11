import { openPlatform, type ManagedCanaryOptions } from "@clank.run/framework";
const canary: ManagedCanaryOptions = {
  stages: [{ trafficPercent: 100, durationMs: 1000, minimumSamples: 100 }],
  maximumErrorRate: 0.01, maximumP95Ms: 100,
  provider: { databasePolicy: "isolated-read-only", readPaths: ["/", "/healthz"] },
};
void openPlatform({ dataDirectory: "/private/platform", publicUrl: "https://control.example.test", canary });
// @ts-expect-error The provider isolation policy is explicit and cannot promote candidate data.
const unsafe: ManagedCanaryOptions = { ...canary, provider: { databasePolicy: "promote-snapshot", readPaths: ["/"] } };
// @ts-expect-error Public paths are required for provider measurement.
const unbounded: ManagedCanaryOptions = { ...canary, provider: { databasePolicy: "isolated-read-only" } };
void unsafe; void unbounded;
