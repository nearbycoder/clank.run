import {
  openPlatform,
  openBackupManager,
  createDeploymentProviderHandler,
  createHttpDeploymentProvider,
  openProviderDeploymentAgent,
  parseDeploymentConfig,
  createResendEmailService,
  type DeploymentProvider,
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
  invitations: {
    email: createResendEmailService({ apiKey: "re_example_secret" }),
    from: { email: "noreply@example.com", name: "Clank" },
    replyTo: { email: "support@example.com" },
    intervalMs: 30_000,
    maxAttempts: 6,
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

const provider: DeploymentProvider = {
  kind: "microvm",
  async reconcile(request) {
    request.operation.fence satisfies number;
    request.desired.generation satisfies number;
    request.artifact?.bundle.config.entry satisfies string | undefined;
  },
};

createDeploymentProviderHandler(provider, {
  token: "replace-with-a-high-entropy-provider-token-000000000000",
});

const remoteProvider = createHttpDeploymentProvider({
  baseUrl: "https://runtime.example.com",
  token: "replace-with-a-high-entropy-provider-token-000000000000",
});

void openProviderDeploymentAgent({
  client: {} as Parameters<typeof openProviderDeploymentAgent>[0]["client"],
  node: { id: "runner-01", region: "us-central" },
  provider: remoteProvider,
  registrationToken: "replace-with-a-high-entropy-enrollment-token-00000000",
});

// @ts-expect-error runner kind is intentionally closed.
const unsupportedRunner: PlatformRunnerOptions = { kind: "ssh" };
void unsupportedRunner;
