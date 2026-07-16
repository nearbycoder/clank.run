import {
  openPlatform,
  parseDeploymentConfig,
  type DeploymentConfig,
  type PlatformRunnerOptions,
} from "clank.run";

const config: DeploymentConfig = parseDeploymentConfig({
  version: 1,
  entry: "dist/server.js",
  include: ["dist", "migrations"],
  database: {
    path: "app.sqlite",
    migrations: "migrations",
    allowUnsafeMigrations: false,
  },
  health: {
    path: "/healthz",
    timeoutMs: 15_000,
  },
  env: {},
});

config.entry satisfies string;
config.database.path satisfies string;

const runner: PlatformRunnerOptions = {
  kind: "docker",
  image: "node:22-bookworm-slim",
  memory: "512m",
  cpus: "1",
  pidsLimit: 128,
};

void openPlatform({
  dataDirectory: ".clank-platform",
  publicUrl: "https://deploy.example.com",
  appUrlTemplate: "https://{slug}.apps.example.com",
  runner,
});

// @ts-expect-error runner kind is intentionally closed.
const unsupportedRunner: PlatformRunnerOptions = { kind: "ssh" };
void unsupportedRunner;
