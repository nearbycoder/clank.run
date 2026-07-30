#!/usr/bin/env node
import {
  createDeploymentProviderHandler,
} from "../dist/provider.js";
import {
  openDockerDeploymentProviderService,
} from "../dist/provider-service.js";
import { serve } from "../dist/node.js";

process.umask(0o077);

const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument === "--help" || argument === "-h")) {
  console.log(`Usage: clank-provider

Runs Clank's complete stateful Docker deployment provider and private runtime ingress.

Required environment:
  CLANK_PROVIDER_TOKEN              Dedicated runner-to-provider bearer token
  CLANK_PROVIDER_OWNER              Stable unique owner label for this provider
  CLANK_PROVIDER_IMAGE              Immutable application image digest

Optional environment:
  PORT                              Private listener port (default: 4600)
  HOST                              Private listener address (default: 127.0.0.1)
  CLANK_PROVIDER_DATA               Persistent provider root (default: .clank-provider)
  CLANK_PROVIDER_DOCKER_EXECUTABLE  Docker CLI path (default: docker)
  CLANK_PROVIDER_ALLOW_MUTABLE_IMAGE  Set 1 only for controlled development
  CLANK_PROVIDER_CONTAINER_USER     Explicit non-root uid:gid
  CLANK_PROVIDER_NETWORK            Docker network (default: bridge)
  CLANK_PROVIDER_MEMORY             Per-container memory (default: 512m)
  CLANK_PROVIDER_CPUS               Per-container CPU limit (default: 1)
  CLANK_PROVIDER_PIDS               Per-container PID limit (default: 128)
  CLANK_PROVIDER_PORT_START         First loopback app port (default: 46000)
  CLANK_PROVIDER_PORT_END           Last loopback app port (default: 49999)
  CLANK_PROVIDER_MAX_RUNTIMES       Project runtime limit (default: 100)
  CLANK_PROVIDER_MAX_CONTAINERS     Container limit (default: 400)
  CLANK_PROVIDER_MAX_DATABASE_BYTES Database/snapshot bound (default: 536870912)
  CLANK_PROVIDER_MAX_ARTIFACT_BYTES Legacy artifact request bound (default: 104857600)
  CLANK_PROVIDER_MAX_RUNTIME_BYTES  Runtime-capsule request bound (default: 805306368)
  CLANK_PROVIDER_HTTP_REQUEST_TIMEOUT_MS Request receive deadline (default: 300000)
  CLANK_PROVIDER_INGRESS_TIMEOUT_MS Application response deadline (default: 30000)
  CLANK_PROVIDER_INGRESS_BODY_BYTES Application request body bound (default: 26214400)
  CLANK_PROVIDER_DRAIN_TIMEOUT_MS   Route drain deadline (default: 30000)
  CLANK_PROVIDER_COMMAND_TIMEOUT_MS Docker command deadline (default: 15000)
  CLANK_PROVIDER_STOP_TIMEOUT_MS    Container stop deadline (default: 10000)
  ALLOWED_HOSTS                     Exact private HTTP Host allowlist
  TRUST_PROXY                       Set 1 only behind a trusted private proxy

Bind this process only to a private network or loopback behind TLS. The provider token,
runtime capsules, application secrets, and SQLite data must never pass through generic logs.`);
  process.exit(0);
}
if (arguments_.length > 0) {
  throw new Error("clank-provider accepts only --help.");
}

const port = number(process.env.PORT, 4600, 1, 65_535);
const hostname = process.env.HOST ?? "127.0.0.1";
const allowedHosts = list(process.env.ALLOWED_HOSTS);
if (!isLoopbackHost(hostname) && allowedHosts.length === 0) {
  throw new Error(
    "ALLOWED_HOSTS is required when the provider listener is not loopback.",
  );
}
const token = required("CLANK_PROVIDER_TOKEN");
const owner = required("CLANK_PROVIDER_OWNER");
const image = required("CLANK_PROVIDER_IMAGE");
const rootDirectory = process.env.CLANK_PROVIDER_DATA ?? ".clank-provider";
const maxArtifactBytes = number(
  process.env.CLANK_PROVIDER_MAX_ARTIFACT_BYTES,
  100 * 1024 * 1024,
  1_024,
  1024 * 1024 * 1024,
);
const maxRuntimeBytes = number(
  process.env.CLANK_PROVIDER_MAX_RUNTIME_BYTES,
  768 * 1024 * 1024,
  1_024,
  2 * 1024 * 1024 * 1024,
);
const httpRequestTimeoutMs = number(
  process.env.CLANK_PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
  5 * 60_000,
  1_000,
  30 * 60_000,
);
const drainTimeoutMs = number(
  process.env.CLANK_PROVIDER_DRAIN_TIMEOUT_MS,
  30_000,
  100,
  5 * 60_000,
);

const service = await openDockerDeploymentProviderService({
  rootDirectory,
  owner,
  image,
  drainTimeoutMs,
  data: {
    maxDatabaseBytes: number(
      process.env.CLANK_PROVIDER_MAX_DATABASE_BYTES,
      512 * 1024 * 1024,
      1_024,
      2 * 1024 * 1024 * 1024,
    ),
  },
  docker: {
    ...(process.env.CLANK_PROVIDER_DOCKER_EXECUTABLE
      ? { executable: process.env.CLANK_PROVIDER_DOCKER_EXECUTABLE }
      : {}),
    allowMutableImage: boolean(process.env.CLANK_PROVIDER_ALLOW_MUTABLE_IMAGE, false),
    ...(process.env.CLANK_PROVIDER_CONTAINER_USER
      ? { user: process.env.CLANK_PROVIDER_CONTAINER_USER }
      : {}),
    ...(process.env.CLANK_PROVIDER_NETWORK
      ? { network: process.env.CLANK_PROVIDER_NETWORK }
      : {}),
    memory: process.env.CLANK_PROVIDER_MEMORY ?? "512m",
    cpus: process.env.CLANK_PROVIDER_CPUS ?? "1",
    pidsLimit: number(process.env.CLANK_PROVIDER_PIDS, 128, 1, 1_000_000),
    portStart: number(process.env.CLANK_PROVIDER_PORT_START, 46_000, 1_024, 65_535),
    portEnd: number(process.env.CLANK_PROVIDER_PORT_END, 49_999, 1_024, 65_535),
    maxRuntimes: number(process.env.CLANK_PROVIDER_MAX_RUNTIMES, 100, 1, 100_000),
    maxContainers: number(process.env.CLANK_PROVIDER_MAX_CONTAINERS, 400, 1, 1_000_000),
    commandTimeoutMs: number(
      process.env.CLANK_PROVIDER_COMMAND_TIMEOUT_MS,
      15_000,
      100,
      10 * 60_000,
    ),
    stopTimeoutMs: number(
      process.env.CLANK_PROVIDER_STOP_TIMEOUT_MS,
      10_000,
      100,
      10 * 60_000,
    ),
  },
  ingress: {
    timeoutMs: number(
      process.env.CLANK_PROVIDER_INGRESS_TIMEOUT_MS,
      30_000,
      100,
      5 * 60_000,
    ),
    maxBodyBytes: number(
      process.env.CLANK_PROVIDER_INGRESS_BODY_BYTES,
      25 * 1024 * 1024,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  },
  onError(error) {
    console.error(
      "[provider]",
      error instanceof Error ? error.message : "Provider operation failed.",
    );
  },
});
const reconciliation = createDeploymentProviderHandler(service, {
  token,
  maxArtifactBytes,
  maxRuntimeBytes,
  onError(error) {
    console.error(
      "[provider-bridge]",
      error instanceof Error ? error.message : "Provider bridge failed.",
    );
  },
});

const handler = {
  async handle(request) {
    const url = new URL(request.url);
    if (reconciliation.paths.includes(url.pathname)) {
      return reconciliation.handle(request);
    }
    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed.", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(request.method === "HEAD" ? null : "ok", {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
    return service.handle(request);
  },
};
const server = await serve(handler, {
  hostname,
  port,
  trustProxy: process.env.TRUST_PROXY === "1",
  maxBodySize: maxRuntimeBytes,
  requestTimeout: httpRequestTimeoutMs,
  ...(allowedHosts.length ? { allowedHosts } : {}),
  onError(error) {
    console.error(
      "[provider-http]",
      error instanceof Error ? error.message : "Provider HTTP request failed.",
    );
  },
});

console.log(`Clank deployment provider: http://${displayHost(hostname)}:${port}`);
console.log(`Provider owner: ${owner}`);
console.log(`Provider data: ${rootDirectory}`);
console.log(`Application image: ${image}`);
console.log("Trust boundary: private network only");

let closing;
const close = async () => {
  if (!closing) {
    closing = (async () => {
      const serverResult = await Promise.allSettled([server.close()]);
      const serviceResult = await Promise.allSettled([service.close()]);
      const failures = [...serverResult, ...serviceResult]
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Provider shutdown failed.");
      }
    })();
  }
  return closing;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`Received ${signal}; draining deployment provider.`);
    const deadline = setTimeout(() => {
      console.error("Provider shutdown exceeded 35 seconds.");
      process.exit(1);
    }, 35_000);
    void close().then(
      () => process.exit(0),
      (error) => {
        console.error(
          "[provider-shutdown]",
          error instanceof Error ? error.message : "Provider shutdown failed.",
        );
        process.exit(1);
      },
    ).finally(() => clearTimeout(deadline));
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function number(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }
  return parsed;
}

function boolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`Invalid boolean environment value: ${value}`);
}

function list(value) {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function displayHost(value) {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function isLoopbackHost(value) {
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}
