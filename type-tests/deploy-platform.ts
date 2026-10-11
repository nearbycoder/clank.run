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
  type IngressCanaryRoute,
  type IngressRuntimeRoute,
} from "@clank.run/framework";
import type {
  DockerDeploymentRuntimeCandidate,
  DockerDeploymentRuntimeLaunchInput,
} from "@clank.run/framework/provider-docker";
import type { DeploymentProviderDataApplyInput } from "@clank.run/framework/provider-data";
import type { DeploymentProviderCanaryBinding, DeploymentProviderCanaryController, DeploymentProviderCanaryOptions, DeploymentProviderService } from "@clank.run/framework/provider-service";

declare const canaryPrimary: DeploymentProviderCanaryBinding;
declare const providerDataInput: DeploymentProviderDataApplyInput;
declare const canaryService: DeploymentProviderService;
const codeOnlyProviderInput: DeploymentProviderDataApplyInput = {...providerDataInput,codeOnly:true};
void codeOnlyProviderInput;
const invalidCodeOnlyProviderInput: DeploymentProviderDataApplyInput = {
  ...providerDataInput,
  // @ts-expect-error code-only verification requires a boolean
  codeOnly:"true",
};
void invalidCodeOnlyProviderInput;
const providerCanaryOptions: DeploymentProviderCanaryOptions = {readPaths:["/healthz"],maxConcurrent:2,maxOperations:8,maximumDurationMs:60_000};
void providerCanaryOptions;
void canaryService.canaries?.prepare({primary:canaryPrimary,controllerEpoch:3,operationId:"canary_typed_01",runtime:providerDataInput.runtime,signal:providerDataInput.signal});
// @ts-expect-error an admitted canary must have an explicit abort signal
void canaryService.canaries?.prepare({primary:canaryPrimary,controllerEpoch:3,operationId:"canary_typed_02",runtime:providerDataInput.runtime});
declare const preparedProviderCanary: Awaited<ReturnType<DeploymentProviderCanaryController["prepare"]>>;
preparedProviderCanary.route.generation satisfies 1;
preparedProviderCanary.route.token satisfies string;
// @ts-expect-error callers cannot substitute an admitted route credential
preparedProviderCanary.route.token="changed";
// @ts-expect-error approved public paths remain read-only
preparedProviderCanary.route.readPaths.push("/private");
void canaryService.canaries?.retire({primary:canaryPrimary,controllerEpoch:3,operationId:"canary_typed_01",releaseId:"candidate_release",capsuleSha256:providerDataInput.runtime.sha256,retirementEpoch:4});
// @ts-expect-error retirement must include the current coordinator epoch separately from the prepare epoch
void canaryService.canaries?.retire({primary:canaryPrimary,controllerEpoch:3,operationId:"canary_typed_01",releaseId:"candidate_release",capsuleSha256:providerDataInput.runtime.sha256});
// @ts-expect-error retirement must bind the exact source capsule digest
void canaryService.canaries?.retire({primary:canaryPrimary,controllerEpoch:3,operationId:"canary_typed_01",releaseId:"candidate_release",retirementEpoch:4});
declare const retiredProviderCanary: Awaited<ReturnType<DeploymentProviderCanaryController["retire"]>>;
retiredProviderCanary.phase satisfies "retired";
retiredProviderCanary.retirementEpoch satisfies number;
// @ts-expect-error an absence receipt does not grant a live route credential
retiredProviderCanary.route.token;
// @ts-expect-error retirement identity cannot be replaced by the caller
retiredProviderCanary.capsuleSha256="changed";

declare const preparedDockerInput: DockerDeploymentRuntimeLaunchInput;
const isolatedDockerInput: DockerDeploymentRuntimeLaunchInput = {
  ...preparedDockerInput,
  isolatedReadOnly: true,
};
void isolatedDockerInput;
const invalidIsolatedDockerInput: DockerDeploymentRuntimeLaunchInput = {
  ...preparedDockerInput,
  // @ts-expect-error isolation cannot be enabled with a string or a guessed profile
  isolatedReadOnly: "true",
};
void invalidIsolatedDockerInput;
declare const isolatedDockerCandidate: DockerDeploymentRuntimeCandidate;
isolatedDockerCandidate.isolatedReadOnly satisfies true | undefined;
// @ts-expect-error candidate identity and isolation cannot be edited by a consumer
isolatedDockerCandidate.isolatedReadOnly = true;
declare const isolatedIngressBinding: IngressRuntimeRoute;
const providerCanaryRoute: IngressCanaryRoute = {
  upstream: "https://provider.example.test", releaseId: "candidate-release", trafficPercent: 10,
  runtime: isolatedIngressBinding, projectId: "isolated_candidate", readPaths: ["/catalog"],
};
void providerCanaryRoute;
// @ts-expect-error provider candidates require an explicit approved path list
const unapprovedProviderCanary: IngressCanaryRoute = {
  upstream: "https://provider.example.test", releaseId: "candidate-release", trafficPercent: 10,
  runtime: isolatedIngressBinding, projectId: "isolated_candidate",
};
void unapprovedProviderCanary;
// @ts-expect-error an isolated project cannot be selected without its exact provider runtime binding
const unboundProviderCanary: IngressCanaryRoute = {
  upstream: "https://provider.example.test", releaseId: "candidate-release", trafficPercent: 10,
  projectId: "isolated_candidate", readPaths: ["/catalog"],
};
void unboundProviderCanary;

const config: DeploymentConfig = parseDeploymentConfig({
  version: 1,
  entry: "dist/server.js",
  include: ["dist", "migrations"],
  database: {
    path: "app.sqlite",
    migrations: "migrations",
    allowUnsafeMigrations: false,
    previewData: {
      tables: {
        tasks: {
          rows: 100,
          columns: {
            id: "keep",
            owner_email: "email",
            payload: { json: { default: "hash", paths: { "/done": "keep" } } },
          },
        },
      },
    },
  },
  health: {
    path: "/healthz",
    timeoutMs: 15_000,
  },
  env: {},
});

config.entry satisfies string;
config.database.path satisfies string;
config.database.previewData?.tables.tasks?.columns?.owner_email satisfies
  | import("@clank.run/framework").DeployPreviewDataTransform
  | import("@clank.run/framework").DeployPreviewJsonTransform
  | undefined;

const runner: PlatformRunnerOptions = {
  kind: "docker",
  image: "node:22-bookworm-slim",
  memory: "512m",
  cpus: "1",
  pidsLimit: 128,
};

declare const objects: ObjectStore;

void openPlatform({
  dataDirectory: ".clank-trusted-platform", publicUrl: "https://deploy.example.com",
  hostingProfile: "trusted", runner: { kind: "process" }, signup: "bootstrap",
  sqliteIsolation: "trusted-process",
});
void openPlatform({
  dataDirectory: ".clank-platform", publicUrl: "https://deploy.example.com",
  // @ts-expect-error unknown isolation policies must never silently disable isolation
  sqliteIsolation: "disabled",
});

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
