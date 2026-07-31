import { parseDeploymentConfig, type DeploymentConfig } from "./deploy.ts";
import type { PreparedDeploymentRuntimeData } from "./provider-data.ts";

export const DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL = "clank-provider-docker/1";
export const DEPLOYMENT_PROVIDER_DOCKER_DIAGNOSTICS_PROTOCOL_V1 =
  "clank-provider-docker-diagnostics/1";
export const DEPLOYMENT_PROVIDER_DOCKER_DIAGNOSTICS_PROTOCOL =
  "clank-provider-docker-diagnostics/2";

export interface DockerDeploymentRuntimeLauncherOptions {
  /** Same private provider root passed to openDeploymentProviderDataStore(). */
  rootDirectory: string;
  /** Unique owner label for this provider process. */
  owner: string;
  /** Immutable application image reference. Mutable tags are refused by default. */
  image: string;
  executable?: string;
  /**
   * Additional operator-controlled Docker client variables. Capsule
   * environment values are never copied here.
   */
  dockerEnvironment?: Readonly<Record<string, string>>;
  /** Allow a mutable image tag. Defaults to false. */
  allowMutableImage?: boolean;
  /** Explicit container uid:gid. Defaults to the non-root provider process uid:gid. */
  user?: string;
  /** Explicitly allow uid 0 in the application container. Defaults to false. */
  allowContainerRoot?: boolean;
  /** Docker network selected by the operator. Defaults to bridge. */
  network?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** First provider-local application port. Defaults to 46,000. */
  portStart?: number;
  /** Last provider-local application port. Defaults to 49,999. */
  portEnd?: number;
  /** Maximum simultaneous project runtimes. Defaults to 100. */
  maxRuntimes?: number;
  /** Maximum combined web/worker/scheduler containers. Defaults to maxRuntimes × 4. */
  maxContainers?: number;
  /** Docker CLI deadline. Defaults to 15 seconds. */
  commandTimeoutMs?: number;
  /** Graceful container stop deadline. Defaults to 10 seconds. */
  stopTimeoutMs?: number;
  fetch?: typeof fetch;
  /** Receives non-secret infrastructure failures and unexpected exits. */
  onError?: (error: unknown) => void;
}

export interface DockerDeploymentRuntimeLaunchInput {
  readonly prepared: PreparedDeploymentRuntimeData;
  readonly signal: AbortSignal;
  /**
   * Start only the private web candidate. Background workers and the scheduler
   * are retained as a memory-only activation plan until `activate()`.
   */
  readonly deferBackground?: boolean;
}

export interface DockerDeploymentRuntimeCandidate {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL;
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly capsuleSha256: string;
  readonly upstream: string;
}

export interface DockerDeploymentRuntimeState
  extends DockerDeploymentRuntimeCandidate {
  readonly status: "candidate" | "active" | "failed";
  readonly port: number;
  readonly containers: number;
  readonly launchedAt: number;
}

export interface DockerDeploymentRuntimeLog {
  readonly sequence: number;
  readonly createdAt: number;
  readonly role: "web" | "worker" | "scheduler";
  readonly instance: number;
  readonly stream: "stdout" | "stderr" | "platform";
  readonly message: string;
}

export interface DockerDeploymentContainerDiagnostics {
  readonly role: "web" | "worker" | "scheduler";
  readonly instance: number;
  readonly running: boolean;
  readonly memoryBytes: number | null;
  readonly memoryLimitBytes: number | null;
  readonly cpuPercent: number | null;
  readonly networkReceiveBytes: number | null;
  readonly networkTransmitBytes: number | null;
  readonly blockReadBytes: number | null;
  readonly blockWriteBytes: number | null;
  readonly pids: number | null;
}

export interface DockerDeploymentFilesystemDiagnostics {
  /** Whether the provider could safely sample the project data filesystem. */
  readonly available: boolean;
  /** Provider-volume capacity. This is not per-project storage attribution. */
  readonly capacityBytes: number | null;
  /** Allocated bytes across the provider filesystem. */
  readonly usedBytes: number | null;
  /** Bytes available to the provider process after filesystem reservations. */
  readonly availableBytes: number | null;
  /** `usedBytes / capacityBytes`, from zero through one. */
  readonly utilization: number | null;
}

export interface DockerDeploymentRuntimeDiagnostics {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_DOCKER_DIAGNOSTICS_PROTOCOL;
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly sampledAt: number;
  readonly statisticsAvailable: boolean;
  readonly containers: readonly DockerDeploymentContainerDiagnostics[];
  readonly totals: {
    readonly memoryBytes: number | null;
    readonly memoryLimitBytes: number | null;
    readonly cpuPercent: number | null;
    readonly networkReceiveBytes: number | null;
    readonly networkTransmitBytes: number | null;
    readonly blockReadBytes: number | null;
    readonly blockWriteBytes: number | null;
    readonly pids: number | null;
  };
  readonly filesystem: DockerDeploymentFilesystemDiagnostics;
  readonly logs: readonly DockerDeploymentRuntimeLog[];
  readonly retainedLogBytes: number;
  readonly logsTruncated: boolean;
}

export interface DockerDeploymentRuntimeLauncher {
  /**
   * Launches and health-checks an ingress-private candidate. The environment
   * is delivered through container stdin and is not retained by the launcher.
   */
  launch(
    input: DockerDeploymentRuntimeLaunchInput,
  ): Promise<DockerDeploymentRuntimeCandidate>;
  /**
   * Starts a deferred candidate's background topology and atomically marks the
   * complete runtime active. Exact retries are idempotent.
   */
  activate(
    candidate: DockerDeploymentRuntimeCandidate,
    signal: AbortSignal,
  ): Promise<DockerDeploymentRuntimeState>;
  /** Marks an exact healthy candidate active after provider data commits. */
  commit(
    candidate: DockerDeploymentRuntimeCandidate,
  ): DockerDeploymentRuntimeState;
  /** Returns non-secret in-memory runtime metadata. */
  inspect(): readonly DockerDeploymentRuntimeState[];
  /** Returns bounded live output and one non-streaming resource sample. */
  diagnostics(
    projectId: string,
    logLimit?: number,
    signal?: AbortSignal,
  ): Promise<DockerDeploymentRuntimeDiagnostics | null>;
  /** Gracefully stops one exact generation, or the project's current generation. */
  stop(projectId: string, generation?: number): Promise<boolean>;
  /**
   * Releases an inactive generation high-water mark after permanent provider
   * data deletion.
   */
  forget(projectId: string, generation: number): boolean;
  /** Stops tracked runtimes, removes scoped orphans, and rejects new work. */
  close(): Promise<void>;
}

interface NativeChild {
  readonly stdin?: {
    write(value: string): boolean;
    end(): void;
    destroy(error?: Error): void;
  };
  readonly stdout?: AsyncIterable<Uint8Array>;
  readonly stderr?: AsyncIterable<Uint8Array>;
  readonly exitCode?: number | null;
  kill(signal?: string): boolean;
  once(event: "error" | "exit", listener: (...arguments_: any[]) => void): void;
}

interface ContainerProcess {
  id: string;
  role: "web" | "worker" | "scheduler";
  instance: number;
  child: NativeChild;
  expectedStop: boolean;
}

interface RuntimeRecord {
  candidate: DockerDeploymentRuntimeCandidate;
  status: "candidate" | "active" | "failed";
  port: number;
  launchedAt: number;
  containers: ContainerProcess[];
  plannedContainers: number;
  dataDirectory: string;
  deferredBackground: boolean;
  pendingBackground: PendingBackgroundPlan | null;
  controller: AbortController;
  logs: DockerDeploymentRuntimeLog[];
  logBytes: number;
  nextLogSequence: number;
  logsTruncated: boolean;
}

interface PendingBackgroundPlan {
  config: DeploymentConfig;
  releaseDirectory: string;
  dataDirectory: string;
  environment: Readonly<Record<string, string>>;
}

interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

interface ParsedDockerStatistics {
  memoryBytes: number;
  memoryLimitBytes: number;
  cpuPercent: number;
  networkReceiveBytes: number;
  networkTransmitBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

interface NodeFs {
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  realpath(path: string): Promise<string>;
  statfs?(path: string): Promise<{
    bsize: number;
    blocks: number;
    bfree: number;
    bavail: number;
  }>;
}

interface NodePath {
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const HOST_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/u;
const RESOURCE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const USER = /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/u;
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_BYTES = 3 * 1024 * 1024;
const MAX_ENCODED_ENVIRONMENT_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_LOG_BYTES = 128 * 1024;
const MAX_RUNTIME_LOG_ENTRIES = 1_000;
const MAX_RUNTIME_LOG_LINE = 16 * 1024;
const TRUSTED_DOCKER_ENVIRONMENT = Object.freeze([
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CUSTOM_HEADERS",
  "DOCKER_DEFAULT_PLATFORM",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "LANG",
  "LC_ALL",
] as const);

/**
 * Opens the zero-dependency reference Docker launcher used by a trusted Clank
 * provider. Opening removes only containers with both exact Clank owner labels,
 * so a provider restart begins fail closed and desired state can be replayed.
 */
export async function openDockerDeploymentRuntimeLauncher(
  options: DockerDeploymentRuntimeLauncherOptions,
): Promise<DockerDeploymentRuntimeLauncher> {
  if ((globalThis as any).process.platform !== "linux") {
    throw new Error("The Docker deployment runtime launcher currently requires Linux.");
  }
  const fs = await nodeFs();
  const path = await nodePath();
  const root = await canonicalDirectory(
    fs,
    path.resolve(nonEmpty(options.rootDirectory, "rootDirectory")),
    "rootDirectory",
  );
  const owner = stringPattern(options.owner, "owner", OWNER);
  const image = dockerImage(options.image, options.allowMutableImage === true);
  const executable = safeCommand(options.executable ?? "docker", "executable");
  const network = stringPattern(options.network ?? "bridge", "network", RESOURCE_VALUE);
  const memory = stringPattern(options.memory ?? "512m", "memory", RESOURCE_VALUE);
  const cpus = stringPattern(options.cpus ?? "1", "cpus", RESOURCE_VALUE);
  const pidsLimit = integer(options.pidsLimit ?? 128, "pidsLimit", 16, 32_768);
  const portStart = integer(options.portStart ?? 46_000, "portStart", 1_024, 65_535);
  const portEnd = integer(options.portEnd ?? 49_999, "portEnd", portStart, 65_535);
  const maxRuntimes = integer(options.maxRuntimes ?? 100, "maxRuntimes", 1, 10_000);
  const maxContainers = integer(
    options.maxContainers ?? Math.min(100_000, maxRuntimes * 4),
    "maxContainers",
    1,
    100_000,
  );
  const commandTimeoutMs = integer(
    options.commandTimeoutMs ?? 15_000,
    "commandTimeoutMs",
    100,
    120_000,
  );
  const stopTimeoutMs = integer(
    options.stopTimeoutMs ?? 10_000,
    "stopTimeoutMs",
    1_000,
    30_000,
  );
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const user = containerUser(options.user, options.allowContainerRoot === true);
  const hostEnvironment = trustedHostEnvironment(options.dockerEnvironment);
  const records = new Map<string, RuntimeRecord>();
  const candidates = new Map<DockerDeploymentRuntimeCandidate, RuntimeRecord>();
  const highWater = new Map<string, {
    generation: number;
    releaseId: string;
    capsuleSha256: string;
  }>();
  const usedPorts = new Set<number>();
  const tails = new Map<string, Promise<void>>();
  let closed = false;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Provider diagnostics cannot affect runtime state.
    }
  };

  const docker = (
    arguments_: readonly string[],
    commandOptions: {
      signal?: AbortSignal;
      allowFailure?: boolean;
    } = {},
  ): Promise<DockerCommandResult> =>
    runCommand(executable, arguments_, {
      timeoutMs: commandTimeoutMs,
      maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
      environment: hostEnvironment,
      ...commandOptions,
    });

  const orphanIds = await listOwnedContainers(docker, owner);
  if (orphanIds.length > 0) {
    await docker(["container", "rm", "--force", ...orphanIds]);
    const remaining = await listOwnedContainers(docker, owner);
    if (remaining.length > 0) {
      throw new Error("Docker provider orphan cleanup did not converge.");
    }
  }

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

  const removeRecord = async (record: RuntimeRecord, force = false): Promise<void> => {
    record.pendingBackground = null;
    if (!record.controller.signal.aborted) {
      record.controller.abort(new Error("Docker deployment runtime stopped."));
    }
    const processes = [...record.containers];
    for (const process of processes) process.expectedStop = true;
    const ids = processes.map((process) => process.id);
    if (ids.length > 0) {
      if (!force) {
        await docker([
          "container",
          "stop",
          "--time",
          String(Math.ceil(stopTimeoutMs / 1_000)),
          ...ids,
        ], { allowFailure: true });
      }
      await docker(["container", "rm", "--force", ...ids], { allowFailure: true });
    }
    const exact = await listRuntimeContainers(docker, owner, record.candidate);
    if (exact.length > 0) {
      await docker(["container", "rm", "--force", ...exact], { allowFailure: true });
    }
    if ((await listRuntimeContainers(docker, owner, record.candidate)).length > 0) {
      throw new Error(`Docker runtime cleanup did not converge for ${runtimeLabel(record)}.`);
    }
    await Promise.allSettled(processes.map((process) =>
      waitForChildExit(process.child, 2_000)));
    const current = records.get(record.candidate.projectId);
    if (current === record) records.delete(record.candidate.projectId);
    candidates.delete(record.candidate);
    usedPorts.delete(record.port);
  };

  const launchContainer = async (
    record: RuntimeRecord,
    launch: {
      config: DeploymentConfig;
      releaseDirectory: string;
      dataDirectory: string;
      environment: Readonly<Record<string, string>>;
      role: "web" | "worker" | "scheduler";
      instance: number;
      entry: string;
      exposePort: boolean;
      signal: AbortSignal;
    },
  ): Promise<ContainerProcess> => {
    throwIfAborted(launch.signal);
    const environment = runtimeEnvironment(
      launch.environment,
      launch.config,
      record.port,
      launch.role,
    );
    const envelope = new TextEncoder().encode(JSON.stringify(environment));
    if (envelope.byteLength > MAX_ENVIRONMENT_BYTES) {
      throw new RangeError("Runtime environment envelope is too large.");
    }
    const labels = [
      "--label", "run.clank.managed=provider-runtime",
      "--label", `run.clank.owner=${owner}`,
      "--label", `run.clank.project=${record.candidate.projectId}`,
      "--label", `run.clank.release=${record.candidate.releaseId}`,
      "--label", `run.clank.generation=${record.candidate.generation}`,
      "--label", `run.clank.role=${launch.role}`,
      "--label", `run.clank.instance=${launch.instance}`,
    ];
    let created: DockerCommandResult;
    try {
      created = await docker([
        "container",
        "create",
        "--interactive",
        "--pull", "never",
        "--restart", "no",
        "--read-only",
        "--init",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges=true",
        "--pids-limit", String(pidsLimit),
        "--memory", memory,
        "--memory-swap", memory,
        "--cpus", cpus,
        "--user", user,
        "--network", network,
        "--stop-timeout", String(Math.ceil(stopTimeoutMs / 1_000)),
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=8m,mode=755",
        "--log-driver", "local",
        "--log-opt", "max-size=10m",
        "--log-opt", "max-file=3",
        ...labels,
        ...(launch.exposePort
          ? ["--publish", `127.0.0.1:${record.port}:${record.port}`]
          : []),
        "--mount", `type=bind,source=${dockerBindSource(launch.releaseDirectory)},target=/app,readonly`,
        "--mount", `type=bind,source=${dockerBindSource(launch.dataDirectory)},target=/data`,
        "--workdir", "/app",
        image,
        "node",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "--eval",
        DOCKER_STDIN_RUNTIME_LAUNCHER,
        launch.entry,
      ], { signal: launch.signal });
    } catch (error) {
      await cleanupUncertainContainer(docker, owner, record, launch).catch((cleanupError) => {
        throw new AggregateError(
          [error, cleanupError],
          "Docker create failed and its exact runtime cleanup could not be verified.",
        );
      });
      throw error;
    }
    const id = created.stdout.trim();
    if (!CONTAINER_ID.test(id)) {
      await cleanupUncertainContainer(docker, owner, record, launch);
      throw new Error("Docker returned an invalid container identifier.");
    }
    let child: NativeChild | undefined;
    try {
      child = await spawnAttachedDocker(executable, id, hostEnvironment);
      throwIfAborted(launch.signal);
      const process: ContainerProcess = {
        id,
        role: launch.role,
        instance: launch.instance,
        child,
        expectedStop: false,
      };
      record.containers.push(process);
      captureRuntimeOutput(record, process, "stdout", child.stdout);
      captureRuntimeOutput(record, process, "stderr", child.stderr);
      child.once("error", (error) => {
        if (!process.expectedStop) {
          record.status = "failed";
          appendRuntimeLog(
            record,
            process,
            "platform",
            "Docker attachment failed.",
          );
          report(new Error(
            `${runtimeLabel(record)} ${roleLabel(process)} Docker attachment failed: ${safeError(error)}`,
          ));
        }
      });
      child.once("exit", (code, signal) => {
        if (!process.expectedStop) {
          record.status = "failed";
          appendRuntimeLog(
            record,
            process,
            "platform",
            `Process exited (${String(code ?? signal ?? "unknown")}).`,
          );
          report(new Error(
            `${runtimeLabel(record)} ${roleLabel(process)} exited (${String(code ?? signal ?? "unknown")}).`,
          ));
        }
      });
      const encoded = base64Url(envelope);
      if (!child.stdin) throw new Error("Docker attachment stdin is unavailable.");
      child.stdin.write(`${encoded}\n`);
      child.stdin.end();
      return process;
    } catch (error) {
      child?.stdin?.destroy();
      await docker(["container", "rm", "--force", id], { allowFailure: true });
      await cleanupUncertainContainer(docker, owner, record, launch);
      throw error;
    }
  };

  const startBackground = async (
    record: RuntimeRecord,
    plan: PendingBackgroundPlan,
    signal: AbortSignal,
  ): Promise<void> => {
    const jobs = plan.config.jobs;
    if (!jobs) return;
    for (let instance = 0; instance < jobs.workers; instance++) {
      if (closed) throw new Error("Docker deployment runtime launcher is closed.");
      await launchContainer(record, {
        ...plan,
        role: "worker",
        instance,
        entry: jobs.entry,
        exposePort: false,
        signal,
      });
    }
    if (jobs.scheduler) {
      if (closed) throw new Error("Docker deployment runtime launcher is closed.");
      await launchContainer(record, {
        ...plan,
        role: "scheduler",
        instance: 0,
        entry: jobs.entry,
        exposePort: false,
        signal,
      });
    }
    await Promise.all(record.containers.slice(1).map((process) =>
      waitForContainerRunning(docker, process.id, signal)));
  };

  const commitRecord = (record: RuntimeRecord): DockerDeploymentRuntimeState => {
    if (record.status === "failed") {
      throw new Error("Docker deployment runtime candidate has failed.");
    }
    record.status = "active";
    highWater.set(record.candidate.projectId, {
      generation: record.candidate.generation,
      releaseId: record.candidate.releaseId,
      capsuleSha256: record.candidate.capsuleSha256,
    });
    return publicState(record);
  };

  const launcher: DockerDeploymentRuntimeLauncher = {
    async launch(input) {
      if (closed) throw new Error("Docker deployment runtime launcher is closed.");
      if (!(input?.signal instanceof AbortSignal)) {
        throw new TypeError("signal must be an AbortSignal.");
      }
      const prepared = await preparedRuntime(fs, path, root, input.prepared);
      const config = prepared.config;
      const deferBackground = input.deferBackground === true;
      if (config.database.path !== prepared.databaseRelativePath) {
        throw new TypeError("Deployment database path does not match prepared provider data.");
      }
      return exclusive(prepared.projectId, async () => {
        if (closed) throw new Error("Docker deployment runtime launcher is closed.");
        throwIfAborted(input.signal);
        const existing = records.get(prepared.projectId);
        if (existing) {
          if (
            existing.candidate.generation === prepared.generation
            && existing.candidate.releaseId === prepared.releaseId
            && existing.candidate.capsuleSha256 === prepared.capsuleSha256
            && existing.status !== "failed"
            && existing.deferredBackground === deferBackground
          ) {
            return existing.candidate;
          }
          throw new Error("Stop the project's current Docker runtime before launching another generation.");
        }
        const latest = highWater.get(prepared.projectId);
        if (latest && prepared.generation < latest.generation) {
          throw new Error("Docker deployment runtime generation is stale.");
        }
        if (
          latest
          && prepared.generation === latest.generation
          && (
            prepared.releaseId !== latest.releaseId
            || prepared.capsuleSha256 !== latest.capsuleSha256
          )
        ) {
          throw new Error("Docker deployment runtime generation conflicts with committed state.");
        }
        if (records.size >= maxRuntimes) {
          throw new Error("Docker deployment runtime capacity reached.");
        }
        const plannedContainers =
          1 + (config.jobs?.workers ?? 0) + (config.jobs?.scheduler ? 1 : 0);
        const existingContainers = [...records.values()].reduce(
          (total, record) => total + record.plannedContainers,
          0,
        );
        if (existingContainers + plannedContainers > maxContainers) {
          throw new Error("Docker deployment container capacity reached.");
        }
        const port = await reservePort(usedPorts, portStart, portEnd);
        if (closed) {
          usedPorts.delete(port);
          throw new Error("Docker deployment runtime launcher is closed.");
        }
        const candidate = Object.freeze({
          protocol: DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL,
          projectId: prepared.projectId,
          releaseId: prepared.releaseId,
          generation: prepared.generation,
          capsuleSha256: prepared.capsuleSha256,
          upstream: `http://127.0.0.1:${port}`,
        }) satisfies DockerDeploymentRuntimeCandidate;
        const record: RuntimeRecord = {
          candidate,
          status: "candidate",
          port,
          launchedAt: Date.now(),
          containers: [],
          plannedContainers,
          dataDirectory: prepared.dataDirectory,
          deferredBackground: deferBackground,
          pendingBackground: null,
          controller: new AbortController(),
          logs: [],
          logBytes: 0,
          nextLogSequence: 1,
          logsTruncated: false,
        };
        records.set(prepared.projectId, record);
        candidates.set(candidate, record);
        const abortRuntime = (): void => {
          record.controller.abort(
            input.signal.reason ?? new Error("Deployment runtime launch aborted."),
          );
        };
        input.signal.addEventListener("abort", abortRuntime, { once: true });
        try {
          await launchContainer(record, {
            config,
            releaseDirectory: prepared.releaseDirectory,
            dataDirectory: prepared.dataDirectory,
            environment: prepared.environment,
            role: "web",
            instance: 0,
            entry: config.entry,
            exposePort: true,
            signal: record.controller.signal,
          });
          await waitForHealth(
            fetcher,
            candidate.upstream,
            config.health.path,
            config.health.timeoutMs,
            record.controller.signal,
            () => record.status === "failed",
          );
          if (closed) throw new Error("Docker deployment runtime launcher is closed.");
          const background = {
            config,
            releaseDirectory: prepared.releaseDirectory,
            dataDirectory: prepared.dataDirectory,
            environment: prepared.environment,
          };
          if (deferBackground) record.pendingBackground = background;
          else await startBackground(record, background, record.controller.signal);
          throwIfAborted(record.controller.signal);
          if (closed) throw new Error("Docker deployment runtime launcher is closed.");
          if (record.status === "failed") {
            throw new Error("A Docker application process exited during startup.");
          }
          return candidate;
        } catch (error) {
          await removeRecord(record);
          throw error;
        } finally {
          input.signal.removeEventListener("abort", abortRuntime);
        }
      });
    },

    async activate(candidate, signal) {
      if (closed) throw new Error("Docker deployment runtime launcher is closed.");
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError("signal must be an AbortSignal.");
      }
      const initial = candidates.get(candidate);
      if (!initial) throw new Error("Docker deployment runtime candidate is unknown.");
      return exclusive(initial.candidate.projectId, async () => {
        if (closed) throw new Error("Docker deployment runtime launcher is closed.");
        throwIfAborted(signal);
        const record = candidates.get(candidate);
        if (!record || records.get(record.candidate.projectId) !== record) {
          throw new Error("Docker deployment runtime candidate is unknown.");
        }
        if (record.status === "active") return publicState(record);
        if (record.status === "failed") {
          await removeRecord(record);
          throw new Error("Docker deployment runtime candidate has failed.");
        }
        const abortRuntime = (): void => {
          record.controller.abort(
            signal.reason ?? new Error("Deployment runtime activation aborted."),
          );
        };
        signal.addEventListener("abort", abortRuntime, { once: true });
        try {
          const background = record.pendingBackground;
          if (background) {
            await startBackground(record, background, record.controller.signal);
            record.pendingBackground = null;
          }
          throwIfAborted(record.controller.signal);
          if (closed) throw new Error("Docker deployment runtime launcher is closed.");
          return commitRecord(record);
        } catch (error) {
          await removeRecord(record);
          throw error;
        } finally {
          signal.removeEventListener("abort", abortRuntime);
        }
      });
    },

    commit(candidate) {
      if (closed) throw new Error("Docker deployment runtime launcher is closed.");
      const record = candidates.get(candidate);
      if (!record || records.get(record.candidate.projectId) !== record) {
        throw new Error("Docker deployment runtime candidate is unknown.");
      }
      if (record.pendingBackground) {
        throw new Error("Deferred Docker background processes must be activated before commit.");
      }
      return commitRecord(record);
    },

    inspect() {
      return Object.freeze(
        [...records.values()]
          .sort((left, right) =>
            left.candidate.projectId.localeCompare(right.candidate.projectId))
          .map(publicState),
      );
    },

    async diagnostics(projectIdInput, logLimitInput = 200, signal?: AbortSignal) {
      if (closed) throw new Error("Docker deployment runtime launcher is closed.");
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError("signal must be an AbortSignal.");
      }
      const projectId = identifier(projectIdInput, "projectId");
      const logLimit = integer(logLimitInput, "logLimit", 0, 1_000);
      throwIfAborted(signal);
      return exclusive(projectId, async () => {
        if (closed) throw new Error("Docker deployment runtime launcher is closed.");
        throwIfAborted(signal);
        const record = records.get(projectId);
        if (!record) return null;
        const processes = [...record.containers];
        let statisticsAvailable = true;
        let statistics = new Map<string, ParsedDockerStatistics>();
        try {
          const result = await docker([
            "container",
            "stats",
            "--no-stream",
            "--format",
            "{{json .}}",
            ...processes.map((process) => process.id),
          ], { signal });
          statistics = parseDockerStatistics(result.stdout, processes);
        } catch (error) {
          throwIfAborted(signal);
          statisticsAvailable = false;
          report(new Error(
            `${runtimeLabel(record)} resource diagnostics failed.`,
            { cause: error },
          ));
        }
        const containers = processes.map((process) => {
          const sample = statistics.get(process.id);
          return Object.freeze({
            role: process.role,
            instance: process.instance,
            running: process.child.exitCode === null
              || process.child.exitCode === undefined,
            memoryBytes: sample?.memoryBytes ?? null,
            memoryLimitBytes: sample?.memoryLimitBytes ?? null,
            cpuPercent: sample?.cpuPercent ?? null,
            networkReceiveBytes: sample?.networkReceiveBytes ?? null,
            networkTransmitBytes: sample?.networkTransmitBytes ?? null,
            blockReadBytes: sample?.blockReadBytes ?? null,
            blockWriteBytes: sample?.blockWriteBytes ?? null,
            pids: sample?.pids ?? null,
          }) satisfies DockerDeploymentContainerDiagnostics;
        });
        const total = (
          key: keyof ParsedDockerStatistics,
        ): number | null => {
          if (!statisticsAvailable || containers.length === 0) return null;
          let value = 0;
          for (const container of containers) {
            const current = container[key];
            if (typeof current !== "number" || !Number.isFinite(current)) {
              return null;
            }
            value += current;
          }
          return Number.isSafeInteger(value) || key === "cpuPercent"
            ? value
            : null;
        };
        const filesystem = await runtimeFilesystemDiagnostics(
          fs,
          record.dataDirectory,
        );
        throwIfAborted(signal);
        return Object.freeze({
          protocol: DEPLOYMENT_PROVIDER_DOCKER_DIAGNOSTICS_PROTOCOL,
          projectId: record.candidate.projectId,
          releaseId: record.candidate.releaseId,
          generation: record.candidate.generation,
          sampledAt: Date.now(),
          statisticsAvailable,
          containers: Object.freeze(containers),
          totals: Object.freeze({
            memoryBytes: total("memoryBytes"),
            memoryLimitBytes: total("memoryLimitBytes"),
            cpuPercent: total("cpuPercent"),
            networkReceiveBytes: total("networkReceiveBytes"),
            networkTransmitBytes: total("networkTransmitBytes"),
            blockReadBytes: total("blockReadBytes"),
            blockWriteBytes: total("blockWriteBytes"),
            pids: total("pids"),
          }),
          filesystem,
          logs: Object.freeze(
            record.logs.slice(Math.max(0, record.logs.length - logLimit))
              .map((entry) => Object.freeze({ ...entry })),
          ),
          retainedLogBytes: record.logBytes,
          logsTruncated: record.logsTruncated
            || record.logs.length > logLimit,
        }) satisfies DockerDeploymentRuntimeDiagnostics;
      });
    },

    async stop(projectIdInput, generationInput) {
      const projectId = identifier(projectIdInput, "projectId");
      const generation = generationInput === undefined
        ? undefined
        : integer(generationInput, "generation", 1, Number.MAX_SAFE_INTEGER);
      return exclusive(projectId, async () => {
        const record = records.get(projectId);
        if (!record || (generation !== undefined && record.candidate.generation !== generation)) {
          return false;
        }
        await removeRecord(record);
        return true;
      });
    },

    forget(projectIdInput, generationInput) {
      const projectId = identifier(projectIdInput, "projectId");
      const generation = integer(generationInput, "generation", 1, Number.MAX_SAFE_INTEGER);
      if (records.has(projectId) || tails.has(projectId)) return false;
      if (highWater.get(projectId)?.generation !== generation) return false;
      highWater.delete(projectId);
      return true;
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const record of records.values()) {
        record.controller.abort(new Error("Docker deployment runtime launcher is closing."));
      }
      const failures: unknown[] = [];
      for (const result of await Promise.allSettled(
        [...records.values()].map((record) => removeRecord(record)),
      )) {
        if (result.status === "rejected") {
          failures.push(result.reason);
          report(result.reason);
        }
      }
      try {
        const remaining = await listOwnedContainers(docker, owner);
        if (remaining.length > 0) {
          await docker(["container", "rm", "--force", ...remaining]);
        }
        if ((await listOwnedContainers(docker, owner)).length > 0) {
          throw new Error("Docker runtime cleanup did not converge during close.");
        }
      } catch (error) {
        failures.push(error);
        report(error);
      }
      if (failures.length === 0) {
        records.clear();
        candidates.clear();
        highWater.clear();
        usedPorts.clear();
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Docker deployment runtime launcher failed to close cleanly.");
      }
    },
  };
  return Object.freeze(launcher);
}

function publicState(record: RuntimeRecord): DockerDeploymentRuntimeState {
  return Object.freeze({
    ...record.candidate,
    status: record.status,
    port: record.port,
    containers: record.containers.length,
    launchedAt: record.launchedAt,
  });
}

async function preparedRuntime(
  fs: NodeFs,
  path: NodePath,
  root: string,
  input: PreparedDeploymentRuntimeData,
): Promise<{
  projectId: string;
  releaseId: string;
  generation: number;
  capsuleSha256: string;
  releaseDirectory: string;
  dataDirectory: string;
  databaseRelativePath: string;
  config: DeploymentConfig;
  environment: Readonly<Record<string, string>>;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("prepared must be provider runtime data.");
  }
  const projectId = identifier(input.projectId, "prepared.projectId");
  const releaseId = identifier(input.releaseId, "prepared.releaseId");
  const generation = integer(
    input.generation,
    "prepared.generation",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const capsuleSha256 = stringPattern(
    input.capsuleSha256,
    "prepared.capsuleSha256",
    DIGEST,
  );
  const projectsRoot = await canonicalDirectory(
    fs,
    path.join(root, "projects"),
    "provider projects directory",
  );
  requireInside(path, root, projectsRoot, "provider projects directory");
  const projectRoot = path.join(projectsRoot, projectId);
  const canonicalProject = await canonicalDirectory(fs, projectRoot, "provider project");
  requireInside(path, projectsRoot, canonicalProject, "provider project");
  const releaseDirectory = await canonicalDirectory(
    fs,
    absolute(input.releaseDirectory, "prepared.releaseDirectory"),
    "prepared.releaseDirectory",
  );
  requireInside(path, path.join(canonicalProject, "generations"), releaseDirectory, "releaseDirectory");
  const databasePath = await canonicalFile(
    fs,
    absolute(input.databasePath, "prepared.databasePath"),
    "prepared.databasePath",
  );
  const dataDirectory = await canonicalDirectory(
    fs,
    path.join(canonicalProject, "data"),
    "provider data directory",
  );
  requireInside(path, dataDirectory, databasePath, "databasePath");
  const databaseRelativePath = path.relative(dataDirectory, databasePath);
  if (!databaseRelativePath || databaseRelativePath.startsWith("..")) {
    throw new TypeError("Prepared provider database path is invalid.");
  }
  const environment = environmentRecord(input.environment);
  const config = parseDeploymentConfig(input.config);
  return {
    projectId,
    releaseId,
    generation,
    capsuleSha256,
    releaseDirectory,
    dataDirectory,
    databaseRelativePath,
    config,
    environment,
  };
}

function runtimeEnvironment(
  input: Readonly<Record<string, string>>,
  config: DeploymentConfig,
  port: number,
  role: "web" | "worker" | "scheduler",
): Record<string, string> {
  const output = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(input)) output[name] = value;
  delete output.CLANK_PROCESS_ROLE;
  delete output.CLANK_WORKER_CONCURRENCY;
  delete output.CLANK_WORKER_QUEUES;
  const database = `/data/${config.database.path}`;
  Object.assign(output, {
    NODE_ENV: "production",
    HOST: role === "web" ? "0.0.0.0" : "127.0.0.1",
    PORT: String(port),
    CLANK_DATABASE_PATH: database,
    CLANK_DATABASE: database,
    PROACT_DATABASE_PATH: database,
    PROACT_DATABASE: database,
    ALLOWED_HOSTS: "",
    CLANK_MANAGED_INGRESS: "1",
    TRUST_PROXY: "1",
    ...(role === "web"
      ? {}
      : {
          CLANK_PROCESS_ROLE: role,
          ...(role === "worker"
            ? {
                CLANK_WORKER_CONCURRENCY: String(config.jobs!.concurrency),
                CLANK_WORKER_QUEUES: config.jobs!.queues.join(","),
              }
            : {}),
        }),
  });
  return output;
}

function environmentRecord(input: unknown): Readonly<Record<string, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("prepared.environment must be an object.");
  }
  const output = Object.create(null) as Record<string, string>;
  const entries = Object.entries(input);
  if (entries.length > 512) throw new RangeError("prepared.environment has too many entries.");
  for (const [name, value] of entries) {
    if (!ENVIRONMENT_NAME.test(name) || typeof value !== "string" || value.includes("\0")) {
      throw new TypeError("prepared.environment contains an invalid entry.");
    }
    output[name] = value;
  }
  return Object.freeze(output);
}

async function listOwnedContainers(
  docker: (
    arguments_: readonly string[],
    options?: { signal?: AbortSignal; allowFailure?: boolean },
  ) => Promise<DockerCommandResult>,
  owner: string,
): Promise<string[]> {
  return listContainers(docker, [
    "label=run.clank.managed=provider-runtime",
    `label=run.clank.owner=${owner}`,
  ]);
}

async function listRuntimeContainers(
  docker: (
    arguments_: readonly string[],
    options?: { signal?: AbortSignal; allowFailure?: boolean },
  ) => Promise<DockerCommandResult>,
  owner: string,
  candidate: DockerDeploymentRuntimeCandidate,
): Promise<string[]> {
  return listContainers(docker, [
    "label=run.clank.managed=provider-runtime",
    `label=run.clank.owner=${owner}`,
    `label=run.clank.project=${candidate.projectId}`,
    `label=run.clank.release=${candidate.releaseId}`,
    `label=run.clank.generation=${candidate.generation}`,
  ]);
}

async function listContainers(
  docker: (
    arguments_: readonly string[],
    options?: { signal?: AbortSignal; allowFailure?: boolean },
  ) => Promise<DockerCommandResult>,
  filters: readonly string[],
): Promise<string[]> {
  const result = await docker([
    "container",
    "ls",
    "--all",
    "--quiet",
    "--no-trunc",
    ...filters.flatMap((filter) => ["--filter", filter]),
  ]);
  const ids = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID.test(id))) {
    throw new Error("Docker returned an invalid owned-container identifier.");
  }
  return [...new Set(ids)];
}

async function cleanupUncertainContainer(
  docker: (
    arguments_: readonly string[],
    options?: { signal?: AbortSignal; allowFailure?: boolean },
  ) => Promise<DockerCommandResult>,
  owner: string,
  record: RuntimeRecord,
  launch: { role: "web" | "worker" | "scheduler"; instance: number },
): Promise<void> {
  const filters = [
    "label=run.clank.managed=provider-runtime",
    `label=run.clank.owner=${owner}`,
    `label=run.clank.project=${record.candidate.projectId}`,
    `label=run.clank.release=${record.candidate.releaseId}`,
    `label=run.clank.generation=${record.candidate.generation}`,
    `label=run.clank.role=${launch.role}`,
    `label=run.clank.instance=${launch.instance}`,
  ];
  const ids = await listContainers(docker, filters);
  if (ids.length > 0) {
    await docker(["container", "rm", "--force", ...ids], { allowFailure: true });
  }
  if ((await listContainers(docker, filters)).length > 0) {
    throw new Error("Docker uncertain-create cleanup did not converge.");
  }
}

async function waitForContainerRunning(
  docker: (
    arguments_: readonly string[],
    options?: { signal?: AbortSignal; allowFailure?: boolean },
  ) => Promise<DockerCommandResult>,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await docker([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      id,
    ], { signal, allowFailure: true });
    if (result.stdout.trim() === "true") return;
    await delay(50, signal);
  }
  throw new Error("A Docker application process exited during startup.");
}

async function spawnAttachedDocker(
  executable: string,
  id: string,
  environment: Readonly<Record<string, string>>,
): Promise<NativeChild> {
  const childProcessName = "node:child_process";
  const { spawn } = await import(childProcessName) as unknown as {
    spawn(
      executable: string,
      arguments_: string[],
      options: Record<string, unknown>,
    ): NativeChild;
  };
  return spawn(
    executable,
    ["container", "start", "--attach", "--interactive", id],
    {
      env: { ...environment },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    environment: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    allowFailure?: boolean;
  },
): Promise<DockerCommandResult> {
  throwIfAborted(options.signal);
  const childProcessName = "node:child_process";
  const { spawn } = await import(childProcessName) as unknown as {
    spawn(
      executable: string,
      arguments_: string[],
      options: Record<string, unknown>,
    ): NativeChild;
  };
  const child = spawn(executable, [...arguments_], {
    env: { ...options.environment },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let overflow: Error | undefined;
  const collect = async (
    stream: AsyncIterable<Uint8Array> | undefined,
    assign: (value: string) => void,
  ): Promise<void> => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        overflow = new Error("Docker command output exceeded its configured limit.");
        child.kill("SIGKILL");
        break;
      }
      assign(decoder.decode(chunk, { stream: true }));
    }
    assign(decoder.decode());
  };
  const stdoutTask = collect(child.stdout, (value) => {
    stdout += value;
  });
  const stderrTask = collect(child.stderr, (value) => {
    stderr += value;
  });
  let settled = false;
  const exit = new Promise<{ code: unknown; signal: unknown; error?: unknown }>((resolve) => {
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null, error });
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    });
  });
  const abort = (): void => {
    child.kill("SIGKILL");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  const result = await exit;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", abort);
  await Promise.allSettled([stdoutTask, stderrTask]);
  throwIfAborted(options.signal);
  if (overflow) throw overflow;
  if (result.error) throw new Error(`Docker command failed: ${safeError(result.error)}`);
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `Docker command failed (${String(result.code ?? result.signal ?? "unknown")}): `
        + boundedFailure(stderr),
    );
  }
  return { stdout, stderr };
}

async function waitForHealth(
  fetcher: typeof fetch,
  upstream: string,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
  failed: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "application did not respond";
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (failed()) throw new Error("Docker application exited before its health check passed.");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetcher(`${upstream}${path}`, {
        redirect: "manual",
        signal: controller.signal,
        headers: { host: new URL(upstream).host },
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      lastFailure = `health returned ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
      lastFailure = safeError(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    await delay(200, signal);
  }
  throw new Error(`Docker runtime health check timed out: ${lastFailure}.`);
}

async function reservePort(
  used: Set<number>,
  start: number,
  end: number,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (used.has(port)) continue;
    used.add(port);
    if (await portAvailable(port)) return port;
    used.delete(port);
  }
  throw new Error("No provider-local Docker application port is available.");
}

async function portAvailable(port: number): Promise<boolean> {
  const netName = "node:net";
  const net = await import(netName) as unknown as {
    createServer(): {
      listen(options: { host: string; port: number; exclusive: boolean }): void;
      close(callback: () => void): void;
      once(event: "error" | "listening", listener: () => void): void;
    };
  };
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

function captureRuntimeOutput(
  record: RuntimeRecord,
  process: ContainerProcess,
  streamName: "stdout" | "stderr",
  stream: AsyncIterable<Uint8Array> | undefined,
): void {
  if (!stream) return;
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline === -1) break;
          appendRuntimeLog(
            record,
            process,
            streamName,
            buffered.slice(0, newline).replace(/\r$/u, ""),
          );
          buffered = buffered.slice(newline + 1);
        }
        if (buffered.length > MAX_RUNTIME_LOG_LINE) {
          appendRuntimeLog(
            record,
            process,
            streamName,
            buffered.slice(0, MAX_RUNTIME_LOG_LINE),
          );
          buffered = "";
        }
      }
      buffered += decoder.decode();
      if (buffered) {
        appendRuntimeLog(record, process, streamName, buffered);
      }
    } catch {
      // The attached process exit path reports infrastructure failures.
    }
  })();
}

function appendRuntimeLog(
  record: RuntimeRecord,
  process: ContainerProcess,
  stream: "stdout" | "stderr" | "platform",
  value: string,
): void {
  const message = value
    .replace(/\u0000/gu, "")
    .slice(0, MAX_RUNTIME_LOG_LINE);
  if (!message) return;
  const bytes = new TextEncoder().encode(message).byteLength;
  const entry = Object.freeze({
    sequence: record.nextLogSequence++,
    createdAt: Date.now(),
    role: process.role,
    instance: process.instance,
    stream,
    message,
  }) satisfies DockerDeploymentRuntimeLog;
  record.logs.push(entry);
  record.logBytes += bytes;
  while (
    record.logs.length > MAX_RUNTIME_LOG_ENTRIES
    || record.logBytes > MAX_RUNTIME_LOG_BYTES
  ) {
    const removed = record.logs.shift();
    if (!removed) break;
    record.logBytes = Math.max(
      0,
      record.logBytes - new TextEncoder().encode(removed.message).byteLength,
    );
    record.logsTruncated = true;
  }
}

function parseDockerStatistics(
  output: string,
  processes: readonly ContainerProcess[],
): Map<string, ParsedDockerStatistics> {
  const samples = new Map<string, ParsedDockerStatistics>();
  const lines = output.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== processes.length) {
    throw new Error("Docker statistics did not cover the exact runtime.");
  }
  for (const line of lines) {
    if (line.length > 4_096) {
      throw new Error("Docker statistics row is too large.");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Docker statistics output is invalid.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Docker statistics output is invalid.");
    }
    const row = value as Record<string, unknown>;
    const rawId = shortDiagnosticString(row.ID, "Docker statistics ID");
    if (!CONTAINER_ID.test(rawId)) {
      throw new Error("Docker statistics identity is invalid.");
    }
    const process = processes.find((entry) => entry.id.startsWith(rawId));
    if (!process || samples.has(process.id)) {
      throw new Error("Docker statistics identity is invalid.");
    }
    const [memoryBytes, memoryLimitBytes] = diagnosticPair(
      row.MemUsage,
      "Docker memory statistics",
    );
    const [networkReceiveBytes, networkTransmitBytes] = diagnosticPair(
      row.NetIO,
      "Docker network statistics",
    );
    const [blockReadBytes, blockWriteBytes] = diagnosticPair(
      row.BlockIO,
      "Docker block statistics",
    );
    const cpuPercent = diagnosticPercent(row.CPUPerc, "Docker CPU statistics");
    const pids = diagnosticInteger(row.PIDs, "Docker PID statistics");
    samples.set(process.id, {
      memoryBytes,
      memoryLimitBytes,
      cpuPercent,
      networkReceiveBytes,
      networkTransmitBytes,
      blockReadBytes,
      blockWriteBytes,
      pids,
    });
  }
  return samples;
}

function diagnosticPair(value: unknown, label: string): [number, number] {
  const normalized = shortDiagnosticString(value, label);
  const parts = normalized.split(/\s*\/\s*/u);
  if (parts.length !== 2) throw new Error(`${label} is invalid.`);
  return [
    diagnosticBytes(parts[0]!, label),
    diagnosticBytes(parts[1]!, label),
  ];
}

function diagnosticBytes(value: string, label: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)$/iu.exec(value.trim());
  if (!match) throw new Error(`${label} is invalid.`);
  const unit = match[2]!.toLowerCase();
  const exponent = ["b", "kb", "mb", "gb", "tb", "pb", "eb"].indexOf(
    unit.replace("i", ""),
  );
  if (exponent < 0) throw new Error(`${label} is invalid.`);
  const base = unit.includes("i") ? 1_024 : 1_000;
  const result = Number(match[1]) * (base ** exponent);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} is invalid.`);
  }
  return Math.round(result);
}

function diagnosticPercent(value: unknown, label: string): number {
  const normalized = shortDiagnosticString(value, label);
  const match = /^([0-9]+(?:\.[0-9]+)?)%$/u.exec(normalized);
  const result = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(result) || result < 0 || result > 1_000_000) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function diagnosticInteger(value: unknown, label: string): number {
  const normalized = shortDiagnosticString(value, label);
  if (!/^[0-9]{1,12}$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  const result = Number(normalized);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is invalid.`);
  return result;
}

async function runtimeFilesystemDiagnostics(
  fs: NodeFs,
  dataDirectory: string,
): Promise<DockerDeploymentFilesystemDiagnostics> {
  const unavailable = (): DockerDeploymentFilesystemDiagnostics => Object.freeze({
    available: false,
    capacityBytes: null,
    usedBytes: null,
    availableBytes: null,
    utilization: null,
  });
  if (typeof fs.statfs !== "function") return unavailable();
  try {
    const stats = await fs.statfs(dataDirectory);
    const blockSize = safeDiagnosticInteger(stats.bsize);
    const capacityBytes = safeDiagnosticProduct(
      safeDiagnosticInteger(stats.blocks),
      blockSize,
    );
    if (capacityBytes < 1) return unavailable();
    const freeBytes = Math.min(
      capacityBytes,
      safeDiagnosticProduct(safeDiagnosticInteger(stats.bfree), blockSize),
    );
    const availableBytes = Math.min(
      freeBytes,
      safeDiagnosticProduct(safeDiagnosticInteger(stats.bavail), blockSize),
    );
    const usedBytes = capacityBytes - freeBytes;
    return Object.freeze({
      available: true,
      capacityBytes,
      usedBytes,
      availableBytes,
      utilization: usedBytes / capacityBytes,
    });
  } catch {
    return unavailable();
  }
}

function safeDiagnosticInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeDiagnosticProduct(left: number, right: number): number {
  const value = left * right;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function shortDiagnosticString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

async function waitForChildExit(child: NativeChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Operation aborted."));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function trustedHostEnvironment(
  additional: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const source = (globalThis as any).process.env as Record<string, string | undefined>;
  const output = Object.create(null) as Record<string, string>;
  for (const name of TRUSTED_DOCKER_ENVIRONMENT) {
    if (typeof source[name] === "string") output[name] = source[name]!;
  }
  output.PATH = source.PATH ?? "";
  output.HOME = source.HOME ?? "";
  if (additional !== undefined) {
    if (!additional || typeof additional !== "object" || Array.isArray(additional)) {
      throw new TypeError("dockerEnvironment must be an object.");
    }
    const entries = Object.entries(additional);
    if (entries.length > 64) throw new RangeError("dockerEnvironment has too many entries.");
    for (const [name, value] of entries) {
      if (
        !HOST_ENVIRONMENT_NAME.test(name)
        || typeof value !== "string"
        || value.length > 16_384
        || value.includes("\0")
      ) {
        throw new TypeError("dockerEnvironment contains an invalid entry.");
      }
      output[name] = value;
    }
  }
  return Object.freeze(output);
}

function containerUser(input: string | undefined, allowRoot: boolean): string {
  const process = (globalThis as any).process;
  const fallback = `${String(process.getuid?.() ?? 65_532)}:${String(process.getgid?.() ?? 65_532)}`;
  const value = stringPattern(input ?? fallback, "user", USER);
  if (!allowRoot && value.split(":", 1)[0] === "0") {
    throw new Error("Container uid 0 requires allowContainerRoot: true.");
  }
  return value;
}

function dockerImage(value: unknown, allowMutable: boolean): string {
  const image = nonEmpty(value, "image");
  if (
    image.length > 512
    || /[\s\0]/u.test(image)
    || image.startsWith("-")
    || (!allowMutable && !IMAGE_DIGEST.test(image))
  ) {
    throw new TypeError(
      allowMutable
        ? "image is invalid."
        : "image must use an immutable @sha256 digest.",
    );
  }
  return image;
}

function dockerBindSource(value: string): string {
  if (/[:,\r\n\0]/u.test(value)) {
    throw new TypeError("Provider Docker bind paths cannot contain colon, comma, or control characters.");
  }
  return value;
}

function safeCommand(value: unknown, label: string): string {
  const command = nonEmpty(value, label);
  if (command.length > 4_096 || command.includes("\0")) {
    throw new TypeError(`${label} is invalid.`);
  }
  return command;
}

async function canonicalDirectory(
  fs: NodeFs,
  value: string,
  label: string,
): Promise<string> {
  const stats = await fs.lstat(value);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError(`${label} must be a real directory.`);
  }
  return fs.realpath(value);
}

async function canonicalFile(fs: NodeFs, value: string, label: string): Promise<string> {
  const stats = await fs.lstat(value);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TypeError(`${label} must be a real file.`);
  }
  return fs.realpath(value);
}

function requireInside(
  path: NodePath,
  root: string,
  target: string,
  label: string,
): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError(`${label} is outside its provider-owned root.`);
  }
}

function absolute(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (!path.startsWith("/")) throw new TypeError(`${label} must be absolute.`);
  return path;
}

async function nodeFs(): Promise<NodeFs> {
  const name = "node:fs/promises";
  return import(name) as unknown as Promise<NodeFs>;
}

async function nodePath(): Promise<NodePath> {
  const name = "node:path";
  return import(name) as unknown as Promise<NodePath>;
}

function roleLabel(process: ContainerProcess): string {
  return `${process.role}${process.role === "worker" ? `[${process.instance + 1}]` : ""}`;
}

function runtimeLabel(record: RuntimeRecord): string {
  return `${record.candidate.projectId}/g${record.candidate.generation}`;
}

function boundedFailure(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized.slice(0, 1_024) || "no diagnostic output";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64Url(input: Uint8Array): string {
  const buffer = (globalThis as any).process.getBuiltinModule?.("node:buffer")?.Buffer;
  if (!buffer) throw new Error("Node buffer module is unavailable.");
  return buffer.from(input).toString("base64url");
}

function identifier(value: unknown, label: string): string {
  return stringPattern(value, label, IDENTIFIER);
}

function stringPattern(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted.");
}

const DOCKER_STDIN_RUNTIME_LAUNCHER = `
const readline = await import("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let encoded;
for await (const line of lines) {
  encoded = line;
  break;
}
lines.close();
process.stdin.destroy();
if (!encoded || encoded.length > ${MAX_ENCODED_ENVIRONMENT_BYTES}) {
  throw new Error("Clank runtime environment is missing or too large.");
}
const decoded = Buffer.from(encoded, "base64url").toString("utf8");
const environment = JSON.parse(decoded);
if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
  throw new Error("Clank runtime environment is invalid.");
}
for (const [name, value] of Object.entries(environment)) {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) || typeof value !== "string" || value.includes("\\0")) {
    throw new Error("Clank runtime environment is invalid.");
  }
  process.env[name] = value;
}
process.umask(0o077);
const entry = process.argv[1];
if (!entry || entry.startsWith("/") || entry.includes("\\0")) {
  throw new Error("Clank runtime entry is invalid.");
}
const { pathToFileURL } = await import("node:url");
await import(pathToFileURL(entry).href);
`.trim();
