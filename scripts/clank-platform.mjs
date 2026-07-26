#!/usr/bin/env node
import { access, rename } from "node:fs/promises";
import { openPlatform } from "../dist/platform.js";
import { serve } from "../dist/node.js";

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
const runner = environment("CLANK_RUNNER", "PROACT_RUNNER") === "docker"
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
  runner,
  signup,
  masterKey: environment("CLANK_PLATFORM_MASTER_KEY", "PROACT_PLATFORM_MASTER_KEY"),
  appHostname: environment("CLANK_APP_HOST", "PROACT_APP_HOST"),
  appUrlTemplate: environment("CLANK_APP_URL_TEMPLATE", "PROACT_APP_URL_TEMPLATE"),
  appPortStart: number(environment("CLANK_APP_PORT_START", "PROACT_APP_PORT_START"), 4300),
  appPortEnd: number(environment("CLANK_APP_PORT_END", "PROACT_APP_PORT_END"), 4999),
  maxArtifactBytes: number(environment("CLANK_MAX_ARTIFACT_BYTES", "PROACT_MAX_ARTIFACT_BYTES"), 100 * 1024 * 1024),
  allowUnsafeMigrations: environment("CLANK_ALLOW_UNSAFE_MIGRATIONS", "PROACT_ALLOW_UNSAFE_MIGRATIONS") === "1",
  limits: {
    organizationsPerAccount: number(process.env.CLANK_MAX_ORGANIZATIONS_PER_ACCOUNT, 5),
    projectsPerAccount: number(process.env.CLANK_MAX_PROJECTS_PER_ACCOUNT, 10),
    projectsPerOrganization: number(process.env.CLANK_MAX_PROJECTS_PER_ORGANIZATION, 10),
    domainsPerProject: number(process.env.CLANK_MAX_DOMAINS_PER_PROJECT, 5),
    metricRetentionDays: number(process.env.CLANK_METRICS_RETENTION_DAYS, 30),
  },
  backups: {
    intervalMs: backupInterval === "0"
      ? false
      : number(backupInterval, 24 * 60 * 60_000),
    batchSize: number(process.env.CLANK_BACKUP_BATCH_SIZE, 5),
    maxBackups: number(process.env.CLANK_BACKUP_MAX_COUNT, 30),
    maxAgeMs: number(process.env.CLANK_BACKUP_MAX_AGE_MS, 90 * 24 * 60 * 60_000),
    maxDatabaseBytes: number(process.env.CLANK_BACKUP_MAX_DATABASE_BYTES, 10 * 1024 * 1024 * 1024),
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
console.log(`Runner: ${runner.kind}`);
console.log(`Managed ingress: ${ingressEnabled ? "enabled" : "disabled"}`);
console.log(`Automatic backups: ${backupInterval === "0" ? "disabled" : "enabled"}`);

let closing;
const close = async () => {
  if (closing) return closing;
  closing = (async () => {
    let serverError;
    try {
      await server.close();
    } catch (error) {
      serverError = error;
    }
    try {
      await platform.close();
    } catch (error) {
      if (serverError) throw new AggregateError([serverError, error], "HTTP and platform shutdown both failed.");
      throw error;
    }
    if (serverError) throw serverError;
  })();
  return closing;
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  const deadline = setTimeout(() => {
    console.error("Platform shutdown exceeded 30 seconds.");
    process.exit(1);
  }, 30_000);
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
