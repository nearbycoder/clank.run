import {
  openPlatform,
  openBackupManager,
  parseDeploymentConfig,
  type DeploymentConfig,
  type ObjectStore,
  type PlatformRunnerOptions,
} from "@clank.run/framework";

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

declare const objects: ObjectStore;

void openPlatform({
  dataDirectory: ".clank-platform",
  publicUrl: "https://deploy.example.com",
  appUrlTemplate: "https://{slug}.apps.example.com",
  runner,
  backups: {
    objects: {
      store: objects,
      namespace: "production-recovery-v1",
      prefix: "backups",
      chunkBytes: 8 * 1024 * 1024,
    },
  },
  jobs: {
    alertDueAfterMs: 5 * 60_000,
  },
});

void openBackupManager({
  databasePath: "app.sqlite",
  repositoryDirectory: ".data/recovery",
  encryptionKey: new Uint8Array(32),
  objects: {
    store: objects,
    namespace: "production-recovery-v1",
    repositoryId: "orbit-tasks",
  },
});

// @ts-expect-error runner kind is intentionally closed.
const unsupportedRunner: PlatformRunnerOptions = { kind: "ssh" };
void unsupportedRunner;
