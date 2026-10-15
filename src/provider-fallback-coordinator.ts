/** Private all-role downtime protocol. No captured-writer receipt is accepted. */
import { platformProviderFallbackContext, platformProviderHandoffContext, platformColdFallbackResumeSelection, platformColdFallbackNoSweepSelection, assertPlatformFallbackParticipant, type PlatformFallbackParticipant, type PlatformRuntime } from "./platform.ts";
import { providerFallbackOrchestrationContext, type ClaimedDeploymentOperation } from "./orchestration.ts";
import { prepareDockerProviderFallbackSource, providerFallbackSourceContext, probeDockerProviderFallbackEndpoint, providerFallbackEndpointContext, stageDockerProviderFallbackTarget, providerFallbackTargetContext, closeProviderFallbackTarget, type ProviderFallbackSource, type DeploymentProviderService } from "./provider-service.ts";
import { decodeDeploymentRuntimeCapsule, type DeploymentRuntimeCapsule } from "./runtime-placement.ts";
import type { DeploymentProviderRequest } from "./provider.ts";

export interface ProviderFallbackReservation { readonly operationId: string; readonly projectId: string; }
type Catalog = ReturnType<typeof providerFallbackOrchestrationContext>;
type Reservation = {
  participant: PlatformFallbackParticipant; catalog: Catalog; source: ProviderFallbackSource; deadline: bigint; targetService: DeploymentProviderService; sourceEndpoint: object; targetEndpoint: object;
  expected: string; originalFence: number; fence: number; capsule?: DeploymentRuntimeCapsule; target?: object;
  journal: string; authentication: string; phase: "reserved"|"stopping"|"stopped"|"launching"|"prepared"; launchIntent?: string; request?: DeploymentProviderRequest; lease?: ClaimedDeploymentOperation;
  committed: boolean; completed: boolean; completedOperation?: string; failed: boolean; published: boolean;
};
const reservations = new WeakMap<object, Reservation>();
const attempts = new WeakMap<object, object>();
const cancellations = new WeakMap<object, {source: object; check(): void}>();
const endpointProbes = new WeakMap<object, {service: DeploymentProviderService; origin: string; deadline: bigint; operationId: string; projectId: string; nodeId: string; check(): void}>();
export function providerFallbackCancellationContext(permit: object) {
  const value=cancellations.get(permit);if(!value)throw new Error("A genuine coordinator source cancellation capability is required.");value.check();return Object.freeze({...value});
}
export function providerFallbackEndpointProbeContext(permit: object) {
  const value=endpointProbes.get(permit);if(!value)throw new Error("A genuine coordinator endpoint probe capability is required.");value.check();return Object.freeze({...value});
}

const recoveries = new WeakMap<object, { journal: string; authentication: string; input: Record<string, any>; check(): void }>();
const journals = new WeakMap<object, { participant: object; journal: string }>();
const commits = new WeakMap<object, { participant: object; check(): void }>();
const completions = new WeakMap<object, { participant: object; check(): void; resumeJournal?: object; source?: { kind: "reserved" | "resumed"; evidence: object; request?: DeploymentProviderRequest } }>();
export type ProviderFallbackResumePhase = "planned" | "claimed" | "staged" | "running" | "published" | "stopped";
export type ProviderFallbackResumeRecord = { resumeId: string; revision: number; phase: ProviderFallbackResumePhase; journal: string; authentication: string };
type ResumeJournalAuthority = { authority: object; data: Readonly<Record<string, any>>; previous?: ProviderFallbackResumeRecord; check(): void };
const resumeJournals = new WeakMap<object, ResumeJournalAuthority>();
export function providerFallbackResumeJournalContext(permit: object, authority: object) {
  const held = resumeJournals.get(permit); if (!held || held.authority !== authority) throw new Error("A genuine original resume journal capability is required."); held.check(); return Object.freeze({ ...held });
}
export function providerFallbackResumeCompletionJournal(permit: object, authority: object): object | undefined {
  const held = completions.get(permit); if (!held || held.participant !== authority) throw new Error("A genuine coordinator completion capability is required."); held.check(); return held.resumeJournal;
}
const settlements = new WeakMap<object, { authority: object; resumeJournal?: object; check(): void }>();
export function providerFallbackResumeSettlementJournal(permit: object, authority: object): object | undefined {
  const held=settlements.get(permit);if(!held||held.authority!==authority)throw new Error("A genuine coordinator settlement capability is required.");held.check();return held.resumeJournal;
}
const recoveryFinalizations = new WeakMap<object, {proof:object;journal:string;authentication:string;selected:"source"|"target";check():void}>();
const retirements = new WeakMap<object, {journal:string;authentication:string;input:Record<string,any>;selected:"source"|"target";service:object;check():void;verifyStopped():Promise<void>}>();
const cancelledSources = new WeakMap<object, {service:object;owner:object;input:Record<string,any>;journal:string;authentication:string;check():void;verifyRunning():Promise<void>}>();
export function providerFallbackCancelledSourceContext(permit:object){const held=cancelledSources.get(permit);if(!held)throw new Error("A genuine cancelled reserved-source capability is required.");held.check();return Object.freeze({...held});}
const sourceClaims = new WeakMap<object, {orchestrator:object;operationId:string;nodeId:string;projectId:string;fence:number;operationImage:string;nodeImage:string;check():void}>();
export function providerFallbackSourceClaimContext(permit:object){const held=sourceClaims.get(permit);if(!held)throw new Error("A genuine original stopped-source claim capability is required.");held.check();return Object.freeze({...held});}

export function providerFallbackRetirementContext(permit:object){const held=retirements.get(permit);if(!held)throw new Error("A genuine finalized fallback retirement capability is required.");held.check();return Object.freeze({...held});}
const resumeObservations = new WeakMap<object,{recoveryOperationId:string;selected:"source"|"target";service:object;owner:object;request:DeploymentProviderRequest;deadline:bigint;check():void;authorizeCompletion():void;persistIntent(native:object):Promise<void>;authorizeLaunch(native:object):void;persistRunning(native:object):Promise<void>;publish():void;authorizeRelease():void}>();
export function providerFallbackResumeContext(permit:object){const held=resumeObservations.get(permit);if(!held)throw new Error("A genuine original fallback resume observation capability is required.");held.check();return Object.freeze({...held});}
const resumeCleanups=new WeakMap<object,{recoveryOperationId:string;selected:"source"|"target";service:object;owner:object;request:DeploymentProviderRequest;deadline?:bigint;check():void}>();
export function providerFallbackResumeCleanupContext(permit:object){
  const held=resumeCleanups.get(permit);if(!held)throw new Error("A genuine original fallback resume cleanup capability is required.");
  held.deadline??=nowMono()+30000000000n;
  const check=()=>{if(nowMono()>=held.deadline!)throw new Error("Fallback resume cleanup deadline expired.");held.check();};check();return Object.freeze({...held,deadline:held.deadline,check});
}
type RetiredResume={runtime:object;journal:string;authentication:string;input:Record<string,any>;selected:"source"|"target";service:DeploymentProviderService;owner:object;placement:string;handoff:string;attempt?:number;busy?:boolean;fence?:number;admitCold?:()=>void;authority:ReturnType<ReturnType<typeof platformProviderFallbackContext>["recovery"]>};
const retiredResumes=new WeakMap<object,Map<string,RetiredResume>>();
const consumedColdSelections=new WeakSet<object>();
export function providerFallbackRecoveryFinalizationContext(permit:object){
  const held=recoveryFinalizations.get(permit);if(!held)throw new Error("A genuine coordinator recovery finalization capability is required.");held.check();return Object.freeze({...held});
}

function journalPermit(participant: object, journal: string): object { const permit=Object.freeze({}); journals.set(permit,{participant,journal}); return permit; }
export function providerFallbackJournalContext(permit: object, participant: object): string {
  const value=journals.get(permit); if(!value||value.participant!==participant)throw new Error("A genuine coordinator journal capability is required."); return value.journal;
}
export function assertProviderFallbackCommit(permit: object, participant: object): void {
  const value=commits.get(permit);if(!value||value.participant!==participant)throw new Error("A genuine coordinator commit capability is required.");value.check();
}
export function assertProviderFallbackCompletion(permit: object, participant: object): void {
  const held=completions.get(permit);if(!held||held.participant!==participant)throw new Error("A genuine coordinator completion capability is required.");held.check();
}
export function providerFallbackSourceCompletionContext(permit: object, authority: object) {
  const held=completions.get(permit);if(!held||held.participant!==authority||!held.source)throw new Error("A genuine original source-completion capability is required.");held.check();return Object.freeze({...held.source});
}
export function assertProviderFallbackSettlement(permit: object, authority: object): void {
  const value=settlements.get(permit);if(!value||value.authority!==authority)throw new Error("A genuine coordinator settlement capability is required.");value.check();
}
const nowMono = () => (globalThis as any).process.hrtime.bigint() as bigint;
const hash = (value: string) => (globalThis as any).process.getBuiltinModule("node:crypto").createHash("sha256").update(value).digest("base64url");
const image = (catalog: Catalog, table: string, key: string, value: string) => JSON.stringify(catalog.internal.prepare("SELECT * FROM " + table + " WHERE " + key + "=?").get(value));
const row = (held: Reservation) => JSON.parse(held.expected);
function current(value: object, expired = false): Reservation {
  const held = reservations.get(value);
  if (!held) throw new Error("A genuine original fallback reservation is required.");
  held.catalog.check();
  if (held.failed || !expired && nowMono() >= held.deadline) throw new Error("Fallback reservation is fenced or expired.");
  if (image(held.catalog,"clank_deployment_handoffs","handoff_id",held.source.operationId) !== held.expected) throw new Error("Original fallback reservation changed.");
  return held;
}
function check(held: Reservation): void {
  held.participant.check(); providerFallbackEndpointContext(held.sourceEndpoint).check(); providerFallbackEndpointContext(held.targetEndpoint).check();
  const id = held.participant.identity, catalog = held.catalog, before = row(held);
  const placement = catalog.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(id.projectId)!;
  if (catalog.nodeImage(catalog.sourceNode(id.sourceNodeId)) !== before.source_node_json || catalog.nodeImage(catalog.targetNode(id.targetNodeId,placement)) !== before.target_node_json) throw new Error("Fallback original node identity changed.");
  if (Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(id.projectId)?.fence) !== held.fence) throw new Error("Fallback lifecycle fence changed.");
  if (!held.committed && JSON.stringify(placement) !== before.placement_json || held.committed && (!placement || placement.assigned_node_id !== id.targetNodeId || Number(placement.generation) !== id.targetGeneration || placement.desired_release_id !== id.releaseId || placement.desired_state !== "running")) throw new Error("Fallback placement changed.");
}
async function verifyLease(held: Reservation): Promise<void> {
  check(held);
  if (!held.lease || !held.request || !held.committed || !await held.participant.orchestrator.authenticateOperation(held.lease)) throw new Error("Fallback publication requires its fresh original runner API lease.");
  check(held);
}
/** Called only by the original source/target service capabilities. */
export function providerFallbackReservationContext(value: object) {
  const held = current(value); check(held);
  const authorizeSource = (source: object) => { current(value); check(held); if (source !== held.source) throw new Error("Fallback source authority differs."); providerFallbackSourceContext(source); };
  const authorizeTarget = (target: object) => {
    current(value); check(held);
    const native = providerFallbackTargetContext(target);
    if (native.service !== held.targetService || native.source !== held.source || native.reservation !== value || native.deadline !== held.deadline || native.capsuleSha256 !== held.capsule?.sha256 || held.target && held.target !== target) throw new Error("Fallback target authority differs.");
    held.target = target;
  };
  return Object.freeze({ source: held.source, deadline: held.deadline, identity: held.participant.identity,
    get targetCapsule() { current(value); if (!held.capsule) throw new Error("Fallback final capsule is not prepared."); return new Uint8Array(held.capsule.bytes); },
    get fence() { current(value); return held.fence; },
    get request() { current(value); if (!held.request) throw new Error("Fallback publication lease is not prepared."); return held.request; },
    check() { current(value); check(held); }, authorizeSource, authorizeTarget,
    authorizeStop(source: object) { authorizeSource(source); if(held.phase!=="stopping")throw new Error("Fallback source stop requires its durable signed stopping phase."); },
    authorizeStage(source: object, service: object) { authorizeSource(source); if(held.phase!=="stopped"||service!==held.targetService)throw new Error("Fallback staging requires its durable stopped phase and original target service."); },
    authorizeLaunch(target: object, intent: unknown) { authorizeTarget(target); if(held.phase!=="launching"||!held.launchIntent||JSON.stringify(intent)!==held.launchIntent)throw new Error("Fallback role launch requires its exact durable signed launch intent."); },
    assertJournal(journal: string, authentication: string) {
      current(value); if (journal !== held.journal || authentication !== held.authentication) throw new Error("Fallback journal differs from its original platform signature.");
      const stored = held.catalog.internal.prepare("SELECT journal,authentication FROM clank_deployment_fallback_journals WHERE operation_id=?").get(held.source.operationId);
      if (stored?.journal !== journal || stored.authentication !== authentication) throw new Error("Fallback durable journal changed.");
    },
    async verifyLease() { current(value); await verifyLease(held); },
    authorizePublication(target: object, request: DeploymentProviderRequest) {
      authorizeTarget(target); if (!held.committed || !held.lease || request !== held.request) throw new Error("Fallback requires the exact original API publication request.");
    },
    authorizeCompletion(target: object, request: DeploymentProviderRequest) {
      authorizeTarget(target);
      const id=held.participant.identity, placement=held.catalog.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(id.projectId);
      if (!held.completed || !held.lease || request!==held.request || !held.completedOperation
        || image(held.catalog,"clank_deployment_operations","id",held.lease.id)!==held.completedOperation
        || placement?.observed_state!=="running" || placement.observed_release_id!==id.releaseId || Number(placement.observed_generation)!==id.targetGeneration) throw new Error("Fallback cleanup release requires its exact completed original API operation and running observation.");
    },
  });
}
export function providerFallbackRecoveryContext(authority: object) {
  const held = recoveries.get(authority); if (!held) throw new Error("A genuine original fallback recovery authority is required."); held.check(); return held;
}

/** Reserve real platform placement/capacity before the first source stop. */
export async function reserveProviderFallback(runtime: object, source: ProviderFallbackSource, sourceBytes: Uint8Array, targetNodeId: string, deadline: bigint, targetService: DeploymentProviderService): Promise<ProviderFallbackReservation> {
  const platform = platformProviderFallbackContext(runtime), native=providerFallbackSourceContext(source);
  const catalog=providerFallbackOrchestrationContext(platformProviderHandoffContext(runtime).orchestrator);
  if(attempts.has(source))throw new Error("Fallback source already has an original reservation attempt.");
  const attempt=Object.freeze({});attempts.set(source,attempt);let transactionStarted=false;
  const originalFence=image(catalog,"clank_deployment_project_fences","project_id",source.projectId);
  try {
  const participant = await platform.prepare(source,sourceBytes,targetNodeId,deadline); assertPlatformFallbackParticipant(participant);
  if(participant.orchestrator!==platformProviderHandoffContext(runtime).orchestrator)throw new Error("Fallback original platform catalog differs.");
  const id=participant.identity;
  participant.authorizeServices(native.service,targetService);
  if(targetService===native.service||id.sourceOrigin===id.targetOrigin)throw new Error("Fallback requires distinct original source and target services and endpoints.");
  await native.verifyRunning(); participant.check();
  // Refuse ordinary preflight failures before a transaction can have an unknown outcome.
  const validate=()=>{
    catalog.check();participant.check();native.check();
    if(catalog.internal.prepare("SELECT handoff_id FROM clank_deployment_handoffs WHERE project_id=? AND state='reserved'").get(source.projectId))throw new Error("Fallback project already has a reservation.");
    const placement=catalog.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(source.projectId);
    if(!placement||placement.placement_mode!=="stateful"||placement.assigned_node_id!==id.sourceNodeId||Number(placement.generation)!==id.sourceGeneration||placement.observed_state!=="running"||Number(placement.observed_generation)!==id.sourceGeneration)throw new Error("Fallback source placement differs.");
    catalog.sourceNode(id.sourceNodeId);catalog.targetNode(id.targetNodeId,placement);
    const counts=catalog.internal.prepare("SELECT count(*) total,sum(project_id=?) project FROM clank_deployment_handoffs").get(source.projectId)!;
    if(Number(counts.total)>=1000||Number(counts.project)>=32)throw new Error("Fallback reservation history capacity is exhausted.");
  };validate();
  const probe=async(service:DeploymentProviderService,role:"source"|"target")=>{
    const permit=Object.freeze({});endpointProbes.set(permit,{service,origin:role==="source"?id.sourceOrigin:id.targetOrigin,deadline,operationId:source.operationId,projectId:source.projectId,nodeId:role==="source"?id.sourceNodeId:id.targetNodeId,check(){catalog.check();participant.check();native.check();if(attempts.get(source)!==attempt||(globalThis as any).process.hrtime.bigint()>=deadline)throw new Error("Fallback original endpoint probe expired.");}});
    return probeDockerProviderFallbackEndpoint(service,permit);
  };
  const sourceEndpoint=await probe(native.service,"source"),targetEndpoint=await probe(targetService,"target");validate();
  let allocatedFence = 0, journal = "", authentication = "";
  transactionStarted=true;
  const expected = catalog.internal.transaction(changes => {
    catalog.check(); participant.check(); native.check();
    if (catalog.internal.prepare("SELECT handoff_id FROM clank_deployment_handoffs WHERE project_id=? AND state='reserved'").get(source.projectId)) throw new Error("Fallback project already has a reservation.");
    const placement = catalog.internal.prepare("SELECT * FROM clank_deployment_placements WHERE project_id=?").get(source.projectId);
    if (!placement || placement.placement_mode !== "stateful" || placement.assigned_node_id !== id.sourceNodeId || Number(placement.generation) !== id.sourceGeneration || placement.observed_state !== "running" || Number(placement.observed_generation) !== id.sourceGeneration) throw new Error("Fallback source placement differs.");
    const origin = catalog.sourceNode(id.sourceNodeId), target = catalog.targetNode(id.targetNodeId,placement);
    const counts = catalog.internal.prepare("SELECT count(*) total,sum(project_id=?) project FROM clank_deployment_handoffs").get(source.projectId)!;
    if (Number(counts.total)>=1000 || Number(counts.project)>=32) throw new Error("Fallback reservation history capacity is exhausted.");
    const now = Date.now(), previous = catalog.internal.prepare("SELECT fence,updated_at FROM clank_deployment_project_fences WHERE project_id=?").get(source.projectId);
    allocatedFence = Number(previous?.fence ?? 0)+1;
    if (!Number.isSafeInteger(allocatedFence) || allocatedFence<1) throw new Error("Fallback lifecycle fence is exhausted.");
    if (catalog.internal.prepare("INSERT INTO clank_deployment_project_fences(project_id,fence,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET fence=excluded.fence,updated_at=excluded.updated_at WHERE clank_deployment_project_fences.fence=excluded.fence-1").run(source.projectId,allocatedFence,Math.max(now,Number(previous?.updated_at??0))).changes!==1) throw new Error("Fallback fence allocation failed.");
    const input = JSON.stringify({protocol:"clank-provider-fallback-reservation/1",identity:id,sourceCapsuleSha256:native.capsuleSha256,sourceEvidenceSha256:hash(JSON.stringify(native.native.evidence)),deadline:deadline.toString(),fence:allocatedFence});
    if (catalog.internal.prepare("INSERT INTO clank_deployment_handoffs VALUES(?,?,?,?,?,?,1,'reserved',?,?,?,?,?,NULL,?,?)").run(source.operationId,source.projectId,id.sourceNodeId,id.targetNodeId,placement.capacity_units,catalog.controller,input,hash(input),JSON.stringify(placement),catalog.nodeImage(origin),catalog.nodeImage(target),now,now).changes!==1) throw new Error("Fallback reservation was not retained.");
    catalog.internal.prepare("UPDATE clank_deployment_operations SET state='cancelled',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE project_id=? AND state IN ('queued','retry','leased')").run(now,source.projectId);
    const reservation = catalog.internal.prepare("SELECT * FROM clank_deployment_handoffs WHERE handoff_id=?").get(source.operationId)!;
    journal = JSON.stringify({protocol:"clank-provider-fallback/1",phase:"reserved",controlIdentity:participant.controlIdentity,identity:id,deadline:deadline.toString(),fence:allocatedFence,reservation,placement,platform:participant.images(),source:native.native.evidence,target:null,cancelledReservation:{...reservation,state:"cancelled",version:Number(reservation.version)+1,updated_at:reservation.updated_at},endpointBindings:{source:providerFallbackEndpointContext(sourceEndpoint).nativeIdentity,target:providerFallbackEndpointContext(targetEndpoint).nativeIdentity}}); authentication=participant.sign(journalPermit(participant,journal));
    catalog.internal.prepare("INSERT INTO clank_deployment_fallback_journals VALUES(?,?,?)").run(source.operationId,journal,authentication);
    changes.record("__orchestration",source.projectId); return JSON.stringify(reservation);
  });
  const result = Object.freeze({operationId:source.operationId,projectId:source.projectId});
  reservations.set(result,{participant,catalog,source,deadline,targetService,sourceEndpoint,targetEndpoint,expected,originalFence:allocatedFence,fence:allocatedFence,journal,authentication,phase:"reserved",committed:false,completed:false,failed:false,published:false});
  providerFallbackReservationContext(result).assertJournal(journal,authentication);
  await native.persistJournal(result,journal,authentication);
  return result;
  } catch(error) {
    if(!transactionStarted){
      const permit=Object.freeze({});cancellations.set(permit,{source,check(){catalog.check();if(attempts.get(source)!==attempt||transactionStarted||image(catalog,"clank_deployment_project_fences","project_id",source.projectId)!==originalFence||catalog.internal.prepare("SELECT handoff_id FROM clank_deployment_handoffs WHERE project_id=? AND state='reserved'").get(source.projectId))throw new Error("Fallback pre-reservation cancellation cannot prove unchanged authority.");}});
      try{await native.cancel(permit);attempts.delete(source);}catch(cleanup){throw new AggregateError([error,cleanup],"Fallback preflight refused and source capture release remains unresolved.");}
    }
    throw error;
  }
}

async function persistPhase(reservation:ProviderFallbackReservation, phase:"stopping"|"stopped"|"launching"|"prepared"):Promise<void> {
  const held=current(reservation);check(held);
  const expected={stopping:"reserved",stopped:"stopping",launching:"stopped",prepared:"launching"}[phase];
  if(held.phase!==expected)throw new Error("Fallback durable phase transition differs.");
  const source=providerFallbackSourceContext(held.source), target=held.target?providerFallbackTargetContext(held.target):undefined;
  if(phase==="launching") { if(!target)throw new Error("Fallback staged target is missing.");held.launchIntent=JSON.stringify(target.launchIntent); }
  const before=row(held), placement=JSON.parse(before.placement_json), id=held.participant.identity, now=Date.now();
  const input:Record<string,any>={protocol:"clank-provider-fallback/1",phase,controlIdentity:held.participant.controlIdentity,identity:id,deadline:held.deadline.toString(),fence:held.originalFence,reservation:before,placement,
    platform:held.participant.images(),source:source.native.evidence,target:phase==="prepared"?target!.native.evidence:null,
    endpointBindings:{source:providerFallbackEndpointContext(held.sourceEndpoint).nativeIdentity,target:providerFallbackEndpointContext(held.targetEndpoint).nativeIdentity}};
  if(phase==="stopping"||phase==="stopped"){
    input.cancelledReservation={...before,state:"cancelled",version:Number(before.version)+1,updated_at:now};
    input.sourceStoppedPlacement={...placement,observed_release_id:null,observed_state:"stopped",observed_generation:id.sourceGeneration,updated_at:now};
  }
  if(held.capsule)input.capsuleSha256=held.capsule.sha256;
  if(held.launchIntent)input.launchIntent=JSON.parse(held.launchIntent);
  if(phase==="launching"||phase==="prepared"){
    const result=JSON.stringify({protocol:"clank-provider-fallback-committed/1",operationId:held.source.operationId,capsuleSha256:held.capsule!.sha256,sourceEvidenceSha256:hash(JSON.stringify(source.native.evidence)),launchIntentSha256:hash(held.launchIntent!),...(phase==="prepared"?{targetEvidenceSha256:hash(JSON.stringify(target!.native.evidence))}:{})});
    input.committedReservation={...before,state:"committed",version:Number(before.version)+1,result_json:result,updated_at:now};
    input.stoppedPlacement={...placement,assigned_node_id:id.targetNodeId,generation:id.targetGeneration,observed_release_id:null,observed_state:"stopped",observed_generation:id.targetGeneration,updated_at:now};
  }
  const journal=JSON.stringify(input),authentication=held.participant.sign(journalPermit(held.participant,journal));
  held.catalog.internal.transaction(()=>{check(held);if(held.catalog.internal.prepare("UPDATE clank_deployment_fallback_journals SET journal=?,authentication=? WHERE operation_id=? AND journal=? AND authentication=?").run(journal,authentication,held.source.operationId,held.journal,held.authentication).changes!==1)throw new Error("Fallback journal phase compare-and-set failed.");});
  held.journal=journal;held.authentication=authentication;held.phase=phase;
  await source.persistJournal(reservation,journal,authentication);if(target)await target.persistJournal(reservation,journal,authentication);
  check(held);
}

async function prepareCommit(reservation: ProviderFallbackReservation): Promise<void> {
  const held=current(reservation); check(held);
  if (!held.target || !held.capsule) throw new Error("Fallback target is not prepared.");
  const source=providerFallbackSourceContext(held.source), target=providerFallbackTargetContext(held.target);
  await source.verifyStopped(); await target.verifyRunning(); check(held);
  const sourceEvidence=source.native.evidence, targetEvidence=target.native.evidence;
  const roster=(evidence:typeof sourceEvidence)=>JSON.stringify(evidence.roles.map(role=>[role.role,role.instance]).sort());
  if (roster(sourceEvidence)!==roster(targetEvidence) || sourceEvidence.policySha256!==targetEvidence.policySha256 || sourceEvidence.imageId!==targetEvidence.imageId
    || sourceEvidence.roles.some(sourceRole=>targetEvidence.roles.some(targetRole=>targetRole.containerId===sourceRole.containerId))) throw new Error("Fallback target role roster, image or original policy differs.");
  await persistPhase(reservation,"prepared");
  const approved=JSON.parse(held.journal),before=approved.reservation,id=held.participant.identity,committedReservation=approved.committedReservation,stoppedPlacement=approved.stoppedPlacement,now=committedReservation.updated_at,result=committedReservation.result_json;
  await source.verifyStopped(); await target.verifyRunning(); check(held);
  const commitPermit=Object.freeze({});commits.set(commitPermit,{participant:held.participant,check(){current(reservation);check(held);source.check();target.check();}});
  held.catalog.internal.transaction(changes=>{
    check(held); held.participant.apply(commitPermit);
    if(held.catalog.internal.prepare("UPDATE clank_deployment_placements SET assigned_node_id=?,generation=?,observed_release_id=NULL,observed_state='stopped',observed_generation=?,updated_at=? WHERE project_id=? AND assigned_node_id=? AND generation=?").run(id.targetNodeId,id.targetGeneration,id.targetGeneration,now,id.projectId,id.sourceNodeId,id.sourceGeneration).changes!==1
      ||held.catalog.internal.prepare("UPDATE clank_deployment_handoffs SET state='committed',version=?,result_json=?,updated_at=? WHERE handoff_id=? AND state='reserved' AND version=? AND input_sha256=?").run(committedReservation.version,result,now,held.source.operationId,before.version,before.input_sha256).changes!==1)throw new Error("Fallback placement compare-and-set failed.");
    held.catalog.internal.prepare("UPDATE clank_deployment_operations SET state='cancelled',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE project_id=? AND state IN ('queued','retry','leased')").run(now,id.projectId);
    if(image(held.catalog,"clank_deployment_placements","project_id",id.projectId)!==JSON.stringify(stoppedPlacement)||image(held.catalog,"clank_deployment_handoffs","handoff_id",held.source.operationId)!==JSON.stringify(committedReservation))throw new Error("Fallback commit readback differs.");
    changes.record("__platform",id.projectId);changes.record("__orchestration",id.projectId);
  });
  held.expected=JSON.stringify(committedReservation);held.committed=true;held.participant.accept();check(held);
}

async function runnerAPI(held: Reservation, nodeToken: string, action: string, body: unknown, signal: AbortSignal): Promise<Response> {
  check(held); const response=await held.participant.api(new Request("http://fallback.internal/api/runner/v1/"+action,{method:"POST",headers:{authorization:"Bearer "+nodeToken,"x-clank-node-id":held.participant.identity.targetNodeId,"content-type":"application/json"},body:JSON.stringify(body),signal}));
  if(!response.ok)throw new Error("Fallback original runner API refused "+action+" ("+response.status+")."); return response;
}

/** Product migration path for ordinary all-role providers; one deadline is never renewed. */
export async function transferDockerProviderFallback(runtime: PlatformRuntime, sourceService: DeploymentProviderService, targetService: DeploymentProviderService, sourceBytes: Uint8Array, input: {projectId:string;operationId:string;targetNodeId:string;targetNodeToken:string;maximumDowntimeMs?:number}) {
  platformProviderFallbackContext(runtime); // Reject structural runtimes before reading caller input.
  const milliseconds=input.maximumDowntimeMs??30000;
  if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>30000)throw new Error("Fallback downtime must be bounded by 30 seconds.");
  const deadline=nowMono()+BigInt(milliseconds)*1000000n, controller=new AbortController(), timer=setTimeout(()=>controller.abort(new Error("Original fallback deadline expired.")),milliseconds);
  let reservation:ProviderFallbackReservation|undefined,target:object|undefined;
  try {
    const source=await prepareDockerProviderFallbackSource(sourceService,input.projectId,sourceBytes,input.operationId,deadline);
    reservation=await reserveProviderFallback(runtime,source,sourceBytes,input.targetNodeId,deadline,targetService);
    const held=current(reservation), native=providerFallbackSourceContext(source); await persistPhase(reservation,"stopping");await native.stop(reservation); check(held);
    held.capsule=await held.participant.snapshot();check(held);await persistPhase(reservation,"stopped");
    target=await stageDockerProviderFallbackTarget(targetService,source,reservation);providerFallbackReservationContext(reservation).authorizeTarget(target);
    const active=providerFallbackTargetContext(target);await persistPhase(reservation,"launching");await active.activate(reservation);await active.verifyRunning();check(held);
    await prepareCommit(reservation);
    const id=held.participant.identity;
    const queued=await held.participant.orchestrator.enqueue({projectId:id.projectId,nodeId:id.targetNodeId,action:"reconcile",payload:{generation:id.targetGeneration,releaseId:id.releaseId,state:"running",runtimeProtocol:"clank-runtime/1"},idempotencyKey:"fallback_"+source.operationId});
    const claimed=await (await held.catalog.claimOperation(queued.operation.id,()=>runnerAPI(held,input.targetNodeToken,"claim",{limit:1},controller.signal))).json();
    const lease=claimed.operations.find((operation:ClaimedDeploymentOperation)=>operation.id===queued.operation.id);
    if(!lease||lease.nodeId!==id.targetNodeId||lease.projectId!==id.projectId||lease.fence<=held.originalFence)throw new Error("Fallback target did not acquire its fresh operation lease.");
    held.lease=lease;held.fence=lease.fence;check(held);
    const response=await runnerAPI(held,input.targetNodeToken,"runtime",{operation:lease},controller.signal), capsule=await decodeDeploymentRuntimeCapsule(new Uint8Array(await response.arrayBuffer()));
    if(capsule.sha256!==held.capsule!.sha256)throw new Error("Fallback API capsule differs from its approved final snapshot.");
    held.request=Object.freeze({operation:Object.freeze({id:lease.id,projectId:lease.projectId,fence:lease.fence,attempt:lease.attempts,maxAttempts:lease.maxAttempts}),desired:Object.freeze({...lease.payload}),runtime:capsule,artifact:capsule.artifact,signal:controller.signal});
    await verifyLease(held);await active.publish(reservation,held.request);await active.verifyRunning();await native.verifyStopped();await verifyLease(held);
    const observed=await (await runnerAPI(held,input.targetNodeToken,"observe",{projectId:id.projectId,generation:id.targetGeneration,releaseId:id.releaseId,state:"running"},controller.signal)).json();
    if(observed.accepted!==true)throw new Error("Fallback running observation was refused.");
    await verifyLease(held);const completed=await (await runnerAPI(held,input.targetNodeToken,"complete",{operation:lease,result:{protocol:"clank-provider-fallback/1",operationId:source.operationId}},controller.signal)).json();
    if(completed.accepted!==true)throw new Error("Fallback API operation completion was refused.");
    const completedOperation=image(held.catalog,"clank_deployment_operations","id",lease.id), completedRow=JSON.parse(completedOperation);
    if(completedRow.state!=="succeeded" || completedRow.node_id!==id.targetNodeId || Number(completedRow.fence)!==held.fence || completedRow.project_id!==id.projectId
      || completedRow.action!=="reconcile" || completedRow.payload!==JSON.stringify(lease.payload) || completedRow.idempotency_key!=="fallback_"+source.operationId
      || completedRow.lease_token_hash!==null || completedRow.lease_expires_at!==null || completedRow.result!==JSON.stringify({protocol:"clank-provider-fallback/1",operationId:source.operationId})) throw new Error("Fallback completed operation differs from its original API acknowledgement.");
    await active.verifyRunning();await native.verifyStopped();check(held);
    held.completedOperation=completedOperation;held.completed=true;
    providerFallbackReservationContext(reservation).authorizeCompletion(target,held.request);
    await active.finalize(reservation,held.request);providerFallbackReservationContext(reservation).authorizeCompletion(target,held.request);held.published=true;
    const completion=Object.freeze({});completions.set(completion,{participant:held.participant,check(){providerFallbackReservationContext(reservation!).authorizeCompletion(target!,held.request!);}});held.participant.complete(completion);
    return Object.freeze({protocol:"clank-provider-fallback-complete/1",operationId:source.operationId,projectId:source.projectId,generation:id.targetGeneration,targetNodeId:id.targetNodeId,roles:active.native.evidence.roles.length});
  } catch(error) {
    if(target)try{await closeProviderFallbackTarget(target);}catch(cleanup){throw new AggregateError([error,cleanup],"Fallback failed and target cleanup remains unresolved.");}
    if(reservation){const held=reservations.get(reservation)!;held.failed=true;}
    throw error;
  } finally {clearTimeout(timer);}
}

/** Unknown commit recovery only settles STOPPED after all-role native absence. */
export async function recoverProviderFallback(runtime: object, journal: string, authentication: string, sourceOwner: object, targetOwner: object, client: object, services?: {sourceService:DeploymentProviderService;targetService:DeploymentProviderService}): Promise<void> {
  const platform=platformProviderFallbackContext(runtime), authority=platform.recovery(journal,authentication), input=JSON.parse(journal), catalog=providerFallbackOrchestrationContext(authority.orchestrator);
  const early=input.phase==="stopping"||input.phase==="stopped", reserved=input.phase==="reserved";
  const cancelledImage=JSON.stringify(input.cancelledReservation), committedImage=JSON.stringify(input.committedReservation);
  const selectedStopped=early?input.sourceStoppedPlacement:input.stoppedPlacement;
  const checkRecovery=()=>{
    authority.check();catalog.check();
    const actual=image(catalog,"clank_deployment_handoffs","handoff_id",input.identity.operationId),placement=image(catalog,"clank_deployment_placements","project_id",input.identity.projectId);
    const stored=catalog.internal.prepare("SELECT journal,authentication FROM clank_deployment_fallback_journals WHERE operation_id=?").get(input.identity.operationId);
    const original=actual===JSON.stringify(input.reservation), cancelled=(reserved||early)&&actual===cancelledImage, committed=!reserved&&!early&&actual===committedImage, actualPlacement=JSON.parse(placement??"null");
    if(stored?.journal!==journal||stored.authentication!==authentication||!original&&!cancelled&&!committed
      ||original&&placement!==JSON.stringify(input.placement)
      ||cancelled&&placement!==JSON.stringify(early?input.sourceStoppedPlacement:input.placement)
      ||committed&&(!actualPlacement||!["running","stopped"].includes(actualPlacement.observed_state)||actualPlacement.observed_release_id!==(actualPlacement.observed_state==="running"?input.identity.releaseId:null)
        ||JSON.stringify({...actualPlacement,observed_release_id:null,observed_state:"stopped",updated_at:input.stoppedPlacement.updated_at})!==JSON.stringify(input.stoppedPlacement)))throw new Error("Fallback recovery journal or reservation changed.");
    const fence=Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(input.identity.projectId)?.fence);
    const operations=catalog.internal.prepare("SELECT * FROM clank_deployment_operations WHERE project_id=? AND (fence>? OR state IN ('queued','retry','leased'))").all(input.identity.projectId,input.fence);
    const desired=JSON.stringify({generation:input.identity.targetGeneration,releaseId:input.identity.releaseId,state:"running",runtimeProtocol:"clank-runtime/1"});
    if(fence!==input.fence&&fence!==input.fence+1||!committed&&fence!==input.fence||operations.some(operation=>operation.idempotency_key!=="fallback_"+input.identity.operationId||operation.node_id!==input.identity.targetNodeId||operation.action!=="reconcile"||operation.payload!==desired||Number(operation.fence)>input.fence+1)
      ||fence===input.fence+1&&operations.filter(operation=>Number(operation.fence)===fence).length!==1)throw new Error("Fallback recovery lifecycle fence or publication operation changed.");
    if(original&&!reserved&&!early){
      // STOPPED settlement preserves an existing reservation; it does not admit a writer.
      const used=catalog.internal.prepare("SELECT (SELECT coalesce(sum(capacity_units),0) FROM clank_deployment_placements WHERE assigned_node_id=? AND project_id!=?)+(SELECT coalesce(sum(capacity_units),0) FROM clank_deployment_handoffs WHERE target_node_id=? AND state='reserved' AND project_id!=?) used").get(input.identity.targetNodeId,input.identity.projectId,input.identity.targetNodeId,input.identity.projectId);
      if(Number(used?.used??0)+Number(input.placement.capacity_units)>Number(JSON.parse(input.reservation.target_node_json).capacity))throw new Error("Fallback STOPPED recovery reserved capacity changed.");
    }
    for(const [id,expected] of [[input.identity.sourceNodeId,input.reservation.source_node_json],[input.identity.targetNodeId,input.reservation.target_node_json]])if(JSON.stringify(catalog.internal.prepare("SELECT id,region,endpoint,capacity,labels,token_hash FROM clank_deployment_nodes WHERE id=?").get(id))!==expected)throw new Error("Fallback recovery node identity changed.");
  };
  const token=Object.freeze({});recoveries.set(token,{journal,authentication,input,check:checkRecovery});checkRecovery();
  const native=await import("./provider-fallback-recovery.ts");
  if(reserved){
    const proof=await native.verifyProviderFallbackReservationCancellation(token,sourceOwner,client);
    try{
      const physical=native.providerFallbackNativeCancellationContext(proof);await physical.verifyRunning();physical.check();checkRecovery();
      const after=input.cancelledReservation;
      catalog.internal.transaction(changes=>{
        physical.check();checkRecovery();
        if(image(catalog,"clank_deployment_handoffs","handoff_id",input.identity.operationId)!==cancelledImage){
          if(catalog.internal.prepare("UPDATE clank_deployment_handoffs SET state='cancelled',version=?,updated_at=? WHERE handoff_id=? AND state='reserved' AND version=? AND input_sha256=?").run(after.version,after.updated_at,input.identity.operationId,input.reservation.version,input.reservation.input_sha256).changes!==1)throw new Error("Fallback untouched-source cancellation failed.");
        }
        if(image(catalog,"clank_deployment_handoffs","handoff_id",input.identity.operationId)!==cancelledImage)throw new Error("Fallback untouched-source cancellation readback differs.");changes.record("__orchestration",input.identity.projectId);
      });
      physical.check();checkRecovery();await physical.verifyRunning();
      if(services){
        const module=await import("./provider-service.ts"),service=services.sourceService,context=module.providerFallbackServiceContext(service);
        const current=()=>{physical.check();checkRecovery();context.check();if(context.owner!==sourceOwner||image(catalog,"clank_deployment_handoffs","handoff_id",input.identity.operationId)!==cancelledImage)throw new Error("Cancelled fallback source retirement differs from its exact original service.");};
        current();const permit=Object.freeze({});cancelledSources.set(permit,{service,owner:sourceOwner,input,journal,authentication,check:current,async verifyRunning(){current();await physical.verifyRunning();current();}});
        await module.retireDockerProviderFallbackCancellation(service,permit);current();await physical.verifyRunning();current();
        const completion=Object.freeze({});completions.set(completion,{participant:authority,check:current,source:{kind:"reserved",evidence:input.source}});
        // A signed successor CAS is terminal: the predecessor authority is revoked by it.
        authority.complete(completion);
      }
      return;
    }finally{native.closeProviderFallbackNativeCancellation(proof);}
  }
  const proof=await native.verifyProviderFallbackRecovery(token,sourceOwner,targetOwner,client);
  try{
    const physical=native.providerFallbackNativeRecoveryContext(proof);await physical.verifyStopped();physical.check();checkRecovery();
    const settlement=Object.freeze({});settlements.set(settlement,{authority,check(){physical.check();checkRecovery();}});
    catalog.internal.transaction(changes=>{
      physical.check();checkRecovery();
      const id=input.identity;
      if(early){
        const cancelled=input.cancelledReservation;
        if(image(catalog,"clank_deployment_handoffs","handoff_id",id.operationId)===JSON.stringify(input.reservation)){
          if(catalog.internal.prepare("UPDATE clank_deployment_handoffs SET state='cancelled',version=?,updated_at=? WHERE handoff_id=? AND state='reserved' AND version=? AND input_sha256=?").run(cancelled.version,cancelled.updated_at,id.operationId,input.reservation.version,input.reservation.input_sha256).changes!==1)throw new Error("Fallback source STOPPED cancellation failed.");
        }
      }else{
        authority.apply(settlement);const committed=input.committedReservation;
        if(image(catalog,"clank_deployment_handoffs","handoff_id",id.operationId)===JSON.stringify(input.reservation)){
          if(catalog.internal.prepare("UPDATE clank_deployment_handoffs SET state='committed',version=?,result_json=?,updated_at=? WHERE handoff_id=? AND state='reserved' AND version=? AND input_sha256=?").run(committed.version,committed.result_json,committed.updated_at,id.operationId,input.reservation.version,input.reservation.input_sha256).changes!==1)throw new Error("Fallback target STOPPED commitment failed.");
        }
      }
      catalog.internal.prepare("UPDATE clank_deployment_placements SET assigned_node_id=?,generation=?,observed_release_id=NULL,observed_state='stopped',observed_generation=?,updated_at=? WHERE project_id=?").run(selectedStopped.assigned_node_id,selectedStopped.generation,selectedStopped.observed_generation,selectedStopped.updated_at,id.projectId);
      catalog.internal.prepare("UPDATE clank_deployment_operations SET state='cancelled',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE project_id=? AND state IN ('queued','retry','leased')").run(Date.now(),id.projectId);
      if(image(catalog,"clank_deployment_handoffs","handoff_id",id.operationId)!==(early?cancelledImage:committedImage)||image(catalog,"clank_deployment_placements","project_id",id.projectId)!==JSON.stringify(selectedStopped))throw new Error("Fallback STOPPED recovery readback differs.");
      changes.record("__platform",id.projectId);changes.record("__orchestration",id.projectId);
    });
    physical.check();checkRecovery();await physical.verifyStopped();
    const finalize=Object.freeze({});recoveryFinalizations.set(finalize,{proof,journal,authentication,selected:early?"source":"target",check(){physical.check();checkRecovery();if(image(catalog,"clank_deployment_handoffs","handoff_id",input.identity.operationId)!==(early?cancelledImage:committedImage)||image(catalog,"clank_deployment_placements","project_id",input.identity.projectId)!==JSON.stringify(selectedStopped))throw new Error("Fallback recovery finalization requires its exact committed STOPPED rows.");}});
    await physical.finalize(finalize);physical.check();checkRecovery();await physical.verifyStopped();
    if(services){
      const module=await import("./provider-service.ts"),selected=early?"source":"target",service=early?services.sourceService:services.targetService,owner=early?sourceOwner:targetOwner;
      const serviceContext=module.providerFallbackServiceContext(service);
      const retiredCurrent=()=>{physical.check();checkRecovery();serviceContext.check();if(serviceContext.owner!==owner||image(catalog,"clank_deployment_handoffs","handoff_id",input.identity.operationId)!==(early?cancelledImage:committedImage)||image(catalog,"clank_deployment_placements","project_id",input.identity.projectId)!==JSON.stringify(selectedStopped))throw new Error("Fallback retirement requires its exact original service and settled STOPPED rows.");};
      const prior=retiredResumes.get(service)?.get(input.identity.operationId);
      if(prior&&prior.runtime===runtime&&prior.journal===journal&&prior.authentication===authentication&&prior.placement===JSON.stringify(selectedStopped)&&prior.handoff===(early?cancelledImage:committedImage)){retiredCurrent();await physical.verifyStopped();return;}
      retiredCurrent();const permit=Object.freeze({});retirements.set(permit,{journal,authentication,input,selected,service,check:retiredCurrent,async verifyStopped(){retiredCurrent();await physical.verifyStopped();retiredCurrent();}});
      await module.retireDockerProviderFallbackRecovery(service,permit);retiredCurrent();await physical.verifyStopped();
      const ready=retiredResumes.get(service)??new Map<string,RetiredResume>();ready.set(input.identity.operationId,{runtime,journal,authentication,input,selected,service,owner,placement:JSON.stringify(selectedStopped),handoff:early?cancelledImage:committedImage,authority});retiredResumes.set(service,ready);
    }
  }finally{native.closeProviderFallbackNativeRecovery(proof);}
}

export function providerFallbackResumeReady(runtime:object,service:object,operationId:string):boolean {
  platformProviderFallbackContext(runtime);const held=retiredResumes.get(service)?.get(operationId);return !!held&&held.runtime===runtime;
}

/** Rehydrate only a genuine, natively cleaned, authenticated STOPPED attempt. */
export async function rehydrateColdProviderFallback(runtime:object,selectionToken:object,counterpartToken:object,sourceService:DeploymentProviderService,targetService:DeploymentProviderService):Promise<void>{
  const selection=platformColdFallbackResumeSelection(selectionToken),counterpart=platformColdFallbackNoSweepSelection(counterpartToken);
  if(selection.runtime!==runtime||consumedColdSelections.has(selectionToken)||sourceService===targetService)throw new Error("Cold fallback resume selection is foreign or already consumed.");
  selection.check();
  const input=JSON.parse(selection.predecessorJournal),record=JSON.parse(selection.resumeJournal),selected: "source"|"target"=["stopping","stopped"].includes(input.phase)?"source":"target";
  if(record.phase!=="stopped"||record.selected!==selected||counterpart.side===selected||counterpart.projectId!==selection.projectId||counterpart.operationId!==selection.operationId||counterpart.resumeId!==selection.resumeId||counterpart.revision!==selection.revision)throw new Error("Cold fallback selected and counterpart admissions differ.");
  const module=await import("./provider-service.ts");selection.check();
  const source=module.providerColdFallbackServiceContext(sourceService,selected==="source"?selectionToken:counterpartToken),target=module.providerColdFallbackServiceContext(targetService,selected==="target"?selectionToken:counterpartToken);
  const service=selected==="source"?sourceService:targetService,native=selected==="source"?source:target;
  if(!native.selected||(selected==="source"?target:source).selected||source.owner===target.owner)throw new Error("Cold fallback requires its exact selected and counterpart native services.");
  const authority=platformProviderFallbackContext(runtime).recovery(selection.predecessorJournal,selection.predecessorAuthentication),catalog=providerFallbackOrchestrationContext(authority.orchestrator),handoff=JSON.stringify(selected==="source"?input.cancelledReservation:input.committedReservation);
  const check=()=>{
    selection.check();authority.cleanupCheck();catalog.check();source.check();target.check();
    if(consumedColdSelections.has(selectionToken)||retiredResumes.get(service)?.has(selection.operationId)
      ||image(catalog,"clank_deployment_handoffs","handoff_id",selection.operationId)!==handoff
      ||image(catalog,"clank_deployment_placements","project_id",selection.projectId)!==record.settlement.placement
      ||Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(selection.projectId)?.fence)!==record.fence)
      throw new Error("Cold fallback exact STOPPED authority changed before consumption.");
    for(const [side,context,nodeId] of [["source",source,input.identity.sourceNodeId],["target",target,input.identity.targetNodeId]] as const){
      const endpoint=input.endpointBindings[side];if(context.ownerLabel!==endpoint.owner||context.owner.root!==endpoint.root||context.owner.serviceDirectory!==endpoint.serviceDirectory||JSON.stringify(catalog.internal.prepare("SELECT id,region,endpoint,capacity,labels,token_hash FROM clank_deployment_nodes WHERE id=?").get(nodeId))!==input.reservation[side+"_node_json"])throw new Error("Cold fallback native service or original node identity changed.");
    }
  };
  check();await native.verifyStopped();check();
  // The selected launcher proved its latest attempt; the original predecessor
  // source and target rosters/paths must independently remain natively absent.
  const permit=Object.freeze({});recoveries.set(permit,{journal:selection.predecessorJournal,authentication:selection.predecessorAuthentication,input,check});
  const recovery=await import("./provider-fallback-recovery.ts"),proof=await recovery.verifyProviderFallbackRecovery(permit,source.owner,target.owner,source.client);
  try{
    const physical=recovery.providerFallbackNativeRecoveryContext(proof);await physical.verifyStopped();check();
    await native.restoreStopped();check();await physical.verifyStopped();check();
    const admitCold=()=>{selection.check();authority.cleanupCheck();source.check();target.check();};
    const ready=retiredResumes.get(service)??new Map<string,RetiredResume>();
    ready.set(selection.operationId,{runtime,journal:selection.predecessorJournal,authentication:selection.predecessorAuthentication,input,selected,service,owner:native.owner,placement:record.settlement.placement,handoff,fence:record.fence,attempt:record.attempt,authority,admitCold});
    retiredResumes.set(service,ready);consumedColdSelections.add(selectionToken);
  }finally{recovery.closeProviderFallbackNativeRecovery(proof);}
}

/** A later ordinary writer attempt requires the exact same-process finalized recovery. */
export async function resumeDockerProviderFallback(runtime:object,service:DeploymentProviderService,operationId:string,nodeToken:string){
  platformProviderFallbackContext(runtime);
  const ready=retiredResumes.get(service)?.get(operationId);if(!ready||ready.runtime!==runtime||ready.busy)throw new Error("A genuine idle original finalized same-process fallback recovery is required for resume.");
  // The old STOPPED selector is consumed before a new planned head intentionally
  // supersedes it; subsequent lifecycle checks use the new signed attempt.
  ready.admitCold?.();ready.admitCold=undefined;
  const {input,authority}=ready,id=input.identity,catalog=providerFallbackOrchestrationContext(authority.orchestrator),deadline=nowMono()+30000000000n,controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error("Ordinary fallback resume deadline expired.")),30000);
  const selectedSource=ready.selected==="source",nodeId=selectedSource?id.sourceNodeId:id.targetNodeId,generation=selectedSource?id.sourceGeneration:id.targetGeneration;
  if(selectedSource&&!["stopping","stopped"].includes(input.phase))throw new Error("Source resume requires its authenticated stopped predecessor.");
  ready.busy=true;
  const initialPlacement=ready.placement,initialFence=ready.fence??Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(id.projectId)?.fence),attempt=Number(catalog.internal.prepare("SELECT MAX(attempt) AS attempt FROM clank_platform_fallback_resume_heads WHERE predecessor_id=?").get(operationId)?.attempt??0)+1,key="fallback_resume_"+operationId+"_"+attempt;
  ready.attempt=attempt;
  const desired=Object.freeze({releaseId:String(id.releaseId),generation:Number(generation),state:"running" as const,runtimeProtocol:"clank-runtime/1" as const}),completionResult={protocol:"clank-provider-fallback-resume/1",operationId,attempt,...(selectedSource?{selected:"source"}: {})};
  let lease:ClaimedDeploymentOperation|undefined,leasedImage:string|undefined,request:DeploymentProviderRequest|undefined,permit:object|undefined,queuedId:string|undefined,completed=false,published=false,observeIssued=false,completeIssued=false;
  let sourceEvidence:object|undefined,record:ProviderFallbackResumeRecord|undefined,terminalPermit:object|undefined,intentCapability:object|undefined,runningCapability:object|undefined;
  let intentEvidence:object|undefined,runningEvidence:object|undefined,settlementImages:object|undefined;
  const recordCheck=()=>{if(record){const head=catalog.internal.prepare("SELECT revision,phase,authentication FROM clank_platform_fallback_resume_heads WHERE resume_id=?").get(key),retained=catalog.internal.prepare("SELECT journal,authentication FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=?").get(key,record.revision);if(head?.revision!==record.revision||head.phase!==record.phase||head.authentication!==record.authentication||retained?.journal!==record.journal||retained.authentication!==record.authentication)throw new Error("Fallback resume durable attempt changed.");}};
  const terminalCheck=(cleanup=false)=>{if(!published||!terminalPermit||record?.phase!=="published")throw new Error("Fallback resume has no exact terminal authority.");authority.checkResumeTerminal(terminalPermit,cleanup);recordCheck();if(!cleanup&&(controller.signal.aborted||nowMono()>=deadline))throw new Error("Fallback resume release deadline expired.");};
  const baseCheck=()=>{
    authority.cleanupCheck();catalog.check();
    const stored=catalog.internal.prepare("SELECT journal,authentication FROM clank_deployment_fallback_journals WHERE operation_id=?").get(operationId);
    if(stored?.journal!==ready.journal||stored.authentication!==ready.authentication||image(catalog,"clank_deployment_handoffs","handoff_id",operationId)!==ready.handoff)throw new Error("Fallback resume original journal or reservation changed.");
    for(const [node,expected] of [[id.sourceNodeId,input.reservation.source_node_json],[id.targetNodeId,input.reservation.target_node_json]])if(JSON.stringify(catalog.internal.prepare("SELECT id,region,endpoint,capacity,labels,token_hash FROM clank_deployment_nodes WHERE id=?").get(node))!==expected)throw new Error("Fallback resume original node identity changed.");
  };
  const cleanupCheck=()=>{
    if(published){terminalCheck(true);return;}
    baseCheck();recordCheck();const placement=image(catalog,"clank_deployment_placements","project_id",id.projectId),row=JSON.parse(placement),before=JSON.parse(initialPlacement);
    if(placement!==initialPlacement&&(!observeIssued||row.observed_state!=="running"||row.observed_release_id!==id.releaseId||JSON.stringify({...row,observed_state:before.observed_state,observed_release_id:before.observed_release_id,updated_at:before.updated_at})!==initialPlacement))throw new Error("Fallback resume placement changed outside its exact observation.");
    const fence=Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(id.projectId)?.fence);
    if(fence!==(lease?.fence??initialFence))throw new Error("Fallback resume lifecycle fence changed.");
    const other=catalog.internal.prepare("SELECT id FROM clank_deployment_operations WHERE project_id=? AND state IN ('queued','retry','leased') AND id!=?").get(id.projectId,queuedId??"");if(other)throw new Error("Fallback resume found a different pending operation.");
    if(lease){
      const actual=image(catalog,"clank_deployment_operations","id",lease.id),row=JSON.parse(actual),before=JSON.parse(leasedImage!);
      if(actual!==leasedImage&&(!completeIssued||JSON.stringify({...before,state:"succeeded",error:null,lease_token_hash:null,lease_expires_at:null,result:JSON.stringify(completionResult),updated_at:row.updated_at})!==actual))throw new Error("Fallback resume original operation changed.");
    }
  };
  const check=()=>{if(published){terminalCheck();return;}authority.check();cleanupCheck();if(controller.signal.aborted||nowMono()>=deadline)throw new Error("Fallback resume writer deadline expired.");if(lease&&!completed&&(image(catalog,"clank_deployment_operations","id",lease.id)!==leasedImage||Number(JSON.parse(leasedImage!).lease_expires_at)<=Date.now()))throw new Error("Fallback resume original runner lease expired or changed.");};
  const journalCapability=(phase:ProviderFallbackResumePhase,valid:()=>void)=>{
    valid();const token=Object.freeze({}),data=Object.freeze({resumeId:key,predecessorId:operationId,predecessorJournalSha256:hash(ready.journal),predecessorAuthentication:ready.authentication,projectId:id.projectId,selected:ready.selected,attempt,phase,deadline:String(deadline),initialPlacement,initialFence,nodeId,generation,desired,operation:queuedId?image(catalog,"clank_deployment_operations","id",queuedId):null,placement:image(catalog,"clank_deployment_placements","project_id",id.projectId),fence:Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(id.projectId)?.fence),capsuleSha256:selectedSource?input.source.capsuleSha256:input.capsuleSha256,...(intentEvidence?{intent:intentEvidence}:{}),...(runningEvidence?{running:runningEvidence}:{}),...(settlementImages?{settlement:settlementImages}:{})});
    resumeJournals.set(token,{authority,data,previous:record,check:valid});return token;
  };
  const retain=(phase:ProviderFallbackResumePhase,valid=check)=>{record=authority.recordResume(journalCapability(phase,valid));recordCheck();};
  const nativeContext=async(native:object)=>{const module=await import("./provider-docker.ts"),held=module.providerFallbackResumeNativeContext(native);if(held.permit!==permit||held.request!==request)throw new Error("Resume native signing capability differs from its original request.");return held;};
  const api=async(action:string,body:unknown)=>{check();const response=await authority.api(new Request("http://fallback.internal/api/runner/v1/"+action,{method:"POST",headers:{authorization:"Bearer "+nodeToken,"x-clank-node-id":nodeId,"content-type":"application/json"},body:JSON.stringify(body),signal:controller.signal}));if(!response.ok)throw new Error("Fallback resume runner API refused "+action+" ("+response.status+").");return response;};
  try{
    check();retain("planned");const queued=await authority.orchestrator.enqueue({projectId:id.projectId,nodeId,action:"reconcile",payload:desired,idempotencyKey:key});queuedId=queued.operation.id;
    if(queued.existing)throw new Error("Fallback resume attempt already exists.");
    let claimed:Response;
    if(selectedSource){
      const permit=Object.freeze({}),operationImage=image(catalog,"clank_deployment_operations","id",queuedId);check();
      sourceClaims.set(permit,{orchestrator:authority.orchestrator,operationId:queuedId,nodeId,projectId:id.projectId,fence:initialFence,operationImage,nodeImage:input.reservation.source_node_json,check(){check();if(image(catalog,"clank_deployment_operations","id",queuedId!)!==operationImage||Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(id.projectId)?.fence)!==initialFence)throw new Error("Fallback stopped-source claim changed before admission.");}});
      claimed=await catalog.claimSourceOperation(permit,()=>api("claim",{limit:1}));
    }else claimed=await catalog.claimOperation(queuedId,()=>api("claim",{limit:1}));
    const response=await claimed.json();lease=response.operations.find((value:ClaimedDeploymentOperation)=>value.id===queuedId);
    if(!lease||lease.nodeId!==nodeId||lease.projectId!==id.projectId||lease.fence!==initialFence+1||JSON.stringify(lease.payload)!==JSON.stringify(desired)||!await authority.orchestrator.authenticateOperation(lease))throw new Error("Fallback resume did not acquire its original runner lease.");leasedImage=image(catalog,"clank_deployment_operations","id",lease.id);check();
    const wire=await api("runtime",{operation:lease}),capsule=await decodeDeploymentRuntimeCapsule(new Uint8Array(await wire.arrayBuffer()));
    if(capsule.sha256!==(selectedSource?input.source.capsuleSha256:input.capsuleSha256)||capsule.manifest.generation!==generation)throw new Error("Fallback resumed runtime differs from its authenticated final snapshot.");
    request=Object.freeze({operation:Object.freeze({id:lease.id,projectId:lease.projectId,fence:lease.fence,attempt:lease.attempts,maxAttempts:lease.maxAttempts}),desired,runtime:capsule,artifact:capsule.artifact,signal:controller.signal});check();
    const module=await import("./provider-service.ts");permit=Object.freeze({});
    retain("claimed");
    resumeObservations.set(permit,{recoveryOperationId:operationId,selected:ready.selected,service,owner:ready.owner,request,deadline,check,
      authorizeCompletion(){check();if(!completed||record?.phase!=="running"||!runningCapability)throw new Error("Fallback resume requires its genuine API completion and signed running evidence.");},
      async persistIntent(native){check();if(record?.phase!=="claimed"||intentCapability)throw new Error("Fallback resume launch intent was already supplied.");const held=await nativeContext(native);if(!held.verifyCreated||held.verifyRunning)throw new Error("Fallback resume requires its genuine never-started native intent.");await held.verifyCreated();check();held.check();intentCapability=native;intentEvidence=JSON.parse(JSON.stringify(held.evidence));retain("staged");},
      authorizeLaunch(native){check();if(native!==intentCapability||record?.phase!=="staged"||!intentEvidence)throw new Error("Fallback resume launch lacks its exact durable native intent.");},
      async persistRunning(native){check();if(record?.phase!=="staged"||runningCapability||!intentCapability)throw new Error("Fallback resume running evidence is out of order.");const held=await nativeContext(native);if(!held.verifyRunning||held.verifyCreated)throw new Error("Fallback resume requires its genuine live native evidence.");await held.verifyRunning();check();held.check();const evidence=JSON.parse(JSON.stringify(held.evidence));
        const intent=intentEvidence as Record<string,any>,running=evidence as Record<string,any>,roster=(roles:any[])=>JSON.stringify(roles.map(role=>[role.role,role.instance,role.containerId,role.configurationSha256]).sort());
        for(const field of ["owner","projectId","releaseId","generation","capsuleSha256","daemonId","imageId","policySha256"])if(running[field]!==intent[field])throw new Error("Fallback resume running identity differs from its signed intent.");if(roster(running.roles)!==roster(intent.roles)||JSON.stringify(running.paths)!==JSON.stringify(intent.paths))throw new Error("Fallback resume running roles or paths differ from its signed intent.");
        runningCapability=native;runningEvidence=evidence;retain("running");},
      publish(){check();if(!completed||published||record?.phase!=="running"||!runningEvidence)throw new Error("Fallback resume progress cannot be published.");terminalPermit=journalCapability("published",check);const completion=Object.freeze({});completions.set(completion,{participant:authority,check,resumeJournal:terminalPermit,...(selectedSource?{source:{kind:"resumed" as const,evidence:sourceEvidence!,request:request!}}:{})});if(selectedSource&&!sourceEvidence)throw new Error("Source resume lacks its original native completion evidence.");authority.complete(completion);record=authority.resumeTerminal(terminalPermit);published=true;},
      authorizeRelease(){terminalCheck();}
    });
    resumeCleanups.set(permit,{recoveryOperationId:operationId,selected:ready.selected,service,owner:ready.owner,request,check:cleanupCheck});
    await module.beginDockerProviderFallbackResume(service,permit);check();await service.reconcile(request);check();await module.verifyDockerProviderFallbackResumed(service,permit);check();
    observeIssued=true;const observed=await(await api("observe",{projectId:id.projectId,generation,releaseId:id.releaseId,state:"running"})).json();if(observed.accepted!==true)throw new Error("Fallback resume running observation was refused.");check();
    await module.verifyDockerProviderFallbackResumed(service,permit);completeIssued=true;const done=await(await api("complete",{operation:lease,result:completionResult})).json();if(done.accepted!==true)throw new Error("Fallback resume operation completion was refused.");
    completed=true;check();if(JSON.parse(image(catalog,"clank_deployment_operations","id",lease.id)).state!=="succeeded")throw new Error("Fallback resume completion was not retained.");sourceEvidence=await module.verifyDockerProviderFallbackResumed(service,permit);
    await module.completeDockerProviderFallbackResume(service,permit);if(!published)throw new Error("Fallback resume did not publish its completed plan progress.");retiredResumes.get(service)!.delete(operationId);
    return Object.freeze({nodeId,generation,operationId:lease.id,fence:lease.fence,...(selectedSource?{sourceRestored:true}: {})});
  }catch(error){
    controller.abort(error);
    try{
      if(permit){
        cleanupCheck();const module=await import("./provider-service.ts");await module.cleanupDockerProviderFallbackResume(service,permit);cleanupCheck();
      }else{
        // No original service admission was issued. Resolve only this exact enqueue/claim, including a lost response.
        baseCheck();if(image(catalog,"clank_deployment_placements","project_id",id.projectId)!==initialPlacement)throw new Error("Unadmitted resume placement changed.");
        const row=catalog.internal.prepare("SELECT * FROM clank_deployment_operations WHERE project_id=? AND idempotency_key=?").get(id.projectId,key),fence=Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(id.projectId)?.fence);
        if(row){if(row.node_id!==nodeId||row.action!=="reconcile"||row.payload!==JSON.stringify(desired)||!["queued","leased"].includes(String(row.state))||Number(row.attempts)>1||fence!==(row.state==="leased"?initialFence+1:initialFence)||row.state==="leased"&&Number(row.fence)!==fence)throw new Error("Unadmitted resume operation changed.");queuedId=String(row.id);}
        else if(fence!==initialFence)throw new Error("Unadmitted resume fence changed.");
        if(catalog.internal.prepare("SELECT id FROM clank_deployment_operations WHERE project_id=? AND state IN ('queued','retry','leased') AND id!=?").get(id.projectId,queuedId??""))throw new Error("Unadmitted resume found different pending work.");
      }
      const beforePlacement=image(catalog,"clank_deployment_placements","project_id",id.projectId),beforeOperation=queuedId?image(catalog,"clank_deployment_operations","id",queuedId):undefined,stamp=Date.now(),stopped=JSON.stringify({...JSON.parse(beforePlacement),observed_state:"stopped",observed_release_id:null,updated_at:stamp});
      const op=beforeOperation?JSON.parse(beforeOperation):undefined,afterOperation=op&&op.state!=="succeeded"?JSON.stringify({...op,state:"cancelled",lease_token_hash:null,lease_expires_at:null,updated_at:stamp}):beforeOperation;
      settlementImages={placement:stopped,operation:afterOperation??null};
      const settlementCheck=()=>{if(published)terminalCheck(true);else baseCheck();if(image(catalog,"clank_deployment_placements","project_id",id.projectId)!==beforePlacement||queuedId&&image(catalog,"clank_deployment_operations","id",queuedId)!==beforeOperation)throw new Error("Fallback resume absence settlement changed.");};
      const stoppedJournal=record?journalCapability("stopped",settlementCheck):undefined,settlement=Object.freeze({});settlements.set(settlement,{authority,resumeJournal:stoppedJournal,check:settlementCheck});let stoppedRecord:ProviderFallbackResumeRecord|undefined;
      const readback=()=>{if(image(catalog,"clank_deployment_placements","project_id",id.projectId)!==stopped||queuedId&&image(catalog,"clank_deployment_operations","id",queuedId)!==afterOperation)return false;if(!stoppedRecord)return !record;const head=catalog.internal.prepare("SELECT revision,phase,authentication FROM clank_platform_fallback_resume_heads WHERE resume_id=?").get(key),retained=catalog.internal.prepare("SELECT journal,authentication FROM clank_platform_fallback_resume_records WHERE resume_id=? AND revision=?").get(key,stoppedRecord.revision);return head?.revision===stoppedRecord.revision&&head.phase==="stopped"&&head.authentication===stoppedRecord.authentication&&retained?.journal===stoppedRecord.journal&&retained.authentication===stoppedRecord.authentication;};
      try{catalog.internal.transaction(changes=>{
        assertProviderFallbackSettlement(settlement,authority);stoppedRecord=authority.apply(settlement);
        catalog.internal.prepare("UPDATE clank_deployment_placements SET observed_state='stopped',observed_release_id=NULL,updated_at=? WHERE project_id=?").run(stamp,id.projectId);
        if(op&&op.state!=="succeeded")catalog.internal.prepare("UPDATE clank_deployment_operations SET state='cancelled',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(stamp,queuedId!);
        if(!readback())throw new Error("Fallback resume absence settlement readback differs.");changes.record("__orchestration",id.projectId);changes.record("__platform",id.projectId);
      });}catch(commitError){if(!readback())throw commitError;}
      if(stoppedRecord)record=stoppedRecord;
      if(published){retiredResumes.get(service)!.delete(operationId);}else baseCheck();ready.placement=stopped;ready.fence=Number(catalog.internal.prepare("SELECT fence FROM clank_deployment_project_fences WHERE project_id=?").get(id.projectId)?.fence);
    }catch(cleanupError){throw new AggregateError([error,cleanupError],"Fallback ordinary resume failed and exact writer cleanup remains unresolved.");}
    throw error;
  }finally{ready.busy=false;clearTimeout(timer);}
}
