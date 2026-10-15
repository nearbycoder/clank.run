import { providerFallbackReservationContext, providerFallbackCancellationContext, providerFallbackEndpointProbeContext, providerFallbackRetirementContext, providerFallbackResumeContext, providerFallbackResumeCleanupContext, providerFallbackCancelledSourceContext } from "./provider-fallback-coordinator.ts";
import { acquireProviderServiceOwnership, admitProviderService, providerServiceRestartFiles, type ProviderServiceOwnership } from "./provider-handoff.ts";
import * as providerHandoff from "./provider-handoff.ts";
import {providerSourceLaunchIngressContext,launchProviderSourceContainer} from "./provider-source-launch.ts";
import {runProviderDockerClient} from "./provider-docker-client.ts";
import {providerAdoptedTargetRuntimeContext,closeProviderAdoptedTargetRuntime,providerTargetHandoffContext, providerActivatedTargetIngressContext, applyProviderTransferTail, activateProviderTransferTarget, type ProviderTransferTarget, type ProviderTargetTransferReceipt, type ProviderActivatedTarget} from "./provider-target-stage.ts";
import { providerDockerClient } from "./provider-docker-client.ts";
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
  captureProviderDockerRoleLease, providerDockerRoleLeaseContext, stopProviderDockerRoleLease, closeProviderDockerRoleLease, commitProviderDockerRoleLease, cleanupProviderDockerRoleLease, armProviderDockerFallbackTarget, closeProviderDockerFallbackTarget, cancelProviderDockerRoleLease, isCurrentProviderDockerRoleLease, stageProviderDockerFallbackTarget, activateProviderDockerFallbackTarget,
  retireProviderDockerFallbackRecovery, retireProviderDockerFallbackCancellation, verifyProviderDockerFallbackResumed, beginProviderDockerFallbackResume, cleanupProviderDockerFallbackResume, completeProviderDockerFallbackResume, finishProviderDockerFallbackResumeCleanup, type ProviderDockerRoleLease,
  type DockerDeploymentRuntimeDiagnostics,
  type DockerDeploymentRuntimeCandidate,
  type DockerDeploymentRuntimeLauncher,
  type DockerDeploymentRuntimeLauncherOptions,
} from "./provider-docker.ts";
import {
  createDeploymentRuntimeIngress,
  providerRuntimeRequestAuthorized,
  captureProviderRuntimeFallbackTombstone, captureProviderRuntimeFallbackSourceTombstone, reactivateProviderRuntimeFallbackIngress,
  type DeploymentRuntimeIngressBinding,
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
  DEPLOYMENT_RUNTIME_MEDIA_TYPE,
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
export const DEPLOYMENT_PROVIDER_CANARY_CONTROL_PROTOCOL = "clank-provider-canary-control/1";
export const DEPLOYMENT_PROVIDER_CANARY_CONTROL_MEDIA_TYPE = "application/vnd.clank.provider-canary-control+json";

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
  /** Combined prepared/retired IDs per primary incarnation; exhaustion requires ordinary reconciliation. */
  readonly maxOperations?: number;
  readonly maximumDurationMs?: number;
  /** Total HTTP control deadline; timeout responses do not acknowledge absence. Defaults to 60 seconds. */
  readonly controlTimeoutMs?: number;
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

/** Exact isolated SQLite checkpoint provenance; timestamps use the provider clock. */
export interface DeploymentProviderShadowState extends Omit<DeploymentProviderCanaryState, "protocol"> {
  readonly protocol: "clank-provider-canary/2";
  readonly purpose: "shadow";
  readonly snapshot: Readonly<{ sha256: string; bytes: number; startedAt: number; completedAt: number }> | null;
}

type ProviderCandidateState = DeploymentProviderCanaryState | DeploymentProviderShadowState;
type ProviderCanaryPrepareInput = { readonly primary: DeploymentProviderCanaryBinding; readonly controllerEpoch: number; readonly operationId: string; readonly runtime: DeploymentRuntimeCapsule; readonly signal: AbortSignal };
type ProviderCanaryRoute = { readonly projectId: string; readonly releaseId: string; readonly generation: 1; readonly path: string; readonly token: string; readonly readPaths: readonly string[] };

export interface DeploymentProviderCanaryRetirement {
  readonly protocol: "clank-provider-canary-retirement/1";
  readonly primary: DeploymentProviderCanaryBinding;
  readonly operationId: string;
  /** Original prepare epoch, not the retiring coordinator's epoch. */
  readonly controllerEpoch: number;
  readonly releaseId: string;
  /** Digest of the original source capsule, not the isolated checkpoint capsule. */
  readonly capsuleSha256: string;
  readonly candidateProjectId: string;
  readonly retirementEpoch: number;
  readonly phase: "retired";
}

export interface DeploymentProviderCanaryController {
  binding(projectId: string): Promise<DeploymentProviderCanaryBinding | null>;
  inspect(projectId: string): Promise<DeploymentProviderCanaryState | DeploymentProviderShadowState | null>;
  /** Trusted callers must fence their native coordinator lease before and after every await. */
  prepare(input: ProviderCanaryPrepareInput & { readonly purpose: "shadow"; readonly stateProtocol: "clank-provider-canary/2" }): Promise<DeploymentProviderShadowState & { readonly route: ProviderCanaryRoute }>;
  prepare(input: ProviderCanaryPrepareInput & { readonly purpose?: never; readonly stateProtocol?: never }): Promise<DeploymentProviderCanaryState & { readonly route: ProviderCanaryRoute }>;
  /** Stops and verifies exact candidate runtime/data absence; it never promotes candidate data. */
  stop(input: { readonly primary: DeploymentProviderCanaryBinding; readonly controllerEpoch: number; readonly operationId: string }): Promise<DeploymentProviderCanaryState | DeploymentProviderShadowState>;
  /** Durably fences a possibly lost prepare before verifying absence. Epochs do not replace the caller's native lease assertions. */
  retire(input: { readonly primary: DeploymentProviderCanaryBinding; readonly controllerEpoch: number; readonly operationId: string; readonly releaseId: string; readonly capsuleSha256: string; readonly retirementEpoch: number }): Promise<DeploymentProviderCanaryRetirement>;
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
  nativeFallback?: true;
}

interface ProviderControlBinding {
  projectId: string;
  releaseId: string;
  generation: number;
  tokenDigest: Uint8Array;
  incarnation: string;
}

interface ProviderCanaryJournal {
  protocol: "clank-provider-canary/1" | "clank-provider-canary/2";
  spent: string[];
  current: ProviderCandidateState;
}

type ProviderCanaryRetirementEntry = Omit<DeploymentProviderCanaryRetirement, "protocol" | "primary" | "phase"> & { phase: "retiring" | "retired" };
interface ProviderCanaryRetirements {
  protocol: "clank-provider-canary-retirements/1";
  primary: DeploymentProviderCanaryBinding;
  epochFloor: number;
  entries: ProviderCanaryRetirementEntry[];
}

interface ProviderCanaryIssuedBinding {
  protocol: "clank-provider-canary-binding/1";
  primary: DeploymentProviderCanaryBinding;
  serviceIncarnation: string;
  tokenDigest: number[];
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
type OrdinarySourceAdmission={ownership:ProviderServiceOwnership;maxDatabaseBytes:number;drainTimeoutMs:number;data:DeploymentProviderDataStore;runtimes:DockerDeploymentRuntimeLauncher;freeze(projectId:string,capsuleSha256:string):Promise<{state:DeploymentProviderServiceState;port:number;root:NodeStats;service:NodeStats;writer:NodeStats}>};
const ordinarySourceAdmissions=new WeakMap<object,OrdinarySourceAdmission>();
/** Private stopped-source ownership for the ordinary all-role downtime path. */
export interface ProviderFallbackSource { readonly projectId: string; readonly operationId: string; readonly generation: number; }
type FallbackSourceContext = { service: DeploymentProviderService; owner: ProviderServiceOwnership; lease: ProviderDockerRoleLease; capsuleSha256: string; deadline: bigint; state: DeploymentProviderServiceState; ingress: Readonly<{ route: string; token: string }>; assertCancelled(permit: object): void; snapshot(): DeploymentProviderDataSnapshot; check(): void; stop(reservation: object): Promise<void>; cancel(permit: object): Promise<void>; canCancel(permit: object): Promise<void>; assertCancel(permit: object): void; verifyRunning(): Promise<void>; verify(): Promise<void>; persistJournal(reservation: object, journal: string, authentication: string): Promise<void>; close(): void };
const fallbackSourceServices = new WeakMap<object, { prepare(projectId: string, capsule: DeploymentRuntimeCapsule, operationId: string, deadline: bigint): Promise<ProviderFallbackSource> }>();
const fallbackSources = new WeakMap<object, FallbackSourceContext>();
export function providerFallbackSourceContext(value: object) {
  const held = fallbackSources.get(value); if (!held) throw new Error("A genuine original fallback source is required."); held.check();
  return Object.freeze({ service: held.service, owner: held.owner, capsuleSha256: held.capsuleSha256, deadline: held.deadline, state: held.state, native: providerDockerRoleLeaseContext(held.lease), snapshot: held.snapshot, check: held.check, stop: held.stop, cancel: held.cancel, verifyRunning: held.verifyRunning, verifyStopped: held.verify, verify: held.verify, persistJournal: held.persistJournal });
}
export function closeProviderFallbackSource(value: object): void {
  const held = fallbackSources.get(value); if (!held) throw new Error("A genuine original fallback source is required."); held.close();
}
/** Internal product boundary: caller bytes must match the original running release. */
export async function prepareDockerProviderFallbackSource(service: DeploymentProviderService, projectId: string, approvedCapsule: Uint8Array, operationId: string, deadline: bigint): Promise<ProviderFallbackSource> {
  const held = fallbackSourceServices.get(service);
  if (!held || !nativeSourceAdmissions.has(service)) throw new Error("A genuine original ordinary Docker provider is required for fallback.");
  identifier(projectId, "projectId"); pattern(operationId, "operationId", /^evac_[A-Za-z0-9_-]{8,128}$/u);
  if (typeof deadline !== "bigint" || deadline <= (globalThis as any).process.hrtime.bigint() || deadline > (globalThis as any).process.hrtime.bigint() + 30000000000n) throw new Error("Fallback requires its original bounded interruption deadline.");
  if (!(approvedCapsule instanceof Uint8Array) || !ArrayBuffer.isView(approvedCapsule)) throw new Error("Fallback requires native capsule bytes.");
  const typed = Object.getPrototypeOf(Uint8Array.prototype), buffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!, length = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(buffer.call(approvedCapsule));
  if (length.call(approvedCapsule) > 32 + 614 * 1024 * 1024) throw new Error("Fallback capsule exceeds its bound.");
  const bytes = new Uint8Array(approvedCapsule); let capsule: DeploymentRuntimeCapsule | undefined;
  try { capsule = await decodeDeploymentRuntimeCapsule(bytes); if (capsule.manifest.projectId !== projectId) throw new Error("Fallback capsule project differs."); return await held.prepare(projectId, capsule, operationId, deadline); }
  finally { bytes.fill(0); capsule?.bytes.fill(0); }
}

const nativeSourceAdmissions=new WeakMap<object,{client:ReturnType<typeof providerDockerClient>;owner:string;image:string;compatible:boolean}>();
/** Private original-service identity for the platform's local evacuation registration. */
export function providerFallbackServiceContext(service: object) {
  const ordinary=ordinarySourceAdmissions.get(service),native=nativeSourceAdmissions.get(service);
  if(!ordinary||!native||!fallbackSourceServices.has(service)||!fallbackTargetServices.has(service))throw new Error("A genuine original ordinary Docker provider is required for local evacuation.");
  providerHandoff.assertProviderServiceOwnership(ordinary.ownership);
  return Object.freeze({owner:ordinary.ownership,ownerLabel:native.owner,client:native.client,check(){providerHandoff.assertProviderServiceOwnership(ordinary.ownership);}});
}
const sourcePreparationReservations=new WeakSet<object>();
const sourceReplacements=new WeakMap<object,{reconcile(request:DeploymentProviderRequest):Promise<void>;handle(request:Request):Promise<Response>;inspect(projectId:string):Promise<DeploymentProviderServiceState|null>;close():Promise<void>}>();
const MAX_STATE_BYTES = 64 * 1024;
const MAX_PROVIDER_DATABASE_BYTES =
  2 * 1024 * 1024 * 1024 - 2 * 1024 * 1024 - 100 * 1024 * 1024 - 32;

/** Retained canary state needs its independent owner before any startup cleanup. */
export async function providerFallbackSourceCancellationLease(source: object, permit: object): Promise<ProviderDockerRoleLease> {
  const held = fallbackSources.get(source); if (!held) throw new Error("A genuine original fallback source is required.");
  await held.canCancel(permit); return held.lease;
}
export function assertProviderFallbackSourceCancellation(source: object, permit: object): void {
  const held = fallbackSources.get(source); if (!held) throw new Error("A genuine original fallback source is required."); held.assertCancel(permit);
}
const fallbackEndpointProbes = new Map<string, { service: DeploymentProviderService; seen: boolean; check(): void }>();
const fallbackEndpointProofs = new WeakMap<object, { authority: object; service: DeploymentProviderService; owner: ProviderServiceOwnership; origin: string; nativeIdentity: object; check(): void }>();
export function providerFallbackEndpointContext(proof: object) {
  const held = fallbackEndpointProofs.get(proof); if (!held) throw new Error("A genuine original provider endpoint proof is required."); held.check(); return Object.freeze({ ...held });
}
export async function probeDockerProviderFallbackEndpoint(service: DeploymentProviderService, authority: object): Promise<object> {
  const held = ordinarySourceAdmissions.get(service); if (!held || !nativeSourceAdmissions.has(service)) throw new Error("A genuine original ordinary Docker provider is required for endpoint binding.");
  const approval = providerFallbackEndpointProbeContext(authority); approval.check(); if (approval.service !== service) throw new Error("Fallback endpoint probe service differs.");
  const originInput = approval.origin, deadline = approval.deadline;
  const origin = new URL(originInput); if (origin.origin !== originInput || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("Fallback provider endpoint must be its exact approved origin.");
  const check = () => { approval.check(); providerHandoff.assertProviderServiceOwnership(held.ownership); if (typeof deadline !== "bigint" || (globalThis as any).process.hrtime.bigint() >= deadline) throw new Error("Fallback provider endpoint proof expired."); };
  check();
  // The owner endpoint runs in a separate HTTP async context. Retain this exact
  // original operation context only for its private nonce callback; every live
  // administrator, project and execution lease check still runs on invocation.
  const originalScope = (globalThis as any).process.getBuiltinModule("node:async_hooks").AsyncLocalStorage.snapshot();
  const nonce = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""), pending = { service, seen: false, check: () => originalScope(check) }; fallbackEndpointProbes.set(nonce, pending);
  try {
    const response = await fetch(origin.origin + "/v1/clank/fallback-owner/" + nonce, { redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(15000, Number((deadline - (globalThis as any).process.hrtime.bigint()) / 1000000n)))) });
    await response.body?.cancel(); check(); if (!pending.seen || response.status !== 204) throw new Error("Approved provider endpoint is not owned by the selected original service.");
    const native = nativeSourceAdmissions.get(service)!, fs = (globalThis as any).process.getBuiltinModule("node:fs");
    const paths = [held.ownership.root, held.ownership.serviceDirectory].map(path => { if (fs.realpathSync(path) !== path) throw new Error("Fallback endpoint directory is not canonical."); const stat = fs.lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022) throw new Error("Fallback endpoint directory is not private."); return Object.freeze({ path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode }); });
    const daemonId = JSON.parse((await runProviderDockerClient(native.client, ["info", "--format", "{{json .ID}}"], { timeoutMs: Math.max(1, Math.min(15000, Number((deadline - (globalThis as any).process.hrtime.bigint()) / 1000000n))), maxOutputBytes: 65536 })).stdout); check();
    if (typeof daemonId !== "string" || !daemonId) throw new Error("Fallback endpoint native Docker identity is unavailable.");
    const nativeIdentity = Object.freeze({ protocol: "clank-provider-fallback-endpoint/1", owner: native.owner, root: held.ownership.root, serviceDirectory: held.ownership.serviceDirectory, daemonId, paths: Object.freeze(paths) });
    const retainedCheck = () => { check(); for (const pin of paths) { const stat = fs.lstatSync(pin.path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || stat.uid !== pin.uid || stat.mode !== pin.mode) throw new Error("Fallback endpoint native directory changed."); } };
    retainedCheck(); const proof = Object.freeze({}); fallbackEndpointProofs.set(proof, { authority, service, owner: held.ownership, origin: origin.origin, nativeIdentity, check: retainedCheck }); return proof;
  } finally { fallbackEndpointProbes.delete(nonce); }
}

export interface ProviderFallbackTarget { readonly projectId: string; readonly operationId: string; readonly generation: number; }
type FallbackTargetContext = {
  service: DeploymentProviderService; owner: ProviderServiceOwnership; launcher: DockerDeploymentRuntimeLauncher; source: ProviderFallbackSource; reservation: object; capsuleSha256: string; deadline: bigint;
  lease(): ProviderDockerRoleLease; launchIntent(): object; check(): void; activate(reservation: object): Promise<void>;
  verifyRunning(): Promise<void>; verifyStopped(): Promise<void>; stop(): Promise<void>;
  publish(reservation: object, request: DeploymentProviderRequest): Promise<void>; finalize(reservation: object, request: DeploymentProviderRequest): Promise<void>;
  persistJournal(reservation: object, journal: string, authentication: string): Promise<void>; close(): Promise<void>; quiesceRetirement(): Promise<void>; retire(): void;
};
const fallbackTargetServices = new WeakMap<object, { stage(source: ProviderFallbackSource, reservation: object): Promise<ProviderFallbackTarget> }>();
const fallbackTargets = new WeakMap<object, FallbackTargetContext>();
type FallbackRetirementBinding = {
  launcher: DockerDeploymentRuntimeLauncher; projectId: string; source?: ProviderFallbackSource; target?: ProviderFallbackTarget;
  lease?: ProviderDockerRoleLease; reservation?: object; evidence: Record<string, any>; intent?: object;
  check(): void; verifyStopped(): Promise<void>; finish(): void;
};
const fallbackRetirementServices = new WeakMap<object, { retire(permit: object): Promise<void> }>();
const fallbackRetirementBindings = new WeakMap<object, FallbackRetirementBinding>();
/** Private original-service binding, available only while authenticated recovery retires its own flight. */
export function providerFallbackRuntimeRetirementContext(permit: object) {
  providerFallbackRetirementContext(permit);
  const held = fallbackRetirementBindings.get(permit);
  if (!held) throw new Error("Fallback retirement has no original service flight.");
  held.check(); return Object.freeze({ ...held });
}
export async function retireDockerProviderFallbackRecovery(service: object, permit: object): Promise<void> {
  const authority = providerFallbackRetirementContext(permit), held = fallbackRetirementServices.get(service);
  if (!held || authority.service !== service || !nativeSourceAdmissions.has(service)) throw new Error("Fallback retirement requires its exact original Docker service.");
  await held.retire(permit); authority.check();
}
type FallbackCancellationBinding = { launcher: DockerDeploymentRuntimeLauncher; lease: ProviderDockerRoleLease; evidence: Record<string, any>; check(): void; verifyRunning(): Promise<void>; finish(): void };
const fallbackCancellationServices = new WeakMap<object, { retire(permit: object): Promise<void> }>();
const fallbackCancellationBindings = new WeakMap<object, FallbackCancellationBinding>();
export function providerFallbackRuntimeCancellationContext(permit: object) {
  providerFallbackCancelledSourceContext(permit);
  const held = fallbackCancellationBindings.get(permit);
  if (!held) throw new Error("Fallback cancelled reservation has no exact original source flight.");
  held.check(); return Object.freeze({ ...held });
}
/** Retire only the capture of an authenticated reserved source that never stopped. */
export async function retireDockerProviderFallbackCancellation(service: object, permit: object): Promise<void> {
  const authority = providerFallbackCancelledSourceContext(permit), held = fallbackCancellationServices.get(service);
  if (!held || authority.service !== service || !nativeSourceAdmissions.has(service)) throw new Error("Fallback cancellation requires its exact original Docker service.");
  await held.retire(permit);
}
type FallbackSourceIngressIdentity = Readonly<{ projectId: string; releaseId: string; generation: number; operationId: string; minimumFence: number; capsuleSha256: string; route: string; token: string }>;
const fallbackSourceIngressStopped = new WeakMap<object, { ingress: DeploymentRuntimeIngress; identity: FallbackSourceIngressIdentity; check(): void }>();
/** A distinct source receipt is minted only by authenticated finalized STOPPED recovery. */
export function providerFallbackSourceIngressStoppedContext(permit: object) {
  const authority = providerFallbackRetirementContext(permit), held = fallbackSourceIngressStopped.get(permit);
  if (!held || authority.selected !== "source") throw new Error("Fallback source ingress has no finalized original stopped receipt.");
  held.check(); return Object.freeze({ ...held });
}
type FallbackResumeBinding = { launcher: DockerDeploymentRuntimeLauncher; request: DeploymentProviderRequest; deadline: bigint; check(): void };
const fallbackResumeServices = new WeakMap<object, { begin(permit: object): Promise<void>; cleanup(permit: object): Promise<void>; complete(permit: object): Promise<void>; verify(permit: object): Promise<object> }>();
const fallbackResumeBindings = new WeakMap<object, FallbackResumeBinding>();
const fallbackResumeLifecycles = new WeakMap<object, { launcher: DockerDeploymentRuntimeLauncher; request: DeploymentProviderRequest; releaseDirectory: string; databasePath: string; stoppedState: string | null; stoppedData: string | null; ingressTombstone?: object; check(): void; cleanupCheck(): void }>();
type FallbackIngressStoppedBinding = { ingress: DeploymentRuntimeIngress; request: DeploymentProviderRequest; check(): void };
type FallbackIngressReactivationBinding = FallbackIngressStoppedBinding & { tombstone: object; binding: DeploymentRuntimeIngressBinding; verifyRunning(): Promise<void> };
const fallbackIngressStopped = new WeakMap<object, FallbackIngressStoppedBinding>();
const fallbackIngressReactivations = new WeakMap<object, FallbackIngressReactivationBinding>();
/** Private exact cleanup receipt; only installed after native absence and STOPPED readback. */
export function providerFallbackIngressStoppedContext(permit: object) {
  const authority = providerFallbackResumeCleanupContext(permit), held = fallbackIngressStopped.get(permit);
  if (!held || held.request !== authority.request) throw new Error("Fallback ingress has no original stopped cleanup receipt.");
  held.check(); return Object.freeze({ ...held });
}
/** Private publication window for a genuine higher-fence retry of that stopped receipt. */
export function providerFallbackIngressReactivationContext(permit: object) {
  const authority = providerFallbackResumeContext(permit), held = fallbackIngressReactivations.get(permit);
  if (!held || held.request !== authority.request) throw new Error("Fallback ingress has no original retry publication authority.");
  held.check(); return Object.freeze({ ...held });
}
export function providerFallbackRuntimeResumeLifecycleContext(permit: object) {
  const authority = providerFallbackResumeContext(permit), held = fallbackResumeLifecycles.get(permit);
  if (!held || held.request !== authority.request) throw new Error("Fallback resume has no original lifecycle binding.");
  held.check(); return Object.freeze({ ...held, deadline: authority.deadline, authorizeCompletion: authority.authorizeCompletion, persistIntent: authority.persistIntent, authorizeLaunch: authority.authorizeLaunch, persistRunning: authority.persistRunning, publish: authority.publish, authorizeRelease: authority.authorizeRelease });
}
export function providerFallbackRuntimeResumeCleanupContext(permit: object) {
  const authority = providerFallbackResumeCleanupContext(permit), held = fallbackResumeLifecycles.get(permit);
  if (!held || held.request !== authority.request) throw new Error("Fallback resume cleanup has no original lifecycle binding.");
  held.cleanupCheck(); return Object.freeze({ launcher: held.launcher, request: held.request, deadline: authority.deadline, check: held.cleanupCheck });
}
export async function beginDockerProviderFallbackResume(service: object, permit: object): Promise<void> {
  const authority = providerFallbackResumeContext(permit), held = fallbackResumeServices.get(service);
  if (!held || authority.service !== service || !nativeSourceAdmissions.has(service)) throw new Error("Fallback resume requires its exact original Docker service.");
  await held.begin(permit); authority.check();
}
export async function cleanupDockerProviderFallbackResume(service: object, permit: object): Promise<void> {
  const authority = providerFallbackResumeCleanupContext(permit), held = fallbackResumeServices.get(service);
  if (!held || authority.service !== service || !nativeSourceAdmissions.has(service)) throw new Error("Fallback resume cleanup requires its exact original Docker service.");
  await held.cleanup(permit); authority.check();
}
export async function completeDockerProviderFallbackResume(service: object, permit: object): Promise<void> {
  const authority = providerFallbackResumeContext(permit), held = fallbackResumeServices.get(service);
  if (!held || authority.service !== service || !nativeSourceAdmissions.has(service)) throw new Error("Fallback resume completion requires its exact original Docker service.");
  await held.complete(permit);
}
export function providerFallbackRuntimeResumeContext(permit: object) {
  providerFallbackResumeContext(permit);
  const held = fallbackResumeBindings.get(permit);
  if (!held) throw new Error("Fallback resume has no original service observation.");
  held.check(); return Object.freeze({ ...held });
}
/** Observe the original ordinary reconciliation; this grants no launch or role-lease authority. */
export async function verifyDockerProviderFallbackResumed(service: object, permit: object): Promise<object> {
  const authority = providerFallbackResumeContext(permit), held = fallbackResumeServices.get(service);
  if (!held || authority.service !== service || !nativeSourceAdmissions.has(service)) throw new Error("Fallback resume observation requires its exact original Docker service.");
  const result = await held.verify(permit); authority.check(); return result;
}
export function providerFallbackTargetContext(value: object) {
  const held = fallbackTargets.get(value); if (!held) throw new Error("A genuine original fallback target is required."); held.check();
  return Object.freeze({ service: held.service, owner: held.owner, source: held.source, reservation: held.reservation, capsuleSha256: held.capsuleSha256, deadline: held.deadline, check: held.check,
    get launchIntent() { return held.launchIntent(); }, get native() { return providerDockerRoleLeaseContext(held.lease()); }, activate: held.activate, verifyRunning: held.verifyRunning, verifyStopped: held.verifyStopped, stop: held.stop,
    publish: held.publish, finalize: held.finalize, persistJournal: held.persistJournal, close: held.close });
}
export function providerFallbackTargetLaunchContext(value: object, reservation: object) {
  const held = fallbackTargets.get(value); if (!held || held.reservation !== reservation) throw new Error("Fallback target launch ownership differs.");
  const authority = providerFallbackReservationContext(reservation); authority.authorizeTarget(value); held.check();
  return Object.freeze({ launcher: held.launcher, deadline: held.deadline, capsuleSha256: held.capsuleSha256, projectId: held.source.projectId, releaseId: authority.identity.releaseId, generation: authority.identity.targetGeneration });
}

export function providerFallbackTargetActivationContext(value: object, reservation: object, intent: object) {
  const held = fallbackTargets.get(value); if (!held || held.reservation !== reservation || held.launchIntent() !== intent) throw new Error("Fallback target activation ownership differs.");
  const authority = providerFallbackReservationContext(reservation); authority.authorizeLaunch(value, intent); held.check(); return Object.freeze({ launcher: held.launcher });
}

export async function providerFallbackTargetPublicationLease(value: object, reservation: object, request: DeploymentProviderRequest): Promise<ProviderDockerRoleLease> {
  const held = fallbackTargets.get(value); if (!held || held.reservation !== reservation) throw new Error("Fallback target publication ownership differs.");
  const authority = providerFallbackReservationContext(reservation); authority.authorizeCompletion(value, request); held.check(); return held.lease();
}
export function closeProviderFallbackTarget(value: object): Promise<void> {
  const held = fallbackTargets.get(value); if (!held) throw new Error("A genuine original fallback target is required."); return held.close();
}
export function stageDockerProviderFallbackTarget(service: DeploymentProviderService, source: ProviderFallbackSource, reservation: object): Promise<ProviderFallbackTarget> {
  const held = fallbackTargetServices.get(service); if (!held || !nativeSourceAdmissions.has(service)) throw new Error("A genuine original ordinary Docker target provider is required.");
  const authority = providerFallbackReservationContext(reservation); authority.authorizeStage(source, service); providerFallbackSourceContext(source).check(); return held.stage(source, reservation);
}

async function assertProviderCanaryOwnership(ownership: ProviderServiceOwnership): Promise<void> {
  const fs = ownership.fs as NodeFs, path = ownership.path as NodePath;
  if (!providerCanaryOwner(await readPrivateJson(fs, path.join(ownership.serviceDirectory, ".canary-controller.json")))) {
    const serviceFiles = await fs.readdir(ownership.serviceDirectory),restartFiles=providerServiceRestartFiles(ownership);
    // Called only after genuine native handoff admission has independently
    // validated this namespace, its exact domain and every zero-barrier catalog.
    if (serviceFiles.some(name => name !== "handoff" && !restartFiles.includes(name) && !/^\.writer\.sqlite(?:-journal|-wal|-shm)?$/u.test(name))) {
      throw new Error("Provider canary owner is missing from retained state.");
    }
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
  try { await admitProviderService(ownership); await assertProviderCanaryOwnership(ownership); return await openOwnedDeploymentProviderService(options, ownership); }
  catch (error) { ownership.close(); throw error; }
}

async function openOwnedDeploymentProviderService(
  options: DeploymentProviderServiceOptions,
  ownership: ProviderServiceOwnership,
  adoption?:Readonly<{runtime:object;handoffId:string;lifecycleFence:number}>,
): Promise<DeploymentProviderService> {
  let adoptedRuntime=adoption===undefined?undefined:providerAdoptedTargetRuntimeContext(adoption.runtime);
  const recoveryProject=providerHandoff.providerServiceAdoptionRecoveryProject(ownership);
  const {root, serviceDirectory} = ownership;
  const fs = ownership.fs as NodeFs, path = ownership.path as NodePath;
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
  const resumeFlights = new Map<string, object>();
  const resumeStoppedReceipts = new Map<string, { state: string; data: string; request: DeploymentProviderRequest; recoveryOperationId: string; selected: "source" | "target"; tombstone?: object }>();
  const sourceResumeReceipts = new Map<string, { operationId: string; journal: string; authentication: string; state: string; data: string; identity: FallbackSourceIngressIdentity; tombstone?: object }>();
  const cancelledSourceRetirements = new Map<string, { journal: string; authentication: string; source: ProviderFallbackSource }>();
  const canaryOptions = normalizeProviderCanaryOptions(options.canaries);
  const canaryRoutes = new Map<string, { projectId: string; releaseId: string; generation: 1; path: string; token: string; readPaths: readonly string[] }>();
  const canaryReservations = new Set<string>();
  const canaryIntents = new Map<string,ProviderCandidateState>();
  const canaryProjectOwners = new Map<string,string>();
  const canaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const canaryDeadlines = new Map<string,number>();
  let canaryIntakeBusy=false;
  let canaryHttpIntakeBusy=false;
  let canaryStartupComplete=false;
  const providerIncarnation=crypto.randomUUID();
  const canaryOwnerPath=path.join(serviceDirectory,".canary-controller.json");
  const previousCanaryOwner=providerCanaryOwner(await readPrivateJson(fs,canaryOwnerPath));
  let canaryOwnerProtocol=previousCanaryOwner?.protocol ?? "clank-provider-canary-owner/1";
  const persistCanaryOwner = async () => {
    const expected={protocol:canaryOwnerProtocol,incarnation:providerIncarnation};
    await atomicWriteJson(fs,path,canaryOwnerPath,expected);
    const retained=providerCanaryOwner(await readPrivateJson(fs,canaryOwnerPath));
    if (!retained || retained.protocol!==expected.protocol || retained.incarnation!==expected.incarnation) throw new Error("Provider canary owner persistence could not be verified.");
  };
  await persistCanaryOwner();
  let closed = false;
  let closing: Promise<void> | undefined;
  const fallbackSourceCloses = new Set<() => void>();
  const fallbackTargetCloses = new Set<() => Promise<void>>();

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
    if (row.nativeFallback !== undefined && row.nativeFallback !== true) throw new Error("Invalid native fallback barrier.");
    return { id: row.id, projectId, releaseId: row.releaseId, generation: Number(row.generation), tokenDigest: row.tokenDigest as number[], writersStopped: row.writersStopped, ...(row.nativeFallback ? { nativeFallback: true as const } : {}) };
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
    if(adoptedRuntime?.projectId===projectId)adoptedRuntime=undefined;
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
  const retirementsPath = (projectId: string) => path.join(serviceDirectory, `${identifier(projectId, "projectId")}.canary-retirements.json`);
  const issuedBindingPath = (projectId: string) => path.join(serviceDirectory, `${identifier(projectId,"projectId")}.canary-binding.json`);
  const readIssuedBinding = async (projectId: string): Promise<ProviderCanaryIssuedBinding | null> => {
    const raw=await readPrivateJson(fs,issuedBindingPath(projectId));
    return raw===null ? null : providerCanaryIssuedBinding(raw,projectId);
  };
  const candidateId = async (state: Pick<DeploymentProviderCanaryState, "primary" | "operationId" | "controllerEpoch" | "capsuleSha256">) =>
    `canary_${await deploymentRuntimeDigest(new TextEncoder().encode([state.primary.projectId, state.primary.incarnation, state.controllerEpoch, state.operationId, state.capsuleSha256].join("\n")))}`;
  const readCanary = async (projectId: string): Promise<ProviderCanaryJournal | null> => {
    const raw = await readPrivateJson(fs, canaryPath(projectId));
    if (raw === null) return null;
    const journal = providerCanaryJournal(raw, projectId);
    if (journal.protocol==="clank-provider-canary/2" && canaryOwnerProtocol!=="clank-provider-canary-owner/2") throw new Error("Provider shadow owner capability is missing.");
    if (journal.current.candidateProjectId !== await candidateId(journal.current)) throw new Error("Provider canary ownership identity is invalid.");
    return journal;
  };
  const writeCanary = async (projectId:string,journal:ProviderCanaryJournal) => {
    await atomicWriteJson(fs,path,canaryPath(projectId),journal);
    if (journal.protocol==="clank-provider-canary/2" && JSON.stringify(await readCanary(projectId))!==JSON.stringify(providerCanaryJournal(journal,projectId))) throw new Error("Provider shadow journal persistence could not be verified.");
  };
  const readRetirements = async (projectId: string, journal: ProviderCanaryJournal | null): Promise<ProviderCanaryRetirements | null> => {
    const raw=await readPrivateJson(fs,retirementsPath(projectId));
    if (raw===null) return null;
    const retired=providerCanaryRetirements(raw,projectId);
    if (journal && sameCanaryBinding(journal.current.primary,retired.primary)
      && new Set([...journal.spent,...retired.entries.map(entry=>entry.operationId)]).size>64) throw new Error("Provider canary retirement history exceeds its combined capacity.");
    for (const entry of retired.entries) {
      if (entry.candidateProjectId!==await candidateId({...entry,primary:retired.primary})) throw new Error("Provider canary retirement ownership identity is invalid.");
      if (journal && (entry.operationId===journal.current.operationId || entry.candidateProjectId===journal.current.candidateProjectId)
        && (!sameCanaryBinding(retired.primary,journal.current.primary) || !sameCanaryOperation(entry,journal.current)
          || entry.phase==="retired" && journal.current.phase!=="stopped")) throw new Error("Provider canary retirement conflicts with its retained candidate journal.");
    }
    return retired;
  };
  const stopCanary = async (projectId: string, expected?: Pick<DeploymentProviderCanaryState,"primary"|"operationId"|"controllerEpoch">, authorize:()=>Promise<void>=async()=>{}): Promise<ProviderCandidateState | null> => {
    const journal = await readCanary(projectId);
    await authorize();
    if (journal && expected && (!sameCanaryBinding(journal.current.primary,expected.primary) || journal.current.operationId!==expected.operationId || journal.current.controllerEpoch!==expected.controllerEpoch)) throw new Error("Provider canary cleanup identity is stale.");
    if (journal) {
      const isolatedProject=journal.current.candidateProjectId,owner=canaryProjectOwners.get(isolatedProject);
      if (owner && owner!==projectId) throw new Error("Provider canary cleanup collides with unrelated ownership.");
      // An old, internally valid journal can be restored beside a newer ordinary
      // project. Validate its current owner before any journal or cleanup effect.
      if (journal.current.phase!=="stopped" && (controls.has(isolatedProject) || await readProjectState(isolatedProject))) throw new Error("Provider canary cleanup collides with ordinary ownership.");
    }
    await authorize();
    // Reconstruct ownership only during serialized lifecycle or startup cleanup.
    // An asynchronous request read must not reclaim an already retired identity.
    if (journal && journal.current.phase!=="stopped") canaryProjectOwners.set(journal.current.candidateProjectId,projectId);
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
    await writeCanary(projectId,journal);
    await authorize();
    const isolatedProject = journal.current.candidateProjectId;
    await cleanupCandidate(null, {projectId:isolatedProject, generation:1});
    await authorize();
    if (ingress.inspect().some(route=>route.projectId===isolatedProject)
      || runtimes.inspect().some(runtime=>runtime.projectId===isolatedProject)) throw new Error("Provider canary still has a runtime; data cleanup is refused.");
    await data.delete({projectId:isolatedProject, confirmation:`delete ${isolatedProject}`});
    await authorize();
    if (await data.inspect(isolatedProject) || ingress.inspect().some(route=>route.projectId===isolatedProject)
      || runtimes.inspect().some(runtime=>runtime.projectId===isolatedProject)) throw new Error("Provider canary cleanup could not be verified.");
    await authorize();
    ingress.forget(isolatedProject,1);
    journal.current = Object.freeze({ ...journal.current, phase:"stopped" });
    await writeCanary(projectId,journal);
    await authorize();
    canaryReservations.delete(projectId);
    canaryIntents.delete(projectId);
    canaryProjectOwners.delete(isolatedProject);
    return journal.current;
  };
  const primaryBinding = async (projectId: string): Promise<DeploymentProviderCanaryBinding | null> => {
    const control = controls.get(projectId);
    const state = await readProjectState(projectId);
    const owner=providerCanaryOwner(await readPrivateJson(fs,canaryOwnerPath));
    if (closed || !control || controls.get(projectId)!==control || !state || state.phase!=="running" || state.state!=="running"
      || state.releaseId!==control.releaseId || state.generation!==control.generation || owner?.protocol!==canaryOwnerProtocol || owner.incarnation!==providerIncarnation) return null;
    return Object.freeze({projectId, releaseId:control.releaseId, generation:control.generation, fence:state.fence, incarnation:control.incarnation});
  };
  const requireCanaryBinding = async (expected: DeploymentProviderCanaryBinding) => {
    const actual = await primaryBinding(expected.projectId);
    if (!actual || !sameCanaryBinding(actual,expected)) throw new Error("Provider canary primary binding is stale.");
  };
  const finishRetirement = async (retired: ProviderCanaryRetirements, entry: ProviderCanaryRetirementEntry, assertOpen: () => Promise<void>) => {
    const projectId=retired.primary.projectId,isolatedProject=entry.candidateProjectId;
    // Also hold the candidate lane: an ordinary request may already have passed
    // capsule decoding before this retirement entered the primary lane.
    return exclusive(isolatedProject,async()=> {
      await assertOpen();
      const journal=await readCanary(projectId);
      await assertOpen();
      const exact=journal && sameCanaryBinding(journal.current.primary,retired.primary) && sameCanaryOperation(journal.current,entry);
      if (journal && (journal.current.operationId===entry.operationId || journal.current.candidateProjectId===isolatedProject) && !exact) throw new Error("Provider canary retirement conflicts with the current candidate.");
      if (controls.has(isolatedProject) || await readProjectState(isolatedProject)
        || canaryProjectOwners.has(isolatedProject) && (!exact || canaryProjectOwners.get(isolatedProject)!==projectId)) throw new Error("Provider canary retirement collides with ordinary or unrelated ownership.");
      await assertOpen();
      if (exact) await stopCanary(projectId,journal.current,assertOpen);
      await assertOpen();
      // An orphan directory without a data manifest is still uncertain state;
      // do not ask the data store to recover an unmatched directory.
      try {await fs.lstat(path.join(root,"projects",isolatedProject));throw new Error("Provider canary retirement found unmatched candidate data.");}
      catch(error) {if (nodeCode(error)!=="ENOENT") throw error;}
      if (await data.inspect(isolatedProject) || await readProjectState(isolatedProject)
        || controls.has(isolatedProject) || canaryProjectOwners.has(isolatedProject)
        || ingress.inspect().some(route=>route.projectId===isolatedProject)
        || runtimes.inspect().some(runtime=>runtime.projectId===isolatedProject)) throw new Error("Provider canary retirement absence could not be verified.");
      await assertOpen();
      if (entry.phase!=="retired") {
        entry.phase="retired";
        await atomicWriteJson(fs,path,retirementsPath(projectId),retired);
        await assertOpen();
      }
      return Object.freeze({protocol:"clank-provider-canary-retirement/1" as const,primary:retired.primary,...entry,phase:"retired" as const});
    });
  };
  const createCanaryController = (authorize:()=>Promise<void>=async()=>{}, allowUnknownOldBinding=false, expectedReleaseId?:string): DeploymentProviderCanaryController => ({
    binding(projectId) { return closed ? Promise.resolve(null) : exclusive(identifier(projectId,"projectId"),async()=> {await authorize();const binding=await primaryBinding(projectId);await authorize();return binding;}); },
    inspect(projectId) { return exclusive(identifier(projectId,"projectId"),async()=> {
      if (closed) throw new Error("Deployment provider service is closed.");
      await authorize();
      const state=(await readCanary(projectId))?.current ?? null;
      await authorize();return state;
    }); },
    prepare: (async (input:ProviderCanaryPrepareInput & {readonly purpose?:unknown;readonly stateProtocol?:unknown}) => {
      const policy=canaryOptions;
      if (!policy || closed || canaryIntakeBusy) throw new Error("Provider canary capsule intake is unavailable.");
      canaryIntakeBusy=true;
      try {
      const startedAt=Date.now(),monotonicStartedAt=performance.now();
      const shadow=shadowPrepare(input);
      const primary = normalizedCanaryBinding(input?.primary);
      const controllerEpoch = positiveInteger(input.controllerEpoch,"controllerEpoch");
      const operationId = identifier(input.operationId,"operationId");
      const signal=input.signal;
      if (!(signal instanceof AbortSignal)) throw new TypeError("Canary signal must be an AbortSignal.");
      throwIfAborted(signal);
      const incoming=input.runtime?.bytes,expectedDigest=pattern(input.runtime?.sha256,"canary capsuleSha256",DIGEST);
      if (!(incoming instanceof Uint8Array) || incoming.byteLength>maxDatabaseBytes+102*1024*1024+32) throw new RangeError("Provider canary capsule exceeds its intake bound.");
      const capturedBytes=new Uint8Array(incoming);
      await authorize();
      const runtime = await decodeDeploymentRuntimeCapsule(capturedBytes,{maxDatabaseBytes});
      if (runtime.sha256!==expectedDigest || runtime.manifest.projectId!==primary.projectId || runtime.manifest.releaseId===primary.releaseId
        || expectedReleaseId!==undefined && runtime.manifest.releaseId!==expectedReleaseId
        || runtime.manifest.database.mode!=="preserve" || runtime.databaseSnapshot || runtime.artifact.bundle.config.jobs) throw new Error("Provider canaries require a distinct code-only release with no declared jobs.");
      return await exclusive(primary.projectId,async()=> {
        let deadline=0;
        const check = async () => {throwIfAborted(signal); await authorize();await requireCanaryBinding(primary);await authorize();if (Date.now()<startedAt || deadline && Date.now()>=deadline
          || performance.now()-monotonicStartedAt>=policy.maximumDurationMs) throw new Error("Provider canary preparation expired or its clock regressed.");};
        await check();
        if (await readEvacuation(primary.projectId)) throw new Error("Provider canary primary is evacuating.");
        const prior = await readCanary(primary.projectId);
        const retired=await readRetirements(primary.projectId,prior);
        await check();
        if (retired?.entries.some(entry=>entry.phase!=="retired")) throw new Error("Provider canary retirement cleanup is unresolved.");
        if (retired?.entries.some(entry=>entry.operationId===operationId)
          || retired && sameCanaryBinding(retired.primary,primary) && controllerEpoch<retired.epochFloor) throw new Error("Provider canary operation or controller epoch is retired.");
        if (prior?.current.operationId===operationId) {
          const current=prior.current, route=canaryRoutes.get(primary.projectId);
          if (!sameCanaryBinding(current.primary,primary) || current.controllerEpoch!==controllerEpoch || current.capsuleSha256!==runtime.sha256 || (current.protocol==="clank-provider-canary/2")!==shadow) throw new Error("Provider canary retry identity differs.");
          if (current.phase!=="running" || !route || current.expiresAt<=Date.now()
            || Date.now()<current.expiresAt-policy.maximumDurationMs
            || (canaryDeadlines.get(primary.projectId)??0)<=performance.now()) throw new Error("Provider canary operation is retired or needs cleanup.");
          return Object.freeze({...current,route});
        }
        if (prior && prior.current.phase!=="stopped") throw new Error("Provider canary cleanup is unresolved.");
        const spent = prior && sameCanaryBinding(prior.current.primary,primary) ? [...prior.spent] : [];
        if (spent.includes(operationId) || prior && sameCanaryBinding(prior.current.primary,primary) && controllerEpoch<prior.current.controllerEpoch) throw new Error("Provider canary operation or controller epoch is retired.");
        const operations=new Set([...spent,...(retired && sameCanaryBinding(retired.primary,primary)?retired.entries.map(entry=>entry.operationId):[])]);
        if (operations.size>=policy.maxOperations || canaryReservations.size>=policy.maxConcurrent) throw new Error("Provider canary capacity is exhausted.");
        if (shadow && canaryOwnerProtocol!=="clank-provider-canary-owner/2") {
          canaryOwnerProtocol="clank-provider-canary-owner/2";
          await persistCanaryOwner();
          await check();
        }
        const state: ProviderCandidateState = Object.freeze({...(shadow ? {protocol:"clank-provider-canary/2" as const,purpose:"shadow" as const,snapshot:null} : {protocol:"clank-provider-canary/1" as const}),operationId,primary,controllerEpoch,
          candidateProjectId:await candidateId({primary,operationId,controllerEpoch,capsuleSha256:runtime.sha256}),releaseId:runtime.manifest.releaseId,
          capsuleSha256:runtime.sha256,phase:"preparing",expiresAt:startedAt+policy.maximumDurationMs});
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
          if (canaryReservations.size>=policy.maxConcurrent) throw new Error("Provider canary capacity is exhausted.");
        } catch (error) {canaryProjectOwners.delete(state.candidateProjectId);throw error;}
        // Reserve synchronously before the first journal await, across project locks.
        canaryReservations.add(primary.projectId);
        canaryIntents.set(primary.projectId,state);
        const journal: ProviderCanaryJournal={protocol:state.protocol,spent:[...spent,operationId],current:state};
        try {
          await writeCanary(primary.projectId,journal);
          await check();
          await runtimes.prepareProject?.(state.candidateProjectId,signal);
          await check();
          const snapshotStartedAt=Date.now();
          let snapshot=await data.snapshot(primary.projectId);
          const snapshotCompletedAt=Date.now();
          if (shadow && snapshot) {
            if (!(snapshot.bytes instanceof Uint8Array) || snapshot.bytes.byteLength>maxDatabaseBytes) throw new Error("Provider shadow checkpoint exceeds its bound.");
            snapshot={...snapshot,bytes:new Uint8Array(snapshot.bytes)};
          }
          await check();
          if (!snapshot || snapshot.projectId!==primary.projectId || snapshot.releaseId!==primary.releaseId || snapshot.generation!==primary.generation
            || snapshot.bytes.byteLength>maxDatabaseBytes || snapshot.sha256!==await deploymentRuntimeDigest(snapshot.bytes)) throw new Error("Provider canary checkpoint is unavailable.");
          await check();
          if (journal.current.protocol==="clank-provider-canary/2") {
            if (!Number.isSafeInteger(snapshotStartedAt) || snapshotStartedAt<1 || !Number.isSafeInteger(snapshotCompletedAt)
              || snapshotCompletedAt<snapshotStartedAt || snapshotCompletedAt>=state.expiresAt) throw new Error("Provider shadow checkpoint clock is invalid.");
            journal.current=Object.freeze({...journal.current,snapshot:Object.freeze({sha256:snapshot.sha256,bytes:snapshot.bytes.byteLength,startedAt:snapshotStartedAt,completedAt:snapshotCompletedAt})});
            await writeCanary(primary.projectId,journal);
            await check();
          }
          const route=Object.freeze({projectId:state.candidateProjectId,releaseId:state.releaseId,generation:1 as const,
            path:`/v1/clank/apps/${state.candidateProjectId}`,token:`clanki_${crypto.randomUUID()}_${crypto.randomUUID()}`,readPaths:policy.readPaths});
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
          await ingress.activate({protocol:DEPLOYMENT_RUNTIME_PROTOCOL,projectId:route.projectId,releaseId:route.releaseId,
            generation:route.generation,path:route.path,token:route.token,upstream:(candidate as DockerDeploymentRuntimeCandidate).upstream});
          await check();
          journal.current=Object.freeze({...journal.current,phase:"running"});
          await writeCanary(primary.projectId,journal);
          await check();
          canaryRoutes.set(primary.projectId,route);
          canaryDeadlines.set(primary.projectId,monotonicStartedAt+policy.maximumDurationMs);
          const timer=setTimeout(()=>{void exclusive(primary.projectId,()=>stopCanary(primary.projectId,state)).catch(report);},Math.max(1,Math.min(state.expiresAt-Date.now(),policy.maximumDurationMs-(performance.now()-monotonicStartedAt))));
          (timer as unknown as {unref?:()=>void}).unref?.();
          canaryTimers.set(primary.projectId,timer);
          return Object.freeze({...journal.current,route});
        } catch (error) {
          try {await stopCanary(primary.projectId,state);} catch(cleanupError) {throw new AggregateError([error,cleanupError],"Provider canary preparation and cleanup failed.");}
          throw error;
        }
      });
      } finally {canaryIntakeBusy=false;}
    }) as DeploymentProviderCanaryController["prepare"],
    async stop(input) {
      if (closed) throw new Error("Deployment provider service is closed.");
      const primary=normalizedCanaryBinding(input?.primary);
      const operationId=identifier(input.operationId,"operationId"),epoch=positiveInteger(input.controllerEpoch,"controllerEpoch");
      return exclusive(primary.projectId,async()=> {
        if (closed) throw new Error("Deployment provider service is closed.");
        await authorize();
        const journal=await readCanary(primary.projectId);
        await authorize();
        if (!journal || !sameCanaryBinding(journal.current.primary,primary) || journal.current.operationId!==operationId || journal.current.controllerEpoch!==epoch) throw new Error("Provider canary cleanup identity differs.");
        return (await stopCanary(primary.projectId,journal.current,authorize))!;
      });
    },
    async retire(input) {
      if (closed) throw new Error("Deployment provider service is closed.");
      // Capture every caller field before the first await, including the primary.
      const primary=normalizedCanaryBinding(input?.primary);
      const requested=Object.freeze({operationId:identifier(input.operationId,"operationId"),controllerEpoch:positiveInteger(input.controllerEpoch,"controllerEpoch"),
        releaseId:identifier(input.releaseId,"releaseId"),capsuleSha256:pattern(input.capsuleSha256,"capsuleSha256",DIGEST),retirementEpoch:positiveInteger(input.retirementEpoch,"retirementEpoch")});
      if (requested.retirementEpoch<requested.controllerEpoch || requested.releaseId===primary.releaseId) throw new Error("Provider canary retirement epoch or release is invalid.");
      return exclusive(primary.projectId,async()=> {
        const assertOpen=async()=> {if (closed) throw new Error("Deployment provider service is closed.");await authorize();};
        await assertOpen();
        const journal=await readCanary(primary.projectId);
        let retired=await readRetirements(primary.projectId,journal);
        await assertOpen();
        const retained=retired?.entries.find(entry=>entry.operationId===requested.operationId);
        if (retained && (!sameCanaryBinding(retired!.primary,primary) || !sameCanaryOperation(retained,requested))) throw new Error("Provider canary retirement identity conflicts with its retained operation.");
        const current=journal?.current;
        if (current?.operationId===requested.operationId && (!sameCanaryBinding(current.primary,primary) || !sameCanaryOperation(current,requested))) throw new Error("Provider canary retirement identity conflicts with its current operation.");
        if (!retained && current?.operationId!==requested.operationId) {
          if (!allowUnknownOldBinding) await requireCanaryBinding(primary);
          await assertOpen();
          if (journal && sameCanaryBinding(journal.current.primary,primary) && journal.spent.includes(requested.operationId)) throw new Error("Provider canary retirement cannot verify a historical operation identity.");
        }
        if (retired && !sameCanaryBinding(retired.primary,primary)) {
          await requireCanaryBinding(primary);
          if (retired.entries.some(entry=>entry.phase!=="retired")) throw new Error("Provider canary retirement cleanup is unresolved.");
          retired=null;
        }
        const candidateProjectId=await candidateId({...requested,primary});
        await assertOpen();
        if (candidateProjectId===primary.projectId) throw new Error("Provider canary retirement collides with its primary.");
        const spent=journal && sameCanaryBinding(journal.current.primary,primary)?journal.spent:[];
        const operations=new Set([...spent,...(retired?.entries.map(entry=>entry.operationId)??[])]);
        if (!operations.has(requested.operationId) && operations.size>=(canaryOptions?.maxOperations??64)) throw new Error("Provider canary capacity is exhausted.");
        retired??={protocol:"clank-provider-canary-retirements/1",primary,epochFloor:requested.retirementEpoch,entries:[]};
        retired.epochFloor=Math.max(retired.epochFloor,requested.retirementEpoch,current && sameCanaryBinding(current.primary,primary)?current.controllerEpoch:0);
        const entry:ProviderCanaryRetirementEntry={...requested,candidateProjectId,retirementEpoch:Math.max(requested.retirementEpoch,retained?.retirementEpoch??0),phase:"retiring"};
        if (retained) retired.entries[retired.entries.indexOf(retained)]=entry;else retired.entries.push(entry);
        await assertOpen();
        await atomicWriteJson(fs,path,retirementsPath(primary.projectId),retired);
        await assertOpen();
        return finishRetirement(retired,entry,assertOpen);
      });
    },
  });
  const canaries=canaryOptions ? createCanaryController() : undefined;

  // Opening any service, including the default/disabled configuration, retires
  // persisted candidates before primary reconciliation can admit another writer.
  const serviceFiles=await fs.readdir(serviceDirectory);
  if (serviceFiles.length>100_000) throw new Error("Provider service metadata capacity is exhausted.");
  for (const name of serviceFiles.filter(name=>name.endsWith(".canary-binding.json"))) {
    await readIssuedBinding(identifier(name.slice(0,-20),"canary binding projectId"));
  }
  const retirementJournals:ProviderCanaryRetirements[]=[];
  for (const name of serviceFiles.filter(name=>name.endsWith(".canary-retirements.json"))) {
    const projectId=identifier(name.slice(0,-24),"canary retirement projectId");
    const retired=await readRetirements(projectId,await readCanary(projectId));
    if (retired) retirementJournals.push(retired);
  }
  // Check retirement ownership before general candidate cleanup can delete data.
  for (const retired of retirementJournals) for (const entry of retired.entries) {
    if (entry.phase==="retiring") await finishRetirement(retired,entry,async()=>{});
  }
  for (const name of serviceFiles.filter(name=>name.endsWith(".canary.json"))) {
    const projectId=identifier(name.slice(0,-12),"canary projectId");
    await stopCanary(projectId);
  }

  canaryStartupComplete=true;

  const handleCanaryControl = async (request:Request, projectId:string, operation:string):Promise<Response> => {
    const unavailable=()=>controlProblem(503,"CANARY_CONTROL_UNCERTAIN","Provider canary outcome is uncertain; retry exact retirement before proceeding.");
    const denied=()=>controlProblem(404,"CONTROL_NOT_FOUND","Provider control endpoint not found.");
    const deadline=new AbortController(),started=performance.now(),timeoutMs=canaryOptions?.controlTimeoutMs??60_000;
    const abort=()=>deadline.abort();
    request.signal.addEventListener("abort",abort,{once:true});
    if (request.signal.aborted) abort();
    let expire!:()=>void;
    const expired=new Promise<Response>(resolve=> {expire=()=>{abort();resolve(unavailable());};});
    const timer=setTimeout(expire,timeoutMs);
    const checkDeadline=()=> {throwIfAborted(deadline.signal);if (performance.now()-started>=timeoutMs) throw new Error("Provider canary control deadline expired.");};
    const work=(async()=> {
      let releaseIntake=false;
      let failedPrepare: (()=>Promise<unknown>) | undefined;
      try {
        const url=new URL(request.url);
        // Reject invalid control envelopes before authentication or application ingress.
        let headerBytes=0,headerCount=0;
        for (const [name,value] of request.headers) {headerBytes+=name.length+value.length;headerCount++;}
        const bindingRequest=operation==="binding",prepareRequest=operation==="prepare";
        const declared=request.headers.get("content-length");
        const maximum=prepareRequest ? maxDatabaseBytes+102*1024*1024+32 : 4_096;
        const header=request.headers.get("x-clank-canary-input");
        if (url.search || url.hash || url.username || url.password || headerBytes>16_384 || headerCount>64
          || request.headers.has("content-encoding") || request.headers.has("transfer-encoding")
          || request.method!==(bindingRequest?"GET":"POST") || !["binding","prepare","inspect","stop","retire"].includes(operation)
          || !canaryOptions && operation!=="retire"
          || bindingRequest && (request.body || declared!==null && declared!=="0" || header!==null)
          || !bindingRequest && (!declared || !/^[1-9][0-9]{0,9}$/u.test(declared) || Number(declared)>maximum || !request.body
            || request.headers.get("content-type")!==(prepareRequest?DEPLOYMENT_RUNTIME_MEDIA_TYPE:"application/json"))
          || prepareRequest && (!header || header.length>4_096) || !prepareRequest && header!==null) return denied();
        const credential=bearerCredential(request.headers.get("authorization"));
        if (!credential) return denied();
        // Digest first, then read the admitted binding. Do not hold capsule intake
        // while an unauthenticated peer sends an incomplete body.
        const admittedDigest=await secretDigest(credential);
        checkDeadline();
        const control=controls.get(projectId);
        const issued=await readIssuedBinding(projectId);
        checkDeadline();
        const currentCredential=!!control && controls.get(projectId)===control && sameDigest(admittedDigest,control.tokenDigest);
        const cleanupCredential=operation==="retire" && issued!==null && sameDigest(admittedDigest,issued.tokenDigest);
        if (!currentCredential && !cleanupCredential) return denied();
        if (operation!=="retire" && !currentCredential) return denied();
        const currentAuthority=async()=> {
          checkDeadline();
          if (closed || !control || controls.get(projectId)!==control || !sameDigest(admittedDigest,control.tokenDigest)) throw new Error("Provider canary current authority changed.");
          const actual=await primaryBinding(projectId);
          checkDeadline();
          if (!actual || controls.get(projectId)!==control) throw new Error("Provider canary current authority changed.");
          return actual;
        };
        if (bindingRequest) return await exclusive(projectId,async()=> {
          const primary=await currentAuthority();
          const prior=await readIssuedBinding(projectId);
          await currentAuthority();
          const next:ProviderCanaryIssuedBinding={protocol:"clank-provider-canary-binding/1",primary,serviceIncarnation:providerIncarnation,tokenDigest:[...admittedDigest]};
          if (!prior || !sameIssuedBinding(prior,next)) {
            const journal=await readCanary(projectId);
            const retired=await readRetirements(projectId,journal);
            await currentAuthority();
            // A binding replacement cannot erase cleanup authority while any old
            // candidate or retirement remains unresolved.
            if (retired) for (const entry of retired.entries) {
              if (entry.phase==="retiring") await finishRetirement(retired,entry,async()=>{await currentAuthority();});
            }
            if (journal && journal.current.phase!=="stopped") {
              if (!prior || !sameCanaryBinding(journal.current.primary,prior.primary)) throw new Error("Provider canary binding replacement has unrelated ownership.");
              await stopCanary(projectId,journal.current,async()=>{await currentAuthority();});
            }
            await currentAuthority();
            await atomicWriteJson(fs,path,issuedBindingPath(projectId),next);
          }
          // An ignored or altered write cannot issue an unrecoverable binding.
          const verified=await readIssuedBinding(projectId);
          await currentAuthority();
          if (!verified || !sameIssuedBinding(verified,next)) throw new Error("Provider canary binding persistence could not be verified.");
          return providerCanaryControlResponse({binding:primary});
        });
        if (!issued || operation!=="retire" && (!currentCredential || issued.serviceIncarnation!==providerIncarnation)) return denied();
        const input=prepareRequest ? parseCanaryControlJson(header!) : parseCanaryControlJson(new TextDecoder("utf-8",{fatal:true}).decode(await readCanaryControlBody(request,Number(declared),maximum,deadline.signal)));
        checkDeadline();
        const allowed=prepareRequest ? ["primary","operationId","controllerEpoch","releaseId","capsuleSha256","purpose","stateProtocol"]
          : operation==="retire" ? ["primary","operationId","controllerEpoch","releaseId","capsuleSha256","retirementEpoch"] : ["primary","operationId","controllerEpoch"];
        exactControlJson(input,allowed);
        const shadow=prepareRequest ? shadowPrepare(input) : false;
        const primary=normalizedCanaryBinding(exactControlJson(input.primary,["projectId","releaseId","generation","fence","incarnation"]) as unknown as DeploymentProviderCanaryBinding);
        const operationId=identifier(input.operationId,"operationId"),controllerEpoch=positiveInteger(input.controllerEpoch,"controllerEpoch");
        if (primary.projectId!==projectId || !sameCanaryBinding(primary,issued.primary)) return denied();
        // Captured receipt and digest, not a fresh credential lookup, fence every
        // asynchronous controller continuation. Cleanup does not gain read/admit privileges.
        const receiptAuthority=async(checkTime=true)=> {
          if (checkTime) checkDeadline();
          if (closed || !canaryStartupComplete) throw new Error("Provider canary control is unavailable.");
          const retained=await readIssuedBinding(projectId);
          if (checkTime) checkDeadline();
          if (closed || !retained || !sameIssuedBinding(retained,issued) || !sameDigest(admittedDigest,retained.tokenDigest)) throw new Error("Provider canary issued authority changed.");
        };
        const authorize=async()=> {
          await receiptAuthority();
          if (operation!=="retire") {
            const actual=await currentAuthority();
            if (!sameCanaryBinding(actual,primary)) throw new Error("Provider canary primary changed.");
          }
        };
        await authorize();
        const oldIssuer=issued.serviceIncarnation!==providerIncarnation && canaryStartupComplete;
        if (prepareRequest) {
          const releaseId=identifier(input.releaseId,"releaseId"),capsuleSha256=pattern(input.capsuleSha256,"capsuleSha256",DIGEST);
          if (releaseId===primary.releaseId) return denied();
          if (canaryHttpIntakeBusy || canaryIntakeBusy) return unavailable();
          canaryHttpIntakeBusy=true;releaseIntake=true;
          const retirement=Object.freeze({primary,operationId,controllerEpoch,releaseId,capsuleSha256,retirementEpoch:controllerEpoch});
          failedPrepare=()=>createCanaryController(()=>receiptAuthority(false),oldIssuer).retire(retirement);
          const bytes=await readCanaryControlBody(request,Number(declared),maximum,deadline.signal);
          await authorize();
          const prepareInput={primary,operationId,controllerEpoch,runtime:{bytes,sha256:capsuleSha256} as DeploymentRuntimeCapsule,signal:deadline.signal};
          const controller=createCanaryController(authorize,false,releaseId);
          const result=await (shadow?controller.prepare({...prepareInput,purpose:"shadow",stateProtocol:"clank-provider-canary/2"}):controller.prepare(prepareInput));
          await authorize();
          const response=providerCanaryControlResponse({state:result});
          checkDeadline();
          failedPrepare=undefined;
          return response;
        }
        const controller=createCanaryController(authorize,oldIssuer);
        if (operation==="retire") {
          const result=await controller.retire({primary,operationId,controllerEpoch,releaseId:identifier(input.releaseId,"releaseId"),
            capsuleSha256:pattern(input.capsuleSha256,"capsuleSha256",DIGEST),retirementEpoch:positiveInteger(input.retirementEpoch,"retirementEpoch")});
          await authorize();
          return providerCanaryControlResponse({retirement:result});
        }
        const state=operation==="stop" ? await controller.stop({primary,operationId,controllerEpoch}) : await controller.inspect(projectId);
        await authorize();
        if (state && (!sameCanaryBinding(state.primary,primary) || state.operationId!==operationId || state.controllerEpoch!==controllerEpoch)) return unavailable();
        return providerCanaryControlResponse({state});
      } catch {
        // A timeout or lost response is not an absence receipt. Queue an exact
        // barrier, while the caller must durably retry retirement before advancing.
        if (failedPrepare) void failedPrepare().catch(report);
        return unavailable();
      } finally {if (releaseIntake) canaryHttpIntakeBusy=false;}
    })();
    try {return await Promise.race([work,expired]);}
    finally {clearTimeout(timer);request.signal.removeEventListener("abort",abort);}
  };

  const service: DeploymentProviderService = {
    protocol: DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,
    kind,
    ...(canaries ? {canaries:Object.freeze(canaries)} : {}),

    async reconcile(requestInput) {
      const replacement=sourceReplacements.get(service);if(replacement)return replacement.reconcile(requestInput);
      if (closed) throw new Error("Deployment provider service is closed.");
      const request = await providerRequest(requestInput, maxDatabaseBytes);
      return exclusive(request.operation.projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        const resume = resumeFlights.get(request.operation.projectId);
        if (resume) { const held = providerFallbackRuntimeResumeLifecycleContext(resume); if (held.request !== requestInput) throw new Error("Project belongs to its original fallback resume operation."); }
        if (canaryProjectOwners.has(request.operation.projectId)) throw new Error("Isolated canary projects cannot use ordinary lifecycle operations.");
        throwIfAborted(request.signal);
        if (await readEvacuation(request.operation.projectId)) throw new Error("Project is fenced for planned evacuation; source writers must remain stopped.");
        const prior = await readProjectState(request.operation.projectId);
        const resumed = resume ? providerFallbackRuntimeResumeLifecycleContext(resume) : null;
        const resumedStopped = resumed?.stoppedState !== null && resumed?.stoppedState !== undefined && JSON.stringify(prior) === resumed.stoppedState;
        if (resumedStopped) { const committed = await data.inspect(request.operation.projectId); resumed!.check(); if (JSON.stringify(committed) !== resumed!.stoppedData) throw new Error("Fallback resume stopped data receipt changed."); }
        assertAccepted(prior, request, resumedStopped);
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
          const ingressBinding = Object.freeze({
            protocol: DEPLOYMENT_RUNTIME_PROTOCOL,
            projectId: committed.projectId,
            releaseId: committed.releaseId,
            generation: committed.generation,
            path: prepared.ingress.route,
            token: prepared.ingress.token,
            upstream: active.upstream,
          });
          if (resume && resumed?.ingressTombstone) {
            const original = resumed.request;
            const check = () => {
              resumed.check(); throwIfAborted(original.signal);
              const current = runtimes.inspect().filter(row => row.projectId === original.operation.projectId);
              if (current.length !== 1 || current[0].status !== "active" || current[0].generation !== original.desired.generation || current[0].releaseId !== original.desired.releaseId || current[0].capsuleSha256 !== original.runtime!.sha256 || current[0].upstream !== active.upstream || controls.has(original.operation.projectId)) throw new Error("Fallback ingress retry original native runtime changed.");
            };
            const verifyState = async () => {
              check(); const [state, stored] = await Promise.all([readProjectState(original.operation.projectId), data.inspect(original.operation.projectId)]); check();
              if (!state || state.phase !== "reconciling" || state.operationId !== original.operation.id || state.fence !== original.operation.fence || !matchesState(state, original) || !matchesData(stored, original) || stored!.fence !== original.operation.fence) throw new Error("Fallback ingress retry original committed state changed.");
            };
            if (fallbackIngressReactivations.has(resume)) throw new Error("Fallback ingress retry publication is already in progress.");
            fallbackIngressReactivations.set(resume, { ingress, request: original, tombstone: resumed.ingressTombstone, binding: ingressBinding, check, async verifyRunning() {
              await verifyState();
              if (fallbackResumeBindings.has(resume)) throw new Error("Fallback ingress retry native observation is already in progress.");
              fallbackResumeBindings.set(resume, { launcher: runtimes, request: original, deadline: providerFallbackResumeContext(resume).deadline, check });
              try { await verifyProviderDockerFallbackResumed(runtimes, resume); await verifyState(); check(); }
              finally { fallbackResumeBindings.delete(resume); }
            } });
            try { await reactivateProviderRuntimeFallbackIngress(ingress, resume); check(); }
            finally { fallbackIngressReactivations.delete(resume); }
          } else {
            await ingress.activate(ingressBinding);
          }
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
      const fallbackProbe = /^\/v1\/clank\/fallback-owner\/([a-f0-9]{64})$/u.exec(new URL(request.url).pathname);
      if (fallbackProbe) { const pending = fallbackEndpointProbes.get(fallbackProbe[1]); if (closed || request.method !== "GET" || !pending || pending.service !== service) return new Response(null, { status: 404 }); pending.check(); pending.seen = true; return new Response(null, { status: 204 }); }

      const replacement=sourceReplacements.get(service);if(replacement)return replacement.handle(request);
      if(adoptedRuntime){try{adoptedRuntime.fast();}catch{try{await ingress.deactivate(adoptedRuntime.projectId,adoptedRuntime.generation,drainTimeoutMs);}catch{}try{await runtimes.stop(adoptedRuntime.projectId,adoptedRuntime.generation);}catch{}return controlProblem(503,"RUNTIME_UNAVAILABLE","Provider runtime is unavailable.");}}
      const url = new URL(request.url);
      // Encoded control namespaces are never delegated to application ingress.
      // Exact routes use their canonical ASCII spelling only.
      if (url.pathname.split("/",4).some(segment=>segment.includes("%"))) {
        return controlProblem(404,"CONTROL_NOT_FOUND","Provider control endpoint not found.");
      }
      try {
        const decoded=decodeURIComponent(url.pathname);
        if (decoded!==url.pathname && (decoded===DEPLOYMENT_PROVIDER_CONTROL_PREFIX || decoded.startsWith(`${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/`))) {
          return controlProblem(404,"CONTROL_NOT_FOUND","Provider control endpoint not found.");
        }
      } catch {return controlProblem(404,"CONTROL_NOT_FOUND","Provider control endpoint not found.");}
      const canaryControl=new RegExp(`^${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/([A-Za-z0-9_-]{1,128})/canary/(binding|prepare|inspect|stop|retire)$`,"u").exec(url.pathname);
      if (canaryControl) return handleCanaryControl(request,canaryControl[1]!,canaryControl[2]!);
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
          if (prior?.nativeFallback) return controlProblem(503, "EVACUATION_PAUSED", "Native fallback requires its original role evidence or authenticated recovery.");
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
      const replacement=sourceReplacements.get(service);if(replacement)return replacement.inspect(projectIdInput);
      if (closed) throw new Error("Deployment provider service is closed.");
      const projectId = identifier(projectIdInput, "projectId");
      return exclusive(projectId, async () => {
        if (closed) throw new Error("Deployment provider service is closed.");
        const state = await readProjectState(projectId);
        if(adoptedRuntime?.projectId===projectId)adoptedRuntime.fast();
        const held = await readEvacuation(projectId);
        if (state && held) return { ...publicState(state), ...(held.writersStopped ? { state: "stopped" as const, releaseId: null, capsuleSha256: null } : {}), phase: "evacuating" };
        if(state?.phase==="running"&&recoveryProject===projectId&&!runtimes.inspect().some(runtime=>runtime.projectId===projectId&&runtime.status==="active"&&runtime.generation===state.generation&&runtime.capsuleSha256===state.capsuleSha256))return {...publicState(state),phase:"reconciling"};
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
      const replacement=sourceReplacements.get(service);if(replacement)return replacement.close();
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
          for (const close of [...fallbackTargetCloses]) try { await close(); } catch (error) { failures.push(error); }
          try { await runtimes.close(); }
          catch (error) { failures.push(error); }
          await Promise.all(activeOperations);
          for (const projectId of [...canaryReservations]) {
            try {await stopCanary(projectId,canaryIntents.get(projectId));} catch(error) {failures.push(error);}
          }
        } finally {
          for (const close of [...fallbackSourceCloses]) try { close(); } catch (error) { failures.push(error); }
          try { ownership.close(); } catch (error) { failures.push(error); }
        }
        for (const failure of failures) report(failure);
        if (failures.length > 0) throw new AggregateError(failures, "Deployment provider service failed to close cleanly.");
      })();
      return closing;
    },
  };
  const fallbackFlights = new Map<string, { operationId: string; capsuleSha256: string; deadline: bigint; flight: Promise<ProviderFallbackSource> }>();
  fallbackSourceServices.set(service, { prepare(projectId, capsule, operationId, deadline) {
    const prior = fallbackFlights.get(projectId);
    if (prior) {
      if (prior.operationId !== operationId || prior.capsuleSha256 !== capsule.sha256 || prior.deadline !== deadline) throw new Error("Fallback cannot change its original operation, capsule or deadline.");
      return prior.flight;
    }
    const flight = exclusive(projectId, async () => {
      const current = () => { providerHandoff.assertProviderServiceOwnership(ownership); if (closed || (globalThis as any).process.hrtime.bigint() >= deadline) throw new Error("Fallback source owner or interruption deadline expired."); };
      current(); const canary = await readCanary(projectId);
      if (await readEvacuation(projectId) || canaryReservations.has(projectId) || canaryProjectOwners.has(projectId) || canary && canary.current.phase !== "stopped") throw new Error("Fallback source already has a conflicting operation.");
      const state = await readProjectState(projectId), committed = await data.inspect(projectId), binding = controls.get(projectId);
      current();
      if (!state || !committed || !binding || state.phase !== "running" || state.state !== "running" || state.capsuleSha256 !== capsule.sha256 || state.releaseId !== capsule.manifest.releaseId || state.generation !== capsule.manifest.generation
        || committed.capsuleSha256 !== state.capsuleSha256 || committed.releaseId !== state.releaseId || committed.generation !== state.generation || committed.fence !== state.fence || binding.generation !== state.generation || binding.releaseId !== state.releaseId) throw new Error("Fallback requires its exact approved running source generation.");
      const roles = await captureProviderDockerRoleLease(runtimes, projectId, state.generation, capsule.sha256, deadline);
      let captured: DeploymentProviderDataSnapshot | undefined, fenced = false, disposed = false;
      let stopFlight: Promise<void> | undefined, originalReservation: object | undefined;
      const close = () => { if (disposed) return; disposed = true; fallbackSourceCloses.delete(close); captured?.bytes.fill(0); closeProviderDockerRoleLease(roles); };
      fallbackSourceCloses.add(close);
      try {
        const native = providerDockerRoleLeaseContext(roles);
        current(); await native.verifyRunning(); current();
        const barrier = { id: operationId, projectId, releaseId: state.releaseId, generation: state.generation, tokenDigest: [...binding.tokenDigest], writersStopped: false, nativeFallback: true };
        const check = () => { if (disposed) throw new Error("Fallback source is closed."); current(); native.check(); };
        const value: ProviderFallbackSource = Object.freeze({ projectId, operationId, generation: state.generation });
        const verify = async () => { check(); if (!captured) throw new Error("Fallback source has no final stopped snapshot."); const hold = await readEvacuation(projectId); if (JSON.stringify(hold) !== JSON.stringify({ ...barrier, writersStopped: true })) throw new Error("Fallback durable stop barrier changed."); await native.verifyStopped(); check(); };
        const stop = (reservation: object): Promise<void> => {
          const authority = providerFallbackReservationContext(reservation);
          authority.authorizeStop(value); check();
          if (authority.source !== value || authority.deadline !== deadline || originalReservation && originalReservation !== reservation) throw new Error("Fallback source reservation differs.");
          originalReservation = reservation;
          if (captured) return verify();
          if (stopFlight) return stopFlight;
          stopFlight = exclusive(projectId, async () => {
            const authorized = () => { check(); authority.check(); authority.authorizeStop(value); };
            authorized(); await native.verifyRunning(); authorized();
            if (JSON.stringify(await readProjectState(projectId)) !== JSON.stringify(state) || controls.get(projectId) !== binding) throw new Error("Fallback source changed before durable reservation.");
            await atomicWriteJson(fs, path, evacuationPath(projectId), barrier); fenced = true; authorized();
            await atomicWriteJson(fs, path, path.join(serviceDirectory, `${projectId}.fallback-source.json`), { protocol: "clank-provider-fallback-source-pending/1", operationId, serviceState: state, evidence: native.evidence }); authorized();
            const observed = await readEvacuation(projectId); if (JSON.stringify(observed) !== JSON.stringify(barrier)) throw new Error("Fallback durable source barrier differs.");
            controls.delete(projectId);
            for (const route of ingress.inspect().filter(route => route.projectId === projectId)) {
              authorized(); const remaining = Math.max(1, Number((deadline - (globalThis as any).process.hrtime.bigint()) / 1000000n));
              const drained = await ingress.deactivate(projectId, route.generation, Math.min(drainTimeoutMs, remaining)); authorized(); if (!drained.drained) throw new Error("Fallback source ingress did not drain within its bound.");
            }
            await stopProviderDockerRoleLease(roles); authorized(); await native.verifyStopped(); authorized();
            const snapshot = await data.snapshot(projectId); authorized();
            if (!snapshot || snapshot.projectId !== projectId || snapshot.releaseId !== state.releaseId || snapshot.generation !== state.generation || snapshot.bytes.byteLength > maxDatabaseBytes || snapshot.sha256 !== await deploymentRuntimeDigest(snapshot.bytes)) throw new Error("Fallback final source snapshot differs.");
            captured = { ...snapshot, bytes: new Uint8Array(snapshot.bytes) }; await native.verifyStopped(); authorized();
            await atomicWriteJson(fs, path, evacuationPath(projectId), { ...barrier, writersStopped: true }); authorized();
          }).catch(error => { if (fenced) throw new AggregateError([error], "Fallback source remains durably fenced; authenticated recovery is required."); throw error; });
          return stopFlight;
        };
        fallbackSources.set(value, { service, owner: ownership, lease: roles, capsuleSha256: capsule.sha256, deadline, state: Object.freeze({ ...state }), ingress: Object.freeze({ route: capsule.manifest.ingress.route, token: capsule.manifest.ingress.token }), check, stop,
          assertCancelled(permit) { const authority = providerFallbackCancelledSourceContext(permit); authority.check(); providerHandoff.assertProviderServiceOwnership(ownership); const nativeFs = (globalThis as any).process.getBuiltinModule("node:fs"), absent = (filename: string) => { try { nativeFs.lstatSync(filename); } catch (error) { if ((error as {code?: string}).code === "ENOENT") return; throw error; } throw new Error("Fallback cancelled source has a stop marker."); }; if (disposed || closed || fenced || captured || stopFlight || controls.get(projectId) !== binding || authority.service !== service || authority.owner !== ownership || authority.input.phase !== "reserved" || authority.input.identity.operationId !== operationId || authority.input.identity.projectId !== projectId || JSON.stringify(authority.input.source) !== JSON.stringify(native.evidence)) throw new Error("Fallback cancelled source is no longer the untouched original reservation."); absent(evacuationPath(projectId)); absent(path.join(serviceDirectory, `${projectId}.fallback-source.json`)); },
          assertCancel(permit) { const authority = providerFallbackCancellationContext(permit); authority.check(); providerHandoff.assertProviderServiceOwnership(ownership); const nativeFs = (globalThis as any).process.getBuiltinModule("node:fs"), exists = (name: string) => { try { nativeFs.lstatSync(name); return true; } catch (error) { if ((error as {code?: string}).code === "ENOENT") return false; throw error; } }; if (disposed || closed || authority.source !== value || originalReservation || fenced || exists(evacuationPath(projectId)) || exists(path.join(serviceDirectory, `${projectId}.fallback-source.json`))) throw new Error("Fallback source cannot release an ambiguous or durable reservation."); },
          async canCancel(permit) { fallbackSources.get(value)!.assertCancel(permit); },
          async cancel(permit) { await cancelProviderDockerRoleLease(roles, value, permit); fallbackFlights.delete(projectId); close(); },
          snapshot() { check(); if (!captured) throw new Error("Fallback source final snapshot is not ready."); return { ...captured, bytes: new Uint8Array(captured.bytes) }; },
          async verifyRunning() { check(); if (fenced) throw new Error("Fallback source is already durably fenced."); await native.verifyRunning(); check(); }, verify,
          async persistJournal(reservation, journal, authentication) { const authority = providerFallbackReservationContext(reservation); authority.authorizeSource(value); authority.assertJournal(journal, authentication); check(); if (originalReservation && reservation !== originalReservation) throw new Error("Fallback source journal reservation differs."); originalReservation = reservation; await atomicWriteJson(fs, path, path.join(serviceDirectory, `${projectId}.fallback-journal.json`), { journal, authentication }); check(); authority.assertJournal(journal, authentication); const retained = await readPrivateJson(fs, path.join(serviceDirectory, `${projectId}.fallback-journal.json`)); if (JSON.stringify(retained) !== JSON.stringify({ journal, authentication })) throw new Error("Fallback authenticated source journal changed."); }, close });
        return value;
      } catch (error) { close(); throw error; }
    });
    fallbackFlights.set(projectId, { operationId, capsuleSha256: capsule.sha256, deadline, flight }); return flight;
  } });
  const fallbackTargetFlights = new Map<string, { reservation: object; flight: Promise<ProviderFallbackTarget> }>();
  fallbackTargetServices.set(service, { stage(source, reservation) {
    const authority = providerFallbackReservationContext(reservation), sourceContext = providerFallbackSourceContext(source);
    authority.authorizeStage(source, service); const projectId = source.projectId, deadline = sourceContext.deadline;
    const prior = fallbackTargetFlights.get(projectId);
    if (prior) { if (prior.reservation !== reservation) throw new Error("Fallback target already belongs to another reservation."); return prior.flight; }
    const flight = exclusive(projectId, async () => {
      const current = () => { providerHandoff.assertProviderServiceOwnership(ownership); authority.check(); sourceContext.check(); if (closed || authority.source !== source || authority.deadline !== deadline || (globalThis as any).process.hrtime.bigint() >= deadline) throw new Error("Fallback target owner, source or interruption deadline differs."); };
      current(); if (ownership === sourceContext.owner || ownership.root === sourceContext.owner.root) throw new Error("Fallback target requires a distinct original provider root.");
      await sourceContext.verifyStopped(); current();
      if (await readEvacuation(projectId) || await readProjectState(projectId) || await data.inspect(projectId) || runtimes.inspect().some(row => row.projectId === projectId) || ingress.inspect().some(row => row.projectId === projectId) || canaryReservations.has(projectId) || canaryProjectOwners.has(projectId)) throw new Error("Fallback target project is not pristine.");
      const bytes = new Uint8Array(authority.targetCapsule); let capsule: DeploymentRuntimeCapsule | undefined;
      let prepared: PreparedDeploymentRuntimeData | undefined, candidate: DockerDeploymentRuntimeCandidate | undefined, roles: ProviderDockerRoleLease | undefined, launchIntent: object | undefined;
      let phase: "staged" | "active" | "published" | "stopped" | "closed" = "staged", activated: Promise<void> | undefined, stopping: Promise<void> | undefined, cleanupFlight: Promise<void> | undefined, retiring = false;
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(new Error("Fallback interruption deadline expired.")); if (phase !== "published" && phase !== "closed") void cleanup().catch(report); }, Math.max(1, Number((deadline - (globalThis as any).process.hrtime.bigint()) / 1000000n)));
      (timer as any).unref?.();
      let value: ProviderFallbackTarget | undefined;
      const cleanup = (): Promise<void> => {
        if (retiring) return cleanupFlight ?? Promise.resolve();
        if (cleanupFlight) return cleanupFlight;
        const work = (async () => { if (phase === "published" && roles && !isCurrentProviderDockerRoleLease(roles)) return; if (value) await closeProviderDockerFallbackTarget(runtimes, value); controls.delete(projectId); for (const route of ingress.inspect().filter(row => row.projectId === projectId)) await ingress.deactivate(projectId, route.generation, 1); if (roles) await cleanupProviderDockerRoleLease(roles); else if (candidate) await runtimes.stop(projectId, candidate.generation); })();
        cleanupFlight = work;
        void work.finally(() => { if (cleanupFlight === work) cleanupFlight = undefined; }).catch(() => {});
        return work;
      };
      const close = async () => { if (phase === "closed") return; clearTimeout(timer); controller.abort(); await cleanup(); phase = "closed"; fallbackTargetCloses.delete(close); roles && closeProviderDockerRoleLease(roles); bytes.fill(0); capsule?.bytes.fill(0); };
      fallbackTargetCloses.add(close);
      try {
        capsule = await decodeDeploymentRuntimeCapsule(bytes); current();
        if (capsule.manifest.projectId !== projectId || capsule.manifest.releaseId !== sourceContext.state.releaseId || capsule.manifest.generation <= source.generation || !capsule.databaseSnapshot) throw new Error("Fallback target capsule does not carry its final replacement snapshot.");
        const snapshot = sourceContext.snapshot();
        try { if (capsule.databaseSnapshot.byteLength !== snapshot.bytes.byteLength || await deploymentRuntimeDigest(capsule.databaseSnapshot) !== snapshot.sha256) throw new Error("Fallback target capsule snapshot differs from final stopped source."); } finally { snapshot.bytes.fill(0); }
        current(); const runtime = capsule;
        const barrier = { id: source.operationId, projectId, releaseId: runtime.manifest.releaseId, generation: runtime.manifest.generation, tokenDigest: [...await secretDigest(runtime.manifest.ingress.controlToken ?? crypto.randomUUID())], writersStopped: true, nativeFallback: true as const };
        // The native fallback marker prevents ordinary lifecycle admission after a crash.
        await atomicWriteJson(fs, path, evacuationPath(projectId), barrier); current();
        const request: DeploymentProviderRequest = { operation: { id: source.operationId, projectId, fence: authority.fence, attempt: 1, maxAttempts: 1 }, desired: { state: "running", generation: runtime.manifest.generation, releaseId: runtime.manifest.releaseId, runtimeProtocol: DEPLOYMENT_RUNTIME_PROTOCOL }, artifact: runtime.artifact, runtime, signal: controller.signal };
        await runtimes.prepareProject?.(projectId, controller.signal); current(); await sourceContext.verifyStopped(); current();
        await data.apply({ ...request, runtime, codeOnly: true }, async original => { current(); if (prepared) throw new Error("Fallback target preparation replayed unexpectedly."); prepared = original; }); current();
        if (!prepared) throw new Error("Fallback target data was not staged.");
        const originalPrepared = prepared;
        const check = () => { if (phase === "closed") throw new Error("Fallback target is closed."); current(); };
        value = Object.freeze({ projectId, operationId: source.operationId, generation: runtime.manifest.generation });
        const exact = (input: object) => { check(); if (input !== reservation) throw new Error("Fallback target reservation changed."); authority.authorizeTarget(value!); };
        const verifyRunning = async () => { check(); if (!roles || phase !== "active" && phase !== "published") throw new Error("Fallback target complete roles are not active."); await providerDockerRoleLeaseContext(roles).verifyRunning(); check(); };
        const verifyStopped = async () => { check(); if (!roles || phase !== "stopped") throw new Error("Fallback target has no native stop receipt."); await providerDockerRoleLeaseContext(roles).verifyStopped(); check(); };
        const stop = () => { check(); if (stopping) return stopping; stopping = exclusive(projectId, async () => { if (!roles) { await cleanup(); throw new Error("Fallback partial target requires authenticated native recovery."); } await stopProviderDockerRoleLease(roles); phase = "stopped"; await verifyStopped(); }); return stopping; };
        const activate = (input: object) => { exact(input); if (activated) return activated; activated = exclusive(projectId, async () => {
          exact(input); if (!launchIntent) throw new Error("Fallback target has no staged launch intent."); authority.authorizeLaunch(value!, launchIntent); await sourceContext.verifyStopped(); exact(input);
          await activateProviderDockerFallbackTarget(runtimes, value!, reservation); exact(input);
          await sourceContext.verifyStopped(); exact(input);
          roles = await captureProviderDockerRoleLease(runtimes, projectId, runtime.manifest.generation, runtime.sha256, deadline); exact(input); phase = "active"; await verifyRunning();
        }).catch(async error => { try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fallback target activation and cleanup failed; authenticated recovery is required."); } throw error; }); return activated; };
        const publish = (input: object, fresh: DeploymentProviderRequest) => exclusive(projectId, async () => {
          exact(input); authority.authorizePublication(value!, fresh);
          const valid = async () => { exact(input); authority.authorizePublication(value!, fresh); await authority.verifyLease(); check(); throwIfAborted(fresh.signal); };
          await valid(); if (fresh !== authority.request || fresh.operation.projectId !== projectId || fresh.operation.fence < request.operation.fence || fresh.runtime?.sha256 !== runtime.sha256 || fresh.desired.generation !== runtime.manifest.generation || fresh.desired.releaseId !== runtime.manifest.releaseId || fresh.desired.state !== "running") throw new Error("Fallback publication differs from the original fresh platform lease.");
          await sourceContext.verifyStopped(); await valid(); await verifyRunning(); await valid();
          await data.apply({ ...fresh, runtime }, async staged => { await valid(); if (staged.databasePath !== originalPrepared.databasePath || staged.releaseDirectory !== originalPrepared.releaseDirectory || staged.capsuleSha256 !== runtime.sha256) throw new Error("Fallback publication data identity changed."); }); await valid();
          await ingress.activate({ protocol: DEPLOYMENT_RUNTIME_PROTOCOL, projectId, releaseId: runtime.manifest.releaseId, generation: runtime.manifest.generation, path: originalPrepared.ingress.route, token: originalPrepared.ingress.token, upstream: candidate!.upstream }); await valid();
          const routes = ingress.inspect().filter(row => row.projectId === projectId); if (routes.length !== 1 || routes[0].generation !== runtime.manifest.generation || routes[0].releaseId !== runtime.manifest.releaseId || routes[0].path !== originalPrepared.ingress.route || !routes[0].latest) throw new Error("Fallback target ingress publication differs.");
          await verifyRunning(); await sourceContext.verifyStopped(); await valid();
          if (originalPrepared.ingress.controlToken) controls.set(projectId, { projectId, releaseId: runtime.manifest.releaseId, generation: runtime.manifest.generation, tokenDigest: await secretDigest(originalPrepared.ingress.controlToken), incarnation: crypto.randomUUID() });
          await valid(); await writeProjectState(stateFor(fresh, "running")); await valid();

        }).catch(async error => { try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fallback target publication and cleanup failed; authenticated recovery is required."); } throw error; });
        const finalize = (input: object, fresh: DeploymentProviderRequest) => exclusive(projectId, async () => {
          const completed = () => { exact(input); authority.authorizeCompletion(value!, fresh); };
          completed(); await verifyRunning(); completed(); await sourceContext.verifyStopped(); completed();
          if (phase !== "active") throw new Error("Fallback completion requires its exact active target.");
          await commitProviderDockerRoleLease(roles!, value!, reservation, fresh); completed();
          await fs.rm(evacuationPath(projectId), { force: true }); await syncDirectory(fs, serviceDirectory); completed(); phase = "published"; clearTimeout(timer);
        });
        fallbackTargets.set(value, { service, owner: ownership, launcher: runtimes, source, reservation, capsuleSha256: runtime.sha256, deadline, launchIntent() { check(); if (!launchIntent) throw new Error("Fallback target has no complete staged native intent."); return launchIntent; }, lease() { if (!roles) throw new Error("Fallback target roles have not been natively observed."); return roles; }, check, activate, verifyRunning, verifyStopped, stop, publish, finalize,
          async persistJournal(input, journal, authentication) { exact(input); authority.assertJournal(journal, authentication); await atomicWriteJson(fs, path, path.join(serviceDirectory, `${projectId}.fallback-journal.json`), { journal, authentication }); exact(input); authority.assertJournal(journal, authentication); const retained = await readPrivateJson(fs, path.join(serviceDirectory, `${projectId}.fallback-journal.json`)); if (JSON.stringify(retained) !== JSON.stringify({ journal, authentication })) throw new Error("Fallback authenticated target journal changed."); }, close,
          async quiesceRetirement() { retiring = true; clearTimeout(timer); controller.abort(); await cleanupFlight?.catch(() => {}); },
          retire() { clearTimeout(timer); controller.abort(); phase = "closed"; fallbackTargetCloses.delete(close); if (roles) closeProviderDockerRoleLease(roles); bytes.fill(0); capsule?.bytes.fill(0); } });
        authority.authorizeTarget(value); authority.authorizeStage(source, service); check();
        await armProviderDockerFallbackTarget(runtimes, value, reservation); check();
        const staged = await stageProviderDockerFallbackTarget(runtimes, value, reservation, originalPrepared, controller.signal); check(); candidate = staged.candidate; launchIntent = staged.intent;
        authority.authorizeStage(source, service); check(); return value;
      } catch (error) { await close(); throw error; }
    });
    fallbackTargetFlights.set(projectId, { reservation, flight }); return flight;
  } });
  fallbackCancellationServices.set(service, { async retire(permit) {
    const authority = providerFallbackCancelledSourceContext(permit), input = authority.input, id = input.identity;
    if (authority.service !== service || authority.owner !== ownership || input.phase !== "reserved") throw new Error("Fallback running retirement requires its exact cancelled reserved source.");
    const projectId = identifier(id.projectId, "projectId");
    await exclusive(projectId, async () => {
      authority.check(); const completed = cancelledSourceRetirements.get(id.operationId);
      if (completed) {
        if (completed.journal !== authority.journal || completed.authentication !== authority.authentication || fallbackFlights.has(projectId)) throw new Error("Fallback cancelled source retirement identity changed.");
        await authority.verifyRunning(); authority.check(); return;
      }
      const flight = fallbackFlights.get(projectId);
      if (!flight || flight.operationId !== id.operationId || flight.capsuleSha256 !== input.source.capsuleSha256) throw new Error("Fallback cancellation cannot adopt a cold or unrelated source capture.");
      const value = await flight.flight; authority.check(); const source = fallbackSources.get(value);
      if (!source || source.service !== service || source.owner !== ownership) throw new Error("Fallback cancellation original source owner differs.");
      const check = () => { authority.check(); source.assertCancelled(permit); if (fallbackFlights.get(projectId) !== flight || value.operationId !== id.operationId || value.generation !== id.sourceGeneration || source.capsuleSha256 !== input.source.capsuleSha256) throw new Error("Fallback cancellation original capture changed."); const control = controls.get(projectId), routes = ingress.inspect().filter(row => row.projectId === projectId); if (!control || control.generation !== value.generation || control.releaseId !== id.releaseId || routes.length !== 1 || routes[0]!.generation !== value.generation || routes[0]!.releaseId !== id.releaseId || !routes[0]!.latest || routes[0]!.path !== source.ingress.route) throw new Error("Fallback cancelled source no longer has its original running bindings."); };
      check();
      const state = await readProjectState(projectId); check();
      if (JSON.stringify(state) !== JSON.stringify(source.state)) throw new Error("Fallback cancelled source original state changed.");
      const binding: FallbackCancellationBinding = { launcher: runtimes, lease: source.lease, evidence: input.source, check, verifyRunning: authority.verifyRunning,
        finish() { check(); cancelledSourceRetirements.set(id.operationId, { journal: authority.journal, authentication: authority.authentication, source: value }); fallbackFlights.delete(projectId); source.close(); } };
      if (fallbackCancellationBindings.has(permit)) throw new Error("Fallback cancelled source retirement is already in progress.");
      fallbackCancellationBindings.set(permit, binding);
      try { await retireProviderDockerFallbackCancellation(runtimes, permit); }
      finally { fallbackCancellationBindings.delete(permit); }
    });
  } });
  fallbackRetirementServices.set(service, { async retire(permit) {
    const authority = providerFallbackRetirementContext(permit), input = authority.input, id = input.identity;
    if (authority.service !== service || input.phase === "reserved" || !["stopping", "stopped", "launching", "prepared"].includes(input.phase)
      || authority.selected !== (["stopping", "stopped"].includes(input.phase) ? "source" : "target")) throw new Error("Fallback retirement requires a finalized stopped transfer phase.");
    const projectId = identifier(id.projectId, "projectId"), selectedSource = authority.selected === "source";
    await exclusive(projectId, async () => {
      const sourceFlight = selectedSource ? fallbackFlights.get(projectId) : undefined, targetFlight = selectedSource ? undefined : fallbackTargetFlights.get(projectId);
      const retiredSource = selectedSource && !sourceFlight ? sourceResumeReceipts.get(projectId) : undefined;
      if (retiredSource) {
        const current = () => { authority.check(); providerHandoff.assertProviderServiceOwnership(ownership); if (closed || sourceResumeReceipts.get(projectId) !== retiredSource || fallbackFlights.has(projectId) || controls.has(projectId) || ingress.inspect().some(row => row.projectId === projectId) || runtimes.inspect().some(row => row.projectId === projectId)
          || retiredSource.operationId !== id.operationId || retiredSource.journal !== authority.journal || retiredSource.authentication !== authority.authentication) throw new Error("Fallback stopped source retirement replay differs."); };
        current(); const [state, committed] = await Promise.all([readProjectState(projectId), data.inspect(projectId)]); current();
        if (JSON.stringify(state) !== retiredSource.state || JSON.stringify(committed) !== retiredSource.data) throw new Error("Fallback stopped source retirement replay state changed.");
        await authority.verifyStopped(); current(); return;
      }
      if (selectedSource ? !sourceFlight : !targetFlight) throw new Error("Fallback retirement cannot adopt a cold or unrelated provider flight.");
      authority.check(); const value = await (sourceFlight?.flight ?? targetFlight!.flight); authority.check();
      const source = selectedSource ? fallbackSources.get(value) : undefined, target = selectedSource ? undefined : fallbackTargets.get(value);
      const nativeFs = (globalThis as any).process.getBuiltinModule("node:fs");
      const absent = (name: string) => { try { nativeFs.lstatSync(name); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return; throw error; } throw new Error("Fallback retirement marker has not been finalized."); };
      const check = () => {
        authority.check(); providerHandoff.assertProviderServiceOwnership(ownership);
        if (closed || value.projectId !== projectId || value.operationId !== id.operationId || value.generation !== (selectedSource ? id.sourceGeneration : id.targetGeneration)
          || (source ?? target)?.service !== service || (source ?? target)?.owner !== ownership
          || sourceFlight && (fallbackFlights.get(projectId) !== sourceFlight || sourceFlight.operationId !== id.operationId || sourceFlight.capsuleSha256 !== input.source.capsuleSha256 || source!.capsuleSha256 !== input.source.capsuleSha256)
          || targetFlight && (fallbackTargetFlights.get(projectId) !== targetFlight || target!.reservation !== targetFlight.reservation || target!.capsuleSha256 !== input.launchIntent.capsuleSha256)) throw new Error("Fallback retirement original operation or flight changed.");
        absent(evacuationPath(projectId)); if (selectedSource) absent(path.join(serviceDirectory, `${projectId}.fallback-source.json`));
        const control = controls.get(projectId);
        if (control && (control.projectId !== projectId || control.generation !== value.generation || control.releaseId !== id.releaseId)) throw new Error("Fallback retirement found a different control binding.");
        if (ingress.inspect().some(route => route.projectId === projectId && (route.generation !== value.generation || route.releaseId !== id.releaseId))) throw new Error("Fallback retirement found a different ingress generation.");
      };
      check();
      if (target) { await target.quiesceRetirement(); check(); }
      for (const route of ingress.inspect().filter(row => row.projectId === projectId)) { check(); await ingress.deactivate(projectId, route.generation, 1); check(); }
      let sourceReceipt: { operationId: string; journal: string; authentication: string; state: string; data: string; identity: FallbackSourceIngressIdentity; tombstone?: object } | undefined;
      if (source) {
        await authority.verifyStopped(); check();
        const stopped: StoredServiceState = Object.freeze({ ...source.state, state: "stopped", phase: "stopped", releaseId: null, capsuleSha256: null, updatedAt: Number(input.sourceStoppedPlacement.updated_at) });
        const [before, committed] = await Promise.all([readProjectState(projectId), data.inspect(projectId)]); check();
        if (JSON.stringify(before) !== JSON.stringify(source.state) && JSON.stringify(before) !== JSON.stringify(stopped)
          || !committed || committed.projectId !== projectId || committed.releaseId !== id.releaseId || committed.generation !== id.sourceGeneration || committed.capsuleSha256 !== source.capsuleSha256 || committed.fence !== source.state.fence) throw new Error("Fallback stopped source original service or data image changed.");
        await writeProjectState(stopped); check(); const retained = await readProjectState(projectId); check();
        if (JSON.stringify(retained) !== JSON.stringify(stopped)) throw new Error("Fallback stopped source state was not retained.");
        const identity: FallbackSourceIngressIdentity = Object.freeze({ projectId, releaseId: id.releaseId, generation: id.sourceGeneration, operationId: source.state.operationId, minimumFence: Number(input.fence), capsuleSha256: source.capsuleSha256, route: source.ingress.route, token: source.ingress.token });
        if (!Number.isSafeInteger(identity.minimumFence) || identity.minimumFence <= source.state.fence) throw new Error("Fallback stopped source reservation fence differs.");
        fallbackSourceIngressStopped.set(permit, { ingress, identity, check });
        let tombstone: object | undefined;
        try { tombstone = await captureProviderRuntimeFallbackSourceTombstone(ingress, permit); check(); }
        finally { fallbackSourceIngressStopped.delete(permit); }
        sourceReceipt = { operationId: id.operationId, journal: authority.journal, authentication: authority.authentication, state: JSON.stringify(stopped), data: JSON.stringify(committed), identity, ...(tombstone ? { tombstone } : {}) };
      }
      const binding: FallbackRetirementBinding = { launcher: runtimes, projectId, ...(selectedSource ? { source: value as ProviderFallbackSource, lease: source!.lease, evidence: input.source } : { target: value as ProviderFallbackTarget, reservation: target!.reservation, evidence: input.target ?? input.launchIntent, intent: input.launchIntent }), check, verifyStopped: authority.verifyStopped,
        finish() { check(); controls.delete(projectId); if (source) { if (!sourceReceipt) throw new Error("Fallback stopped source has no exact resume receipt."); sourceResumeReceipts.set(projectId, sourceReceipt); source.close(); fallbackFlights.delete(projectId); } else { target!.retire(); fallbackTargetFlights.delete(projectId); } } };
      if (fallbackRetirementBindings.has(permit)) throw new Error("Fallback retirement is already in progress.");
      fallbackRetirementBindings.set(permit, binding);
      try {
        await retireProviderDockerFallbackRecovery(runtimes, permit); authority.check();
      } finally { fallbackRetirementBindings.delete(permit); }
    });
  } });
  fallbackResumeServices.set(service, { async begin(permit) {
    const authority = providerFallbackResumeContext(permit), request = authority.request, projectId = request.operation.projectId;
    if (authority.service !== service || authority.owner !== ownership || request.desired.state !== "running" || !request.runtime) throw new Error("Fallback resume lifecycle authority differs.");
    const runtime = request.runtime;
    await exclusive(projectId, async () => {
      authority.check(); providerHandoff.assertProviderServiceOwnership(ownership);
      if (closed || resumeFlights.has(projectId) || fallbackResumeLifecycles.has(permit) || controls.has(projectId) || ingress.inspect().some(row => row.projectId === projectId) || runtimes.inspect().some(row => row.projectId === projectId)) throw new Error("Fallback resume requires its recovered project to remain stopped.");
      if (await readEvacuation(projectId)) throw new Error("Fallback resume recovery barrier remains."); authority.check();
      const [prior, committed] = await Promise.all([readProjectState(projectId), data.inspect(projectId)]); authority.check();
      if (!matchesData(committed, request) || committed!.fence >= request.operation.fence) throw new Error("Fallback resume requires its exact recovered data and a newer original fence.");
      const receipt = resumeStoppedReceipts.get(projectId);
      const retry = receipt && receipt.recoveryOperationId === authority.recoveryOperationId && receipt.selected === authority.selected && JSON.stringify(prior) === receipt.state && JSON.stringify(committed) === receipt.data && prior?.phase === "stopped" && prior.state === "stopped" && prior.generation === request.desired.generation && prior.fence === receipt.request.operation.fence && prior.fence < request.operation.fence
        && receipt.request.desired.releaseId === request.desired.releaseId && receipt.request.runtime?.sha256 === request.runtime!.sha256 && matchesData(committed, request) && committed!.fence <= receipt.request.operation.fence;
      const sourceReceipt = sourceResumeReceipts.get(projectId);
      const sourceResume = !retry && authority.selected === "source" && sourceReceipt && sourceReceipt.operationId === authority.recoveryOperationId
        && JSON.stringify(prior) === sourceReceipt.state && JSON.stringify(committed) === sourceReceipt.data && prior?.phase === "stopped" && prior.state === "stopped"
        && request.operation.fence > sourceReceipt.identity.minimumFence && request.desired.generation === sourceReceipt.identity.generation && request.desired.releaseId === sourceReceipt.identity.releaseId
        && runtime.sha256 === sourceReceipt.identity.capsuleSha256 && runtime.manifest.ingress.route === sourceReceipt.identity.route && runtime.manifest.ingress.token === sourceReceipt.identity.token;
      if (authority.selected === "source" && !retry && !sourceResume) throw new Error("Fallback source resume requires its exact finalized source STOPPED receipt.");
      const stoppedState = retry ? receipt!.state : sourceResume ? sourceReceipt!.state : null, stoppedData = retry ? receipt!.data : sourceResume ? sourceReceipt!.data : null;
      const tombstone = retry ? receipt!.tombstone : sourceResume ? sourceReceipt!.tombstone : undefined;
      const current = () => { providerHandoff.assertProviderServiceOwnership(ownership); if (closed || resumeFlights.get(projectId) !== permit || retry && resumeStoppedReceipts.get(projectId) !== receipt || sourceResume && sourceResumeReceipts.get(projectId) !== sourceReceipt) throw new Error("Fallback resume original service lifecycle or stopped receipt changed."); };
      // inspect() exposes validated paths relative to its original project root;
      // the native launcher pins the same absolute paths as preparedData().
      const projectDirectory = path.join(ownership.root, "projects", projectId);
      const binding = { launcher: runtimes, request, releaseDirectory: path.resolve(projectDirectory, committed!.releaseDirectory), databasePath: path.resolve(projectDirectory, committed!.databasePath), stoppedState, stoppedData, ...(tombstone ? { ingressTombstone: tombstone } : {}), check() { authority.check(); current(); }, cleanupCheck() { const cleanup = providerFallbackResumeCleanupContext(permit); cleanup.check(); current(); if (cleanup.service !== service || cleanup.owner !== ownership || cleanup.request !== request) throw new Error("Fallback resume cleanup operation changed."); } };
      resumeFlights.set(projectId, permit); fallbackResumeLifecycles.set(permit, binding);
      await beginProviderDockerFallbackResume(runtimes, permit); binding.check();
    });
  }, async cleanup(permit) {
    const authority = providerFallbackResumeCleanupContext(permit), request = authority.request, projectId = request.operation.projectId;
    if (authority.service !== service || authority.owner !== ownership) throw new Error("Fallback resume cleanup service differs.");
    await exclusive(projectId, async () => {
      const lifecycle = fallbackResumeLifecycles.get(permit);
      if (!lifecycle || lifecycle.request !== request) throw new Error("Fallback resume cleanup cannot adopt another operation.");
      const check = () => { lifecycle.cleanupCheck(); const control = controls.get(projectId); if (control && (control.generation !== request.desired.generation || control.releaseId !== request.desired.releaseId)) throw new Error("Fallback resume cleanup control changed."); if (ingress.inspect().some(route => route.projectId === projectId && (route.generation !== request.desired.generation || route.releaseId !== request.desired.releaseId))) throw new Error("Fallback resume cleanup route changed."); };
      check();
      for (const route of ingress.inspect().filter(row => row.projectId === projectId)) { check(); await ingress.deactivate(projectId, route.generation, 1); check(); }
      await cleanupProviderDockerFallbackResume(runtimes, permit); check();
      const stopped: StoredServiceState = Object.freeze({ ...stateFor(request, "stopped"), state: "stopped", releaseId: null, capsuleSha256: null });
      await writeProjectState(stopped); check();
      const [stored, committed] = await Promise.all([readProjectState(projectId), data.inspect(projectId)]); check();
      if (JSON.stringify(stored) !== JSON.stringify(stopped)) throw new Error("Fallback resume stopped state was not retained.");
      let tombstone: object | undefined;
      fallbackIngressStopped.set(permit, { ingress, request, check() { check(); if (runtimes.inspect().some(row => row.projectId === projectId) || ingress.inspect().some(row => row.projectId === projectId)) throw new Error("Fallback ingress stopped receipt found a live project binding."); } });
      try { tombstone = await captureProviderRuntimeFallbackTombstone(ingress, permit); check(); }
      finally { fallbackIngressStopped.delete(permit); }
      finishProviderDockerFallbackResumeCleanup(runtimes, permit); check();
      resumeStoppedReceipts.set(projectId, { state: JSON.stringify(stored), data: JSON.stringify(committed), request, recoveryOperationId: authority.recoveryOperationId, selected: authority.selected, ...(tombstone ? { tombstone } : {}) });
      controls.delete(projectId); resumeFlights.delete(projectId); fallbackResumeLifecycles.delete(permit);
    });
  }, async complete(permit) {
    const authority = providerFallbackResumeContext(permit), request = authority.request, projectId = request.operation.projectId;
    authority.authorizeCompletion(); await fallbackResumeServices.get(service)!.verify(permit); authority.authorizeCompletion();
    await exclusive(projectId, async () => {
      const lifecycle = fallbackResumeLifecycles.get(permit); if (!lifecycle || lifecycle.request !== request) throw new Error("Fallback resume completion lifecycle differs.");
      lifecycle.check(); authority.authorizeCompletion();
      // The original coordinator publishes the terminal durable result inside
      // completeResume. No fallible admission check may follow that point.
      await completeProviderDockerFallbackResume(runtimes, permit);
      resumeStoppedReceipts.delete(projectId); sourceResumeReceipts.delete(projectId); resumeFlights.delete(projectId); fallbackResumeLifecycles.delete(permit);
    });
  }, async verify(permit) {
    const authority = providerFallbackResumeContext(permit), request = authority.request, deadline = authority.deadline;
    if (authority.service !== service || authority.owner !== ownership || !request.runtime || request.desired.state !== "running") throw new Error("Fallback resume observation authority differs.");
    const projectId = request.operation.projectId;
    return exclusive(projectId, async () => {
      const binding = controls.get(projectId), runtime = request.runtime!;
      const check = () => {
        authority.check(); providerHandoff.assertProviderServiceOwnership(ownership); throwIfAborted(request.signal);
        if (closed || (globalThis as any).process.hrtime.bigint() >= deadline || resumeFlights.get(projectId) !== permit || fallbackResumeLifecycles.get(permit)?.request !== request || fallbackFlights.has(projectId) || fallbackTargetFlights.has(projectId) || controls.get(projectId) !== binding) throw new Error("Fallback resumed service is closed, reserved or changed.");
        const routes = ingress.inspect().filter(row => row.projectId === projectId), active = runtimes.inspect().filter(row => row.projectId === projectId);
        if (routes.length !== 1 || !routes[0].latest || routes[0].generation !== request.desired.generation || routes[0].releaseId !== request.desired.releaseId || routes[0].path !== runtime.manifest.ingress.route
          || active.length !== 1 || active[0].status !== "active" || active[0].generation !== request.desired.generation || active[0].releaseId !== request.desired.releaseId || active[0].capsuleSha256 !== runtime.sha256
          || binding && (binding.projectId !== projectId || binding.generation !== request.desired.generation || binding.releaseId !== request.desired.releaseId)) throw new Error("Fallback resumed route, control or runtime differs.");
      };
      const verifyState = async () => {
        check(); const [state, committed, barrier] = await Promise.all([readProjectState(projectId), data.inspect(projectId), readEvacuation(projectId)]); check();
        if (barrier || !state || state.phase !== "running" || state.operationId !== request.operation.id || state.fence !== request.operation.fence || !matchesState(state, request)
          || !matchesData(committed, request) || committed!.fence !== request.operation.fence) throw new Error("Fallback resumed ordinary state differs from its genuine runner lease.");
      };
      await verifyState();
      const expectedControl = runtime.manifest.ingress.controlToken ? await secretDigest(runtime.manifest.ingress.controlToken) : undefined; check();
      if (expectedControl ? !binding || !sameDigest(binding.tokenDigest, expectedControl) : binding !== undefined) throw new Error("Fallback resumed control token differs.");
      if (fallbackResumeBindings.has(permit)) throw new Error("Fallback resume observation is already in progress.");
      fallbackResumeBindings.set(permit, { launcher: runtimes, request, deadline, check });
      try { const evidence = await verifyProviderDockerFallbackResumed(runtimes, permit); await verifyState(); check(); return evidence; }
      finally { fallbackResumeBindings.delete(permit); }
    });
  } });
  ordinarySourceAdmissions.set(service,{ownership,maxDatabaseBytes,drainTimeoutMs,data,runtimes,freeze(projectId,capsuleSha256){return exclusive(projectId,async()=>{
    if(closed||tails.size!==1||canaryReservations.size||canaryProjectOwners.size)throw new Error("Provider source preparation requires its sole idle project.");
    providerHandoff.assertProviderServiceOwnership(ownership);
    const state=await readProjectState(projectId),committed=await data.inspect(projectId);
    const current=runtimes.inspect(),routes=ingress.inspect();
    if(!state||state.phase!=="running"||state.state!=="running"||state.capsuleSha256!==capsuleSha256||!committed||committed.capsuleSha256!==capsuleSha256||state.generation!==committed.generation||state.releaseId!==committed.releaseId||state.fence!==committed.fence
      ||current.length!==1||current[0].projectId!==projectId||current[0].status!=="active"||current[0].capsuleSha256!==capsuleSha256||current[0].generation!==state.generation
      ||routes.length!==1||routes[0].projectId!==projectId||routes[0].generation!==state.generation||!routes[0].latest)throw new Error("Provider source preparation requires its exact approved running release and route.");
    const root=await fs.lstat(ownership.root),directory=await fs.lstat(ownership.serviceDirectory),writer=await fs.lstat(path.join(ownership.serviceDirectory,".writer.sqlite"));
    providerHandoff.assertProviderServiceOwnership(ownership);
    closed=true;return {state,port:current[0].port,root,service:directory,writer};
  });}});
  if(adoption && adoptedRuntime){
    const native=adoptedRuntime,capsule=await native.capsule();
    try{
      const committed=await data.inspect(native.projectId),runtime=runtimes.inspect();native.fast();
      if(!committed||committed.generation!==native.generation||committed.releaseId!==native.releaseId||committed.capsuleSha256!==native.capsuleSha256||committed.fence!==adoption.lifecycleFence||runtime.length!==1||runtime[0].status!=="active"||runtime[0].capsuleSha256!==native.capsuleSha256||runtime[0].generation!==native.generation)throw new Error("Original adopted target canonical state differs.");
      await native.verify();
      await ingress.activate({protocol:DEPLOYMENT_RUNTIME_PROTOCOL,projectId:native.projectId,releaseId:native.releaseId,generation:native.generation,path:capsule.manifest.ingress.route,token:capsule.manifest.ingress.token,upstream:runtime[0].upstream});native.fast();
      if(capsule.manifest.ingress.controlToken)controls.set(native.projectId,{projectId:native.projectId,releaseId:native.releaseId,generation:native.generation,tokenDigest:await secretDigest(capsule.manifest.ingress.controlToken),incarnation:crypto.randomUUID()});
      const state:StoredServiceState=Object.freeze({protocol:DEPLOYMENT_PROVIDER_SERVICE_PROTOCOL,projectId:native.projectId,operationId:adoption.handoffId,fence:adoption.lifecycleFence,generation:native.generation,state:"running",releaseId:native.releaseId,capsuleSha256:native.capsuleSha256,phase:"running",updatedAt:Date.now()});
      await writeProjectState(state);if(JSON.stringify(await readProjectState(native.projectId))!==JSON.stringify(state))throw new Error("Original adopted target service state was not retained.");native.fast();
    }finally{capsule.bytes.fill(0);}
  }
  return Object.freeze(service);
}

/** Opens the complete zero-dependency Docker provider stack with secure defaults. */
export async function openDockerDeploymentProviderService(
  options: DockerDeploymentProviderServiceOptions,
  retainedOwnership?: ProviderServiceOwnership,
): Promise<DeploymentProviderService> {
  if (!options || typeof options !== "object") {
    throw new TypeError("Docker deployment provider service options are required.");
  }
  if (retainedOwnership) providerHandoff.assertProviderServiceOwnership(retainedOwnership);
  // Acquire before the Docker launcher's startup orphan cleanup can touch any
  // containers belonging to an already running service for this provider root.
  const ownership = retainedOwnership ?? await acquireProviderServiceOwnership(options.rootDirectory, true);
  let ingress: DeploymentRuntimeIngress | undefined;
  let runtimes: DockerDeploymentRuntimeLauncher | undefined;
  try {
    const dockerOptions = {
      ...(options.docker ?? {}),
      rootDirectory: ownership.root,
      owner: options.owner,
      image: options.image,
      onError: options.docker?.onError ?? options.onError,
    };
    const client = providerDockerClient(dockerOptions);
    await admitProviderService(ownership, client, options.owner);
    await assertProviderCanaryOwnership(ownership);
    const data = await openDeploymentProviderDataStore({
      ...(options.data ?? {}),
      rootDirectory: ownership.root,
    });
    runtimes = await openDockerDeploymentRuntimeLauncher(dockerOptions, undefined, dockerOptions.coldFallbackResumeSelection);
    const ingressOptions={...(options.ingress??{}),onError:options.ingress?.onError??options.onError};
    ingress = createDeploymentRuntimeIngress(ingressOptions);
    const service=await openOwnedDeploymentProviderService({
      rootDirectory: ownership.root,
      data,
      runtimes,
      ingress,
      kind: options.kind,
      drainTimeoutMs: options.drainTimeoutMs,
      maxDatabaseBytes: options.data?.maxDatabaseBytes,
      onError: options.onError,
      canaries: options.canaries,
    }, ownership);
    const d=dockerOptions;
    const compatible=!d.allowMutableImage&&!d.allowContainerRoot&&d.diskQuota===undefined&&d.outboundNetwork===undefined
      &&(d.user===undefined||d.user===String((globalThis as any).process.getuid?.())+":"+String((globalThis as any).process.getgid?.()))
      &&(d.network===undefined||d.network==="bridge")&&(d.memory===undefined||d.memory==="512m")&&(d.cpus===undefined||d.cpus==="1")
      &&(d.pidsLimit===undefined||d.pidsLimit===128)&&(d.stopTimeoutMs===undefined||d.stopTimeoutMs===10)
      &&(d.commandTimeoutMs===undefined||d.commandTimeoutMs===15000)&&(d.fetch===undefined||d.fetch===globalThis.fetch)
      &&Object.keys(ingressOptions).every(key=>key==="onError")&&ingressOptions.onError===undefined&&d.onError===undefined
      &&ordinarySourceAdmissions.get(service)!.drainTimeoutMs===30000
      &&(client.environment.DOCKER_HOST===undefined||client.environment.DOCKER_HOST==="unix:///var/run/docker.sock")
      &&client.environment.DOCKER_CONTEXT===undefined;
    nativeSourceAdmissions.set(service,{client,owner:d.owner,image:d.image,compatible});
    return service;
  } catch (error) {
    await Promise.allSettled([
      ...(ingress ? [ingress.close(options.drainTimeoutMs)] : []),
      ...(runtimes ? [runtimes.close()] : []),
    ]);
    if (!retainedOwnership) ownership.close();
    throw error;
  }
}

/** Move a committed running target into the real ordinary Docker provider stack. */
export async function adoptDockerDeploymentProviderTarget(receipt:providerHandoff.ProviderTargetAdoptionReceipt):Promise<DeploymentProviderService>{
  const move=await providerHandoff.moveProviderTargetOwnership(receipt);
  let runtimes:DockerDeploymentRuntimeLauncher|undefined,ingress:DeploymentRuntimeIngress|undefined;
  try{
    const native=providerAdoptedTargetRuntimeContext(move.runtime);
    const references=JSON.parse((await runProviderDockerClient(native.client,["image","inspect",native.imageId,"--format","{{json .RepoDigests}}"],{timeoutMs:15000,maxOutputBytes:65536})).stdout);
    if(!Array.isArray(references)||!references.length||typeof references[0]!=="string"||!/@sha256:[a-f0-9]{64}$/u.test(references[0]))throw new Error("Adopted target requires its original immutable image reference.");native.fast();
    await assertProviderCanaryOwnership(move.owner);
    const data=await openDeploymentProviderDataStore({rootDirectory:move.owner.root});native.fast();
    const dockerOptions={rootDirectory:move.owner.root,owner:native.domain.owner,image:references[0],portStart:native.port,portEnd:native.port};
    runtimes=await openDockerDeploymentRuntimeLauncher(dockerOptions,move.runtime);ingress=createDeploymentRuntimeIngress();
    const service=await openOwnedDeploymentProviderService({rootDirectory:move.owner.root,data,runtimes,ingress},move.owner,move);
    nativeSourceAdmissions.set(service,{client:native.client,owner:native.domain.owner,image:references[0],compatible:true});return service;
  }catch(error){const errors:unknown[]=[error];for(const cleanup of [()=>ingress?.close(),()=>runtimes?.close(),()=>closeProviderAdoptedTargetRuntime(move.runtime)])try{await cleanup();}catch(cause){errors.push(cause);}try{move.owner.close();}catch(cause){errors.push(cause);}if(errors.length>1)throw new AggregateError(errors,"Live target service adoption and cleanup failed.");throw error;}
}

function normalizeProviderCanaryOptions(input: DeploymentProviderCanaryOptions | undefined) {
  if (input===undefined) return undefined;
  if (!input || !Array.isArray(input.readPaths) || input.readPaths.length<1 || input.readPaths.length>128 || new Set(input.readPaths).size!==input.readPaths.length
    || input.readPaths.some(value=>typeof value!=="string" || value.length>512 || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/u.test(value)
      || value.split("/").some(part=>part==="." || part===".."))) throw new TypeError("Provider canary paths must be bounded exact public paths.");
  return Object.freeze({readPaths:Object.freeze([...input.readPaths]),maxConcurrent:integer(input.maxConcurrent??4,"canary maxConcurrent",1,64),
    maxOperations:integer(input.maxOperations??32,"canary maxOperations",1,64),controlTimeoutMs:integer(input.controlTimeoutMs??60_000,"canary controlTimeoutMs",100,30*60_000),maximumDurationMs:integer(input.maximumDurationMs??30*60_000,"canary maximumDurationMs",100,30*60_000)});
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

function providerCanaryIssuedBinding(raw:unknown,projectId:string):ProviderCanaryIssuedBinding {
  const value=exactControlJson(raw,["protocol","primary","serviceIncarnation","tokenDigest"]);
  const primary=normalizedCanaryBinding(exactControlJson(value.primary,["projectId","releaseId","generation","fence","incarnation"]) as unknown as DeploymentProviderCanaryBinding);
  if (value.protocol!=="clank-provider-canary-binding/1" || primary.projectId!==projectId
    || !Array.isArray(value.tokenDigest) || value.tokenDigest.length!==32
    || value.tokenDigest.some(byte=>!Number.isInteger(byte) || byte<0 || byte>255)) throw new Error("Provider canary issued binding is invalid.");
  return {protocol:"clank-provider-canary-binding/1",primary,tokenDigest:[...value.tokenDigest],
    serviceIncarnation:pattern(value.serviceIncarnation,"canary service incarnation",/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)};
}

function sameDigest(left:Uint8Array|readonly number[],right:Uint8Array|readonly number[]):boolean {
  if (left.length!==right.length) return false;
  let different=0;
  for (let index=0;index<left.length;index++) different|=left[index]!^right[index]!;
  return different===0;
}

function sameIssuedBinding(left:ProviderCanaryIssuedBinding,right:ProviderCanaryIssuedBinding):boolean {
  return left.protocol===right.protocol && left.serviceIncarnation===right.serviceIncarnation
    && sameCanaryBinding(left.primary,right.primary) && sameDigest(left.tokenDigest,right.tokenDigest);
}

function sameCanaryOperation(left: Pick<DeploymentProviderCanaryState,"operationId"|"controllerEpoch"|"releaseId"|"capsuleSha256">,right: Pick<DeploymentProviderCanaryState,"operationId"|"controllerEpoch"|"releaseId"|"capsuleSha256">) {
  return left.operationId===right.operationId && left.controllerEpoch===right.controllerEpoch && left.releaseId===right.releaseId && left.capsuleSha256===right.capsuleSha256;
}

function providerCanaryRetirements(raw: unknown,projectId: string): ProviderCanaryRetirements {
  const object=(input:unknown,keys:readonly string[])=> {
    if (!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).some(key=>!keys.includes(key))) throw new Error("Provider canary retirement journal is invalid.");
    return input as Record<string,unknown>;
  };
  const value=object(raw,["protocol","primary","epochFloor","entries"]);
  if (value.protocol!=="clank-provider-canary-retirements/1" || !Array.isArray(value.entries) || value.entries.length<1 || value.entries.length>64) throw new Error("Provider canary retirement journal protocol or capacity is invalid.");
  const primary=normalizedCanaryBinding(object(value.primary,["projectId","releaseId","generation","fence","incarnation"]) as unknown as DeploymentProviderCanaryBinding);
  if (primary.projectId!==projectId) throw new Error("Provider canary retirement journal scope is invalid.");
  const epochFloor=positiveInteger(value.epochFloor,"canary retirement epochFloor");
  const operations=new Set<string>();
  const entries=value.entries.map(rawEntry=> {
    const entry=object(rawEntry,["operationId","controllerEpoch","releaseId","capsuleSha256","candidateProjectId","retirementEpoch","phase"]);
    const operationId=identifier(entry.operationId,"canary retirement operationId"),controllerEpoch=positiveInteger(entry.controllerEpoch,"canary retirement controllerEpoch");
    const retirementEpoch=positiveInteger(entry.retirementEpoch,"canary retirement epoch"),releaseId=identifier(entry.releaseId,"canary retirement releaseId");
    if (operations.has(operationId) || retirementEpoch<controllerEpoch || retirementEpoch>epochFloor || releaseId===primary.releaseId || !["retiring","retired"].includes(String(entry.phase))) throw new Error("Provider canary retirement history or epoch floor is invalid.");
    operations.add(operationId);
    const candidateProjectId=pattern(entry.candidateProjectId,"canary retirement candidateProjectId",/^canary_[a-f0-9]{64}$/u);
    if (candidateProjectId===primary.projectId) throw new Error("Provider canary retirement collides with its primary.");
    return {operationId,controllerEpoch,releaseId,capsuleSha256:pattern(entry.capsuleSha256,"canary retirement capsuleSha256",DIGEST),candidateProjectId,retirementEpoch,phase:entry.phase as "retiring"|"retired"};
  });
  return {protocol:"clank-provider-canary-retirements/1",primary,epochFloor,entries};
}

function shadowPrepare(input: {readonly purpose?:unknown;readonly stateProtocol?:unknown}):boolean {
  const hasPurpose=Object.hasOwn(input,"purpose"),hasProtocol=Object.hasOwn(input,"stateProtocol");
  const purpose=input.purpose,protocol=input.stateProtocol;
  if (!hasPurpose && !hasProtocol) return false;
  if (!hasPurpose || !hasProtocol || purpose!=="shadow" || protocol!=="clank-provider-canary/2") throw new TypeError("Provider shadow prepare purpose and state protocol must be explicit.");
  return true;
}

function providerCanaryOwner(raw:unknown): {protocol:"clank-provider-canary-owner/1"|"clank-provider-canary-owner/2";incarnation:string} | null {
  if (raw===null) return null;
  try {
    const value=exactControlJson(raw,["protocol","incarnation"]);
    if (value.protocol!=="clank-provider-canary-owner/1" && value.protocol!=="clank-provider-canary-owner/2") throw new Error();
    return {protocol:value.protocol,incarnation:pattern(value.incarnation,"provider canary owner incarnation",/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)};
  } catch {throw new Error("Provider canary owner protocol is unsupported.");}
}

function providerCanaryJournal(raw: unknown,projectId: string): ProviderCanaryJournal {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("Provider canary journal is invalid.");
  const value=raw as Record<string,unknown>;
  if (value.protocol!=="clank-provider-canary/1" && value.protocol!=="clank-provider-canary/2" || Object.keys(value).some(key=>!["protocol","spent","current"].includes(key))
    || !Array.isArray(value.spent) || value.spent.length<1 || value.spent.length>64 || new Set(value.spent).size!==value.spent.length
    || value.spent.some(id=>typeof id!=="string" || !IDENTIFIER.test(id)) || !value.current || typeof value.current!=="object" || Array.isArray(value.current)) throw new Error("Provider canary journal protocol or history is invalid.");
  const entry=value.current as Record<string,unknown>;
  const shadow=value.protocol==="clank-provider-canary/2";
  if (entry.protocol!==value.protocol || Object.keys(entry).some(key=>!["protocol","operationId","primary","controllerEpoch","candidateProjectId","releaseId","capsuleSha256","phase","expiresAt",...(shadow?["purpose","snapshot"]:[])].includes(key))
    || !["preparing","running","stopping","stopped"].includes(String(entry.phase))) throw new Error("Provider canary journal state is invalid.");
  const primary=normalizedCanaryBinding((shadow?exactControlJson(entry.primary,["projectId","releaseId","generation","fence","incarnation"]):entry.primary) as DeploymentProviderCanaryBinding);
  const operationId=identifier(entry.operationId,"canary operationId");
  if (primary.projectId!==projectId || !value.spent.includes(operationId) || shadow && entry.releaseId===primary.releaseId) throw new Error("Provider canary journal scope is invalid.");
  let snapshot:DeploymentProviderShadowState["snapshot"]=null;
  if (shadow) {
    if (entry.purpose!=="shadow" || !Object.hasOwn(entry,"snapshot") || entry.phase==="running" && entry.snapshot===null) throw new Error("Provider shadow checkpoint state is invalid.");
    if (entry.snapshot!==null) {
      const value=exactControlJson(entry.snapshot,["sha256","bytes","startedAt","completedAt"]);
      snapshot=Object.freeze({sha256:pattern(value.sha256,"shadow checkpoint digest",DIGEST),bytes:integer(value.bytes,"shadow checkpoint bytes",1,MAX_PROVIDER_DATABASE_BYTES),
        startedAt:positiveInteger(value.startedAt,"shadow checkpoint startedAt"),completedAt:positiveInteger(value.completedAt,"shadow checkpoint completedAt")});
      if (snapshot.completedAt<snapshot.startedAt || snapshot.completedAt>=Number(entry.expiresAt)) throw new Error("Provider shadow checkpoint interval is invalid.");
    }
  }
  const current=Object.freeze({...(shadow?{protocol:"clank-provider-canary/2" as const,purpose:"shadow" as const,snapshot}:{protocol:"clank-provider-canary/1" as const}),primary,operationId,controllerEpoch:positiveInteger(entry.controllerEpoch,"canary controllerEpoch"),
    candidateProjectId:pattern(entry.candidateProjectId,"canary candidateProjectId",/^canary_[a-f0-9]{64}$/u),releaseId:identifier(entry.releaseId,"canary releaseId"),
    capsuleSha256:pattern(entry.capsuleSha256,"canary capsuleSha256",DIGEST),phase:entry.phase as DeploymentProviderCanaryState["phase"],expiresAt:positiveInteger(entry.expiresAt,"canary expiresAt")});
  return {protocol:current.protocol,spent:[...value.spent] as string[],current};
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
  resumedStopped = false,
): void {
  if (!prior) return;
  if (prior.phase === "rolling-back" || prior.phase === "deleting") {
    throw new Error("Provider service lifecycle operation is incomplete.");
  }
  const capsuleSha256 = request.runtime?.sha256 ?? null;
  const resumed = resumedStopped && prior.phase === "stopped" && prior.state === "stopped" && prior.releaseId === null && prior.capsuleSha256 === null && request.desired.state === "running" && request.operation.fence > prior.fence;
  const exact = prior.generation === request.desired.generation
    && (resumed || prior.state === request.desired.state && prior.releaseId === request.desired.releaseId && prior.capsuleSha256 === capsuleSha256);
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

export function deploymentProviderCanaryPath(projectId:string,operation:"binding"|"prepare"|"inspect"|"stop"|"retire"):string {
  if (!["binding","prepare","inspect","stop","retire"].includes(operation)) throw new TypeError("Provider canary control operation is invalid.");
  return `${DEPLOYMENT_PROVIDER_CONTROL_PREFIX}/${identifier(projectId,"projectId")}/canary/${operation}`;
}

function providerCanaryControlResponse(payload:{binding:DeploymentProviderCanaryBinding}|{state:ProviderCandidateState|null}|{retirement:DeploymentProviderCanaryRetirement}):Response {
  const body=JSON.stringify({protocol:DEPLOYMENT_PROVIDER_CANARY_CONTROL_PROTOCOL,...payload});
  const length=new TextEncoder().encode(body).byteLength;
  if (length>64*1024) throw new Error("Provider canary response exceeds its bound.");
  return new Response(body,{headers:{"content-type":DEPLOYMENT_PROVIDER_CANARY_CONTROL_MEDIA_TYPE,"content-length":String(length),
    "cache-control":"private, no-store","x-content-type-options":"nosniff"}});
}

function parseCanaryControlJson(text:string):Record<string,unknown> {
  return exactControlJson(JSON.parse(text),["primary","operationId","controllerEpoch","releaseId","capsuleSha256","retirementEpoch","purpose","stateProtocol"]);
}

async function readCanaryControlBody(request:Request,expected:number,maximum:number,signal:AbortSignal):Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(expected) || expected<1 || expected>maximum || !request.body) throw new Error("Provider canary body length is invalid.");
  const reader=request.body.getReader();
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",abort,{once:true});
  const chunks:Uint8Array[]=[];
  let length=0;
  try {
    for (;;) {
      const item=await reader.read();
      throwIfAborted(signal);
      if (item.done) break;
      length+=item.value.byteLength;
      if (length>expected || length>maximum) throw new Error("Provider canary body exceeds its bound.");
      chunks.push(new Uint8Array(item.value));
    }
    if (length!==expected) throw new Error("Provider canary body length is invalid.");
    const bytes=new Uint8Array(length);
    let offset=0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return bytes;
  } finally {signal.removeEventListener("abort",abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
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

const sourceIngressOwners = new WeakSet<object>();
const sourceIngressContexts = new WeakMap<object, {source:ReturnType<typeof providerSourceLaunchIngressContext>;phase():string;active():ProviderActivatedTarget;close():Promise<void>}>();
/** Original provider publication only. Copied fields cannot certify a coordinator switch. */
export function providerSourceHandoffIngressContext(value:object){const held=sourceIngressContexts.get(value);if(!held)throw new Error("A genuine original provider handoff ingress is required.");return Object.freeze({...held});}

/** Private provider composition. Every route and writer comes from an original native capability. */
export async function openProviderSourceHandoffIngress(originalSource: object) {
  const source = providerSourceLaunchIngressContext(originalSource);
  if (sourceIngressOwners.has(originalSource)) throw new Error("Original source ingress cannot be duplicated or recycled.");
  sourceIngressOwners.add(originalSource);
  const ingress = createDeploymentRuntimeIngress();
  let phase: "source" | "draining" | "target" | "closed" = "source";
  let binding = source.binding;
  let active: ProviderActivatedTarget | undefined;
  let stopped: providerHandoff.ProviderSourceStopLease | undefined;
  const verifications = new WeakMap<object, Promise<void>>();
  let handoffFlight: Promise<Readonly<{ target: ProviderActivatedTarget; interruptionMs: number }>> | undefined;
  let handoffInputs: { target: ProviderTransferTarget; receipt: ProviderTargetTransferReceipt } | undefined;
  let closing: Promise<void> | undefined;
  let sourceRevoked = false, sourceDrained = false, cutoverDeadline: number | undefined;
  const unavailable = () => Response.json({ error: "RUNTIME_UNAVAILABLE" }, { status: 503, headers: { "cache-control": "no-store" } });
  const drainSource = async () => {
    if(phase==="draining")assertSwitching();
    const pending = ingress.deactivate(source.binding.projectId, source.binding.generation, phase==="draining"&&cutoverDeadline!==undefined?Math.max(1,Math.floor(cutoverDeadline-performance.now())):30_000);
    sourceRevoked = true;
    const result = await pending;
    sourceDrained = result.drained;
    if (!result.drained) throw new Error("Original source ingress did not drain before its deadline.");
  };
  const unregisterDrain = source.retainDrain(drainSource);
  const assertSwitching = () => {
    if (phase !== "draining") throw new Error("Original provider handoff is closed or fenced.");
    if(cutoverDeadline!==undefined&&performance.now()>=cutoverDeadline)throw new Error("Original provider handoff interruption deadline expired.");
  };
  const cleanup = async (target?: ProviderTransferTarget) => {
    const failures: unknown[] = [];
    phase = "closed";
    try { if (!await ingress.close(30_000)) throw new Error("Original provider ingress cleanup did not drain."); } catch (error) { failures.push(error); }
    try { if (active) await active.close(); else await target?.close(); } catch (error) { failures.push(error); }
    try { await source.close(); } catch (error) { failures.push(error); }
    try { stopped?.close(); } catch (error) { failures.push(error); }
    unregisterDrain();
    if (failures.length) throw new AggregateError(failures, "Original provider handoff cleanup failed.");
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    phase = "closed";
    return closing = (async () => {
      // A reserved activation can still be settling. It must finish or fail
      // before close reports that its exact target process has been removed.
      await handoffFlight?.catch(() => {});
      await cleanup(handoffInputs?.target);
    })();
  };
  try {
    await source.container.verifyCurrent(); source.check();
    await ingress.activate(source.binding); source.check();
  } catch (error) {
    try { await cleanup(); } catch (failure) { throw new AggregateError([error, failure], "Original source ingress admission and cleanup failed."); }
    throw error;
  }
  const service = Object.freeze({
    projectId: source.binding.projectId,
    inspect() { return Object.freeze({ phase, sourceRevoked, sourceDrained }); },
    /** Exact capsule route for the trusted managed-ingress controller. */
    route() {
      return Object.freeze({ protocol: binding.protocol, generation: binding.generation, path: binding.path, token: binding.token });
    },
    async handle(request: Request): Promise<Response> {
      const selectedPhase = phase, selected = active, selectedBinding = binding;
      if (selectedPhase !== "source" && selectedPhase !== "target") return unavailable();
      try {
        if (!await providerRuntimeRequestAuthorized(request, selectedBinding)) return unavailable();
        if (phase !== selectedPhase || active !== selected) return unavailable();
        if (selectedPhase === "source") source.check(); else selected!.assertCurrent();
        const owner = selected ?? originalSource;
        let verification = verifications.get(owner);
        if (!verification) {
          verification = (selectedPhase === "source" ? source.container.verifyCurrent() : selected!.verifyHealthy()).finally(() => { verifications.delete(owner); });
          verifications.set(owner, verification);
        }
        await verification;
        if (phase !== selectedPhase || active !== selected) return unavailable();
        if (selectedPhase === "source") source.check(); else selected!.assertCurrent();
        return await ingress.handle(request);
      } catch {
        // A source verification already in flight must not fence the target
        // selected by a concurrent, successful handoff.
        if (phase === selectedPhase && active === selected) void close().catch(() => {});
        return unavailable();
      }
    },
    handoff(target: ProviderTransferTarget, receipt: ProviderTargetTransferReceipt) {
      if (handoffFlight) {
        if (handoffInputs?.target !== target || handoffInputs.receipt !== receipt) throw new Error("Original ingress handoff cannot change its target or receipt.");
        if (phase === "closed") throw new Error("Original ingress handoff is closed or fenced.");
        active?.assertCurrent();
        return handoffFlight;
      }
      // Resolve both original capabilities before revoking any source traffic.
      const selected = providerTargetHandoffContext(target, receipt);
      const transfer = providerHandoff.providerSourceTransferContext(selected.source);
      if (transfer.bridge !== source.bridge || selected.source.grantId !== source.grantId) throw new Error("Provider ingress handoff requires its matching original source.");
      if (phase !== "source") throw new Error("Original source ingress is unavailable for handoff.");
      source.check(); selected.check();
      handoffInputs = { target, receipt };
      // Reserve synchronously before any await; requests still verifying the
      // source must observe this phase before reserving an ingress body lease.
      const duration=selected.begin();
      phase = "draining";
      const began = performance.now();cutoverDeadline=began+duration;
      handoffFlight = (async () => {
        try {
          await selected.ready();assertSwitching();source.check();
          await selected.verify(); assertSwitching(); source.check();
          if (receipt.kind === "tail") { await providerHandoff.acknowledgeProviderSourceTargetReceipt(receipt); assertSwitching(); source.check(); }
          await drainSource(); assertSwitching(); source.check();
          const quiescence = await providerHandoff.quiesceProviderSourceForTarget(receipt); assertSwitching();
          stopped = await providerHandoff.stopQuiescentProviderSource(quiescence, originalSource); assertSwitching();
          const terminal = await providerHandoff.publishProviderSourceTerminalTail(stopped); assertSwitching();
          const finalReceipt = terminal ? await applyProviderTransferTail(target, receipt) : receipt; assertSwitching();
          active = await activateProviderTransferTarget(target, stopped, finalReceipt); assertSwitching();
          const publication = providerActivatedTargetIngressContext(active);
          await publication.verify(); assertSwitching(); publication.check();
          await ingress.activate(publication.binding); assertSwitching(); publication.check();
          await selected.finish(active);assertSwitching();publication.check();
          binding = publication.binding;
          phase = "target";
          return Object.freeze({ target: active, interruptionMs: performance.now() - began });
        } catch (error) {
          try { await cleanup(target); } catch (failure) { throw new AggregateError([error, failure], "Original provider ingress handoff and cleanup failed."); }
          throw error;
        }
      })();
      return handoffFlight;
    },
    close,
  });
  sourceIngressContexts.set(service,{source,phase:()=>phase,active(){if(phase!=="target"||!active)throw new Error("Original provider target is not published.");active.assertCurrent();return active;},close});
  return service;
}

/** Private normal-provider admission. Caller bytes must equal the currently approved native release. */
export async function prepareDockerProviderSource(
  value: DeploymentProviderService, projectIdInput: string, approvedCapsule: Uint8Array,
  nodeId: string, limits: providerHandoff.ProviderHandoffBridgeLimits,
) {
  const native=nativeSourceAdmissions.get(value),ordinary=ordinarySourceAdmissions.get(value);
  if(!native||!ordinary)throw new Error("A genuine original Docker provider service is required.");
  if(!native.compatible)throw new Error("The original Docker policy does not support captured source preparation.");
  if(sourcePreparationReservations.has(value))throw new Error("Original Docker source preparation cannot be duplicated or recycled.");
  const capturedLimits=providerHandoff.captureProviderHandoffLimits(limits);
  const projectId=identifier(projectIdInput,"projectId");
  if(typeof nodeId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/u.test(nodeId))throw new Error("Source preparation requires its registered node identity.");
  if(/[\r\n,]/u.test(ordinary.ownership.root))throw new Error("Original provider path cannot be represented by the source profile.");
  const typed=Object.getPrototypeOf(Uint8Array.prototype),length=Object.getOwnPropertyDescriptor(typed,"byteLength")!.get!,buffer=Object.getOwnPropertyDescriptor(typed,"buffer")!.get!;
  try{
    if(!(approvedCapsule instanceof Uint8Array)||!ArrayBuffer.isView(approvedCapsule)||length.call(approvedCapsule)>32+614*1024*1024)throw new Error();
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!.call(buffer.call(approvedCapsule));
  }catch{throw new Error("Source preparation requires bounded native non-shared capsule bytes.");}
  const bytes=new Uint8Array(approvedCapsule);
  let decoded:DeploymentRuntimeCapsule|undefined;
  let owner:ProviderServiceOwnership|undefined,sourceService:providerHandoff.ProviderSourceServiceOwnership|undefined,data:providerHandoff.ProviderSourceLaunchDataLease|undefined;
  let launched:Awaited<ReturnType<typeof launchProviderSourceContainer>>|undefined,ingress:Awaited<ReturnType<typeof openProviderSourceHandoffIngress>>|undefined;
  let closing:Promise<void>|undefined;
  let ordinaryFrozen=false;
  const close=()=>closing??=(async()=>{
    const failures:unknown[]=[];
    try{if(ingress)await ingress.close();else await launched?.close();}catch(error){failures.push(error);}
    for(const resource of [data,sourceService,owner])try{resource?.close();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,"Original prepared provider source cleanup failed.");
  })();
  try{
    decoded=await decodeDeploymentRuntimeCapsule(bytes);
    if(decoded.manifest.projectId!==projectId||decoded.artifact.bundle.config.jobs!==undefined
      ||!decoded.artifact.bundle.files.some(file=>file.path==="node_modules/@clank.run/framework/dist/provider-source-entry.js")
      ||Object.values(decoded.manifest.environment).some(v=>/[\r\n\0]/u.test(v)))throw new Error("The approved capsule does not support this captured source profile.");
    // Read only the already cached immutable image before stopping any traffic.
    const inspected=await runProviderDockerClient(native.client,["image","inspect",native.image,"--format","{{json .Id}}"],{timeoutMs:15000,maxOutputBytes:4096});
    const imageId=JSON.parse(inspected.stdout.trim());
    if(typeof imageId!=="string"||!/^sha256:[a-f0-9]{64}$/u.test(imageId))throw new Error("Original provider image identity is unavailable.");
    const frozen=await ordinary.freeze(projectId,decoded.sha256);
    ordinaryFrozen=true;
    if(frozen.state.releaseId!==decoded.manifest.releaseId||frozen.state.generation!==decoded.manifest.generation)throw new Error("Source capsule differs from the approved running provider generation.");
    sourcePreparationReservations.add(value);
    const began=performance.now();
    await value.close();
    owner=await acquireProviderServiceOwnership(ordinary.ownership.root);
    const fs=owner.fs as NodeFs,path=owner.path as NodePath;
    const actual=[await fs.lstat(owner.root),await fs.lstat(owner.serviceDirectory),await fs.lstat(path.join(owner.serviceDirectory,".writer.sqlite"))];
    for(const [i,expected] of [frozen.root,frozen.service,frozen.writer].entries()){
      const current=actual[i];
      if(current.isSymbolicLink()||current.dev!==expected.dev||current.ino!==expected.ino||current.uid!==expected.uid||(i<2?!current.isDirectory():!current.isFile()||current.nlink!==1))throw new Error("Original provider root ownership changed during source preparation.");
    }
    providerHandoff.assertProviderServiceOwnership(owner);
    const domain=await providerHandoff.createProviderHandoffDomain(owner,native.client,nodeId,native.owner);
    await providerHandoff.initializeProviderHandoff(owner,domain);
    await providerHandoff.installProviderHandoffProject(owner,domain,projectId);
    const bridge=await providerHandoff.enableProviderHandoffBridge(owner,domain,capturedLimits);
    sourceService=await providerHandoff.admitProviderSourceService(bridge);
    data=await providerHandoff.retainProviderSourceLaunchData(sourceService,{projectId,releaseId:decoded.manifest.releaseId,generation:decoded.manifest.generation,capsuleSha256:decoded.sha256,fence:frozen.state.fence});
    launched=await launchProviderSourceContainer(sourceService,data,bytes,imageId,frozen.port);
    ingress=await openProviderSourceHandoffIngress(launched);
    const currentSource=launched,currentIngress=ingress;
    sourceReplacements.set(value,{
      async reconcile(input){
        const request=await providerRequest(input,ordinary.maxDatabaseBytes);
        if(currentIngress.inspect().phase!=="source"||request.operation.projectId!==projectId||request.operation.id!==frozen.state.operationId||request.operation.fence!==frozen.state.fence
          ||request.desired.state!=="running"||request.desired.generation!==frozen.state.generation||request.desired.releaseId!==frozen.state.releaseId||request.runtime?.sha256!==frozen.state.capsuleSha256)throw new Error("Prepared source reconciliation cannot change its original admission.");
        currentSource.assertCurrent();await currentSource.container.verifyCurrent();currentSource.assertCurrent();
      },
      handle:request=>currentIngress.handle(request),
      async inspect(selected){
        if(identifier(selected,"projectId")!==projectId)return null;
        if(currentIngress.inspect().phase==="source"){
          currentSource.assertCurrent();await currentSource.container.verifyCurrent();currentSource.assertCurrent();
          return Object.freeze({...frozen.state});
        }
        const original=providerSourceHandoffIngressContext(currentIngress).active();
        await original.verifyHealthy();
        return Object.freeze({...frozen.state,state:"stopped" as const,releaseId:null,capsuleSha256:null,phase:"stopped" as const});
      },
      close,
    });
    return Object.freeze({owner,domain,bridge,service:sourceService,data,launched,ingress,preparationMs:performance.now()-began,close});
  }catch(error){
    if(ordinaryFrozen)try{await value.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original ordinary provider close is uncertain.");}
    try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original provider source admission and cleanup failed.");}
    throw error;
  }finally{bytes.fill(0);decoded?.bytes.fill(0);}
}
