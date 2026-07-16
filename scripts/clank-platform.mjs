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
  ...(allowedHosts?.length ? { allowedHosts } : {}),
  onError: (error) => console.error("[http]", error),
});

console.log(`Clank deployment platform: ${publicUrl}`);
console.log(`Platform data: ${platform.dataDirectory}`);
console.log(`Runner: ${runner.kind}`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await platform.close();
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));

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
