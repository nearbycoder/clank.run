#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createDeploymentCoordinatorClient,
  fileDeploymentNodeCredentials,
} from "../dist/runner.js";
import {
  createHttpDeploymentProvider,
  openProviderDeploymentAgent,
} from "../dist/provider.js";

process.umask(0o077);

const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument === "--help" || argument === "-h")) {
  console.log(`Usage: clank-runner [--check [--json]]

Runs a portable remote deployment node backed by an authenticated HTTP provider.

Diagnostics:
  --check                          Validate configuration and saved node access
  --json                           Emit the check result as agent-readable JSON

Required environment:
  CLANK_CONTROL_URL                Clank control-plane origin
  CLANK_RUNNER_NODE_ID             Stable node identifier
  CLANK_PROVIDER_URL               Runtime-provider service origin
  CLANK_PROVIDER_TOKEN             Dedicated provider bearer token

First enrollment:
  CLANK_RUNNER_REGISTRATION_TOKEN  Control-plane enrollment token

Optional environment:
  CLANK_RUNNER_REGION              Placement region (default: local)
  CLANK_RUNNER_CAPACITY            Process-slot capacity (default: 10)
  CLANK_RUNNER_ENDPOINT            Private operator endpoint metadata
  CLANK_RUNNER_LABELS              Comma-separated key=value labels
  CLANK_RUNNER_CREDENTIALS         Private credential file
  CLANK_RUNNER_CONCURRENCY         Concurrent operations (default: 2)
  CLANK_RUNNER_CLAIM_LIMIT         Operations per claim (default: concurrency)
  CLANK_RUNNER_POLL_INTERVAL_MS    Claim cadence (default: 1000)
  CLANK_RUNNER_HEARTBEAT_MS        Heartbeat cadence (default: 10000)
  CLANK_RUNNER_SHUTDOWN_MS         Graceful drain deadline (default: 30000)
  CLANK_RUNNER_CONTROL_TIMEOUT_MS  Control request deadline (default: 10000)
  CLANK_RUNNER_ARTIFACT_TIMEOUT_MS Artifact deadline (default: 60000)
  CLANK_RUNNER_MAX_ARTIFACT_BYTES Artifact ceiling (default: 104857600)
  CLANK_RUNNER_RUNTIME_TIMEOUT_MS  Runtime capsule deadline (default: 120000)
  CLANK_RUNNER_MAX_RUNTIME_BYTES  Runtime capsule ceiling (default: 805306368)
  CLANK_PROVIDER_TIMEOUT_MS        Provider deadline (default: 60000)
  CLANK_PROVIDER_RETRIES           Exact reconciliation retries (default: 2)

The enrollment and provider tokens are never printed. After first enrollment,
remove CLANK_RUNNER_REGISTRATION_TOKEN when your process manager permits it.`);
  process.exit(0);
}
if (arguments_.some((argument) => !["--check", "--json"].includes(argument))) {
  throw new Error("clank-runner accepts only --check, --json, or --help.");
}
if (arguments_.includes("--json") && !arguments_.includes("--check")) {
  throw new Error("--json must be used with --check.");
}
const checkOnly = arguments_.includes("--check");
const jsonOutput = arguments_.includes("--json");

const controlUrl = required("CLANK_CONTROL_URL");
const nodeId = identifier(required("CLANK_RUNNER_NODE_ID"), "CLANK_RUNNER_NODE_ID");
const providerUrl = required("CLANK_PROVIDER_URL");
const providerToken = token(required("CLANK_PROVIDER_TOKEN"), "CLANK_PROVIDER_TOKEN");
const concurrency = number(process.env.CLANK_RUNNER_CONCURRENCY, 2, 1, 64);
const credentialsPath = resolve(
  process.env.CLANK_RUNNER_CREDENTIALS
    ?? `.clank-runner/${nodeId}.credentials.json`,
);
const credentials = fileDeploymentNodeCredentials(credentialsPath);

const client = createDeploymentCoordinatorClient({
  baseUrl: controlUrl,
  timeoutMs: number(process.env.CLANK_RUNNER_CONTROL_TIMEOUT_MS, 10_000, 100, 10 * 60_000),
  artifactTimeoutMs: number(
    process.env.CLANK_RUNNER_ARTIFACT_TIMEOUT_MS,
    60_000,
    100,
    10 * 60_000,
  ),
  maxArtifactBytes: number(
    process.env.CLANK_RUNNER_MAX_ARTIFACT_BYTES,
    100 * 1024 * 1024,
    1_024,
    1024 * 1024 * 1024,
  ),
  runtimeTimeoutMs: number(
    process.env.CLANK_RUNNER_RUNTIME_TIMEOUT_MS,
    120_000,
    100,
    30 * 60_000,
  ),
  maxRuntimeBytes: number(
    process.env.CLANK_RUNNER_MAX_RUNTIME_BYTES,
    768 * 1024 * 1024,
    1_024,
    2 * 1024 * 1024 * 1024,
  ),
});
const provider = createHttpDeploymentProvider({
  baseUrl: providerUrl,
  token: providerToken,
  timeoutMs: number(process.env.CLANK_PROVIDER_TIMEOUT_MS, 60_000, 100, 10 * 60_000),
  retries: number(process.env.CLANK_PROVIDER_RETRIES, 2, 0, 10),
});

if (checkOnly) {
  const storedCredential = await credentials.load(nodeId);
  let control = storedCredential ? "authenticated" : "not_contacted";
  let errorCode;
  if (storedCredential) {
    try {
      await client.authenticate(nodeId, storedCredential);
    } catch (error) {
      control = "authentication_failed";
      errorCode = typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "CONTROL_CHECK_FAILED";
    }
  }
  const enrollment = storedCredential
    ? "saved_node_credential"
    : process.env.CLANK_RUNNER_REGISTRATION_TOKEN
      ? "ready_for_one_time_enrollment"
      : "enrollment_required";
  const ready = control !== "authentication_failed" && enrollment !== "enrollment_required";
  const result = {
    ok: ready,
    nodeId,
    region: identifier(process.env.CLANK_RUNNER_REGION ?? "local", "CLANK_RUNNER_REGION"),
    capacity: number(process.env.CLANK_RUNNER_CAPACITY, 10, 1, 100_000),
    control: {
      origin: new URL(controlUrl).origin,
      status: control,
      ...(errorCode ? { errorCode } : {}),
    },
    provider: {
      origin: new URL(providerUrl).origin,
      kind: provider.kind,
      status: "configured_not_contacted",
    },
    credentials: {
      path: credentialsPath,
      status: enrollment,
    },
  };
  if (jsonOutput) console.log(JSON.stringify(result));
  else {
    console.log(`Clank runner check: ${ready ? "ready" : "not ready"}`);
    console.log(`Node: ${nodeId} (${result.region})`);
    console.log(`Control plane: ${result.control.origin} · ${result.control.status}`);
    console.log(`Provider: ${result.provider.origin} · ${result.provider.status}`);
    console.log(`Credentials: ${credentialsPath} · ${enrollment}`);
  }
  process.exit(ready ? 0 : 1);
}

await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
const agent = await openProviderDeploymentAgent({
  client,
  provider,
  node: {
    id: nodeId,
    region: identifier(process.env.CLANK_RUNNER_REGION ?? "local", "CLANK_RUNNER_REGION"),
    capacity: number(process.env.CLANK_RUNNER_CAPACITY, 10, 1, 100_000),
    ...(process.env.CLANK_RUNNER_ENDPOINT
      ? { endpoint: process.env.CLANK_RUNNER_ENDPOINT }
      : {}),
    labels: labels(process.env.CLANK_RUNNER_LABELS),
  },
  ...(process.env.CLANK_RUNNER_REGISTRATION_TOKEN
    ? {
        registrationToken: token(
          process.env.CLANK_RUNNER_REGISTRATION_TOKEN,
          "CLANK_RUNNER_REGISTRATION_TOKEN",
        ),
      }
    : {}),
  credentials,
  concurrency,
  claimLimit: number(process.env.CLANK_RUNNER_CLAIM_LIMIT, concurrency, 1, 100),
  pollIntervalMs: number(process.env.CLANK_RUNNER_POLL_INTERVAL_MS, 1_000, 10, 60_000),
  heartbeatIntervalMs: number(
    process.env.CLANK_RUNNER_HEARTBEAT_MS,
    10_000,
    100,
    5 * 60_000,
  ),
  shutdownTimeoutMs: number(
    process.env.CLANK_RUNNER_SHUTDOWN_MS,
    30_000,
    100,
    10 * 60_000,
  ),
  onError(error) {
    console.error(
      "[runner]",
      error instanceof Error ? error.message : "Deployment runner failed.",
    );
  },
});

console.log(`Clank deployment node: ${agent.nodeId}`);
console.log(`Control plane: ${new URL(controlUrl).origin}`);
console.log(`Provider: ${provider.kind} (${new URL(providerUrl).origin})`);
console.log(`Region: ${agent.node.region}`);
console.log(`Capacity: ${agent.node.capacity}; concurrency: ${concurrency}`);
console.log(`Credentials: ${credentialsPath}`);

let closing;
async function close(signal) {
  if (!closing) {
    console.log(`Received ${signal}; draining deployment node.`);
    closing = agent.close();
  }
  await closing;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void close(signal).then(
      () => process.exit(0),
      (error) => {
        console.error("[runner shutdown]", error instanceof Error ? error.message : "Shutdown failed.");
        process.exit(1);
      },
    );
  });
}

await agent.done;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function token(value, name) {
  if (value.length < 32 || value.length > 512 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error(`${name} must be a high-entropy token between 32 and 512 characters.`);
  }
  return value;
}

function identifier(value, name) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, underscores, or hyphens.`);
  }
  return value;
}

function number(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }
  return parsed;
}

function labels(value) {
  const output = {};
  if (!value) return output;
  const entries = value.split(",");
  if (entries.length > 32) throw new Error("CLANK_RUNNER_LABELS cannot contain more than 32 labels.");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("CLANK_RUNNER_LABELS must use key=value entries.");
    const key = entry.slice(0, separator).trim();
    const item = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key)
      || item.length > 256
      || /[\u0000-\u001f\u007f]/u.test(item)
      || ["__proto__", "constructor", "prototype", "provider"].includes(key)) {
      throw new Error(`Invalid CLANK_RUNNER_LABELS entry: ${key}`);
    }
    if (Object.hasOwn(output, key)) throw new Error(`Duplicate CLANK_RUNNER_LABELS entry: ${key}`);
    output[key] = item;
  }
  return output;
}
