import {
  openDeploymentProviderDataStore,
  type DeploymentProviderDataSnapshot,
  type DeploymentProviderDataState,
  type DeploymentProviderDataStore,
  type PreparedDeploymentRuntimeData,
} from "./provider-data.ts";
import {
  DEPLOYMENT_PROVIDER_DOCKER_DIAGNOSTICS_PROTOCOL,
  openDockerDeploymentRuntimeLauncher,
  type DockerDeploymentRuntimeDiagnostics,
  type DockerDeploymentRuntimeCandidate,
  type DockerDeploymentRuntimeLauncher,
  type DockerDeploymentRuntimeLauncherOptions,
} from "./provider-docker.ts";
import {
  createDeploymentRuntimeIngress,
  type DeploymentRuntimeIngress,
  type DeploymentRuntimeIngressOptions,
} from "./provider-runtime.ts";
import {
  type DeploymentProvider,
  type DeploymentProviderLifecycleRequest,
  type DeploymentProviderRequest,
} from "./provider.ts";
import {
  decodeDeploymentRuntimeCapsule,
  DEPLOYMENT_RUNTIME_PROTOCOL,
  deploymentRuntimeDigest,
} from "./runtime-placement.ts";
import {
  inspectPlatformJobs,
  mutatePlatformJob,
} from "./platform-jobs.ts";
import type { JobState } from "./jobs.ts";

export const DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL = "clank-provider-service/1";
export const DEPLOYMENT_PROVIDER_CONTROL_PREFIX = "/v1/clank/control";
export const DEPLOYMENT_PROVIDER_SNAPSHOT_MEDIA_TYPE =
  "application/vnd.clank.provider-snapshot";
export const DEPLOYMENT_PROVIDER_DIAGNOSTICS_MEDIA_TYPE =
  "application/vnd.clank.provider-diagnostics+json";
export const DEPLOYMENT_PROVIDER_JOBS_PROTOCOL = "clank-provider-jobs/1";
export const DEPLOYMENT_PROVIDER_JOBS_MEDIA_TYPE =
  "application/vnd.clank.provider-jobs+json";

export interface DeploymentProviderServiceState {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL;
  readonly projectId: string;
  readonly operationId: string;
  readonly fence: number;
  readonly generation: number;
  readonly state: "running" | "stopped";
  readonly releaseId: string | null;
  readonly capsuleSha256: string | null;
  readonly phase:
    | "reconciling"
    | "running"
    | "stopped"
    | "rolling-back"
    | "rolled-back"
    | "deleting";
  readonly updatedAt: number;
}

export type DeploymentProviderServiceLifecycleRequest =
  DeploymentProviderLifecycleRequest;

export interface DeploymentProviderServiceOptions {
  /** Existing private provider root shared by the injected data and runtime components. */
  rootDirectory: string;
  data: DeploymentProviderDataStore;
  runtimes: DockerDeploymentRuntimeLauncher;
  ingress: DeploymentRuntimeIngress;
  /** Stable provider kind reported to the coordinator. Defaults to `docker`. */
  kind?: string;
  /** Maximum route drain before reconciliation fails closed. Defaults to 30 seconds. */
  drainTimeoutMs?: number;
  /** Runtime database/snapshot verification bound. Defaults to 512 MiB. */
  maxDatabaseBytes?: number;
  /** Receives non-secret cleanup and infrastructure diagnostics. */
  onError?: (error: unknown) => void;
}

export interface DockerDeploymentProviderServiceOptions {
  rootDirectory: string;
  owner: string;
  image: string;
  kind?: string;
  drainTimeoutMs?: number;
  data?: Omit<Parameters<typeof openDeploymentProviderDataStore>[0], "rootDirectory">;
  docker?: Omit<
    DockerDeploymentRuntimeLauncherOptions,
    "rootDirectory" | "owner" | "image"
  >;
  ingress?: DeploymentRuntimeIngressOptions;
  /** Default private diagnostic hook used by every component. */
  onError?: (error: unknown) => void;
}

export interface DeploymentProviderService extends DeploymentProvider {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL;
  /** Handles provider-private runtime ingress plus authenticated control routes. */
  handle(request: Request): Promise<Response>;
  /** Reads durable, non-secret desired-state progress for one project. */
  inspect(projectId: string): Promise<DeploymentProviderServiceState | null>;
  /** Creates a consistent provider-data snapshot for external encrypted backup. */
  snapshot(projectId: string): Promise<DeploymentProviderDataSnapshot | null>;
  /** Returns bounded live output and resource attribution for one runtime. */
  diagnostics(
    projectId: string,
    logLimit?: number,
  ): Promise<DockerDeploymentRuntimeDiagnostics | null>;
  /** Drains every writer and restores the immediate provider-data predecessor. */
  rollback(
    request: DeploymentProviderServiceLifecycleRequest,
  ): Promise<DeploymentProviderDataState | null>;
  /** Drains every writer and permanently removes provider-owned project state. */
  delete(request: DeploymentProviderServiceLifecycleRequest): Promise<boolean>;
  /** Revokes traffic, drains requests, stops runtimes, and closes the service. */
  close(): Promise<void>;
}

interface StoredServiceState extends DeploymentProviderServiceState {}

interface ProviderControlBinding {
  projectId: string;
  releaseId: string;
  generation: number;
  tokenDigest: Uint8Array;
}

interface NodeStats {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  uid?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface NodeFileHandle {
  stat(): Promise<NodeStats>;
  readFile(options: { encoding: "utf8" }): Promise<string>;
  writeFile(value: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface NodeFs {
  constants: { O_RDONLY: number; O_NOFOLLOW?: number };
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<NodeStats>;
  mkdir(path: string, options: { recursive?: boolean; mode?: number }): Promise<void>;
  open(
    path: string,
    flags: string | number,
    mode?: number,
  ): Promise<NodeFileHandle>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force?: boolean }): Promise<void>;
}

interface NodePath {
  dirname(path: string): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_PROVIDER_DATABASE_BYTES =
  2 * 1024 * 1024 * 1024 - 2 * 1024 * 1024 - 100 * 1024 * 1024 - 32;

/**
 * Composes provider data, an isolated Docker launcher, and private ingress into
 * one fenced desired-state provider. Application secrets remain only in the
 * verified capsule and transient runtime activation plan.
 */
export async function openDeploymentProviderService(
  options: DeploymentProviderServiceOptions,
): Promise<DeploymentProviderService> {
  if (!options || typeof options !== "object") {
    throw new TypeError("Deployment provider service options are required.");
  }
  const fs = await nodeFs();
  const path = await nodePath();
  const root = await privateDirectory(
    fs,
    path.resolve(nonEmpty(options.rootDirectory, "rootDirectory")),
    "rootDirectory",
  );
  const serviceDirectory = path.join(root, "service");
  await ensurePrivateDirectory(fs, serviceDirectory, "provider service directory");
  requireInside(path, root, await fs.realpath(serviceDirectory), "provider service directory");
  const kind = pattern(options.kind ?? "docker", "kind", KIND);
  const drainTimeoutMs = integer(
    options.drainTimeoutMs ?? 30_000,
    "drainTimeoutMs",
    100,
    5 * 60_000,
  );
  const maxDatabaseBytes = integer(
    options.maxDatabaseBytes ?? 512 * 1024 * 1024,
    "maxDatabaseBytes",
    1_024,
    MAX_PROVIDER_DATABASE_BYTES,
  );
  const data = requiredComponent(options.data, "data", [
    "apply",
    "inspect",
    "snapshot",
    "rollback",
    "delete",
  ]);
  const runtimes = requiredComponent(options.runtimes, "runtimes", [
    "launch",
    "activate",
    "inspect",
    "diagnostics",
    "stop",
    "close",
  ]);
  const ingress = requiredComponent(options.ingress, "ingress", [
    "activate",
    "inspect",
    "handle",
    "deactivate",
    "close",
  ]);
  const tails = new Map<string, Promise<void>>();
  const controls = new Map<string, ProviderControlBinding>();
  let closed = false;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot affect deployment state.
    }
  };

  const exclusive = async <Value>(
    projectId: string,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    const prior = tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    tails.set(projectId, tail);
    await prior;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(projectId) === tail) tails.delete(projectId);
    }
  };

  const statePath = (projectId: string): string =>
    path.join(serviceDirectory, `${identifier(projectId, "projectId")}.json`);

  const readProjectState = async (
    projectId: string,
  ): Promise<StoredServiceState | null> =>
    serviceState(await readPrivateJson(fs, statePath(projectId)), projectId);

  const writeProjectState = async (state: StoredServiceState): Promise<void> => {
    await atomicWriteJson(fs, path, statePath(state.projectId), state);
  };

  const removeProjectState = async (projectId: string): Promise<void> => {
    await fs.rm(statePath(projectId), { force: true });
    await syncDirectory(fs, serviceDirectory);
  };

  const quiesce = async (projectId: string): Promise<void> => {
    controls.delete(projectId);
    const bindings = ingress.inspect()
      .filter((binding) => binding.projectId === projectId)
      .sort((left, right) => right.generation - left.generation);
    for (const binding of bindings) {
      const result = await ingress.deactivate(
        projectId,
        binding.generation,
        drainTimeoutMs,
      );
      if (!result.drained) {
        throw new Error("Provider runtime traffic did not drain before its deadline.");
      }
    }
    const active = runtimes.inspect()
      .filter((runtime) => runtime.projectId === projectId)
      .sort((left, right) => right.generation - left.generation);
    for (const runtime of active) {
      await runtimes.stop(projectId, runtime.generation);
    }
    if (runtimes.inspect().some((runtime) => runtime.projectId === projectId)) {
      throw new Error("Provider runtime cleanup could not be verified.");
    }
  };

  const cleanupCandidate = async (
    candidate: DockerDeploymentRuntimeCandidate | null,
    expected?: Pick<
      PreparedDeploymentRuntimeData,
      "projectId" | "generation"
    > | null,
  ): Promise<void> => {
    const identity = candidate ?? expected;
    if (!identity) return;
    const failures: unknown[] = [];
    try {
      const result = await ingress.deactivate(
        identity.projectId,
        identity.generation,
        drainTimeoutMs,
      );
      if (!result.drained) {
        failures.push(new Error("Candidate traffic did not drain before cleanup."));
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtimes.stop(identity.projectId, identity.generation);
      if (runtimes.inspect().some((runtime) =>
        runtime.projectId === identity.projectId
        && runtime.generation === identity.generation)) {
        failures.push(new Error("Candidate runtime cleanup could not be verified."));
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      for (const failure of failures) report(failure);
      throw new AggregateError(failures, "Provider candidate cleanup failed.");
    }
  };

  const service: DeploymentProviderService = {
    protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
    kind,

    async reconcile(requestInput) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const request = await providerRequest(requestInput, maxDatabaseBytes);
      return exclusive(request.operation.projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        throwIfAborted(request.signal);
        const prior = await readProjectState(request.operation.projectId);
        assertAccepted(prior, request);
        let bootstrapData: DeploymentProviderDataState | null = null;
        let bootstrapInspected = false;
        if (!prior) {
          await quiesce(request.operation.projectId);
          bootstrapData = await data.inspect(request.operation.projectId);
          bootstrapInspected = true;
          assertAcceptedData(bootstrapData, request);
        }
        const intent = stateFor(request, "reconciling");
        await writeProjectState(intent);
        throwIfAborted(request.signal);

        if (request.desired.state === "stopped") {
          if (!bootstrapInspected) await quiesce(request.operation.projectId);
          throwIfAborted(request.signal);
          await writeProjectState(stateFor(request, "stopped"));
          return;
        }

        const runtime = request.runtime!;
        const liveRuntime = runtimes.inspect().filter((entry) =>
          entry.projectId === request.operation.projectId);
        const liveIngress = ingress.inspect().filter((entry) =>
          entry.projectId === request.operation.projectId);
        const exactRuntime = liveRuntime.length === 1
          && liveRuntime[0].generation === request.desired.generation
          && liveRuntime[0].releaseId === request.desired.releaseId
          && liveRuntime[0].capsuleSha256 === runtime.sha256
          && liveRuntime[0].status === "active";
        const exactIngress = liveIngress.length === 1
          && liveIngress[0].generation === request.desired.generation
          && liveIngress[0].releaseId === request.desired.releaseId
          && liveIngress[0].path === runtime.manifest.ingress.route
          && liveIngress[0].latest;
        const trustedRunningRetry = prior?.phase === "running"
          && matchesState(prior, request)
          && exactRuntime
          && exactIngress;
        if (!trustedRunningRetry && !bootstrapInspected) {
          await quiesce(request.operation.projectId);
        }
        const existingData = bootstrapInspected
          ? bootstrapData
          : await data.inspect(request.operation.projectId);
        if (trustedRunningRetry && !matchesData(existingData, request)) {
          await quiesce(request.operation.projectId);
        }
        throwIfAborted(request.signal);

        let prepared: PreparedDeploymentRuntimeData | null = null;
        let candidate: DockerDeploymentRuntimeCandidate | null = null;
        try {
          const committed = await data.apply({
            operation: request.operation,
            desired: request.desired,
            runtime,
            signal: request.signal,
          }, async (value) => {
            prepared = value;
            candidate = await runtimes.launch({
              prepared: value,
              signal: request.signal,
              deferBackground: true,
            });
          }, async (value) => {
            await cleanupCandidate(candidate, value);
          });
          if (!prepared || !candidate) {
            throw new Error("Provider data validation did not produce a runtime candidate.");
          }
          if (
            committed.projectId !== candidate.projectId
            || committed.releaseId !== candidate.releaseId
            || committed.generation !== candidate.generation
            || committed.capsuleSha256 !== candidate.capsuleSha256
          ) {
            throw new Error("Provider data and runtime candidate do not match.");
          }
          const active = await runtimes.activate(candidate, request.signal);
          throwIfAborted(request.signal);
          await ingress.activate({
            protocol: DEPLOYMENT_RUNTIME_PROTOCOL,
            projectId: committed.projectId,
            releaseId: committed.releaseId,
            generation: committed.generation,
            path: prepared.ingress.route,
            token: prepared.ingress.token,
            upstream: active.upstream,
          });
          if (prepared.ingress.controlToken) {
            controls.set(committed.projectId, {
              projectId: committed.projectId,
              releaseId: committed.releaseId,
              generation: committed.generation,
              tokenDigest: await secretDigest(prepared.ingress.controlToken),
            });
          } else {
            controls.delete(committed.projectId);
          }
          throwIfAborted(request.signal);
          await writeProjectState(stateFor(request, "running"));
        } catch (error) {
          controls.delete(request.operation.projectId);
          try {
            await cleanupCandidate(candidate, prepared);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Provider reconciliation and candidate cleanup both failed.",
            );
          }
          throw error;
        } finally {
          prepared = null;
          candidate = null;
        }
      });
    },

    async handle(request) {
      const url = new URL(request.url);
      const control = new RegExp(
        `^${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/([A-Za-z0-9_-]{1,128})/(snapshot|diagnostics|jobs(?:/(job_[a-f0-9]{32})/(cancel|retry))?)$`,
        "u",
      ).exec(url.pathname);
      if (!control) {
        if (
          url.pathname === DEPLOYMENT_PROVIDER_CONTROL_PREFIX
          || url.pathname.startsWith(`${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/`)
        ) {
          return controlProblem(
            404,
            "CONTROL_NOT_FOUND",
            "Provider control endpoint not found.",
          );
        }
        return ingress.handle(request);
      }
      const operation = control[2]!;
      let logLimit = 200;
      let jobState: JobState | undefined;
      let jobQueue: string | undefined;
      let jobLimit = 100;
      let alertDueAfterMs = 5 * 60_000;
      if (operation === "diagnostics") {
        if (
          [...url.searchParams.keys()].some((key) => key !== "logs")
          || url.searchParams.getAll("logs").length > 1
        ) {
          return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
        }
        const requested = url.searchParams.get("logs");
        if (requested !== null && !/^(?:0|[1-9][0-9]{0,2}|1000)$/u.test(requested)) {
          return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
        }
        if (requested !== null) logLimit = Number(requested);
      }
      if (operation === "jobs") {
        const allowed = new Set(["state", "queue", "limit", "alertDueAfterMs"]);
        if (
          [...url.searchParams.keys()].some((key) => !allowed.has(key))
          || [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
        ) {
          return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
        }
        const state = url.searchParams.get("state");
        if (
          state !== null
          && !["queued", "running", "retry", "succeeded", "dead", "cancelled"].includes(state)
        ) {
          return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
        }
        if (state !== null) jobState = state as JobState;
        const queue = url.searchParams.get("queue");
        if (
          queue !== null
          && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(queue)
        ) {
          return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
        }
        if (queue !== null) jobQueue = queue;
        const limit = url.searchParams.get("limit");
        if (limit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(limit)) {
          return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
        }
        if (limit !== null) jobLimit = Number(limit);
        const alert = url.searchParams.get("alertDueAfterMs");
        if (
          alert !== null
          && (
            !/^[1-9][0-9]{3,9}$/u.test(alert)
            || Number(alert) < 1_000
            || Number(alert) > 30 * 24 * 60 * 60_000
          )
        ) {
          return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
        }
        if (alert !== null) alertDueAfterMs = Number(alert);
      }
      const jobMutation = operation.startsWith("jobs/");
      if (
        (jobMutation ? request.method !== "POST" : request.method !== "GET")
        || ((operation === "snapshot" || jobMutation) && url.search)
      ) {
        return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
      }
      const projectId = control[1]!;
      const binding = controls.get(projectId);
      const credential = bearerCredential(request.headers.get("authorization"));
      if (
        !binding
        || !credential
        || !await secretMatches(credential, binding.tokenDigest)
      ) {
        return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
      }
      return exclusive(projectId, async () => {
        try {
          if (closed) {
            return controlProblem(
              503,
              "PROVIDER_UNAVAILABLE",
              providerControlUnavailableMessage(operation),
            );
          }
          const current = controls.get(projectId);
          const state = await readProjectState(projectId);
          if (
            current !== binding
            || !state
            || state.phase !== "running"
            || state.state !== "running"
            || state.releaseId !== binding.releaseId
            || state.generation !== binding.generation
          ) {
            return controlProblem(409, "PROVIDER_GENERATION_STALE", "Provider generation is not current.");
          }
          if (operation === "diagnostics") {
            const diagnostics = await runtimes.diagnostics(
              projectId,
              logLimit,
              request.signal,
            );
            if (
              !diagnostics
              || diagnostics.protocol
                !== DEPLOYMENT_PROVIDER_DOCKER_DIAGNOSTICS_PROTOCOL
              || diagnostics.projectId !== projectId
              || diagnostics.releaseId !== binding.releaseId
              || diagnostics.generation !== binding.generation
            ) {
              return controlProblem(
                409,
                "PROVIDER_GENERATION_STALE",
                "Provider generation is not current.",
              );
            }
            const body = JSON.stringify(diagnostics);
            const bodyBytes = new TextEncoder().encode(body).byteLength;
            if (bodyBytes > 512 * 1024) {
              throw new Error("Provider diagnostics response exceeded its bound.");
            }
            return new Response(body, {
              status: 200,
              headers: {
                "cache-control": "private, no-store",
                "content-length": String(bodyBytes),
                "content-type": DEPLOYMENT_PROVIDER_DIAGNOSTICS_MEDIA_TYPE,
                "x-clank-release-id": diagnostics.releaseId,
                "x-clank-runtime-generation": String(diagnostics.generation),
                "x-content-type-options": "nosniff",
              },
            });
          }
          if (operation === "jobs" || jobMutation) {
            const providerData = await data.inspect(projectId);
            if (
              !providerData
              || providerData.releaseId !== binding.releaseId
              || providerData.generation !== binding.generation
            ) {
              return controlProblem(
                409,
                "PROVIDER_GENERATION_STALE",
                "Provider generation is not current.",
              );
            }
            const databasePath = await providerJobDatabasePath(
              fs,
              path,
              root,
              projectId,
              providerData.databasePath,
              maxDatabaseBytes,
            );
            if (operation === "jobs") {
              const snapshot = await inspectPlatformJobs({
                databasePath,
                alertDueAfterMs,
                ...(jobState === undefined ? {} : { state: jobState }),
                ...(jobQueue === undefined ? {} : { queue: jobQueue }),
                limit: jobLimit,
              });
              return providerJobsResponse(binding, { snapshot });
            }
            const input = exactControlJson(
              await readControlJson(request, 1_024),
              control[4] === "retry" ? ["runAt"] : [],
            );
            const mutation = await mutatePlatformJob({
              databasePath,
              id: control[3]!,
              action: control[4] as "cancel" | "retry",
              ...(control[4] === "retry" && input.runAt !== undefined
                ? {
                    runAt: integer(
                      input.runAt,
                      "runAt",
                      0,
                      Number.MAX_SAFE_INTEGER,
                    ),
                  }
                : {}),
            });
            return providerJobsResponse(binding, { mutation });
          }
          const snapshot = await data.snapshot(projectId);
          if (
            !snapshot
            || snapshot.releaseId !== binding.releaseId
            || snapshot.generation !== binding.generation
            || snapshot.bytes.byteLength > maxDatabaseBytes
            || snapshot.sha256 !== await deploymentRuntimeDigest(snapshot.bytes)
          ) {
            return controlProblem(409, "PROVIDER_GENERATION_STALE", "Provider generation is not current.");
          }
          return new Response(snapshot.bytes, {
            status: 200,
            headers: {
              "cache-control": "private, no-store",
              "content-length": String(snapshot.bytes.byteLength),
              "content-type": DEPLOYMENT_PROVIDER_SNAPSHOT_MEDIA_TYPE,
              "x-clank-content-sha256": snapshot.sha256,
              "x-clank-release-id": snapshot.releaseId,
              "x-clank-runtime-generation": String(snapshot.generation),
              "x-content-type-options": "nosniff",
            },
          });
        } catch (error) {
          report(error);
          return controlProblem(
            503,
            "PROVIDER_UNAVAILABLE",
            providerControlUnavailableMessage(operation),
          );
        }
      });
    },

    async inspect(projectIdInput) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const projectId = identifier(projectIdInput, "projectId");
      return exclusive(projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        const state = await readProjectState(projectId);
        return state ? publicState(state) : null;
      });
    },

    async snapshot(projectIdInput) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const projectId = identifier(projectIdInput, "projectId");
      return exclusive(projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        return data.snapshot(projectId);
      });
    },

    async diagnostics(projectIdInput, logLimitInput = 200) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const projectId = identifier(projectIdInput, "projectId");
      const logLimit = integer(logLimitInput, "logLimit", 0, 1_000);
      return exclusive(projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        return runtimes.diagnostics(projectId, logLimit);
      });
    },

    async rollback(requestInput) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const request = lifecycleRequest(requestInput, "rollback");
      return exclusive(request.operation.projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        throwIfAborted(request.signal);
        const prior = await readProjectState(request.operation.projectId);
        const retry = lifecycleRetry(prior, request, "rolling-back", "rolled-back");
        await quiesce(request.operation.projectId);
        throwIfAborted(request.signal);
        const current = await data.inspect(request.operation.projectId);
        if (retry === "complete") {
          if (current && current.generation >= request.generation) {
            throw new Error("Completed provider rollback conflicts with provider data.");
          }
          if (current && current.fence !== request.operation.fence) {
            throw new Error("Completed provider rollback has an invalid provider-data fence.");
          }
          return current;
        }
        if (retry === "intent") {
          if (current && current.generation > request.generation) {
            throw new Error("Provider rollback generation is stale.");
          }
          if (
            current
            && current.generation < request.generation
            && current.fence !== request.operation.fence
          ) {
            throw new Error("Provider rollback result has an invalid provider-data fence.");
          }
        } else {
          if (!current) {
            if (prior) throw new Error("Provider service state has no matching provider data.");
            return null;
          }
          if (current.generation !== request.generation) {
            throw new Error("Provider rollback generation is stale.");
          }
          if (!current.rollbackAvailable) {
            throw new Error("Provider rollback data is unavailable.");
          }
          if (request.operation.fence <= current.fence) {
            throw new Error("Provider rollback fence is stale.");
          }
          await writeProjectState(lifecycleState(request, "rolling-back"));
        }
        throwIfAborted(request.signal);
        const restored = current?.generation === request.generation
          ? await data.rollback({
              projectId: request.operation.projectId,
              generation: request.generation,
              confirmation: request.confirmation,
              fence: request.operation.fence,
            })
          : current;
        throwIfAborted(request.signal);
        await writeProjectState(lifecycleState(request, "rolled-back"));
        return restored;
      });
    },

    async delete(requestInput) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const request = lifecycleRequest(requestInput, "delete");
      return exclusive(request.operation.projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        throwIfAborted(request.signal);
        const prior = await readProjectState(request.operation.projectId);
        const retry = lifecycleRetry(prior, request, "deleting");
        await quiesce(request.operation.projectId);
        throwIfAborted(request.signal);
        const current = await data.inspect(request.operation.projectId);
        if (current && current.generation !== request.generation) {
          throw new Error("Provider deletion generation is stale.");
        }
        if (retry === "new") {
          if (!prior && !current) return false;
          if (current && request.operation.fence <= current.fence) {
            throw new Error("Provider deletion fence is stale.");
          }
          await writeProjectState(lifecycleState(request, "deleting"));
        }
        throwIfAborted(request.signal);
        const deleted = await data.delete({
          projectId: request.operation.projectId,
          confirmation: request.confirmation,
        });
        throwIfAborted(request.signal);
        await removeProjectState(request.operation.projectId);
        return deleted || retry === "intent";
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      controls.clear();
      const activeOperations = [...tails.values()];
      const failures: unknown[] = [];
      try {
        const drained = await ingress.close(drainTimeoutMs);
        if (!drained) failures.push(new Error("Provider ingress did not drain before shutdown."));
      } catch (error) {
        failures.push(error);
      }
      try {
        await runtimes.close();
      } catch (error) {
        failures.push(error);
      }
      await Promise.all(activeOperations);
      for (const failure of failures) report(failure);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Deployment provider service failed to close cleanly.");
      }
    },
  };
  return Object.freeze(service);
}

/** Opens the complete zero-dependency Docker provider stack with secure defaults. */
export async function openDockerDeploymentProviderService(
  options: DockerDeploymentProviderServiceOptions,
): Promise<DeploymentProviderService> {
  if (!options || typeof options !== "object") {
    throw new TypeError("Docker deployment provider service options are required.");
  }
  const data = await openDeploymentProviderDataStore({
    ...(options.data ?? {}),
    rootDirectory: options.rootDirectory,
  });
  let ingress: DeploymentRuntimeIngress | undefined;
  let runtimes: DockerDeploymentRuntimeLauncher | undefined;
  try {
    runtimes = await openDockerDeploymentRuntimeLauncher({
      ...(options.docker ?? {}),
      rootDirectory: options.rootDirectory,
      owner: options.owner,
      image: options.image,
      onError: options.docker?.onError ?? options.onError,
    });
    ingress = createDeploymentRuntimeIngress({
      ...(options.ingress ?? {}),
      onError: options.ingress?.onError ?? options.onError,
    });
    return await openDeploymentProviderService({
      rootDirectory: options.rootDirectory,
      data,
      runtimes,
      ingress,
      kind: options.kind,
      drainTimeoutMs: options.drainTimeoutMs,
      maxDatabaseBytes: options.data?.maxDatabaseBytes,
      onError: options.onError,
    });
  } catch (error) {
    await Promise.allSettled([
      ...(ingress ? [ingress.close(options.drainTimeoutMs)] : []),
      ...(runtimes ? [runtimes.close()] : []),
    ]);
    throw error;
  }
}

async function providerRequest(
  input: DeploymentProviderRequest,
  maxDatabaseBytes: number,
): Promise<DeploymentProviderRequest> {
  if (!input || typeof input !== "object") {
    throw new TypeError("Provider request is required.");
  }
  const operation = input.operation;
  if (!operation || typeof operation !== "object") {
    throw new TypeError("Provider operation is required.");
  }
  const projectId = identifier(operation.projectId, "operation.projectId");
  const id = identifier(operation.id, "operation.id");
  const fence = positiveInteger(operation.fence, "operation.fence");
  const attempt = positiveInteger(operation.attempt, "operation.attempt");
  const maxAttempts = positiveInteger(operation.maxAttempts, "operation.maxAttempts");
  if (attempt > maxAttempts) throw new TypeError("Provider operation attempt exceeds maxAttempts.");
  if (!(input.signal instanceof AbortSignal)) {
    throw new TypeError("Provider request signal must be an AbortSignal.");
  }
  const desired = input.desired;
  if (!desired || typeof desired !== "object") {
    throw new TypeError("Provider desired state is required.");
  }
  const generation = positiveInteger(desired.generation, "desired.generation");
  if (desired.state !== "running" && desired.state !== "stopped") {
    throw new TypeError("Provider desired state is invalid.");
  }
  let artifact = input.artifact;
  let runtime = input.runtime ?? null;
  if (desired.state === "stopped") {
    if (
      desired.releaseId !== null
      || (desired.runtimeProtocol !== undefined && desired.runtimeProtocol !== null)
      || input.runtime
      || input.artifact
    ) {
      throw new TypeError("Stopped provider state cannot include release content.");
    }
  } else {
    const releaseId = identifier(desired.releaseId, "desired.releaseId");
    if (
      desired.runtimeProtocol !== DEPLOYMENT_RUNTIME_PROTOCOL
      || !input.runtime
      || !(input.runtime.bytes instanceof Uint8Array)
      || !DIGEST.test(input.runtime.sha256)
      || await deploymentRuntimeDigest(input.runtime.bytes) !== input.runtime.sha256
    ) {
      throw new TypeError("Provider service requires a running runtime capsule.");
    }
    runtime = await decodeDeploymentRuntimeCapsule(
      new Uint8Array(input.runtime.bytes),
      {
        maxDatabaseBytes,
        maxCapsuleBytes:
          2 * 1024 * 1024 + 100 * 1024 * 1024 + maxDatabaseBytes + 32,
      },
    );
    if (
      runtime.manifest?.protocol !== DEPLOYMENT_RUNTIME_PROTOCOL
      || runtime.manifest.projectId !== projectId
      || runtime.manifest.releaseId !== releaseId
      || runtime.manifest.generation !== generation
      || !input.artifact
      || input.artifact.sha256 !== runtime.artifact?.sha256
    ) {
      throw new TypeError("Provider runtime capsule does not match desired state.");
    }
    artifact = runtime.artifact;
  }
  return Object.freeze({
    operation: Object.freeze({ id, projectId, fence, attempt, maxAttempts }),
    desired: Object.freeze({
      generation,
      releaseId: desired.state === "running"
        ? identifier(desired.releaseId, "desired.releaseId")
        : null,
      state: desired.state,
      runtimeProtocol: desired.state === "running" ? DEPLOYMENT_RUNTIME_PROTOCOL : null,
    }),
    artifact,
    runtime,
    signal: input.signal,
  });
}

function lifecycleRequest(
  input: DeploymentProviderServiceLifecycleRequest,
  action: "rollback" | "delete",
): DeploymentProviderServiceLifecycleRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`Provider ${action} request is required.`);
  }
  const fields = Object.keys(input);
  if (
    fields.length !== 4
    || !["operation", "generation", "confirmation", "signal"].every((field) =>
      fields.includes(field))
  ) {
    throw new TypeError(`Provider ${action} request is invalid.`);
  }
  const operation = input.operation;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new TypeError(`Provider ${action} operation is required.`);
  }
  const operationFields = Object.keys(operation);
  if (
    operationFields.length !== 5
    || !["id", "projectId", "fence", "attempt", "maxAttempts"].every((field) =>
      operationFields.includes(field))
  ) {
    throw new TypeError(`Provider ${action} operation is invalid.`);
  }
  const projectId = identifier(operation.projectId, "operation.projectId");
  const normalizedOperation = Object.freeze({
    id: identifier(operation.id, "operation.id"),
    projectId,
    fence: positiveInteger(operation.fence, "operation.fence"),
    attempt: positiveInteger(operation.attempt, "operation.attempt"),
    maxAttempts: positiveInteger(operation.maxAttempts, "operation.maxAttempts"),
  });
  if (normalizedOperation.attempt > normalizedOperation.maxAttempts) {
    throw new TypeError(`Provider ${action} operation attempt exceeds maxAttempts.`);
  }
  const generation = positiveInteger(input.generation, "generation");
  const confirmation = nonEmpty(input.confirmation, "confirmation");
  const expected = action === "rollback"
    ? `rollback ${projectId} ${generation}`
    : `delete ${projectId}`;
  if (confirmation !== expected) {
    throw new TypeError(`confirmation must equal "${expected}".`);
  }
  if (!(input.signal instanceof AbortSignal)) {
    throw new TypeError(`Provider ${action} signal must be an AbortSignal.`);
  }
  return Object.freeze({
    operation: normalizedOperation,
    generation,
    confirmation,
    signal: input.signal,
  });
}

function assertAccepted(
  prior: StoredServiceState | null,
  request: DeploymentProviderRequest,
): void {
  if (!prior) return;
  if (prior.phase === "rolling-back" || prior.phase === "deleting") {
    throw new Error("Provider service lifecycle operation is incomplete.");
  }
  const capsuleSha256 = request.runtime?.sha256 ?? null;
  const exact = prior.generation === request.desired.generation
    && prior.state === request.desired.state
    && prior.releaseId === request.desired.releaseId
    && prior.capsuleSha256 === capsuleSha256;
  if (request.desired.generation < prior.generation) {
    throw new Error("Provider service generation is stale.");
  }
  if (request.desired.generation === prior.generation && !exact) {
    throw new Error("Provider service generation conflicts with durable desired state.");
  }
  if (request.operation.fence < prior.fence) {
    throw new Error("Provider service fence is stale.");
  }
  if (
    request.operation.fence === prior.fence
    && request.operation.id !== prior.operationId
  ) {
    throw new Error("Provider service operation conflicts with its durable fence.");
  }
}

function lifecycleRetry(
  prior: StoredServiceState | null,
  request: DeploymentProviderServiceLifecycleRequest,
  intentPhase: "rolling-back" | "deleting",
  completePhase?: "rolled-back",
): "new" | "intent" | "complete" {
  if (!prior) return "new";
  const exact = prior.operationId === request.operation.id
    && prior.fence === request.operation.fence
    && prior.generation === request.generation;
  if (prior.phase === intentPhase && exact) return "intent";
  if (completePhase && prior.phase === completePhase && exact) return "complete";
  if (prior.phase === "rolling-back" || prior.phase === "deleting") {
    throw new Error("Another provider service lifecycle operation is incomplete.");
  }
  if (request.generation < prior.generation) {
    throw new Error("Provider service lifecycle generation is stale.");
  }
  if (request.operation.fence < prior.fence) {
    throw new Error("Provider service lifecycle fence is stale.");
  }
  if (request.operation.fence === prior.fence) {
    throw new Error("Provider service lifecycle operation conflicts with its durable fence.");
  }
  return "new";
}

function assertAcceptedData(
  state: DeploymentProviderDataState | null,
  request: DeploymentProviderRequest,
): void {
  if (!state) return;
  if (request.desired.generation < state.generation) {
    throw new Error("Provider service generation is stale against provider data.");
  }
  if (request.desired.generation === state.generation) {
    if (request.desired.state !== "running" || !matchesData(state, request)) {
      throw new Error("Provider service generation conflicts with provider data.");
    }
    if (request.operation.fence < state.fence) {
      throw new Error("Provider service fence is stale against provider data.");
    }
    return;
  }
  if (request.operation.fence <= state.fence) {
    throw new Error("Provider service fence is stale against provider data.");
  }
}

function lifecycleState(
  request: DeploymentProviderServiceLifecycleRequest,
  phase: "rolling-back" | "rolled-back" | "deleting",
): StoredServiceState {
  return Object.freeze({
    protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
    projectId: request.operation.projectId,
    operationId: request.operation.id,
    fence: request.operation.fence,
    generation: request.generation,
    state: "stopped",
    releaseId: null,
    capsuleSha256: null,
    phase,
    updatedAt: Date.now(),
  });
}

function stateFor(
  request: DeploymentProviderRequest,
  phase: StoredServiceState["phase"],
): StoredServiceState {
  return Object.freeze({
    protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
    projectId: request.operation.projectId,
    operationId: request.operation.id,
    fence: request.operation.fence,
    generation: request.desired.generation,
    state: request.desired.state,
    releaseId: request.desired.releaseId,
    capsuleSha256: request.runtime?.sha256 ?? null,
    phase,
    updatedAt: Date.now(),
  });
}

function matchesData(
  state: DeploymentProviderDataState | null,
  request: DeploymentProviderRequest,
): boolean {
  return Boolean(
    state
    && state.projectId === request.operation.projectId
    && state.releaseId === request.desired.releaseId
    && state.generation === request.desired.generation
    && state.capsuleSha256 === request.runtime?.sha256,
  );
}

function matchesState(
  state: StoredServiceState,
  request: DeploymentProviderRequest,
): boolean {
  return state.generation === request.desired.generation
    && state.state === request.desired.state
    && state.releaseId === request.desired.releaseId
    && state.capsuleSha256 === (request.runtime?.sha256 ?? null);
}

function serviceState(
  value: unknown,
  projectId: string,
): StoredServiceState | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider service state is invalid.");
  }
  const input = value as Record<string, unknown>;
  const expected = [
    "protocol",
    "projectId",
    "operationId",
    "fence",
    "generation",
    "state",
    "releaseId",
    "capsuleSha256",
    "phase",
    "updatedAt",
  ];
  if (
    Object.keys(input).length !== expected.length
    || expected.some((key) => !Object.hasOwn(input, key))
    || input.protocol !== DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL
    || identifier(input.projectId, "state.projectId") !== projectId
  ) {
    throw new Error("Provider service state is invalid.");
  }
  const state = input.state;
  const phase = input.phase;
  if (
    (state !== "running" && state !== "stopped")
    || (
      phase !== "reconciling"
      && phase !== "running"
      && phase !== "stopped"
      && phase !== "rolling-back"
      && phase !== "rolled-back"
      && phase !== "deleting"
    )
    || (phase === "running" && state !== "running")
    || (phase === "stopped" && state !== "stopped")
    || (
      (phase === "rolling-back" || phase === "rolled-back" || phase === "deleting")
      && state !== "stopped"
    )
  ) {
    throw new Error("Provider service state phase is invalid.");
  }
  const releaseId = input.releaseId === null
    ? null
    : identifier(input.releaseId, "state.releaseId");
  const capsuleSha256 = input.capsuleSha256 === null
    ? null
    : pattern(input.capsuleSha256, "state.capsuleSha256", DIGEST);
  if (
    (state === "running" && (!releaseId || !capsuleSha256))
    || (state === "stopped" && (releaseId !== null || capsuleSha256 !== null))
  ) {
    throw new Error("Provider service state binding is invalid.");
  }
  return Object.freeze({
    protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
    projectId,
    operationId: identifier(input.operationId, "state.operationId"),
    fence: positiveInteger(input.fence, "state.fence"),
    generation: positiveInteger(input.generation, "state.generation"),
    state,
    releaseId,
    capsuleSha256,
    phase,
    updatedAt: positiveInteger(input.updatedAt, "state.updatedAt"),
  });
}

function publicState(state: StoredServiceState): DeploymentProviderServiceState {
  return Object.freeze({ ...state });
}

export function deploymentProviderSnapshotPath(projectId: string): string {
  return `${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/${identifier(projectId, "projectId")}/snapshot`;
}

export function deploymentProviderDiagnosticsPath(projectId: string): string {
  return `${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/${identifier(projectId, "projectId")}/diagnostics`;
}

export function deploymentProviderJobsPath(projectId: string): string {
  return `${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/${identifier(projectId, "projectId")}/jobs`;
}

export function deploymentProviderJobMutationPath(
  projectId: string,
  jobId: string,
  action: "cancel" | "retry",
): string {
  if (!/^job_[a-f0-9]{32}$/u.test(jobId)) {
    throw new TypeError("jobId is invalid.");
  }
  if (action !== "cancel" && action !== "retry") {
    throw new TypeError("job action is invalid.");
  }
  return `${deploymentProviderJobsPath(projectId)}/${jobId}/${action}`;
}

function providerJobsResponse(
  binding: ProviderControlBinding,
  payload: { snapshot: unknown } | { mutation: unknown },
): Response {
  const body = JSON.stringify({
    protocol: DEPLOYMENT_PROVIDER_JOBS_PROTOCOL,
    projectId: binding.projectId,
    releaseId: binding.releaseId,
    generation: binding.generation,
    ...payload,
  });
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (bodyBytes > 512 * 1024) {
    throw new Error("Provider jobs response exceeded its bound.");
  }
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(bodyBytes),
      "content-type": DEPLOYMENT_PROVIDER_JOBS_MEDIA_TYPE,
      "x-clank-release-id": binding.releaseId,
      "x-clank-runtime-generation": String(binding.generation),
      "x-content-type-options": "nosniff",
    },
  });
}

function providerControlUnavailableMessage(operation: string): string {
  if (operation === "diagnostics") return "Provider diagnostics are unavailable.";
  if (operation === "jobs" || operation.startsWith("jobs/")) {
    return "Provider job controls are unavailable.";
  }
  return "Provider snapshot is unavailable.";
}

async function readControlJson(
  request: Request,
  maximum: number,
): Promise<unknown> {
  if (request.headers.get("content-type") !== "application/json") {
    throw new TypeError("Provider control request content type is invalid.");
  }
  const declared = request.headers.get("content-length");
  if (!declared || !/^[1-9][0-9]*$/u.test(declared)) {
    throw new TypeError("Provider control request length is invalid.");
  }
  const expected = Number(declared);
  if (!Number.isSafeInteger(expected) || expected > maximum || !request.body) {
    throw new TypeError("Provider control request length is invalid.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > expected || length > maximum) {
        throw new TypeError("Provider control request exceeds its bound.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== expected) {
    throw new TypeError("Provider control request length is invalid.");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Provider control request JSON is invalid.");
  }
}

function exactControlJson(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Provider control request JSON is invalid.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new TypeError("Provider control request JSON is invalid.");
  }
  return value as Record<string, unknown>;
}

function bearerCredential(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer ([^\u0000-\u0020\u007f]{32,512})$/u.exec(value);
  return match?.[1] ?? null;
}

async function secretDigest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function secretMatches(value: string, expected: Uint8Array): Promise<boolean> {
  const actual = await secretDigest(value);
  if (actual.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < actual.byteLength; index++) {
    difference |= actual[index]! ^ expected[index]!;
  }
  return difference === 0;
}

function controlProblem(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readPrivateJson(
  fs: NodeFs,
  filename: string,
): Promise<unknown | null> {
  let handle: NodeFileHandle;
  try {
    handle = await fs.open(
      filename,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return null;
    if (nodeCode(error) === "ELOOP") {
      throw new Error("Provider service state must be a bounded regular file.");
    }
    throw error;
  }
  let encoded: string;
  try {
    const [opened, current] = await Promise.all([
      handle.stat(),
      fs.lstat(filename),
    ]);
    if (
      current.isSymbolicLink()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
      || !opened.isFile()
      || opened.size > MAX_STATE_BYTES
      || (opened.mode & 0o077) !== 0
      || !ownedByCurrentUser(opened)
    ) {
      throw new Error("Provider service state must be a private regular file.");
    }
    encoded = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(encoded);
  } catch {
    throw new Error("Provider service state is invalid JSON.");
  }
}

async function atomicWriteJson(
  fs: NodeFs,
  path: NodePath,
  filename: string,
  value: unknown,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > MAX_STATE_BYTES) {
    throw new Error("Provider service state exceeds 65536 bytes.");
  }
  const temporary = `${filename}.tmp-${crypto.randomUUID()}`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, filename);
    await syncDirectory(fs, path.dirname(filename));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function ensurePrivateDirectory(
  fs: NodeFs,
  directory: string,
  label: string,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || !ownedByCurrentUser(stats)
  ) {
    throw new Error(`${label} must be an owner-controlled real directory.`);
  }
  await fs.chmod(directory, 0o700);
  await privateDirectory(fs, directory, label);
}

async function privateDirectory(
  fs: NodeFs,
  directory: string,
  label: string,
): Promise<string> {
  const stats = await fs.lstat(directory);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || (stats.mode & 0o077) !== 0
    || !ownedByCurrentUser(stats)
  ) {
    throw new Error(`${label} must be a private owner-controlled directory.`);
  }
  return fs.realpath(directory);
}

async function syncDirectory(fs: NodeFs, directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireInside(
  path: NodePath,
  parent: string,
  child: string,
  label: string,
): void {
  const relative = path.relative(parent, child);
  if (!relative || relative === ".." || relative.startsWith(`..${separator()}`)) {
    throw new Error(`${label} is outside its provider root.`);
  }
}

async function providerJobDatabasePath(
  fs: NodeFs,
  path: NodePath,
  root: string,
  projectId: string,
  relative: string,
  maximum: number,
): Promise<string> {
  const projectDirectory = path.join(root, "projects", projectId);
  const dataDirectory = path.join(projectDirectory, "data");
  const database = path.resolve(projectDirectory, relative);
  requireInside(path, dataDirectory, database, "provider job database");
  const resolvedData = await fs.realpath(dataDirectory);
  const sidecars = ["", "-wal", "-shm", "-journal"];
  let total = 0;
  for (const suffix of sidecars) {
    const filename = `${database}${suffix}`;
    let stats: NodeStats;
    try {
      stats = await fs.lstat(filename);
    } catch (error) {
      if (suffix && nodeCode(error) === "ENOENT") continue;
      throw error;
    }
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || (stats.mode & 0o077) !== 0
      || !ownedByCurrentUser(stats)
    ) {
      throw new Error("Provider job database must use private regular files.");
    }
    requireInside(
      path,
      resolvedData,
      await fs.realpath(filename),
      "provider job database file",
    );
    total += stats.size;
    if (!Number.isSafeInteger(total) || total > maximum) {
      throw new Error("Provider job database exceeds its configured bound.");
    }
  }
  return database;
}

function separator(): string {
  return (globalThis as any).process.platform === "win32" ? "\\" : "/";
}

function ownedByCurrentUser(stats: NodeStats): boolean {
  const getuid = (globalThis as any).process.getuid;
  return typeof getuid !== "function" || stats.uid === getuid.call((globalThis as any).process);
}

function requiredComponent<Value>(
  value: Value,
  label: string,
  methods: readonly string[],
): Value {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${label} component is required.`);
  }
  if (methods.some((method) =>
    typeof (value as unknown as Record<string, unknown>)[method] !== "function")) {
    throw new TypeError(`${label} component is invalid.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  return pattern(value, label, IDENTIFIER);
}

function pattern(value: unknown, label: string, expression: RegExp): string {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  return integer(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("Provider service operation was aborted.");
  }
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function nodeFs(): Promise<NodeFs> {
  const name = "node:fs/promises";
  return import(name) as unknown as Promise<NodeFs>;
}

async function nodePath(): Promise<NodePath> {
  const name = "node:path";
  return import(name) as unknown as Promise<NodePath>;
}
