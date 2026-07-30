#!/usr/bin/env node
import { access, rename } from "node:fs/promises";
import { openPlatform } from "../dist/platform.js";
import { serve } from "../dist/node.js";
import { createS3ObjectStore } from "../dist/object-storage.js";
import {
  resolveBackupStorage,
  resolvePlatformHosting,
  resolveProviderPlacement,
  resolveRunnerArtifactStorage,
} from "./platform-hosting.mjs";

process.umask(0o077);

const port = number(process.env.PORT, 4200);
const hostname = process.env.HOST ?? "127.0.0.1";
const publicUrl = environment("CLANK_PLATFORM_URL", "PROACT_PLATFORM_URL")
  ?? `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`;
const dataDirectory = environment("CLANK_PLATFORM_DATA", "PROACT_PLATFORM_DATA")
  ?? await defaultDataDirectory();
const signupSetting = environment("CLANK_SIGNUP", "PROACT_SIGNUP");
if (signupSetting && !["bootstrap", "public", "disabled"].includes(signupSetting)) {
  throw new Error("CLANK_SIGNUP must be bootstrap, public, or disabled.");
}
const signup = signupSetting === "public"
  ? true
  : signupSetting === "disabled"
    ? false
    : "bootstrap";
const hosting = resolvePlatformHosting(process.env, signupSetting);
const runner = hosting.runnerKind === "docker"
  ? {
      kind: "docker",
      executable: environment("CLANK_DOCKER_EXECUTABLE", "PROACT_DOCKER_EXECUTABLE"),
      image: environment("CLANK_DOCKER_IMAGE", "PROACT_DOCKER_IMAGE"),
      memory: environment("CLANK_APP_MEMORY", "PROACT_APP_MEMORY"),
      cpus: environment("CLANK_APP_CPUS", "PROACT_APP_CPUS"),
      pidsLimit: number(environment("CLANK_APP_PIDS", "PROACT_APP_PIDS"), 128),
    }
  : { kind: "process" };
const ingressBaseDomain = environment("CLANK_INGRESS_BASE_DOMAIN", "PROACT_INGRESS_BASE_DOMAIN");
const customDomainTarget = environment("CLANK_CUSTOM_DOMAIN_TARGET", "PROACT_CUSTOM_DOMAIN_TARGET");
const customDomainAddresses = list(environment("CLANK_CUSTOM_DOMAIN_ADDRESSES", "PROACT_CUSTOM_DOMAIN_ADDRESSES"));
const ingressEnabled = environment("CLANK_INGRESS", "PROACT_INGRESS") === "1" || Boolean(ingressBaseDomain);
const domainRecheckInterval = process.env.CLANK_DOMAIN_RECHECK_INTERVAL_MS;
const backupInterval = process.env.CLANK_BACKUP_INTERVAL_MS;
const previewCleanupInterval = process.env.CLANK_PREVIEW_CLEANUP_INTERVAL_MS;
const runnerArtifactStorage = resolveRunnerArtifactStorage(process.env);
const backupStorage = resolveBackupStorage(process.env);
const providerPlacement = resolveProviderPlacement(process.env);
const runnerCoordinatorSetting = process.env.CLANK_RUNNER_COORDINATOR;
if (
  runnerCoordinatorSetting !== undefined
  && runnerCoordinatorSetting !== "0"
  && runnerCoordinatorSetting !== "1"
) {
  throw new Error("CLANK_RUNNER_COORDINATOR must be 0 or 1.");
}
const runnerCoordinatorEnabled =
  runnerCoordinatorSetting === "1" || Boolean(process.env.CLANK_RUNNER_REGISTRATION_TOKEN);
if (runnerArtifactStorage && !runnerCoordinatorEnabled) {
  throw new Error(
    "CLANK_RUNNER_ARTIFACT_STORE=s3 requires CLANK_RUNNER_COORDINATOR=1.",
  );
}
if (providerPlacement && !runnerCoordinatorEnabled) {
  throw new Error(
    "CLANK_PROVIDER_DEFAULT_PLACEMENT requires CLANK_RUNNER_COORDINATOR=1.",
  );
}
if (providerPlacement && !ingressEnabled) {
  throw new Error(
    "CLANK_PROVIDER_DEFAULT_PLACEMENT requires managed ingress.",
  );
}
const ingress = ingressEnabled ? {
  enabled: true,
  ...(ingressBaseDomain ? { baseDomain: ingressBaseDomain } : {}),
  ...(customDomainTarget ? { customDomainTarget } : {}),
  ...(customDomainAddresses.length ? { customDomainAddresses } : {}),
  ...(process.env.CLANK_TLS_ASK_TOKEN ? { tlsAskToken: process.env.CLANK_TLS_ASK_TOKEN } : {}),
  maxBodyBytes: number(process.env.CLANK_INGRESS_MAX_BODY_BYTES, 25 * 1024 * 1024),
  domainRecheckIntervalMs: domainRecheckInterval === "0"
    ? false
    : number(domainRecheckInterval, 5 * 60_000),
  domainRecheckBatchSize: number(process.env.CLANK_DOMAIN_RECHECK_BATCH_SIZE, 25),
  domainRecheckTimeoutMs: number(process.env.CLANK_DOMAIN_RECHECK_TIMEOUT_MS, 10_000),
} : undefined;

const platform = await openPlatform({
  dataDirectory,
  publicUrl,
  startupRecovery: "background",
  hostingProfile: hosting.hostingProfile,
  platformAdminEmails: list(process.env.CLANK_PLATFORM_ADMIN_EMAILS),
  runner,
  ...(runnerCoordinatorEnabled
    ? {
        deploymentAgents: {
          managedEnrollment: true,
          ...(process.env.CLANK_RUNNER_REGISTRATION_TOKEN
            ? { registrationToken: process.env.CLANK_RUNNER_REGISTRATION_TOKEN }
            : {}),
          maxRequestBytes: number(process.env.CLANK_RUNNER_MAX_REQUEST_BYTES, 128 * 1024),
          maxArtifactBytes: number(
            process.env.CLANK_RUNNER_MAX_ARTIFACT_BYTES,
            100 * 1024 * 1024,
          ),
          ...(runnerArtifactStorage
            ? {
                artifacts: {
                  namespace: runnerArtifactStorage.namespace,
                  store: createS3ObjectStore(runnerArtifactStorage.options),
                },
              }
            : {}),
          ...(providerPlacement ? { placement: providerPlacement } : {}),
        },
      }
    : {}),
  signup,
  masterKey: environment("CLANK_PLATFORM_MASTER_KEY", "PROACT_PLATFORM_MASTER_KEY"),
  appHostname: environment("CLANK_APP_HOST", "PROACT_APP_HOST"),
  appUrlTemplate: environment("CLANK_APP_URL_TEMPLATE", "PROACT_APP_URL_TEMPLATE"),
  appPortStart: number(environment("CLANK_APP_PORT_START", "PROACT_APP_PORT_START"), 4300),
  appPortEnd: number(environment("CLANK_APP_PORT_END", "PROACT_APP_PORT_END"), 4999),
  reservedAppPorts: [port],
  maxArtifactBytes: number(environment("CLANK_MAX_ARTIFACT_BYTES", "PROACT_MAX_ARTIFACT_BYTES"), 100 * 1024 * 1024),
  allowUnsafeMigrations: environment("CLANK_ALLOW_UNSAFE_MIGRATIONS", "PROACT_ALLOW_UNSAFE_MIGRATIONS") === "1",
  limits: {
    organizationsPerAccount: number(process.env.CLANK_MAX_ORGANIZATIONS_PER_ACCOUNT, 5),
    projectsPerAccount: number(process.env.CLANK_MAX_PROJECTS_PER_ACCOUNT, 10),
    projectsPerOrganization: number(process.env.CLANK_MAX_PROJECTS_PER_ORGANIZATION, 10),
    domainsPerProject: number(process.env.CLANK_MAX_DOMAINS_PER_PROJECT, 5),
    metricRetentionDays: number(process.env.CLANK_METRICS_RETENTION_DAYS, 30),
    releasesPerProject: number(process.env.CLANK_MAX_RELEASES_PER_PROJECT, 50),
    releaseStorageBytesPerProject: number(
      process.env.CLANK_MAX_RELEASE_STORAGE_BYTES_PER_PROJECT,
      20 * 1024 * 1024 * 1024,
    ),
    requestsPerMonthPerOrganization: number(
      process.env.CLANK_MAX_REQUESTS_PER_MONTH_PER_ORGANIZATION,
      5_000_000,
    ),
    transferBytesPerMonthPerOrganization: number(
      process.env.CLANK_MAX_TRANSFER_BYTES_PER_MONTH_PER_ORGANIZATION,
      100 * 1024 * 1024 * 1024,
    ),
    requestsPerMinutePerProject: number(
      process.env.CLANK_MAX_REQUESTS_PER_MINUTE_PER_PROJECT,
      3_000,
    ),
    usageRetentionMonths: number(process.env.CLANK_USAGE_RETENTION_MONTHS, 24),
  },
  backups: {
    intervalMs: backupInterval === "0"
      ? false
      : number(backupInterval, 24 * 60 * 60_000),
    batchSize: number(process.env.CLANK_BACKUP_BATCH_SIZE, 5),
    maxBackups: number(process.env.CLANK_BACKUP_MAX_COUNT, 30),
    maxAgeMs: number(process.env.CLANK_BACKUP_MAX_AGE_MS, 90 * 24 * 60 * 60_000),
    maxDatabaseBytes: number(process.env.CLANK_BACKUP_MAX_DATABASE_BYTES, 10 * 1024 * 1024 * 1024),
    ...(backupStorage
      ? {
          objects: {
            namespace: backupStorage.namespace,
            prefix: backupStorage.prefix,
            chunkBytes: backupStorage.chunkBytes,
            store: createS3ObjectStore(backupStorage.options),
          },
        }
      : {}),
  },
  jobs: {
    alertDueAfterMs: number(process.env.CLANK_JOB_ALERT_DUE_AFTER_MS, 5 * 60_000),
  },
  previews: {
    defaultTtlMs: number(process.env.CLANK_PREVIEW_DEFAULT_TTL_MS, 7 * 24 * 60 * 60_000),
    maxTtlMs: number(process.env.CLANK_PREVIEW_MAX_TTL_MS, 30 * 24 * 60 * 60_000),
    cleanupIntervalMs: previewCleanupInterval === "0"
      ? false
      : number(previewCleanupInterval, 5 * 60_000),
  },
  ...(ingress ? { ingress } : {}),
  onError: (error) => console.error("[platform]", error),
});

const allowedHosts = process.env.ALLOWED_HOSTS
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const server = await serve(platform, {
  hostname,
  port,
  trustProxy: process.env.TRUST_PROXY === "1",
  maxBodySize: number(environment("CLANK_MAX_ARTIFACT_BYTES", "PROACT_MAX_ARTIFACT_BYTES"), 100 * 1024 * 1024) + 1024,
  ...(ingressEnabled ? { allowedHosts: [] } : allowedHosts?.length ? { allowedHosts } : {}),
  onError: (error) => console.error("[http]", error),
});

console.log(`Clank deployment platform: ${publicUrl}`);
console.log(`Platform data: ${platform.dataDirectory}`);
console.log(`Hosting profile: ${platform.hostingProfile}`);
console.log(`Runner: ${runner.kind}`);
if (platform.hostingProfile === "trusted") {
  console.warn("Trusted hosting profile: deployed applications share the control-plane Unix trust boundary.");
}
console.log(`Managed ingress: ${ingressEnabled ? "enabled" : "disabled"}`);
console.log(`Remote runner coordinator: ${runnerCoordinatorEnabled ? "enabled" : "disabled"}`);
console.log(`One-time runner enrollment: ${runnerCoordinatorEnabled ? "enabled" : "disabled"}`);
console.log(`Legacy shared runner enrollment: ${process.env.CLANK_RUNNER_REGISTRATION_TOKEN ? "enabled" : "disabled"}`);
console.log(`Runner artifact storage: ${runnerArtifactStorage ? "object" : "local"}`);
console.log(
  `Provider project placement: ${
    providerPlacement ? `enabled (default ${providerPlacement.default})` : "disabled"
  }`,
);
console.log(`Encrypted backup storage: ${backupStorage ? "object" : "local"}`);
console.log(`Automatic backups: ${backupInterval === "0" ? "disabled" : "enabled"}`);
console.log(`Preview cleanup: ${previewCleanupInterval === "0" ? "disabled" : "enabled"}`);

let closing;
const close = async () => {
  if (closing) return closing;
  closing = (async () => {
    const results = await Promise.allSettled([server.close(), platform.close()]);
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "HTTP and platform shutdown both failed.");
  })();
  return closing;
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  const deadline = setTimeout(() => {
    console.error("Platform shutdown exceeded 25 seconds.");
    process.exit(1);
  }, 25_000);
  void close().then(
    () => process.exit(0),
    (error) => {
      console.error("[shutdown]", error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  ).finally(() => clearTimeout(deadline));
}

function environment(primary, legacy) {
  return process.env[primary] ?? process.env[legacy];
}

async function defaultDataDirectory() {
  try {
    await access(".clank-platform");
    return ".clank-platform";
  } catch {}
  try {
    await rename(".proact-platform", ".clank-platform");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return ".clank-platform";
}

function number(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid numeric environment value: ${value}`);
  return parsed;
}

function list(value) {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}
