import { openProviderFallbackWatchdog, type ProviderFallbackWatchdog } from "./provider-fallback-watchdog.ts";
import { providerFallbackTargetPublicationLease, providerFallbackTargetLaunchContext, providerFallbackTargetActivationContext, providerFallbackSourceCancellationLease, assertProviderFallbackSourceCancellation, providerFallbackRuntimeRetirementContext, providerFallbackRuntimeCancellationContext, providerFallbackRuntimeResumeContext, providerFallbackRuntimeResumeLifecycleContext, providerFallbackRuntimeResumeCleanupContext } from "./provider-service.ts";
import type { DeploymentProviderRequest } from "./provider.ts";
import { observeProviderFallbackRoles } from "./provider-fallback-native.ts";
import {claimProviderAdoptedTargetLauncher,type providerAdoptedTargetRuntimeContext} from "./provider-target-stage.ts";
import { consumeProviderDockerClient, runProviderDockerClient } from "./provider-docker-client.ts";
import {
  applyLinuxDockerNetworkPolicy, createLinuxDockerNetworkPlan, enforceLinuxProjectDiskQuota, removeLinuxDockerNetworkPolicy,
  type DockerOutboundNetworkPolicy, type LinuxDockerNetworkPlan, type LinuxProjectDiskQuota,
} from "./linux-project-isolation.ts";
import { captureLogLines } from "./security.ts";
import { parseDeploymentConfig, type DeploymentConfig } from "./deploy.ts";
import type { PreparedDeploymentRuntimeData } from "./provider-data.ts";
import { platformColdFallbackResumeSelection, platformColdFallbackNoSweepSelection } from "./platform.ts";
import { cleanupColdFallbackRoles } from "./provider-fallback-cold-native.ts";

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
  /** Privileged, fail-closed XFS project quotas. Choose a unique quota ID for each project. */
  diskQuota?: LinuxProjectDiskQuota | ((projectId: string) => LinuxProjectDiskQuota);
  /** Privileged, fail-closed dedicated Docker bridge and nftables outbound policy. */
  outboundNetwork?: DockerOutboundNetworkPolicy | ((projectId: string) => DockerOutboundNetworkPolicy);
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
  /** @internal Platform-issued read-only cold resume admission. */
  coldFallbackResumeSelection?: object;
  /** @internal Platform-issued exact counterpart admission; permits no mutation. */
  coldFallbackNoSweepSelection?: object;
}

export interface DockerDeploymentRuntimeLaunchInput {
  readonly prepared: PreparedDeploymentRuntimeData;
  readonly signal: AbortSignal;
  /**
   * Start only the private web candidate. Background workers and the scheduler
   * are retained as a memory-only activation plan until `activate()`.
   */
  readonly deferBackground?: boolean;
  /** Candidate-only data mount: read-only, no declared jobs and forced outbound denial. Requires outbound-network enforcement; cannot be activated or committed. */
  readonly isolatedReadOnly?: boolean;
}

export interface DockerDeploymentRuntimeCandidate {
  readonly protocol: typeof DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL;
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly capsuleSha256: string;
  readonly upstream: string;
  /** Present only when filesystem/network enforcement and candidate-only admission are required. */
  readonly isolatedReadOnly?: true;
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
  /** Enforces disk quotas before provider extraction, migration, and application writes. */
  prepareProject?(projectId: string, signal?: AbortSignal): Promise<void>;
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
  child?: NativeChild;
  expectedStop: boolean;
}

interface RuntimeRecord {
  fallbackStaged?: { starts: Array<() => Promise<void>>; started: boolean };
  fallbackPlan?: Readonly<{ config: DeploymentConfig; releaseDirectory: string }>;
  outputObserver?:{close():Promise<void>};
  adopted?:ReturnType<typeof providerAdoptedTargetRuntimeContext>;
  adoptionTimer?:ReturnType<typeof setInterval>;
  adoptionVerification?:Promise<void>;
  isolationNetwork?: { plan: LinuxDockerNetworkPlan; executable?: string };
  candidate: DockerDeploymentRuntimeCandidate;
  status: "candidate" | "active" | "failed";
  port: number;
  launchedAt: number;
  containers: ContainerProcess[];
  plannedContainers: number;
  dataDirectory: string;
  deferredBackground: boolean;
  isolatedReadOnly: boolean;
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
  code: number | null;
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
const DIGEST = /^[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/u;
const RESOURCE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const USER = /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/u;
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_BYTES = 3 * 1024 * 1024;
/** Private original-launcher role lease. Its fields alone grant no authority. */
export interface ProviderDockerRoleLease {
  readonly projectId: string; readonly generation: number; readonly releaseId: string; readonly capsuleSha256: string;
}
type RoleLeaseContext = {
  launcher: DockerDeploymentRuntimeLauncher;
  record: RuntimeRecord;
  observation: Awaited<ReturnType<typeof observeProviderFallbackRoles>>;
  check(): void; verifyRunning(): Promise<void>; stop(): Promise<void>; verifyStopped(): Promise<void>; cleanup(): Promise<void>; verifyCancellation(): Promise<void>; current(): boolean; cancel(): void; publish(): Promise<void>; close(): void;
};
const fallbackLaunchers = new WeakMap<object, { capture(projectId: string, generation: number, capsuleSha256: string, deadline: bigint): Promise<ProviderDockerRoleLease>; arm(target: object, reservation: object): Promise<void>; cancel(target: object): Promise<void>; stage(target: object, reservation: object, prepared: PreparedDeploymentRuntimeData, signal: AbortSignal): Promise<{ candidate: DockerDeploymentRuntimeCandidate; intent: object }>; activate(target: object, reservation: object): Promise<void>; retire(permit: object): Promise<void>; verifyResumed(permit: object): Promise<object>; beginResume(permit: object): Promise<void>; cleanupResume(permit: object): Promise<void>; finishResumeCleanup(permit: object): void; completeResume(permit: object): Promise<void> }>();
const fallbackRoleLeases = new WeakMap<object, RoleLeaseContext>();
type FallbackResumeNativeBinding = { permit: object; launcher: DockerDeploymentRuntimeLauncher; request: DeploymentProviderRequest; evidence: object; check(): void; verifyCreated?(): Promise<void>; verifyRunning?(): Promise<void> };
const fallbackResumeNativeCapabilities = new WeakMap<object, FallbackResumeNativeBinding>();
/** Native evidence can be signed only while its original tracked launcher owns it. */
export function providerFallbackResumeNativeContext(capability: object) {
  const held = fallbackResumeNativeCapabilities.get(capability);
  if (!held) throw new Error("A genuine original native resume capability is required.");
  held.check(); return Object.freeze({ ...held });
}

const fallbackStageInputs = new WeakMap<object, { target: object; reservation: object }>();
export function captureProviderDockerRoleLease(launcher: DockerDeploymentRuntimeLauncher, projectId: string, generation: number, capsuleSha256: string, deadline: bigint): Promise<ProviderDockerRoleLease> {
  const native = fallbackLaunchers.get(launcher);
  if (!native) throw new Error("A genuine original Docker launcher is required for fallback.");
  if (typeof deadline !== "bigint" || deadline <= (globalThis as any).process.hrtime.bigint() || deadline > (globalThis as any).process.hrtime.bigint() + 30000000000n) throw new Error("Fallback requires its original bounded interruption deadline.");
  return native.capture(identifier(projectId, "projectId"), integer(generation, "generation", 1, Number.MAX_SAFE_INTEGER), stringPattern(capsuleSha256, "capsuleSha256", /^[a-f0-9]{64}$/u), deadline);
}
export function providerDockerRoleLeaseContext(lease: object) {
  const held = fallbackRoleLeases.get(lease);
  if (!held) throw new Error("A genuine original Docker role lease is required.");
  held.check();
  return Object.freeze({ evidence: held.observation.evidence, check: held.check, verifyRunning: held.verifyRunning, verifyStopped: held.verifyStopped });
}
export function stopProviderDockerRoleLease(lease: object): Promise<void> {
  const held = fallbackRoleLeases.get(lease); if (!held) throw new Error("A genuine original Docker role lease is required.");
  held.check(); return held.stop();
}
export function closeProviderDockerRoleLease(lease: object): void {
  const held = fallbackRoleLeases.get(lease); if (!held) throw new Error("A genuine original Docker role lease is required.");
  held.close();
}

/** Original-lease cleanup can outlive admission, but cannot issue running authority. */
export function isCurrentProviderDockerRoleLease(lease: object): boolean {
  const held = fallbackRoleLeases.get(lease); if (!held) throw new Error("A genuine original Docker role lease is required."); return held.current();
}

export function cleanupProviderDockerRoleLease(lease: object): Promise<void> {
  const held = fallbackRoleLeases.get(lease); if (!held) throw new Error("A genuine original Docker role lease is required."); return held.cleanup();
}

export async function cancelProviderDockerRoleLease(lease: object, source: object, permit: object): Promise<void> {
  const held = fallbackRoleLeases.get(lease); if (!held) throw new Error("A genuine original Docker role lease is required.");
  if (await providerFallbackSourceCancellationLease(source, permit) !== lease) throw new Error("Fallback source cancellation role lease differs."); await held.verifyCancellation(); assertProviderFallbackSourceCancellation(source, permit); held.cancel();
}

export function armProviderDockerFallbackTarget(launcher: object, target: object, reservation: object): Promise<void> {
  const held = fallbackLaunchers.get(launcher); if (!held) throw new Error("A genuine original Docker launcher is required for fallback."); return held.arm(target, reservation);
}
export function stageProviderDockerFallbackTarget(launcher: object, target: object, reservation: object, prepared: PreparedDeploymentRuntimeData, signal: AbortSignal) {
  const held = fallbackLaunchers.get(launcher); if (!held) throw new Error("A genuine original Docker launcher is required for fallback."); return held.stage(target, reservation, prepared, signal);
}
export function activateProviderDockerFallbackTarget(launcher: object, target: object, reservation: object): Promise<void> {
  const held = fallbackLaunchers.get(launcher); if (!held) throw new Error("A genuine original Docker launcher is required for fallback."); return held.activate(target, reservation);
}
export function closeProviderDockerFallbackTarget(launcher: object, target: object): Promise<void> {
  const held = fallbackLaunchers.get(launcher); if (!held) throw new Error("A genuine original Docker launcher is required for fallback."); return held.cancel(target);
}
export async function retireProviderDockerFallbackCancellation(launcher: object, permit: object): Promise<void> {
  const authority = providerFallbackRuntimeCancellationContext(permit), held = fallbackRoleLeases.get(authority.lease);
  if (!fallbackLaunchers.has(launcher) || authority.launcher !== launcher || !held || held.launcher !== launcher || JSON.stringify(held.observation.evidence) !== JSON.stringify(authority.evidence)) throw new Error("Fallback cancellation requires the exact original running Docker role capture.");
  await authority.verifyRunning(); authority.check(); await held.verifyCancellation();
  // No await may separate the fresh durable/native ownership check from release.
  authority.check(); held.cancel(); authority.finish();
}
export function retireProviderDockerFallbackRecovery(launcher: object, permit: object): Promise<void> {
  const authority = providerFallbackRuntimeRetirementContext(permit), held = fallbackLaunchers.get(launcher);
  if (!held || authority.launcher !== launcher) throw new Error("Fallback retirement requires its original Docker launcher.");
  return held.retire(permit);
}
export function verifyProviderDockerFallbackResumed(launcher: object, permit: object): Promise<object> {
  const authority = providerFallbackRuntimeResumeContext(permit), held = fallbackLaunchers.get(launcher);
  if (!held || authority.launcher !== launcher) throw new Error("Fallback resume observation requires its original Docker launcher.");
  return held.verifyResumed(permit);
}
export function beginProviderDockerFallbackResume(launcher: object, permit: object): Promise<void> {
  const authority = providerFallbackRuntimeResumeLifecycleContext(permit), held = fallbackLaunchers.get(launcher);
  if (!held || authority.launcher !== launcher) throw new Error("Fallback resume lifecycle launcher differs."); return held.beginResume(permit);
}
export function cleanupProviderDockerFallbackResume(launcher: object, permit: object): Promise<void> {
  const authority = providerFallbackRuntimeResumeCleanupContext(permit), held = fallbackLaunchers.get(launcher);
  if (!held || authority.launcher !== launcher) throw new Error("Fallback resume cleanup launcher differs."); return held.cleanupResume(permit);
}
export function completeProviderDockerFallbackResume(launcher: object, permit: object): Promise<void> {
  const authority = providerFallbackRuntimeResumeLifecycleContext(permit), held = fallbackLaunchers.get(launcher);
  if (!held || authority.launcher !== launcher) throw new Error("Fallback resume completion launcher differs."); return held.completeResume(permit);
}
export function finishProviderDockerFallbackResumeCleanup(launcher: object, permit: object): void {
  const authority = providerFallbackRuntimeResumeCleanupContext(permit), held = fallbackLaunchers.get(launcher);
  if (!held || authority.launcher !== launcher) throw new Error("Fallback resume cleanup completion launcher differs."); held.finishResumeCleanup(permit);
}

export async function commitProviderDockerRoleLease(lease: object, target: object, reservation: object, request: DeploymentProviderRequest): Promise<void> {
  const held = fallbackRoleLeases.get(lease); if (!held) throw new Error("A genuine original Docker role lease is required.");
  if (await providerFallbackTargetPublicationLease(target, reservation, request) !== lease) throw new Error("Fallback publication does not own the original role lease.");
  held.check(); await held.verifyRunning(); await held.publish();
}

const MAX_ENCODED_ENVIRONMENT_BYTES = 4 * 1024 * 1024;
const coldFallbackLaunchers = new WeakMap<object, { token: object; selected: boolean; owner: string; root: string; check(): void; verifyStopped(): Promise<void> }>();
/** @internal Only a real launcher that completed authenticated cold admission can attest its stopped state. */
export function providerColdFallbackLauncherContext(launcher: object, token: object) {
  const held = coldFallbackLaunchers.get(launcher);
  if (!held || held.token !== token) throw new Error("A genuine completed cold fallback launcher admission is required.");
  held.check(); return Object.freeze({ ...held });
}
const MAX_RUNTIME_LOG_BYTES = 128 * 1024;
const MAX_RUNTIME_LOG_ENTRIES = 1_000;
const MAX_RUNTIME_LOG_LINE = 16 * 1024;
/**
 * Opens the zero-dependency reference Docker launcher used by a trusted Clank
 * provider. Opening removes only containers with both exact Clank owner labels,
 * so a provider restart begins fail closed and desired state can be replayed.
 */
export async function openDockerDeploymentRuntimeLauncher(
  options: DockerDeploymentRuntimeLauncherOptions,
  adoption?:object,
  coldResumeToken?:object,
): Promise<DockerDeploymentRuntimeLauncher> {
  // Claim the adoption capability before observing even the presence of any
  // caller-supplied launcher option. Structural or copied tokens must fail
  // without triggering hostile getters on `options`.
  const adopted=adoption===undefined?undefined:claimProviderAdoptedTargetLauncher(adoption);
  if (adoption !== undefined && (coldResumeToken !== undefined || options.coldFallbackNoSweepSelection !== undefined)) throw new Error("Adopted-target and cold fallback admissions are mutually exclusive.");
  if (coldResumeToken !== undefined && options.coldFallbackNoSweepSelection !== undefined) throw new Error("Cold fallback cleanup and counterpart admissions are mutually exclusive.");
  const coldResume = coldResumeToken === undefined ? undefined : platformColdFallbackResumeSelection(coldResumeToken);
  const coldNoSweep = options.coldFallbackNoSweepSelection === undefined ? undefined : platformColdFallbackNoSweepSelection(options.coldFallbackNoSweepSelection);
  const coldResumeRecord = coldResume ? JSON.parse(coldResume.resumeJournal) : undefined;
  const coldResumeEvidence = coldResumeRecord?.intent;
  if (coldResume && (coldResumeRecord?.phase !== "stopped" || !coldResumeEvidence || coldResumeEvidence.protocol !== "clank-provider-fallback-launch-intent/1"
    || coldResumeEvidence.projectId !== coldResume.projectId || typeof coldResumeEvidence.owner !== "string" || !Array.isArray(coldResumeEvidence.roles) || !Array.isArray(coldResumeEvidence.paths)))
    throw new Error("Cold fallback resume selection lacks an authenticated exact role launch intent.");
  coldResume?.check();
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
  const client = adopted?.client ?? consumeProviderDockerClient(options);
  const { executable, environment: hostEnvironment } = client;
  const network = stringPattern(options.network ?? "bridge", "network", RESOURCE_VALUE);
  if (options.outboundNetwork && options.network !== undefined) throw new TypeError("outboundNetwork manages its own project bridge; omit network.");
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
  const fallbackReservations = new Map<string, object>();
  const fallbackCloses = new Set<() => void>();
  const fallbackWatchdogs = new Map<string, { target: object; capsuleSha256: string; watchdog: ProviderFallbackWatchdog }>();
  type ResumeTracking = { permit: object; request: DeploymentProviderRequest; capsuleSha256: string; cleaned: boolean; daemonId?: string; watchdog?: ProviderFallbackWatchdog; record?: RuntimeRecord; observation?: Awaited<ReturnType<typeof observeProviderFallbackRoles>>; intentObservation?: Awaited<ReturnType<typeof observeProviderFallbackRoles>>; intentCapability?: object; runningCapability?: object; runningPersisted?: boolean; pins: Array<{ path: string; fd: number; dev: number; ino: number; uid: number; mode: number }> };
  const resumeTracking = new Map<string, ResumeTracking>();
  let coldResumeRecovered = false;
  let coldNoSweepAdmitted = false;
  const nativeFs = (globalThis as any).process.getBuiltinModule("node:fs");
  const checkResume = (held: ResumeTracking, cleanup = false) => {
    const authority = cleanup ? providerFallbackRuntimeResumeCleanupContext(held.permit) : providerFallbackRuntimeResumeLifecycleContext(held.permit);
    authority.check();
    if (closed || authority.launcher !== launcher || authority.request !== held.request || resumeTracking.get(held.request.operation.projectId) !== held
      || records.has(held.request.operation.projectId) && records.get(held.request.operation.projectId) !== held.record) throw new Error("Fallback resume retained native lifecycle changed.");
    for (const pin of held.pins) for (const stat of [nativeFs.fstatSync(pin.fd), nativeFs.lstatSync(pin.path)]) if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || stat.uid !== pin.uid || stat.mode !== pin.mode || stat.mode & 0o022) throw new Error("Fallback resume native path changed.");
    return authority;
  };
  const closeResumePins = (held: ResumeTracking) => { held.observation?.close(); held.observation = undefined; held.intentObservation?.close(); held.intentObservation = undefined; if (held.intentCapability) fallbackResumeNativeCapabilities.delete(held.intentCapability); if (held.runningCapability) fallbackResumeNativeCapabilities.delete(held.runningCapability); for (const pin of held.pins.splice(0).reverse()) nativeFs.closeSync(pin.fd); };

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
    runProviderDockerClient(client, arguments_, {
      timeoutMs: commandTimeoutMs,
      maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
      ...commandOptions,
    });

  if(adopted){
    if(root!==adopted.root||owner!==adopted.domain.owner||network!=="bridge"||memory!=="512m"||cpus!=="1"||pidsLimit!==128||stopTimeoutMs!==10000||commandTimeoutMs!==15000||user!==String((globalThis as any).process.getuid())+":"+String((globalThis as any).process.getgid())||options.allowMutableImage||options.allowContainerRoot||options.diskQuota!==undefined||options.outboundNetwork!==undefined||options.fetch!==undefined||portStart>adopted.port||portEnd<adopted.port)throw new Error("Adopted target differs from its native launcher policy.");
    if(JSON.parse((await docker(["image","inspect",image,"--format","{{json .Id}}"])).stdout)!==adopted.imageId)throw new Error("Adopted target launcher image changed.");
    await adopted.verify();
  }
  if (coldNoSweep) {
    if (coldNoSweep.owner !== owner || coldNoSweep.root !== root) throw new Error("Cold fallback counterpart admission differs from its exact owner/root.");
    coldNoSweep.check();
    const daemonId = JSON.parse((await docker(["info", "--format", "{{json .ID}}"])).stdout);
    coldNoSweep.check();
    if (daemonId !== coldNoSweep.daemonId) throw new Error("Cold fallback counterpart Docker daemon identity changed.");
    coldNoSweepAdmitted = true;
  }
  if (coldResume && coldResumeEvidence) {
    const crypto = (globalThis as any).process.getBuiltinModule("node:crypto");
    if (coldResumeEvidence.owner !== owner || coldResumeEvidence.projectId !== coldResume.projectId || coldResumeEvidence.releaseId !== coldResumeRecord.identity.releaseId
      || coldResumeEvidence.generation !== coldResumeRecord.generation || coldResumeEvidence.capsuleSha256 !== coldResumeRecord.capsuleSha256
      || typeof coldResumeEvidence.daemonId !== "string" || typeof coldResumeEvidence.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(coldResumeEvidence.imageId)
      || coldResumeEvidence.policySha256 !== crypto.createHash("sha256").update(JSON.stringify({ user, network, memory, cpus, pidsLimit })).digest("hex"))
      throw new Error("Cold fallback resume exact native identity or policy differs from its launcher.");
    if (JSON.parse((await docker(["image", "inspect", image, "--format", "{{json .Id}}"])).stdout) !== coldResumeEvidence.imageId)
      throw new Error("Cold fallback resume image differs from its launch intent.");
    await cleanupColdFallbackRoles({ evidence: coldResumeEvidence, record: coldResumeRecord, owner, root, docker, check: coldResume.check,
      stopTimeoutSeconds: Math.ceil(stopTimeoutMs / 1000), nativeFs, path });
    coldResumeRecovered = true;
  }
  // A cold token authenticates only its one role roster. Do not expand that
  // authority into the ordinary process-wide owner sweep after its cleanup.
  const orphanIds = coldResumeRecovered || coldNoSweepAdmitted ? [] : await listOwnedContainers(docker, owner);
  if(adopted){if(orphanIds.length!==1||orphanIds[0]!==adopted.containerId)throw new Error("Adopted target owner inventory changed.");adopted.fast();}
  else if (orphanIds.length > 0) {
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

  const verifyResumeAbsent = async (held: ResumeTracking, cleanup = true) => {
    const authority = checkResume(held, cleanup), expected = new Set(held.record?.containers.map(role => role.id) ?? []);
    const execute = async (args: string[]) => { checkResume(held, cleanup); const result = await runProviderDockerClient(client, args, { timeoutMs: Math.max(1, Math.min(commandTimeoutMs, Number((authority.deadline - (globalThis as any).process.hrtime.bigint()) / 1000000n))), maxOutputBytes: 1024 * 1024 }); checkResume(held, cleanup); return result.stdout; };
    const domain = async () => { const id = JSON.parse(await execute(["info", "--format", "{{json .ID}}"])); if (typeof id !== "string" || !id || held.daemonId && held.daemonId !== id) throw new Error("Fallback resume cleanup daemon changed."); };
    await domain();
    const raw = (await execute(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"])).trim(), ids = raw ? raw.split("\n") : [];
    if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{64}$/u.test(id))) throw new Error("Fallback resume cleanup inventory exceeds its bound.");
    for (const cid of ids) {
      const rows = JSON.parse(await execute(["container", "inspect", cid])), row = rows?.[0];
      if (!Array.isArray(rows) || rows.length !== 1 || row?.Id !== cid || !Array.isArray(row.Mounts)) throw new Error("Fallback resume cleanup inventory differs.");
      if (expected.has(cid) || row.Config?.Labels?.["run.clank.owner"] === owner && row.Config.Labels["run.clank.project"] === held.request.operation.projectId) throw new Error("Fallback resume still has a native role.");
      for (const mount of row.Mounts) if (mount.RW === true) { if (typeof mount.Source !== "string" || !mount.Source.startsWith("/")) throw new Error("Fallback resume competing mount is unverifiable."); const real = nativeFs.realpathSync(mount.Source), stat = nativeFs.statSync(real); if (held.pins.some(pin => real === pin.path || real.startsWith(pin.path + "/") || pin.path.startsWith(real + "/") || stat.dev === pin.dev && stat.ino === pin.ino)) throw new Error("Fallback resume retains a competing writable mount."); }
    }
    const read = (filename: string) => { const fd = nativeFs.openSync(filename, nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW | nativeFs.constants.O_NONBLOCK); try { const buffer = new Uint8Array(65537), count = nativeFs.readSync(fd, buffer, 0, buffer.byteLength, 0); if (count > 65536) throw new Error("Fallback resume process observation exceeds its bound."); return new TextDecoder().decode(buffer.subarray(0, count)); } finally { nativeFs.closeSync(fd); } };
    const processes = nativeFs.readdirSync("/proc").filter((name: string) => /^[1-9][0-9]*$/u.test(name)); if (processes.length > 65536) throw new Error("Fallback resume process inventory exceeds its bound.");
    for (const pid of processes) { checkResume(held, cleanup); let groups: string; try { groups = read("/proc/" + pid + "/cgroup"); } catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; } for (const cid of expected) if (groups.split("\n").some(group => group.endsWith("/docker/" + cid) || group.endsWith("/docker-" + cid + ".scope"))) throw new Error("Fallback resume retains a native role process."); }
    await domain(); checkResume(held, cleanup);
  };

  const inspectIsolationNetwork = async (plan: LinuxDockerNetworkPlan, projectId: string, execute = docker) => {
    const inspected = await execute(["network", "inspect", plan.network], { allowFailure: true });
    if (inspected.code !== 0) {
      const names = await execute(["network", "ls", "--format", "{{.Name}}"]);
      if (names.stdout.split(/\r?\n/).includes(plan.network)) throw new Error("Cannot verify isolated Docker network absence; policy retained.");
      return undefined;
    }
    const states = JSON.parse(inspected.stdout), state = states?.[0];
    if (!Array.isArray(states) || states.length !== 1 || state?.Name !== plan.network || !/^[a-f0-9]{64}$/u.test(state?.Id ?? "")
      || state.Driver !== "bridge" || state.Options?.["com.docker.network.bridge.name"] !== plan.bridge
      || state.Labels?.["run.clank.owner"] !== owner || state.Labels?.["run.clank.project"] !== projectId
      || !state.Containers || typeof state.Containers !== "object" || Array.isArray(state.Containers) || Object.keys(state.Containers).length) {
      throw new Error("Refusing isolated Docker network cleanup without matching empty project ownership.");
    }
    return state.Id as string;
  };

  const removeIsolationNetwork = async (projectId: string, plan: LinuxDockerNetworkPlan, nftExecutable?: string, execute = docker, signal?: AbortSignal) => {
    const containers = await listContainers(execute, ["label=run.clank.managed=provider-runtime", `label=run.clank.owner=${owner}`, `label=run.clank.project=${projectId}`]);
    if (containers.length) throw new Error("Refusing isolated Docker network cleanup while project containers remain.");
    const networkId = await inspectIsolationNetwork(plan, projectId, execute);
    if (networkId) {
      // Remove the inspected identity, never a replacement that reuses its name.
      await execute(["network", "rm", networkId], { allowFailure: true });
      if (await inspectIsolationNetwork(plan, projectId, execute)) throw new Error("Isolated Docker network cleanup did not converge; policy retained.");
    }
    await removeLinuxDockerNetworkPolicy(plan, nftExecutable, signal);
  };

  const removeRecord = async (record: RuntimeRecord, force = false, fallbackDeadline?: bigint): Promise<void> => {
    const resume = resumeTracking.get(record.candidate.projectId);
    if (resume) { if (resume.record !== record) throw new Error("Fallback resume cannot remove a different original runtime."); fallbackDeadline ??= closed ? (globalThis as any).process.hrtime.bigint() + 30000000000n : checkResume(resume, true).deadline; }
    const remaining = () => {
      if (fallbackDeadline === undefined) return commandTimeoutMs;
      const milliseconds = Number((fallbackDeadline - (globalThis as any).process.hrtime.bigint()) / 1000000n);
      if (milliseconds < 1) throw new Error("Fallback interruption deadline expired during exact role cleanup.");
      return Math.min(commandTimeoutMs, milliseconds);
    };
    const execute: typeof docker = fallbackDeadline === undefined ? docker : (args, opts = {}) => runProviderDockerClient(client, args, { timeoutMs: remaining(), maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES, ...opts });
    record.pendingBackground = null;
    if (!record.controller.signal.aborted) {
      record.controller.abort(new Error("Docker deployment runtime stopped."));
    }
    if(record.adoptionTimer)clearInterval(record.adoptionTimer);
    if(record.adoptionVerification)await record.adoptionVerification.catch(()=>{});
    const adopted=record.adopted;
    if(adopted){const results=await Promise.allSettled([adopted.close(),record.outputObserver?.close()??Promise.resolve()]);const errors=results.filter((result):result is PromiseRejectedResult=>result.status==="rejected").map(result=>result.reason);if(errors.length)throw new AggregateError(errors,"Adopted runtime and output observer cleanup failed.");record.adopted=undefined;record.outputObserver=undefined;}
    const processes = [...record.containers];
    for (const process of processes) process.expectedStop = true;
    const ids = processes.map((process) => process.id);
    if (!adopted && ids.length > 0) {
      if (!force) {
        await execute([
          "container",
          "stop",
          "--time",
          String(fallbackDeadline === undefined ? Math.ceil(stopTimeoutMs / 1_000) : Math.max(0, Math.floor(Math.min(stopTimeoutMs, remaining()) / 1_000))),
          ...ids,
        ], { allowFailure: true });
      }
      await execute(["container", "rm", "--force", ...ids], { allowFailure: true });
    }
    const exact = await listRuntimeContainers(execute, owner, record.candidate);
    if ((fallbackDeadline !== undefined || coldResumeRecovered || coldNoSweepAdmitted) && exact.some(id => !ids.includes(id))) throw new Error("Fallback refuses cleanup authority over an unretained role.");
    if (fallbackDeadline === undefined && !coldResumeRecovered && !coldNoSweepAdmitted && exact.length > 0) {
      await execute(["container", "rm", "--force", ...exact], { allowFailure: true });
    }
    if ((await listRuntimeContainers(execute, owner, record.candidate)).length > 0) {
      throw new Error(`Docker runtime cleanup did not converge for ${runtimeLabel(record)}.`);
    }
    await Promise.allSettled(processes.filter(process=>process.child).map((process) =>
      waitForChildExit(process.child!, Math.min(2_000, remaining()))));
    remaining();
    if (record.isolationNetwork) {
      const { plan, executable } = record.isolationNetwork;
      await removeIsolationNetwork(record.candidate.projectId, plan, executable, execute, fallbackDeadline === undefined ? undefined : AbortSignal.timeout(remaining()));
      record.isolationNetwork = undefined;
    }
    remaining();
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
    const resume = resumeTracking.get(record.candidate.projectId);
    if (resume) { checkResume(resume); if (resume.record !== record || !resume.watchdog) throw new Error("Fallback resume create lifecycle differs."); }
    const watchdog = fallbackWatchdogs.get(record.candidate.projectId) ?? (resume?.watchdog ? { capsuleSha256: resume.capsuleSha256, watchdog: resume.watchdog } : undefined);
    const createArguments = [
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
        "--network", record.isolationNetwork?.plan.network ?? network,
        ...(record.isolationNetwork ? ["--dns", "127.0.0.1", "--dns-option", "attempts:1", "--dns-option", "timeout:1",
          ...Object.entries(record.isolationNetwork.plan.hosts).flatMap(([name, address]) => ["--add-host", `${name}:${address}`])] : []),
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
        "--mount", `type=bind,source=${dockerBindSource(launch.dataDirectory)},target=/data${record.isolatedReadOnly ? ",readonly" : ""}`,
        "--workdir", "/app",
        image,
        "node",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "--eval",
        DOCKER_STDIN_RUNTIME_LAUNCHER,
        launch.entry,
      ];
    let created: DockerCommandResult;
    try {
      if (watchdog) { if (watchdog.capsuleSha256 !== record.candidate.capsuleSha256) throw new Error("Fallback watchdog capsule differs."); created = { stdout: await watchdog.watchdog.create(createArguments), stderr: "", code: 0 }; }
      else created = await docker(createArguments, { signal: launch.signal });
    } catch (error) {
      if (watchdog) throw error;
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
    const process: ContainerProcess = { id, role: launch.role, instance: launch.instance, expectedStop: false };
    record.containers.push(process);
    if (resume) checkResume(resume);
    const attach = async (): Promise<void> => {
    let child: NativeChild | undefined;
    try {
      watchdog?.watchdog.check();
      if (resume) checkResume(resume);
      child = await spawnAttachedDocker(executable, id, hostEnvironment);
      throwIfAborted(launch.signal);
      process.child = child;
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
      if (resume) checkResume(resume);
    } catch (error) {
      child?.stdin?.destroy();
      await docker(["container", "rm", "--force", id], { allowFailure: true });
      if (!watchdog) await cleanupUncertainContainer(docker, owner, record, launch);
      throw error;
    }
    };
    if (record.fallbackStaged) record.fallbackStaged.starts.push(attach); else await attach();
    return process;
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
    if (record.fallbackStaged) return;
    await Promise.all(record.containers.slice(1).map((process) =>
      waitForContainerRunning(docker, process.id, signal)));
  };

  const commitRecord = (record: RuntimeRecord): DockerDeploymentRuntimeState => {
    const resume = resumeTracking.get(record.candidate.projectId);
    if (resume) { checkResume(resume); if (resume.record !== record || !resume.watchdog) throw new Error("Fallback resume commit runtime differs."); resume.watchdog.check(); }
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

  const prepareProject = async (projectId: string, signal?: AbortSignal): Promise<void> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new TypeError("Invalid project isolation identifier.");
    if (closed) throw new Error("Docker deployment runtime launcher is closed.");
    if (!options.diskQuota) return;
    const quota = typeof options.diskQuota === "function" ? options.diskQuota(projectId) : options.diskQuota;
    await enforceLinuxProjectDiskQuota(quota, path.join(root, "projects", projectId), path.join(root, ".isolation-quotas"), projectId, signal);
  };

  const launcher: DockerDeploymentRuntimeLauncher = {
    prepareProject,
    async launch(input) {
      if (closed) throw new Error("Docker deployment runtime launcher is closed.");
      if (!(input?.signal instanceof AbortSignal)) {
        throw new TypeError("signal must be an AbortSignal.");
      }
      if (input.isolatedReadOnly !== undefined && typeof input.isolatedReadOnly !== 'boolean') throw new TypeError('isolatedReadOnly must be a boolean.');
      const isolatedReadOnly=input.isolatedReadOnly===true;
      if (isolatedReadOnly && !options.outboundNetwork) throw new TypeError('Isolated read-only candidates require outbound network enforcement.');
      const prepared = await preparedRuntime(fs, path, root, input.prepared);
      const config = prepared.config;
      const fallbackStage = fallbackStageInputs.get(input);
      if (fallbackStage) { const authority = providerFallbackTargetLaunchContext(fallbackStage.target, fallbackStage.reservation); if (authority.launcher !== launcher || authority.projectId !== prepared.projectId || authority.capsuleSha256 !== prepared.capsuleSha256) throw new Error("Fallback staging authority differs."); }
      const deferBackground = input.deferBackground === true;
      if (isolatedReadOnly && ((config.jobs?.workers ?? 0)>0 || config.jobs?.scheduler)) throw new TypeError("Isolated read-only candidates cannot declare background workers or schedulers.");
      if (config.database.path !== prepared.databaseRelativePath) {
        throw new TypeError("Deployment database path does not match prepared provider data.");
      }
      return exclusive(prepared.projectId, async () => {
        if (closed) throw new Error("Docker deployment runtime launcher is closed.");
        const resume = resumeTracking.get(prepared.projectId);
        if (resume) { checkResume(resume); if (resume.capsuleSha256 !== prepared.capsuleSha256 || resume.request.desired.generation !== prepared.generation || resume.request.desired.releaseId !== prepared.releaseId || input.signal !== resume.request.signal || !resume.watchdog || resume.record && records.get(prepared.projectId) !== resume.record) throw new Error("Fallback resume launch differs from its original request."); }
        throwIfAborted(input.signal);
        if (fallbackReservations.has(prepared.projectId)) throw new Error("Project is fenced by its original fallback role lease.");
        const existing = records.get(prepared.projectId);
        if (existing) {
          if (
            existing.candidate.generation === prepared.generation
            && existing.candidate.releaseId === prepared.releaseId
            && existing.candidate.capsuleSha256 === prepared.capsuleSha256
            && existing.status !== "failed"
            && existing.deferredBackground === deferBackground
            && existing.isolatedReadOnly === isolatedReadOnly
          ) {
            if(existing.adopted)await existing.adopted.verify();
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
          ...(isolatedReadOnly ? {isolatedReadOnly:true as const} : {}),
        }) satisfies DockerDeploymentRuntimeCandidate;
        const record: RuntimeRecord = {
          candidate,
          status: "candidate",
          port,
          launchedAt: Date.now(),
          containers: [],
          plannedContainers,
          dataDirectory: prepared.dataDirectory,
          fallbackPlan: Object.freeze({ config, releaseDirectory: prepared.releaseDirectory }),
          ...(fallbackStage || resume ? { fallbackStaged: { starts: [], started: false } } : {}),
          deferredBackground: deferBackground,
          isolatedReadOnly,
          pendingBackground: null,
          controller: new AbortController(),
          logs: [],
          logBytes: 0,
          nextLogSequence: 1,
          logsTruncated: false,
        };
        records.set(prepared.projectId, record);
        candidates.set(candidate, record);
        if (resume) resume.record = record;
        const abortRuntime = (): void => {
          record.controller.abort(
            input.signal.reason ?? new Error("Deployment runtime launch aborted."),
          );
        };
        input.signal.addEventListener("abort", abortRuntime, { once: true });
        try {
          if (resume) { checkResume(resume); if (resume.pins.length !== 2 || resume.pins[0].path !== record.dataDirectory || resume.pins[1].path !== record.fallbackPlan!.releaseDirectory) throw new Error("Fallback resume prepared directories differ from its original stopped data."); }
          await prepareProject(prepared.projectId, record.controller.signal);
          if (options.outboundNetwork) {
            const configuredPolicy = typeof options.outboundNetwork === "function" ? options.outboundNetwork(prepared.projectId) : options.outboundNetwork;
            const policy = isolatedReadOnly ? {allowCidrs:[],hosts:{},nftExecutable:configuredPolicy.nftExecutable} : configuredPolicy;
            const plan = await createLinuxDockerNetworkPlan(owner, prepared.projectId, policy);
            const existing = await docker(["network", "inspect", plan.network], { allowFailure: true });
            if (existing.code === 0) {
              const state = JSON.parse(existing.stdout)[0];
              if (state?.Labels?.["run.clank.owner"] !== owner || state?.Labels?.["run.clank.project"] !== prepared.projectId || Object.keys(state?.Containers ?? {}).length) {
                throw new Error("Refusing an existing Docker network without matching empty project ownership.");
              }
              await docker(["network", "rm", plan.network]);
            }
            await applyLinuxDockerNetworkPolicy(plan, policy.nftExecutable, record.controller.signal);
            record.isolationNetwork = { plan, executable: policy.nftExecutable };
            await docker(["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${plan.bridge}`,
              "--opt", "com.docker.network.bridge.enable_icc=false", "--ipv6=false",
              "--label", `run.clank.owner=${owner}`, "--label", `run.clank.project=${prepared.projectId}`, plan.network], { signal: record.controller.signal });
            const inspected = JSON.parse((await docker(["network", "inspect", plan.network])).stdout)[0];
            if (inspected?.Driver !== "bridge" || inspected?.Options?.["com.docker.network.bridge.name"] !== plan.bridge
              || inspected?.EnableIPv6 !== false || inspected?.Labels?.["run.clank.owner"] !== owner) {
              throw new Error("Dedicated Docker network verification failed; runtime launch is refused.");
            }
          }
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
          if (!fallbackStage && !resume) await waitForHealth(
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
          if (!isolatedReadOnly) {
            if (deferBackground && !resume) record.pendingBackground = background;
            else await startBackground(record, background, record.controller.signal);
          }
          throwIfAborted(record.controller.signal);
          if (closed) throw new Error("Docker deployment runtime launcher is closed.");
          if (record.status === "failed") {
            throw new Error("A Docker application process exited during startup.");
          }
          if (resume) {
            checkResume(resume); const authority = providerFallbackRuntimeResumeLifecycleContext(resume.permit), stage = record.fallbackStaged;
            if (!stage || stage.started || record.containers.length !== plannedContainers || stage.starts.length !== plannedContainers) throw new Error("Fallback resume staged role roster is incomplete.");
            const observation = await observeProviderFallbackRoles({ client, owner, projectId: prepared.projectId, releaseId: prepared.releaseId, generation: prepared.generation, capsuleSha256: prepared.capsuleSha256, image, user,
              network: record.isolationNetwork?.plan.network ?? network, memory, cpus, pidsLimit, releaseDirectory: prepared.releaseDirectory, dataDirectory: prepared.dataDirectory, deadline: authority.deadline, created: true,
              roles: record.containers.map(role => ({ role: role.role, instance: role.instance, containerId: role.id, command: ["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", DOCKER_STDIN_RUNTIME_LAUNCHER, role.role === "web" ? config.entry : config.jobs!.entry] })) });
            resume.intentObservation = observation;
            const capability = Object.freeze({}); resume.intentCapability = capability;
            const current = () => { checkResume(resume); observation.check(); if (resume.intentCapability !== capability || resume.record !== record || records.get(prepared.projectId) !== record || candidates.get(candidate) !== record || record.controller.signal.aborted) throw new Error("Fallback resume staged native capability changed."); };
            fallbackResumeNativeCapabilities.set(capability, { permit: resume.permit, launcher, request: resume.request, evidence: observation.evidence, check: current,
              async verifyCreated() { current(); if (stage.started) throw new Error("Fallback resume launch intent already started."); await observation.verifyCreated(); current(); } });
            current(); await authority.persistIntent(capability); current(); await observation.verifyCreated(); current(); authority.authorizeLaunch(capability);
            stage.started = true;
            for (const start of stage.starts) { current(); authority.authorizeLaunch(capability); resume.watchdog!.check(); await start(); current(); authority.authorizeLaunch(capability); }
            await Promise.all(record.containers.map(role => waitForContainerRunning(docker, role.id, record.controller.signal))); current();
            const remaining = Math.max(1, Number((authority.deadline - (globalThis as any).process.hrtime.bigint()) / 1000000n));
            await waitForHealth(fetcher, candidate.upstream, config.health.path, Math.min(config.health.timeoutMs, remaining), AbortSignal.any([record.controller.signal, AbortSignal.timeout(remaining)]), () => record.status === "failed"); current();
            await observation.verifyRunning(); current(); record.fallbackStaged = undefined;
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
        const resume = record && resumeTracking.get(record.candidate.projectId);
        if (resume) { checkResume(resume); if (resume.record !== record || signal !== resume.request.signal) throw new Error("Fallback resume activation differs from its original request."); }
        if (record && fallbackReservations.has(record.candidate.projectId)) throw new Error("Project is fenced by its original fallback role lease.");
        if (!record || records.get(record.candidate.projectId) !== record) {
          throw new Error("Docker deployment runtime candidate is unknown.");
        }
        if (record.fallbackStaged) throw new Error("Fallback staged roles require their authenticated launch intent.");
        if (record.isolatedReadOnly) throw new Error("Isolated read-only candidates must be stopped before authoritative deployment; activation is refused.");
        if(record.adopted)await record.adopted.verify();
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
      if (record && fallbackReservations.has(record.candidate.projectId)) throw new Error("Project is fenced by its original fallback role lease.");
      if (!record || records.get(record.candidate.projectId) !== record) {
        throw new Error("Docker deployment runtime candidate is unknown.");
      }
      if (record.isolatedReadOnly) throw new Error("Isolated read-only candidates cannot be committed as an authoritative runtime.");
        if (record.pendingBackground) {
        throw new Error("Deferred Docker background processes must be activated before commit.");
      }
      record.adopted?.fast();
      return commitRecord(record);
    },

    inspect() {
      for(const record of records.values())if(record.adopted)try{record.adopted.fast();}catch(error){record.status="failed";report(error);void exclusive(record.candidate.projectId,()=>removeRecord(record,true)).catch(report);}
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
        if(record.adopted)await record.adopted.verify();
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
            running: process.child ? process.child.exitCode === null
              || process.child.exitCode === undefined : Boolean(record.adopted && record.status==="active"),
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
        if (!record) {
          if (generation !== undefined && highWater.has(projectId) && highWater.get(projectId)!.generation !== generation) return false;
          if (options.outboundNetwork) {
            const policy = typeof options.outboundNetwork === "function" ? options.outboundNetwork(projectId) : options.outboundNetwork;
            const plan = await createLinuxDockerNetworkPlan(owner, projectId, { allowCidrs: [] });
            await removeIsolationNetwork(projectId, plan, policy.nftExecutable);
          }
          return false;
        }
        if (generation !== undefined && record.candidate.generation !== generation) {
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
      for (const held of resumeTracking.values()) try { await held.watchdog?.close(); } catch (error) { failures.push(error); }
      for (const result of await Promise.allSettled(
        [...records.values()].map((record) => removeRecord(record)),
      )) {
        if (result.status === "rejected") {
          failures.push(result.reason);
          report(result.reason);
        }
      }
      try {
        // Cold admission owns only authenticated/locally tracked role CIDs. An
        // unrelated container with the same provider owner must survive close.
        const remaining = coldResumeRecovered || coldNoSweepAdmitted ? [] : await listOwnedContainers(docker, owner);
        if (remaining.length > 0) {
          await docker(["container", "rm", "--force", ...remaining]);
        }
        if (!coldResumeRecovered && !coldNoSweepAdmitted && (await listOwnedContainers(docker, owner)).length > 0) {
          throw new Error("Docker runtime cleanup did not converge during close.");
        }
      } catch (error) {
        failures.push(error);
        report(error);
      }
      if (failures.length === 0) {
        records.clear();
        for (const close of [...fallbackCloses]) try { close(); } catch (error) { failures.push(error); }
        candidates.clear();
        highWater.clear();
        usedPorts.clear();
      }
      if (failures.length > 0) {
        for (const held of resumeTracking.values()) try { closeResumePins(held); } catch (error) { report(error); }
        throw new AggregateError(failures, "Docker deployment runtime launcher failed to close cleanly.");
      }
      for (const held of resumeTracking.values()) closeResumePins(held); resumeTracking.clear();
    },
  };
  if(adopted){
    const candidate=Object.freeze({protocol:DEPLOYMENT_PROVIDER_DOCKER_PROTOCOL,projectId:adopted.projectId,releaseId:adopted.releaseId,generation:adopted.generation,capsuleSha256:adopted.capsuleSha256,upstream:"http://127.0.0.1:"+adopted.port});
    const record:RuntimeRecord={candidate,status:"active",port:adopted.port,launchedAt:adopted.launchedAt,containers:[{id:adopted.containerId,role:"web",instance:0,expectedStop:false}],plannedContainers:1,dataDirectory:adopted.dataDirectory,deferredBackground:true,isolatedReadOnly:false,pendingBackground:null,controller:new AbortController(),logs:[],logBytes:0,nextLogSequence:1,logsTruncated:false,adopted};
    records.set(adopted.projectId,record);candidates.set(candidate,record);usedPorts.add(adopted.port);highWater.set(adopted.projectId,{generation:adopted.generation,releaseId:adopted.releaseId,capsuleSha256:adopted.capsuleSha256});
    try{record.outputObserver=await observeAdoptedRuntimeOutput(record,client.executable,client.environment,report);adopted.fast();}catch(error){await removeRecord(record,true);throw error;}
    record.adoptionTimer=setInterval(()=>{if(closed||record.adoptionVerification||record.status!=="active")return;
      const verification=adopted.verify();record.adoptionVerification=verification;
      void verification.then(()=>{record.adoptionVerification=undefined;},error=>{record.adoptionVerification=undefined;record.status="failed";report(error);void exclusive(adopted.projectId,()=>removeRecord(record,true)).catch(report);});
    },5000);(record.adoptionTimer as any).unref?.();
    adopted.fast();
  }
  const stagedTargets = new WeakMap<object, { candidate: DockerDeploymentRuntimeCandidate; record: RuntimeRecord; observation: Awaited<ReturnType<typeof observeProviderFallbackRoles>>; reservation: object; intent: object; signal: AbortSignal }>();
  // Retain identity after failed cleanup closes staging pins, until authenticated recovery retires it.
  const retainedTargets = new WeakMap<object, { record: RuntimeRecord; reservation: object; intent: object }>();
  fallbackLaunchers.set(launcher, { async stage(target, reservation, prepared, signal) {
    const authority = providerFallbackTargetLaunchContext(target, reservation);
    if (authority.launcher !== launcher || stagedTargets.has(target) || !fallbackWatchdogs.has(authority.projectId)) throw new Error("Fallback target staging authority differs.");
    const input = { prepared, signal }; fallbackStageInputs.set(input, { target, reservation });
    const candidate = await launcher.launch(input), record = candidates.get(candidate), plan = record?.fallbackPlan;
    if (!record || !plan || !record.fallbackStaged || record.fallbackStaged.started || record.containers.length !== record.plannedContainers) throw new Error("Fallback staged role roster is incomplete.");
    const observation = await observeProviderFallbackRoles({ client, owner, projectId: candidate.projectId, releaseId: candidate.releaseId, generation: candidate.generation, capsuleSha256: candidate.capsuleSha256, image, user, network: record.isolationNetwork?.plan.network ?? network, memory, cpus, pidsLimit, releaseDirectory: plan.releaseDirectory, dataDirectory: record.dataDirectory, deadline: authority.deadline, created: true,
      roles: record.containers.map(role => ({ role: role.role, instance: role.instance, containerId: role.id, command: ["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", DOCKER_STDIN_RUNTIME_LAUNCHER, role.role === "web" ? plan.config.entry : plan.config.jobs!.entry] })) });
    providerFallbackTargetLaunchContext(target, reservation); const intent = observation.evidence;
    stagedTargets.set(target, { candidate, record, observation, reservation, intent, signal }); retainedTargets.set(target, { record, reservation, intent }); return Object.freeze({ candidate, intent });
  }, async activate(target, reservation) {
    const held = stagedTargets.get(target); if (!held || held.reservation !== reservation) throw new Error("Fallback staged target ownership differs.");
    const valid = () => { const authority = providerFallbackTargetActivationContext(target, reservation, held.intent); if (authority.launcher !== launcher || records.get(held.candidate.projectId) !== held.record || held.record.status !== "candidate") throw new Error("Fallback staged runtime changed."); throwIfAborted(held.signal); fallbackWatchdogs.get(held.candidate.projectId)!.watchdog.check(); };
    return exclusive(held.candidate.projectId, async () => {
      valid(); await held.observation.verifyCreated(); valid(); const stage = held.record.fallbackStaged; if (!stage || stage.started) throw new Error("Fallback staged activation replay differs."); stage.started = true;
      for (const start of stage.starts) { valid(); await start(); valid(); }
      await Promise.all(held.record.containers.map(role => waitForContainerRunning(docker, role.id, held.signal))); valid();
      const health = held.record.fallbackPlan!.config.health;
      await waitForHealth(fetcher, held.candidate.upstream, health.path, health.timeoutMs, held.signal, () => held.record.status === "failed"); valid();
      await held.observation.verifyRunning(); valid(); held.record.fallbackStaged = undefined; commitRecord(held.record); held.observation.close();
    });
  }, async arm(target, reservation) {
    const held = providerFallbackTargetLaunchContext(target, reservation);
    if (held.launcher !== launcher || closed || records.has(held.projectId) || fallbackWatchdogs.has(held.projectId) || resumeTracking.has(held.projectId)) throw new Error("Fallback target launcher is not pristine.");
    const watchdog = await openProviderFallbackWatchdog(client, { owner, projectId: held.projectId, releaseId: held.releaseId, generation: held.generation, deadline: held.deadline });
    providerFallbackTargetLaunchContext(target, reservation); fallbackWatchdogs.set(held.projectId, { target, capsuleSha256: held.capsuleSha256, watchdog });
  }, async cancel(target) { const staged = stagedTargets.get(target); if (staged) { staged.observation.close(); stagedTargets.delete(target); } for (const held of fallbackWatchdogs.values()) if (held.target === target) { await held.watchdog.close(); return; } }, async retire(permit) {
    const authority = providerFallbackRuntimeRetirementContext(permit), projectId = authority.projectId;
    if (authority.launcher !== launcher) throw new Error("Fallback retirement launcher differs.");
    await exclusive(projectId, async () => {
      const retained = authority.target ? retainedTargets.get(authority.target) : undefined;
      const lease = authority.lease ?? fallbackReservations.get(projectId), held = lease ? fallbackRoleLeases.get(lease) : undefined;
      const record = authority.source ? held?.record : retained?.record;
      const watcher = fallbackWatchdogs.get(projectId);
      const check = () => {
        authority.check();
        if (closed || !record || record.adopted || record.outputObserver || record.adoptionTimer || record.adoptionVerification
          || record.candidate.projectId !== projectId || record.candidate.releaseId !== authority.evidence.releaseId || record.candidate.generation !== authority.evidence.generation || record.candidate.capsuleSha256 !== authority.evidence.capsuleSha256
          || records.has(projectId) && records.get(projectId) !== record || candidates.has(record.candidate) && candidates.get(record.candidate) !== record
          || fallbackReservations.get(projectId) !== lease || lease && (!held || held.launcher !== launcher || held.record !== record)
          || authority.source && (!lease || JSON.stringify(held!.observation.evidence) !== JSON.stringify(authority.evidence) || watcher)
          || authority.target && (!retained || retainedTargets.get(authority.target) !== retained || retained.reservation !== authority.reservation || JSON.stringify(retained.intent) !== JSON.stringify(authority.intent) || watcher && watcher.target !== authority.target)
          || fallbackWatchdogs.get(projectId) !== watcher) throw new Error("Fallback retirement native reservation or original record changed.");
        const roster = (roles: Array<{ role: string; instance: number; containerId?: string; id?: string }>) => JSON.stringify(roles.map(role => [role.role, role.instance, role.containerId ?? role.id]).sort());
        if (record.plannedContainers !== authority.evidence.roles.length || roster(record.containers) !== roster(authority.evidence.roles)) throw new Error("Fallback retirement native role roster differs.");
      };
      check();
      // A failed watchdog exit is not an absence receipt. The independent authenticated
      // recovery proof below must freshly verify every role after its process exits.
      if (watcher) { await watcher.watchdog.close().catch(() => {}); check(); }
      await authority.verifyStopped(); check();
      for (const process of record!.containers) process.expectedStop = true;
      record!.pendingBackground = null; record!.fallbackStaged = undefined;
      record!.controller.abort(new Error("Authenticated fallback recovery retired this stopped runtime."));
      check();
      if (records.get(projectId) === record) { records.delete(projectId); usedPorts.delete(record!.port); }
      candidates.delete(record!.candidate);
      if (lease) { fallbackReservations.delete(projectId); held!.close(); }
      if (authority.target) { stagedTargets.get(authority.target)?.observation.close(); stagedTargets.delete(authority.target); retainedTargets.delete(authority.target); }
      if (watcher) fallbackWatchdogs.delete(projectId);
      authority.finish();
    });
  }, async beginResume(permit) {
    const authority = providerFallbackRuntimeResumeLifecycleContext(permit), request = authority.request, projectId = request.operation.projectId;
    if (authority.launcher !== launcher || !request.runtime) throw new Error("Fallback resume admission launcher differs.");
    await exclusive(projectId, async () => {
      authority.check();
      if (closed || records.has(projectId) || resumeTracking.has(projectId) || fallbackReservations.has(projectId) || fallbackWatchdogs.has(projectId)) throw new Error("Fallback resume native project is not stopped and unreserved.");
      const held: ResumeTracking = { permit, request, capsuleSha256: request.runtime!.sha256, cleaned: false, pins: [] }; resumeTracking.set(projectId, held);
      const projectRoot = path.join(root, "projects", projectId), dataDirectory = path.join(projectRoot, "data");
      requireInside(path, dataDirectory, authority.databasePath, "fallback resume database"); requireInside(path, path.join(projectRoot, "generations"), authority.releaseDirectory, "fallback resume release");
      for (const filename of [dataDirectory, authority.releaseDirectory]) { if (nativeFs.realpathSync(filename) !== filename) throw new Error("Fallback resume original directory is not canonical."); const fd = nativeFs.openSync(filename, nativeFs.constants.O_RDONLY | nativeFs.constants.O_DIRECTORY | nativeFs.constants.O_NOFOLLOW), stat = nativeFs.fstatSync(fd); held.pins.push({ path: filename, fd, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode }); } checkResume(held);
      held.daemonId = JSON.parse((await docker(["info", "--format", "{{json .ID}}"], { signal: request.signal })).stdout); checkResume(held);
      if (typeof held.daemonId !== "string" || !held.daemonId) throw new Error("Fallback resume native daemon identity is unavailable.");
      await verifyResumeAbsent(held, false); checkResume(held);
      held.watchdog = await openProviderFallbackWatchdog(client, { owner, projectId, releaseId: request.desired.releaseId!, generation: request.desired.generation, deadline: authority.deadline }); checkResume(held);
    });
  }, async cleanupResume(permit) {
    const authority = providerFallbackRuntimeResumeCleanupContext(permit), projectId = authority.request.operation.projectId;
    await exclusive(projectId, async () => {
      const held = resumeTracking.get(projectId); if (!held || held.permit !== permit || held.request !== authority.request) throw new Error("Fallback resume cleanup cannot adopt an unrelated runtime.");
      checkResume(held, true);
      if (held.record) { for (const role of held.record.containers) role.expectedStop = true; held.record.controller.abort(new Error("Original fallback resume failed.")); }
      let watchdogFailure: unknown;
      try { await held.watchdog?.close(); } catch (error) { watchdogFailure = error; } checkResume(held, true);
      // A completed watchdog may already be disarmed. Its retained native observer
      // still owns exact cleanup if the subsequent durable plan COMMIT failed.
      const observation = held.observation ?? held.intentObservation;
      if (observation) { await observation.cleanupVerifyConfiguration(); checkResume(held, true); }
      else if (watchdogFailure && held.record) throw watchdogFailure;
      if (held.record && records.get(projectId) === held.record) { await removeRecord(held.record, true, authority.deadline); checkResume(held, true); }
      await verifyResumeAbsent(held); checkResume(held, true);
      if (observation) { await observation.cleanupVerifyStopped(); checkResume(held, true); }
      held.cleaned = true;
    });
  }, finishResumeCleanup(permit) {
    const authority = providerFallbackRuntimeResumeCleanupContext(permit), projectId = authority.request.operation.projectId, held = resumeTracking.get(projectId);
    if (!held || held.permit !== permit || !held.cleaned || records.has(projectId)) throw new Error("Fallback resume cleanup lacks its exact stopped receipt.");
    checkResume(held, true); closeResumePins(held); resumeTracking.delete(projectId);
  }, async completeResume(permit) {
    const authority = providerFallbackRuntimeResumeLifecycleContext(permit), projectId = authority.request.operation.projectId;
    await exclusive(projectId, async () => {
      const held = resumeTracking.get(projectId);
      if (!held || held.permit !== permit || held.cleaned || !held.record || !held.observation || !held.watchdog || records.get(projectId) !== held.record) throw new Error("Fallback resume completion lacks its original running runtime.");
      const current = () => { checkResume(held); authority.authorizeCompletion(); if (held.record!.status !== "active" || held.record!.controller.signal.aborted) throw new Error("Fallback resume completion runtime changed."); };
      current(); await held.observation.verifyRunning(); current();
      if (!held.runningCapability || !held.runningPersisted) throw new Error("Fallback resume completion has no signed original running evidence.");
      held.watchdog.check();
      // The independent guard remains armed across the durable terminal COMMIT.
      // A lost response keeps exact cleanup authority; disarm requires the exact
      // authenticated terminal afterimage, never a predecessor writer check.
      authority.publish(); authority.authorizeRelease();
      await held.watchdog.commit();
      try { closeResumePins(held); } catch (error) { report(error); }
      resumeTracking.delete(projectId);
    });
  }, async verifyResumed(permit) {
    const authority = providerFallbackRuntimeResumeContext(permit), request = authority.request, projectId = request.operation.projectId;
    if (authority.launcher !== launcher || !request.runtime) throw new Error("Fallback resume native observation authority differs.");
    authority.check();
    return exclusive(projectId, async () => {
      const record = records.get(projectId), plan = record?.fallbackPlan, tracked = resumeTracking.get(projectId);
      const check = () => {
        authority.check(); throwIfAborted(request.signal);
        if (closed || (globalThis as any).process.hrtime.bigint() >= authority.deadline || !record || !plan || records.get(projectId) !== record || candidates.get(record.candidate) !== record
          || !tracked || tracked.permit !== permit || tracked.record !== record || tracked.cleaned || !tracked.watchdog || record.status !== "active" || record.pendingBackground || record.fallbackStaged || record.adopted || record.isolatedReadOnly || record.controller.signal.aborted
          || fallbackReservations.has(projectId) || fallbackWatchdogs.has(projectId) || record.candidate.generation !== request.desired.generation || record.candidate.releaseId !== request.desired.releaseId || record.candidate.capsuleSha256 !== request.runtime!.sha256) throw new Error("Fallback resumed original Docker runtime changed.");
      };
      check();
      const roles: Array<{ role: "web" | "worker" | "scheduler"; instance: number; entry: string }> = [{ role: "web", instance: 0, entry: plan!.config.entry }];
      for (let instance = 0; instance < (plan!.config.jobs?.workers ?? 0); instance++) roles.push({ role: "worker", instance, entry: plan!.config.jobs!.entry });
      if (plan!.config.jobs?.scheduler) roles.push({ role: "scheduler", instance: 0, entry: plan!.config.jobs.entry });
      if (record!.plannedContainers !== roles.length || record!.containers.length !== roles.length || roles.some(role => record!.containers.filter(process => process.role === role.role && process.instance === role.instance).length !== 1)) throw new Error("Fallback resumed Docker role roster is incomplete.");
      const observation = tracked!.observation ?? await observeProviderFallbackRoles({ client, owner, projectId, releaseId: record!.candidate.releaseId, generation: record!.candidate.generation, capsuleSha256: record!.candidate.capsuleSha256, image, user,
        network: record!.isolationNetwork?.plan.network ?? network, memory, cpus, pidsLimit, releaseDirectory: plan!.releaseDirectory, dataDirectory: record!.dataDirectory, deadline: authority.deadline,
        roles: roles.map(role => ({ role: role.role, instance: role.instance, containerId: record!.containers.find(process => process.role === role.role && process.instance === role.instance)!.id, command: ["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", DOCKER_STDIN_RUNTIME_LAUNCHER, role.entry] })) });
      let retained = false;
      try {
        check(); tracked!.observation = observation; retained = true;
        check(); const remaining = Math.max(1, Number((authority.deadline - (globalThis as any).process.hrtime.bigint()) / 1000000n));
        await waitForHealth(globalThis.fetch, record!.candidate.upstream, plan!.config.health.path, Math.min(plan!.config.health.timeoutMs, remaining), AbortSignal.any([request.signal, record!.controller.signal, AbortSignal.timeout(remaining)]), () => record!.status === "failed"); check();
        await observation.verifyRunning(); check();
        if (!tracked!.runningCapability) {
          const capability = Object.freeze({}); tracked!.runningCapability = capability;
          const current = () => { check(); observation.check(); if (tracked!.runningCapability !== capability || tracked!.observation !== observation) throw new Error("Fallback resume running native capability changed."); };
          fallbackResumeNativeCapabilities.set(capability, { permit, launcher, request, evidence: observation.evidence, check: current, async verifyRunning() { current(); await observation.verifyRunning(); current(); } });
        }
        if (!tracked!.runningPersisted) { await providerFallbackRuntimeResumeLifecycleContext(permit).persistRunning(tracked!.runningCapability); check(); tracked!.runningPersisted = true; }
        return observation.evidence;
      } finally { if (!retained) observation.close(); }
    });
  }, capture(projectId, generation, capsuleSha256, deadline) {
    return exclusive(projectId, async () => {
      if (closed || fallbackReservations.has(projectId) || resumeTracking.has(projectId)) throw new Error("Fallback source project is closed or already reserved.");
      const record = records.get(projectId), plan = record?.fallbackPlan;
      if (!record || !plan || record.status !== "active" || record.pendingBackground || record.adopted || record.isolatedReadOnly || record.candidate.generation !== generation || record.candidate.capsuleSha256 !== capsuleSha256) throw new Error("Fallback requires the original complete active ordinary runtime.");
      const roles: Array<{ role: "web" | "worker" | "scheduler"; instance: number; entry: string }> = [{ role: "web", instance: 0, entry: plan.config.entry }];
      for (let instance = 0; instance < (plan.config.jobs?.workers ?? 0); instance++) roles.push({ role: "worker", instance, entry: plan.config.jobs!.entry });
      if (plan.config.jobs?.scheduler) roles.push({ role: "scheduler", instance: 0, entry: plan.config.jobs.entry });
      if (record.containers.length !== roles.length || record.plannedContainers !== roles.length || roles.some(role => record.containers.filter(process => process.role === role.role && process.instance === role.instance).length !== 1)) throw new Error("Fallback runtime does not own the complete approved role roster.");
      const lease: ProviderDockerRoleLease = Object.freeze({ projectId, generation, releaseId: record.candidate.releaseId, capsuleSha256 });
      fallbackReservations.set(projectId, lease);
      let observation: Awaited<ReturnType<typeof observeProviderFallbackRoles>> | undefined;
      let phase: "running" | "stopping" | "stopped" | "closed" = "running", stopping: Promise<void> | undefined, published = false;
      const check = () => {
        if (closed || phase === "closed" || (!published && fallbackReservations.get(projectId) !== lease) || phase === "running" && (records.get(projectId) !== record || record.status !== "active") || phase === "stopped" && records.has(projectId)) throw new Error("Original fallback runtime ownership changed.");
        observation?.check();
        if (phase === "running") fallbackWatchdogs.get(projectId)?.watchdog.check();
      };
      const close = () => { if (phase === "closed") return; phase = "closed"; fallbackCloses.delete(close); observation?.close(); /* Reservation remains fenced until the provider's durable decision is resolved. */ };
      try {
        observation = await observeProviderFallbackRoles({ client, owner, projectId, releaseId: record.candidate.releaseId, generation, capsuleSha256, image, user, network: record.isolationNetwork?.plan.network ?? network, memory, cpus, pidsLimit, releaseDirectory: plan.releaseDirectory, dataDirectory: record.dataDirectory, deadline,
          roles: roles.map(role => ({ role: role.role, instance: role.instance, containerId: record.containers.find(process => process.role === role.role && process.instance === role.instance)!.id, command: ["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", DOCKER_STDIN_RUNTIME_LAUNCHER, role.entry] })) });
        check(); const native = observation;
        const stop = () => {
          check(); if (phase === "stopped") return native.verifyStopped(); if (stopping) return stopping;
          stopping = exclusive(projectId, async () => {
            check(); if (phase === "running") await native.verifyRunning(); else await native.verifyRemaining(); check(); phase = "stopping";
            await removeRecord(record, false, deadline); check(); await native.verifyStopped(); phase = "stopped"; check();
          }).finally(() => { stopping = undefined; });
          return stopping;
        };
        fallbackCloses.add(close);
        fallbackRoleLeases.set(lease, { launcher, record, observation, check, current: () => records.get(projectId) === record, verifyRunning: async () => { check(); if (phase !== "running") throw new Error("Fallback original roles are no longer running."); await native.verifyRunning(); check(); }, stop,
          cleanup: async () => {
            if (phase === "closed" || !published && fallbackReservations.get(projectId) !== lease || records.has(projectId) && records.get(projectId) !== record) throw new Error("Fallback cleanup ownership changed.");
            await exclusive(projectId, async () => { await native.cleanupVerifyRemaining(); phase = "stopping"; await removeRecord(record, true, native.cleanupDeadline()); await native.cleanupVerifyStopped(); phase = "stopped"; });
          }, verifyCancellation: async () => { if (closed || phase !== "running" || published || fallbackReservations.get(projectId) !== lease || records.get(projectId) !== record || record.status !== "active") throw new Error("Fallback source cancellation ownership changed."); await native.cleanupVerifyRunning(); }, cancel() { if (closed || phase !== "running" || published || fallbackReservations.get(projectId) !== lease || records.get(projectId) !== record || record.status !== "active") throw new Error("Fallback source cancellation is no longer pristine."); fallbackReservations.delete(projectId); close(); }, verifyStopped: async () => { check(); if (phase !== "stopped") throw new Error("Fallback original roles have no native stop evidence."); await native.verifyStopped(); check(); }, async publish() { check(); if (phase !== "running") throw new Error("Fallback publication requires running original roles."); const watcher = fallbackWatchdogs.get(projectId); await watcher?.watchdog.commit(); check(); if (watcher && fallbackWatchdogs.get(projectId) === watcher) fallbackWatchdogs.delete(projectId); published = true; fallbackReservations.delete(projectId); }, close });
        return lease;
      } catch (error) { fallbackReservations.delete(projectId); close(); throw error; }
    });
  } });
  if (coldResumeRecovered || coldNoSweepAdmitted) {
    const token = coldResumeRecovered ? coldResumeToken! : options.coldFallbackNoSweepSelection!;
    const check = () => {
      if (closed || records.size || candidates.size || resumeTracking.size || fallbackReservations.size || fallbackWatchdogs.size) throw new Error("Cold fallback launcher is no longer pristine.");
      if (coldResumeRecovered) coldResume!.check(); else coldNoSweep!.check();
    };
    coldFallbackLaunchers.set(launcher, { token, selected: coldResumeRecovered, owner, root, check, async verifyStopped() {
      check();
      if (coldResumeRecovered) await cleanupColdFallbackRoles({ evidence: coldResumeEvidence, record: coldResumeRecord, owner, root, docker, check,
        stopTimeoutSeconds: Math.ceil(stopTimeoutMs / 1000), nativeFs, path });
      else if (JSON.parse((await docker(["info", "--format", "{{json .ID}}"])).stdout) !== coldNoSweep!.daemonId) throw new Error("Cold fallback counterpart Docker daemon identity changed.");
      check();
    } });
  }
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
    CLANK_BUCKET_ROOT: "/data/buckets",
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

async function observeAdoptedRuntimeOutput(record:RuntimeRecord,executable:string,environment:Readonly<Record<string,string>>,report:(error:unknown)=>void):Promise<{close():Promise<void>}>{
 const moduleName="node:child_process",{spawn}=await import(moduleName) as unknown as {spawn(executable:string,args:string[],options:Record<string,unknown>):NativeChild};
 const runtime=record.containers[0]!;record.logsTruncated=true;
 const child=spawn(executable,["container","logs","--follow","--tail","100",runtime.id],{env:{...environment},stdio:["ignore","pipe","pipe"],shell:false});
 let ended=false,expected=false,closing:Promise<void>|undefined,resolve!:()=>void;const settled=new Promise<void>(done=>{resolve=done;});
 const stopped=(error?:unknown)=>{if(ended)return;ended=true;resolve();if(!expected){record.logsTruncated=true;appendRuntimeLog(record,runtime,"platform","Application output observer is unavailable.");report(error??new Error("Adopted application output observer exited."));}};
 child.once("error",error=>stopped(error));child.once("exit",()=>stopped());
 captureRuntimeOutput(record,runtime,"stdout",child.stdout);captureRuntimeOutput(record,runtime,"stderr",child.stderr);
 return {close(){return closing??=(async()=>{expected=true;if(!ended)child.kill("SIGTERM");await Promise.race([settled,new Promise<void>(done=>setTimeout(done,1000))]);if(!ended){child.kill("SIGKILL");await Promise.race([settled,new Promise<void>(done=>setTimeout(done,2000))]);}if(!ended)throw new Error("Adopted output observer cleanup is unsettled.");})();}};
}

function captureRuntimeOutput(
  record: RuntimeRecord,
  process: ContainerProcess,
  streamName: "stdout" | "stderr",
  stream: AsyncIterable<Uint8Array> | undefined,
): void {
  if (!stream) return;
  void captureLogLines(stream, (line) => appendRuntimeLog(record, process, streamName, line)).catch(() => {
    // The attached process exit path reports infrastructure failures.
  });
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
