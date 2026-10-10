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
  createDeploymentRuntimeCapsule,
  DEPLOYMENT_RUNTIME_PROTOCOL,
  deploymentRuntimeDigest,
  type DeploymentRuntimeCapsule,
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
    | "deleting"
    | "evacuating";
  readonly updatedAt: number;
}

export type DeploymentProviderServiceLifecycleRequest =
  DeploymentProviderLifecycleRequest;

export interface DeploymentProviderCanaryOptions {
  /** Exact anonymous GET/HEAD paths approved by the provider operator. */
  readonly readPaths: readonly string[];
  readonly maxConcurrent?: number;
  /** Per primary incarnation; capacity exhaustion requires ordinary reconciliation. */
  readonly maxOperations?: number;
  readonly maximumDurationMs?: number;
}

export interface DeploymentProviderCanaryBinding {
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly fence: number;
  /** Opaque provider-issued incarnation; changes after primary reconciliation or restart. */
  readonly incarnation: string;
}

export interface DeploymentProviderCanaryState {
  readonly protocol: "clank-provider-canary/1";
  readonly operationId: string;
  readonly primary: DeploymentProviderCanaryBinding;
  readonly controllerEpoch: number;
  readonly candidateProjectId: string;
  readonly releaseId: string;
  readonly capsuleSha256: string;
  readonly phase: "preparing" | "running" | "stopping" | "stopped";
  readonly expiresAt: number;
}

export interface DeploymentProviderCanaryController {
  binding(projectId: string): Promise<DeploymentProviderCanaryBinding | null>;
  inspect(projectId: string): Promise<DeploymentProviderCanaryState | null>;
  /** Trusted callers must fence their native coordinator lease before and after every await. */
  prepare(input: { readonly primary: DeploymentProviderCanaryBinding; readonly controllerEpoch: number; readonly operationId: string; readonly runtime: DeploymentRuntimeCapsule; readonly signal: AbortSignal }): Promise<DeploymentProviderCanaryState & { readonly route: { readonly projectId: string; readonly releaseId: string; readonly generation: 1; readonly path: string; readonly token: string; readonly readPaths: readonly string[] } }>;
  /** Stops and verifies exact candidate runtime/data absence; it never promotes candidate data. */
  stop(input: { readonly primary: DeploymentProviderCanaryBinding; readonly controllerEpoch: number; readonly operationId: string }): Promise<DeploymentProviderCanaryState>;
}

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
  canaries?: DeploymentProviderCanaryOptions;
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
  canaries?: DeploymentProviderCanaryOptions;
  /** Default private diagnostic hook used by every component. */
  onError?: (error: unknown) => void;
}

export interface DeploymentProviderService extends DeploymentProvider {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL;
  /** Omitted by default. Candidate data can never become the authoritative database. */
  readonly canaries?: DeploymentProviderCanaryController;
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

interface ProviderEvacuationHold {
  id: string;
  projectId: string;
  releaseId: string;
  generation: number;
  tokenDigest: number[];
  writersStopped: boolean;
}

interface ProviderControlBinding {
  projectId: string;
  releaseId: string;
  generation: number;
  tokenDigest: Uint8Array;
  incarnation: string;
}

interface ProviderCanaryJournal {
  protocol: "clank-provider-canary/1";
  spent: string[];
  current: DeploymentProviderCanaryState;
}

interface NodeStats {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  uid?: number;
  nlink: number;
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
  readdir(path: string): Promise<string[]>;
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

interface ProviderServiceOwnership {
  readonly fs: NodeFs;
  readonly path: NodePath;
  readonly root: string;
  readonly serviceDirectory: string;
  close(): void;
}

/**
 * Hold a native write lock for the entire service lifetime. The file is never
 * removed or replaced: a second writer must contend on the same SQLite inode,
 * and process death releases ownership without a clock or a stale PID takeover.
 */
async function acquireProviderServiceOwnership(rootDirectory: string, createRoot = false): Promise<ProviderServiceOwnership> {
  const fs = await nodeFs(), path = await nodePath();
  const requested = path.resolve(nonEmpty(rootDirectory, "rootDirectory"));
  if (createRoot) await ensurePrivateDirectory(fs, requested, "rootDirectory");
  const root = await privateDirectory(fs, requested, "rootDirectory");
  const serviceDirectory = path.join(root, "service");
  await ensurePrivateDirectory(fs, serviceDirectory, "provider service directory");
  requireInside(path, root, await fs.realpath(serviceDirectory), "provider service directory");
  const filename = path.join(serviceDirectory, ".writer.sqlite");
  try {
    const handle = await fs.open(filename, "wx", 0o600);
    await handle.close();
    await syncDirectory(fs, serviceDirectory);
  } catch (error) {
    if (nodeCode(error) !== "EEXIST") throw error;
  }
  // SQLite may open its journal while acquiring/recovering the lock. Validate
  // every possible sidecar before giving native SQLite this private pathname.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const target = filename + suffix;
    let stat: NodeStats;
    try { stat = await fs.lstat(target); }
    catch (error) { if (suffix && nodeCode(error) === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownedByCurrentUser(stat)
      || (stat.mode & 0o077) !== 0 || stat.size > MAX_STATE_BYTES || await fs.realpath(target) !== target) {
      throw new Error("Provider service ownership must use private bounded native SQLite files.");
    }
  }
  const sqliteName = "node:sqlite";
  const { DatabaseSync } = await import(sqliteName) as unknown as {
    DatabaseSync: new (filename: string) => {
      exec(sql: string): void;
      prepare(sql: string): { get(): Record<string, unknown> | undefined; all(): Record<string, unknown>[] };
      close(): void;
    };
  };
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    const schema = database.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (schema.length === 0) {
      database.exec("CREATE TABLE clank_provider_service_owner (protocol INTEGER NOT NULL CHECK(protocol=1)) STRICT; INSERT INTO clank_provider_service_owner VALUES (1)");
    } else if (schema.length !== 1 || schema[0].name !== "clank_provider_service_owner" || schema[0].type !== "table"
      || database.prepare("SELECT * FROM clank_provider_service_owner").all().length !== 1
      || database.prepare("SELECT protocol FROM clank_provider_service_owner").get()?.protocol !== 1) {
      throw new Error("Provider service ownership protocol is unsupported.");
    }
    // Persist the protocol first; acquire the lifetime reservation immediately.
    // If another process wins this brief gap we fail before provider side effects.
    database.exec("COMMIT; BEGIN IMMEDIATE");
    let released = false;
    return Object.freeze({fs, path, root, serviceDirectory, close() {
      if (released) return;
      database.close();
      released = true;
    }});
  } catch (error) {
    database.close();
    const code = (error as { errcode?: number }).errcode;
    if (typeof code === "number" && (code & 255) === 5) throw new Error("Provider service root already has an active writer.");
    throw error;
  }
}

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
  const ownership = await acquireProviderServiceOwnership(options.rootDirectory);
  try { return await openOwnedDeploymentProviderService(options, ownership); }
  catch (error) { ownership.close(); throw error; }
}

async function openOwnedDeploymentProviderService(
  options: DeploymentProviderServiceOptions,
  ownership: ProviderServiceOwnership,
): Promise<DeploymentProviderService> {
  const {fs, path, root, serviceDirectory} = ownership;
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
  const canaryOptions = normalizeProviderCanaryOptions(options.canaries);
  const canaryRoutes = new Map<string, { projectId: string; releaseId: string; generation: 1; path: string; token: string; readPaths: readonly string[] }>();
  const canaryReservations = new Set<string>();
  const canaryIntents = new Map<string,DeploymentProviderCanaryState>();
  const canaryProjectOwners = new Map<string,string>();
  const canaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const canaryDeadlines = new Map<string,number>();
  let canaryIntakeBusy=false;
  const providerIncarnation=crypto.randomUUID();
  const canaryOwnerPath=path.join(serviceDirectory,".canary-controller.json");
  const previousCanaryOwner=await readPrivateJson(fs,canaryOwnerPath);
  if (previousCanaryOwner!==null && (!previousCanaryOwner || typeof previousCanaryOwner!=="object"
    || Array.isArray(previousCanaryOwner)
    || Object.keys(previousCanaryOwner).some(key=>!["protocol","incarnation"].includes(key))
    || (previousCanaryOwner as Record<string,unknown>).protocol!=="clank-provider-canary-owner/1"
    || typeof (previousCanaryOwner as Record<string,unknown>).incarnation!=="string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test((previousCanaryOwner as Record<string,string>).incarnation))) throw new Error("Provider canary owner protocol is unsupported.");
  await atomicWriteJson(fs,path,canaryOwnerPath,{protocol:"clank-provider-canary-owner/1",incarnation:providerIncarnation});
  let closed = false;
  let closing: Promise<void> | undefined;

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

  const evacuationPath = (projectId: string) => path.join(serviceDirectory, `${identifier(projectId, "projectId")}.evacuation.json`);
  const readEvacuation = async (projectId: string): Promise<ProviderEvacuationHold | null> => {
    const value = await readPrivateJson(fs, evacuationPath(projectId));
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider evacuation barrier.");
    const row = value as Record<string, unknown>;
    if (row.projectId !== projectId || typeof row.id !== "string" || !/^evac_[A-Za-z0-9_-]{8,128}$/u.test(row.id)
      || typeof row.releaseId !== "string" || !IDENTIFIER.test(row.releaseId) || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1
      || typeof row.writersStopped !== "boolean" || !Array.isArray(row.tokenDigest) || row.tokenDigest.length !== 32 || row.tokenDigest.some(byte => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255)) throw new Error("Invalid provider evacuation barrier.");
    return { id: row.id, projectId, releaseId: row.releaseId, generation: Number(row.generation), tokenDigest: row.tokenDigest as number[], writersStopped: row.writersStopped };
  };

  const quiesce = async (projectId: string): Promise<void> => {
    await stopCanary(projectId);
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

  const canaryPath = (projectId: string) => path.join(serviceDirectory, `${identifier(projectId, "projectId")}.canary.json`);
  const candidateId = async (state: Pick<DeploymentProviderCanaryState, "primary" | "operationId" | "controllerEpoch" | "capsuleSha256">) =>
    `canary_${await deploymentRuntimeDigest(new TextEncoder().encode([state.primary.projectId, state.primary.incarnation, state.controllerEpoch, state.operationId, state.capsuleSha256].join("\n")))}`;
  const readCanary = async (projectId: string): Promise<ProviderCanaryJournal | null> => {
    const raw = await readPrivateJson(fs, canaryPath(projectId));
    if (raw === null) return null;
    const journal = providerCanaryJournal(raw, projectId);
    if (journal.current.candidateProjectId !== await candidateId(journal.current)) throw new Error("Provider canary ownership identity is invalid.");
    if (journal.current.phase!=="stopped") canaryProjectOwners.set(journal.current.candidateProjectId,projectId);
    return journal;
  };
  const stopCanary = async (projectId: string, expected?: Pick<DeploymentProviderCanaryState,"primary"|"operationId"|"controllerEpoch">): Promise<DeploymentProviderCanaryState | null> => {
    const journal = await readCanary(projectId);
    if (journal && expected && (!sameCanaryBinding(journal.current.primary,expected.primary) || journal.current.operationId!==expected.operationId || journal.current.controllerEpoch!==expected.controllerEpoch)) throw new Error("Provider canary cleanup identity is stale.");
    const timer = canaryTimers.get(projectId);
    if (timer) clearTimeout(timer);
    canaryTimers.delete(projectId);
    canaryDeadlines.delete(projectId);
    canaryRoutes.delete(projectId);
    if (!journal) {
      const intent=canaryIntents.get(projectId);
      if (intent) canaryProjectOwners.delete(intent.candidateProjectId);
      canaryReservations.delete(projectId); canaryIntents.delete(projectId); return null;
    }
    if (journal.current.phase === "stopped") { canaryReservations.delete(projectId); canaryIntents.delete(projectId); canaryProjectOwners.delete(journal.current.candidateProjectId); return journal.current; }
    canaryReservations.add(projectId);
    journal.current = Object.freeze({ ...journal.current, phase:"stopping" });
    await atomicWriteJson(fs, path, canaryPath(projectId), journal);
    const isolatedProject = journal.current.candidateProjectId;
    await cleanupCandidate(null, {projectId:isolatedProject, generation:1});
    if (ingress.inspect().some(route=>route.projectId===isolatedProject)
      || runtimes.inspect().some(runtime=>runtime.projectId===isolatedProject)) throw new Error("Provider canary still has a runtime; data cleanup is refused.");
    await data.delete({projectId:isolatedProject, confirmation:`delete ${isolatedProject}`});
    if (await data.inspect(isolatedProject) || ingress.inspect().some(route=>route.projectId===isolatedProject)
      || runtimes.inspect().some(runtime=>runtime.projectId===isolatedProject)) throw new Error("Provider canary cleanup could not be verified.");
    ingress.forget(isolatedProject,1);
    journal.current = Object.freeze({ ...journal.current, phase:"stopped" });
    await atomicWriteJson(fs, path, canaryPath(projectId), journal);
    canaryReservations.delete(projectId);
    canaryIntents.delete(projectId);
    canaryProjectOwners.delete(isolatedProject);
    return journal.current;
  };
  const primaryBinding = async (projectId: string): Promise<DeploymentProviderCanaryBinding | null> => {
    const control = controls.get(projectId);
    const state = await readProjectState(projectId);
    const owner=await readPrivateJson(fs,canaryOwnerPath) as Record<string,unknown> | null;
    if (closed || !control || controls.get(projectId)!==control || !state || state.phase!=="running" || state.state!=="running"
      || state.releaseId!==control.releaseId || state.generation!==control.generation || owner?.protocol!=="clank-provider-canary-owner/1" || owner.incarnation!==providerIncarnation) return null;
    return Object.freeze({projectId, releaseId:control.releaseId, generation:control.generation, fence:state.fence, incarnation:control.incarnation});
  };
  const requireCanaryBinding = async (expected: DeploymentProviderCanaryBinding) => {
    const actual = await primaryBinding(expected.projectId);
    if (!actual || !sameCanaryBinding(actual,expected)) throw new Error("Provider canary primary binding is stale.");
  };
  const canaries: DeploymentProviderCanaryController | undefined = canaryOptions ? {
    binding(projectId) { return closed ? Promise.resolve(null) : exclusive(identifier(projectId,"projectId"),()=>primaryBinding(projectId)); },
    inspect(projectId) { return exclusive(identifier(projectId,"projectId"),async()=> {
      if (closed) throw new Error("Deployment provider service is closed.");
      return (await readCanary(projectId))?.current ?? null;
    }); },
    async prepare(input) {
      if (closed || canaryIntakeBusy) throw new Error("Provider canary capsule intake is unavailable.");
      canaryIntakeBusy=true;
      try {
      const startedAt=Date.now(),monotonicStartedAt=performance.now();
      const primary = normalizedCanaryBinding(input?.primary);
      const controllerEpoch = positiveInteger(input.controllerEpoch,"controllerEpoch");
      const operationId = identifier(input.operationId,"operationId");
      const signal=input.signal;
      if (!(signal instanceof AbortSignal)) throw new TypeError("Canary signal must be an AbortSignal.");
      throwIfAborted(signal);
      const incoming=input.runtime?.bytes,expectedDigest=pattern(input.runtime?.sha256,"canary capsuleSha256",DIGEST);
      if (!(incoming instanceof Uint8Array) || incoming.byteLength>maxDatabaseBytes+102*1024*1024+32) throw new RangeError("Provider canary capsule exceeds its intake bound.");
      const runtime = await decodeDeploymentRuntimeCapsule(new Uint8Array(incoming),{maxDatabaseBytes});
      if (runtime.sha256!==expectedDigest || runtime.manifest.projectId!==primary.projectId || runtime.manifest.releaseId===primary.releaseId
        || runtime.manifest.database.mode!=="preserve" || runtime.databaseSnapshot || runtime.artifact.bundle.config.jobs) throw new Error("Provider canaries require a distinct code-only release with no declared jobs.");
      return await exclusive(primary.projectId,async()=> {
        let deadline=0;
        const check = async () => {throwIfAborted(signal); await requireCanaryBinding(primary);if (Date.now()<startedAt || deadline && Date.now()>=deadline
          || performance.now()-monotonicStartedAt>=canaryOptions.maximumDurationMs) throw new Error("Provider canary preparation expired or its clock regressed.");};
        await check();
        if (await readEvacuation(primary.projectId)) throw new Error("Provider canary primary is evacuating.");
        const prior = await readCanary(primary.projectId);
        await check();
        if (prior?.current.operationId===operationId) {
          const current=prior.current, route=canaryRoutes.get(primary.projectId);
          if (!sameCanaryBinding(current.primary,primary) || current.controllerEpoch!==controllerEpoch || current.capsuleSha256!==runtime.sha256) throw new Error("Provider canary retry identity differs.");
          if (current.phase!=="running" || !route || current.expiresAt<=Date.now()
            || Date.now()<current.expiresAt-canaryOptions.maximumDurationMs
            || (canaryDeadlines.get(primary.projectId)??0)<=performance.now()) throw new Error("Provider canary operation is retired or needs cleanup.");
          return Object.freeze({...current,route});
        }
        if (prior && prior.current.phase!=="stopped") throw new Error("Provider canary cleanup is unresolved.");
        const spent = prior && sameCanaryBinding(prior.current.primary,primary) ? [...prior.spent] : [];
        if (spent.includes(operationId) || prior && sameCanaryBinding(prior.current.primary,primary) && controllerEpoch<prior.current.controllerEpoch) throw new Error("Provider canary operation or controller epoch is retired.");
        if (spent.length>=canaryOptions.maxOperations || canaryReservations.size>=canaryOptions.maxConcurrent) throw new Error("Provider canary capacity is exhausted.");
        const state: DeploymentProviderCanaryState = Object.freeze({protocol:"clank-provider-canary/1",operationId,primary,controllerEpoch,
          candidateProjectId:await candidateId({primary,operationId,controllerEpoch,capsuleSha256:runtime.sha256}),releaseId:runtime.manifest.releaseId,
          capsuleSha256:runtime.sha256,phase:"preparing",expiresAt:startedAt+canaryOptions.maximumDurationMs});
        deadline=state.expiresAt;
        await check();
        // Reserve the isolated project before any preflight await. An ordinary
        // lifecycle operation already in its lane must finish before preparation.
        if (tails.has(state.candidateProjectId) || canaryProjectOwners.has(state.candidateProjectId)) throw new Error("Provider canary isolated identity is already owned.");
        canaryProjectOwners.set(state.candidateProjectId,primary.projectId);
        try {
          if (await data.inspect(state.candidateProjectId) || await readProjectState(state.candidateProjectId)
            || runtimes.inspect().some(value=>value.projectId===state.candidateProjectId)
            || ingress.inspect().some(value=>value.projectId===state.candidateProjectId)) throw new Error("Provider canary isolated identity is already owned.");
          await check();
          if (canaryReservations.size>=canaryOptions.maxConcurrent) throw new Error("Provider canary capacity is exhausted.");
        } catch (error) {canaryProjectOwners.delete(state.candidateProjectId);throw error;}
        // Reserve synchronously before the first journal await, across project locks.
        canaryReservations.add(primary.projectId);
        canaryIntents.set(primary.projectId,state);
        const journal: ProviderCanaryJournal={protocol:"clank-provider-canary/1",spent:[...spent,operationId],current:state};
        try {
          await atomicWriteJson(fs,path,canaryPath(primary.projectId),journal);
          await check();
          await runtimes.prepareProject?.(state.candidateProjectId,signal);
          await check();
          const snapshot=await data.snapshot(primary.projectId);
          await check();
          if (!snapshot || snapshot.projectId!==primary.projectId || snapshot.releaseId!==primary.releaseId || snapshot.generation!==primary.generation
            || snapshot.bytes.byteLength>maxDatabaseBytes || snapshot.sha256!==await deploymentRuntimeDigest(snapshot.bytes)) throw new Error("Provider canary checkpoint is unavailable.");
          await check();
          const route=Object.freeze({projectId:state.candidateProjectId,releaseId:state.releaseId,generation:1 as const,
            path:`/v1/clank/apps/${state.candidateProjectId}`,token:`clanki_${crypto.randomUUID()}_${crypto.randomUUID()}`,readPaths:canaryOptions.readPaths});
          const isolated=await createDeploymentRuntimeCapsule({projectId:route.projectId,releaseId:route.releaseId,generation:1,environment:{},
            database:{path:runtime.manifest.database.path,mode:"replace",snapshot:snapshot.bytes},ingress:{route:route.path,token:route.token},artifact:runtime.artifact.bytes},{maxDatabaseBytes});
          await check();
          let candidate: DockerDeploymentRuntimeCandidate | null=null;
          await data.apply({operation:{id:operationId,projectId:route.projectId,fence:1,attempt:1,maxAttempts:1},
            desired:{generation:1,state:"running",releaseId:route.releaseId,runtimeProtocol:DEPLOYMENT_RUNTIME_PROTOCOL},runtime:isolated,signal,codeOnly:true},async prepared=> {
              await check();
              candidate=await runtimes.launch({prepared,signal,isolatedReadOnly:true});
              await check();
              if (!candidate.isolatedReadOnly || candidate.projectId!==route.projectId || candidate.generation!==1 || candidate.capsuleSha256!==isolated.sha256) throw new Error("Provider canary isolation acknowledgement is invalid.");
            },async()=> {await cleanupCandidate(null,{projectId:route.projectId,generation:1});});
          await check();
          if (!candidate) throw new Error("Provider canary runtime was not prepared.");
          await ingress.activate({protocol:DEPLOYMENT_RUNTIME_PROTOCOL,...route,upstream:(candidate as DockerDeploymentRuntimeCandidate).upstream});
          await check();
          journal.current=Object.freeze({...state,phase:"running"});
          await atomicWriteJson(fs,path,canaryPath(primary.projectId),journal);
          await check();
          canaryRoutes.set(primary.projectId,route);
          canaryDeadlines.set(primary.projectId,monotonicStartedAt+canaryOptions.maximumDurationMs);
          const timer=setTimeout(()=>{void exclusive(primary.projectId,()=>stopCanary(primary.projectId,state)).catch(report);},Math.max(1,Math.min(state.expiresAt-Date.now(),canaryOptions.maximumDurationMs-(performance.now()-monotonicStartedAt))));
          (timer as unknown as {unref?:()=>void}).unref?.();
          canaryTimers.set(primary.projectId,timer);
          return Object.freeze({...journal.current,route});
        } catch (error) {
          try {await stopCanary(primary.projectId,state);} catch(cleanupError) {throw new AggregateError([error,cleanupError],"Provider canary preparation and cleanup failed.");}
          throw error;
        }
      });
      } finally {canaryIntakeBusy=false;}
    },
    async stop(input) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const primary=normalizedCanaryBinding(input?.primary);
      const operationId=identifier(input.operationId,"operationId"),epoch=positiveInteger(input.controllerEpoch,"controllerEpoch");
      return exclusive(primary.projectId,async()=> {
        if (closed) throw new Error("Deployment provider service is closed.");
        const journal=await readCanary(primary.projectId);
        if (!journal || !sameCanaryBinding(journal.current.primary,primary) || journal.current.operationId!==operationId || journal.current.controllerEpoch!==epoch) throw new Error("Provider canary cleanup identity differs.");
        return (await stopCanary(primary.projectId,journal.current))!;
      });
    },
  } : undefined;

  // Opening any service, including the default/disabled configuration, retires
  // persisted candidates before primary reconciliation can admit another writer.
  const serviceFiles=await fs.readdir(serviceDirectory);
  if (serviceFiles.length>100_000) throw new Error("Provider service metadata capacity is exhausted.");
  for (const name of serviceFiles.filter(name=>name.endsWith(".canary.json"))) {
    const projectId=identifier(name.slice(0,-12),"canary projectId");
    await stopCanary(projectId);
  }

  const service: DeploymentProviderService = {
    protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
    kind,
    ...(canaries ? {canaries:Object.freeze(canaries)} : {}),

    async reconcile(requestInput) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const request = await providerRequest(requestInput, maxDatabaseBytes);
      return exclusive(request.operation.projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        if (canaryProjectOwners.has(request.operation.projectId)) throw new Error("Isolated canary projects cannot use ordinary lifecycle operations.");
        throwIfAborted(request.signal);
        if (await readEvacuation(request.operation.projectId)) throw new Error("Project is fenced for planned evacuation; source writers must remain stopped.");
        const prior = await readProjectState(request.operation.projectId);
        assertAccepted(prior, request);
        await stopCanary(request.operation.projectId);
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
          await runtimes.prepareProject?.(request.operation.projectId, request.signal);
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
              incarnation: crypto.randomUUID(),
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
      const candidateProject=/^\/v1\/clank\/apps\/(canary_[a-f0-9]{64})(?:\/|$)/u.exec(url.pathname)?.[1];
      const primaryProject=candidateProject ? canaryProjectOwners.get(candidateProject) : undefined;
      // The generated prefix is not reserved for ordinary provider projects.
      // Candidate ownership is retained until ingress absence is verified.
      const ordinaryPrimary=candidateProject && !primaryProject && ingress.inspect().some(binding=>
        binding.projectId===candidateProject && binding.path===`/v1/clank/apps/${candidateProject}`);
      if (candidateProject && !ordinaryPrimary) {
        if (!primaryProject) return controlProblem(503,"CANARY_UNAVAILABLE","Provider canary is unavailable.");
        const route=canaryRoutes.get(primaryProject);
        const journal=await readCanary(primaryProject);
        const binding=await primaryBinding(primaryProject);
        if (!route || canaryRoutes.get(primaryProject)!==route || route.projectId!==candidateProject || !journal || journal.current.phase!=="running"
          || journal.current.expiresAt<=Date.now() || Date.now()<journal.current.expiresAt-(canaryOptions?.maximumDurationMs??0)
          || (canaryDeadlines.get(primaryProject)??0)<=performance.now() || !binding || !sameCanaryBinding(binding,journal.current.primary)) return controlProblem(503,"CANARY_UNAVAILABLE","Provider canary is unavailable.");
        const pathname=url.pathname.slice(route.path.length)||"/";
        if (!["GET","HEAD"].includes(request.method) || url.search || request.body || request.headers.has("authorization") || request.headers.has("cookie")
          || request.headers.has("content-length") && request.headers.get("content-length")!=="0" || !route.readPaths.includes(pathname)) return controlProblem(404,"CANARY_READ_REQUIRED","Provider canary permits only approved anonymous reads.");
        const headers=new Headers({"cache-control":"no-store"});
        for (const name of ["x-clank-project-id","x-clank-runtime-protocol","x-clank-runtime-generation","x-clank-runtime-ingress"]) {
          const value=request.headers.get(name);if (value!==null) headers.set(name,value);
        }
        const accept=request.headers.get("accept");if (accept && accept.length<=512) headers.set("accept",accept);
        const result=await ingress.handle(new Request(request.url,{method:request.method,headers,signal:request.signal}));
        const responseHeaders=new Headers(result.headers);
        for (const name of ["set-cookie","clear-site-data","www-authenticate","authentication-info","proxy-authenticate"]) responseHeaders.delete(name);
        responseHeaders.set("cache-control","no-store");
        return new Response(result.body,{status:result.status,statusText:result.statusText,headers:responseHeaders});
      }
      const control = new RegExp(
        `^${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/([A-Za-z0-9_-]{1,128})/(evacuate|snapshot|diagnostics|jobs(?:/(job_[a-f0-9]{32})/(cancel|retry))?)$`,
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
        ((jobMutation || operation === "evacuate") ? request.method !== "POST" : request.method !== "GET")
        || ((operation === "snapshot" || operation === "evacuate" || jobMutation) && url.search)
      ) {
        return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
      }
      const projectId = control[1]!;
      const held = operation === "evacuate" ? await readEvacuation(projectId) : null;
      const binding = controls.get(projectId) ?? (held ? { projectId, releaseId: held.releaseId, generation: held.generation, tokenDigest: new Uint8Array(held.tokenDigest) } : undefined);
      const credential = bearerCredential(request.headers.get("authorization"));
      if (
        !binding
        || !credential
        || !await secretMatches(credential, binding.tokenDigest)
      ) {
        return controlProblem(404, "CONTROL_NOT_FOUND", "Provider control endpoint not found.");
      }
      if (operation === "evacuate") return exclusive(projectId, async () => {
        try {
          if (closed) return controlProblem(503, "PROVIDER_UNAVAILABLE", "Provider is unavailable.");
          const id = request.headers.get("x-clank-evacuation-id") ?? "";
          if (!/^evac_[A-Za-z0-9_-]{8,128}$/u.test(id)) return controlProblem(422, "EVACUATION_ID_REQUIRED", "An exact evacuation plan is required.");
          const prior = await readEvacuation(projectId), state = await readProjectState(projectId);
          if (prior ? prior.id !== id || prior.releaseId !== binding.releaseId || prior.generation !== binding.generation
            : controls.get(projectId) !== binding || !state || state.phase !== "running" || state.releaseId !== binding.releaseId || state.generation !== binding.generation) {
            return controlProblem(409, "PROVIDER_GENERATION_STALE", "Provider generation or evacuation changed.");
          }
          if (!prior) await atomicWriteJson(fs, path, evacuationPath(projectId), { id, projectId, releaseId: binding.releaseId, generation: binding.generation, tokenDigest: [...binding.tokenDigest], writersStopped: false });
          // The durable barrier is written first. Failed stops and restarts stay
          // fenced until this exact evacuation is retried; reconciliation cannot restart writers.
          await quiesce(projectId);
          await atomicWriteJson(fs, path, evacuationPath(projectId), { id, projectId, releaseId: binding.releaseId, generation: binding.generation, tokenDigest: [...binding.tokenDigest], writersStopped: true });
          const snapshot = await data.snapshot(projectId);
          if (!snapshot || snapshot.releaseId !== binding.releaseId || snapshot.generation !== binding.generation
            || snapshot.bytes.byteLength > maxDatabaseBytes || snapshot.sha256 !== await deploymentRuntimeDigest(snapshot.bytes)) throw new Error("Final evacuation snapshot is unavailable.");
          return new Response(new Uint8Array(snapshot.bytes).buffer, { headers: {
            "cache-control": "private, no-store", "content-type": DEPLOYMENT_PROVIDER_SNAPSHOT_MEDIA_TYPE,
            "content-length": String(snapshot.bytes.byteLength), "x-clank-content-sha256": snapshot.sha256,
            "x-clank-release-id": snapshot.releaseId, "x-clank-runtime-generation": String(snapshot.generation),
            "x-clank-evacuation-id": id, "x-clank-writers-stopped": "true", "x-content-type-options": "nosniff",
          } });
        } catch (error) { report(error); return controlProblem(503, "EVACUATION_PAUSED", "Source evacuation is fenced and must be retried."); }
      });
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
        const held = await readEvacuation(projectId);
        if (state && held) return { ...publicState(state), ...(held.writersStopped ? { state: "stopped" as const, releaseId: null, capsuleSha256: null } : {}), phase: "evacuating" };
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
        if (canaryProjectOwners.has(request.operation.projectId)) throw new Error("Isolated canary projects cannot use ordinary lifecycle operations.");
        if (await readEvacuation(request.operation.projectId)) throw new Error("Project is fenced for planned evacuation.");
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
        if (canaryProjectOwners.has(request.operation.projectId)) throw new Error("Isolated canary projects cannot use ordinary lifecycle operations.");
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

    close() {
      if (closing) return closing;
      closed = true;
      controls.clear();
      for (const timer of canaryTimers.values()) clearTimeout(timer);
      canaryTimers.clear();
      const activeOperations = [...tails.values()];
      closing = (async () => {
        const failures: unknown[] = [];
        try {
          try {
            const drained = await ingress.close(drainTimeoutMs);
            if (!drained) failures.push(new Error("Provider ingress did not drain before shutdown."));
          } catch (error) { failures.push(error); }
          try { await runtimes.close(); }
          catch (error) { failures.push(error); }
          await Promise.all(activeOperations);
          for (const projectId of [...canaryReservations]) {
            try {await stopCanary(projectId,canaryIntents.get(projectId));} catch(error) {failures.push(error);}
          }
        } finally {
          try { ownership.close(); } catch (error) { failures.push(error); }
        }
        for (const failure of failures) report(failure);
        if (failures.length > 0) throw new AggregateError(failures, "Deployment provider service failed to close cleanly.");
      })();
      return closing;
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
  // Acquire before the Docker launcher's startup orphan cleanup can touch any
  // containers belonging to an already running service for this provider root.
  const ownership = await acquireProviderServiceOwnership(options.rootDirectory, true);
  let ingress: DeploymentRuntimeIngress | undefined;
  let runtimes: DockerDeploymentRuntimeLauncher | undefined;
  try {
    const data = await openDeploymentProviderDataStore({
      ...(options.data ?? {}),
      rootDirectory: options.rootDirectory,
    });
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
    return await openOwnedDeploymentProviderService({
      rootDirectory: options.rootDirectory,
      data,
      runtimes,
      ingress,
      kind: options.kind,
      drainTimeoutMs: options.drainTimeoutMs,
      maxDatabaseBytes: options.data?.maxDatabaseBytes,
      onError: options.onError,
      canaries: options.canaries,
    }, ownership);
  } catch (error) {
    await Promise.allSettled([
      ...(ingress ? [ingress.close(options.drainTimeoutMs)] : []),
      ...(runtimes ? [runtimes.close()] : []),
    ]);
    ownership.close();
    throw error;
  }
}

function normalizeProviderCanaryOptions(input: DeploymentProviderCanaryOptions | undefined) {
  if (input===undefined) return undefined;
  if (!input || !Array.isArray(input.readPaths) || input.readPaths.length<1 || input.readPaths.length>128 || new Set(input.readPaths).size!==input.readPaths.length
    || input.readPaths.some(value=>typeof value!=="string" || value.length>512 || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/u.test(value)
      || value.split("/").some(part=>part==="." || part===".."))) throw new TypeError("Provider canary paths must be bounded exact public paths.");
  return Object.freeze({readPaths:Object.freeze([...input.readPaths]),maxConcurrent:integer(input.maxConcurrent??4,"canary maxConcurrent",1,64),
    maxOperations:integer(input.maxOperations??32,"canary maxOperations",1,64),maximumDurationMs:integer(input.maximumDurationMs??30*60_000,"canary maximumDurationMs",100,30*60_000)});
}

function normalizedCanaryBinding(input: DeploymentProviderCanaryBinding): DeploymentProviderCanaryBinding {
  if (!input || typeof input!=="object") throw new TypeError("Provider canary binding is required.");
  return Object.freeze({projectId:identifier(input.projectId,"primary.projectId"),releaseId:identifier(input.releaseId,"primary.releaseId"),
    generation:positiveInteger(input.generation,"primary.generation"),fence:positiveInteger(input.fence,"primary.fence"),
    incarnation:pattern(input.incarnation,"primary.incarnation",/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)});
}

function sameCanaryBinding(left: DeploymentProviderCanaryBinding,right: DeploymentProviderCanaryBinding) {
  return left.projectId===right.projectId && left.releaseId===right.releaseId && left.generation===right.generation && left.fence===right.fence && left.incarnation===right.incarnation;
}

function providerCanaryJournal(raw: unknown,projectId: string): ProviderCanaryJournal {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("Provider canary journal is invalid.");
  const value=raw as Record<string,unknown>;
  if (value.protocol!=="clank-provider-canary/1" || Object.keys(value).some(key=>!["protocol","spent","current"].includes(key))
    || !Array.isArray(value.spent) || value.spent.length<1 || value.spent.length>64 || new Set(value.spent).size!==value.spent.length
    || value.spent.some(id=>typeof id!=="string" || !IDENTIFIER.test(id)) || !value.current || typeof value.current!=="object" || Array.isArray(value.current)) throw new Error("Provider canary journal protocol or history is invalid.");
  const entry=value.current as Record<string,unknown>;
  if (entry.protocol!=="clank-provider-canary/1" || Object.keys(entry).some(key=>!["protocol","operationId","primary","controllerEpoch","candidateProjectId","releaseId","capsuleSha256","phase","expiresAt"].includes(key))
    || !["preparing","running","stopping","stopped"].includes(String(entry.phase))) throw new Error("Provider canary journal state is invalid.");
  const primary=normalizedCanaryBinding(entry.primary as DeploymentProviderCanaryBinding);
  const operationId=identifier(entry.operationId,"canary operationId");
  if (primary.projectId!==projectId || !value.spent.includes(operationId)) throw new Error("Provider canary journal scope is invalid.");
  const current=Object.freeze({protocol:"clank-provider-canary/1" as const,primary,operationId,controllerEpoch:positiveInteger(entry.controllerEpoch,"canary controllerEpoch"),
    candidateProjectId:pattern(entry.candidateProjectId,"canary candidateProjectId",/^canary_[a-f0-9]{64}$/u),releaseId:identifier(entry.releaseId,"canary releaseId"),
    capsuleSha256:pattern(entry.capsuleSha256,"canary capsuleSha256",DIGEST),phase:entry.phase as DeploymentProviderCanaryState["phase"],expiresAt:positiveInteger(entry.expiresAt,"canary expiresAt")});
  return {protocol:"clank-provider-canary/1",spent:[...value.spent] as string[],current};
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
  binding: Pick<ProviderControlBinding,"projectId"|"releaseId"|"generation">,
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
