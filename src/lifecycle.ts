/** Transparent revision, release, promotion, portability, and capacity contracts. */

export type RevisionEventKind = "query" | "mutation" | "ui" | "migration" | "deploy" | "flag" | "policy" | "agent";
export interface RevisionPatch { readonly op: "set" | "delete"; readonly path: string; readonly value?: unknown; }
export interface RevisionEventInput { readonly id: string; readonly revision: number; readonly at: string; readonly kind: RevisionEventKind; readonly actor: string; readonly summary: string; readonly correlationId?: string; readonly parentId?: string; readonly patches?: readonly RevisionPatch[]; readonly metadata?: unknown; }
export interface RevisionEvent extends RevisionEventInput { readonly patches: readonly RevisionPatch[]; }
export interface RevisionLedger { readonly protocol: "clank-revision-ledger/1"; readonly initialState: unknown; readonly events: readonly RevisionEvent[]; }
export interface RevisionInspection { readonly protocol: "clank-revision-inspection/1"; readonly revision: number; readonly state: unknown; readonly event: RevisionEvent | null; readonly trace: readonly RevisionEvent[]; }

export interface ReleaseMaterial { readonly releaseId: string; readonly artifactSha256: string; readonly sourceRevision: string; readonly migrationIds: readonly string[]; readonly configurationSha256: string; readonly frameworkVersion: string; readonly builder: string; readonly builtAt: string; }
export interface ReleaseProvenance extends ReleaseMaterial { readonly protocol: "clank-provenance/1"; readonly digest: string; }

export interface PromotionStageInput { readonly name: string; readonly trafficPercent: number; readonly requiredChecks?: readonly string[]; readonly requiresApproval?: boolean; }
export interface PromotionPlan { readonly protocol: "clank-promotion/1"; readonly release: ReleaseProvenance; readonly stages: readonly { readonly name: string; readonly trafficPercent: number; readonly requiredChecks: readonly string[]; readonly requiresApproval: boolean; }[]; }
export interface PromotionEvidence { readonly stage: string; readonly checks: Readonly<Record<string, boolean>>; readonly approved?: boolean; }
export interface PromotionDecision { readonly ready: boolean; readonly stage: string | null; readonly blockers: readonly string[]; }
export interface RolloutMetrics { readonly samples: number; readonly errorRate: number; readonly p95Ms: number; readonly saturation?: number; }
export interface RolloutGuardrails { readonly minimumSamples?: number; readonly maximumErrorRate: number; readonly maximumP95Ms: number; readonly maximumSaturation?: number; }
export interface RolloutDecision { readonly action: "continue" | "pause" | "rollback"; readonly reasons: readonly string[]; }

export interface PortableProjectFileInput { readonly path: string; readonly bytes: Uint8Array; readonly mode?: 0o600 | 0o644 | 0o700 | 0o755; }
export interface PortableProjectFile { readonly path: string; readonly size: number; readonly sha256: string; readonly mode: 0o600 | 0o644 | 0o700 | 0o755; readonly content: string; }
export interface PortableProjectExport { readonly protocol: "clank-project-export/1"; readonly project: { readonly name: string; readonly frameworkVersion: string; readonly exportedAt: string; }; readonly files: readonly PortableProjectFile[]; readonly digest: string; }

export type CloneTransform = "keep" | "hash" | "redact" | "email" | "drop";
export interface ClonePolicy { readonly default: CloneTransform; readonly fields?: Readonly<Record<string, CloneTransform>>; }
export interface SanitizedClone<T extends Record<string, unknown>> { readonly protocol: "clank-sanitized-clone/1"; readonly rows: readonly T[]; readonly redactedFields: readonly string[]; }

export interface CapacityWorkload { readonly requestsPerMonth: number; readonly transferBytesPerMonth: number; readonly databaseBytes: number; readonly artifactBytes: number; readonly peakRealtimeConnections?: number; readonly jobCpuMsPerMonth?: number; readonly minimumReplicas?: number; }
export interface CapacityRateCard { readonly requestMillion: number; readonly transferGb: number; readonly storageGb: number; readonly processUnit: number; }
export interface CapacityEstimate { readonly protocol: "clank-capacity-estimate/1"; readonly processUnits: number; readonly storageBytes: number; readonly requestMillions: number; readonly transferGb: number; readonly monthlyCost: number; readonly assumptions: readonly string[]; }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._@+/-]{1,500}$/u;
const EVENT_KINDS = new Set<RevisionEventKind>(["query", "mutation", "ui", "migration", "deploy", "flag", "policy", "agent"]);
const TRANSFORMS = ["keep", "hash", "redact", "email", "drop"] as const;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

export function createRevisionLedger(initialState: unknown, eventsInput: readonly RevisionEventInput[]): RevisionLedger {
  const state = data(initialState, "initial revision state");
  if (!Array.isArray(eventsInput) || eventsInput.length > 100_000) throw new TypeError("Revision events must be an array of at most 100,000 entries.");
  const ids = new Set<string>();
  const events = eventsInput.map((input, index) => {
    if (!plain(input)) throw new TypeError(`Revision event ${index} must be an object.`);
    exact(input, ["id", "revision", "at", "kind", "actor", "summary", "correlationId", "parentId", "patches", "metadata"], `revision event ${index}`);
    const id = token(input.id, `revision event ${index} ID`);
    if (ids.has(id)) throw new TypeError(`Revision event ID is duplicated: ${id}.`);
    if (input.revision !== index + 1) throw new TypeError(`Revision event ${id} must have revision ${index + 1}.`);
    if (!EVENT_KINDS.has(input.kind)) throw new TypeError(`Revision event ${id} kind is invalid.`);
    const parentId = input.parentId === undefined ? undefined : token(input.parentId, `revision event ${id} parent`);
    if (parentId && !ids.has(parentId)) throw new TypeError(`Revision event ${id} parent must reference an earlier event.`);
    if (!Array.isArray(input.patches ?? []) || (input.patches?.length ?? 0) > 1_000) throw new TypeError(`Revision event ${id} may contain at most 1,000 patches.`);
    const patches = (input.patches ?? []).map((patch, patchIndex) => normalizePatch(patch, `${id} patch ${patchIndex}`));
    ids.add(id);
    return freeze({ id, revision: input.revision, at: iso(input.at, `revision event ${id} time`), kind: input.kind, actor: token(input.actor, `revision event ${id} actor`), summary: text(input.summary, `revision event ${id} summary`, 1_000), ...(input.correlationId ? { correlationId: token(input.correlationId, `revision event ${id} correlation`) } : {}), ...(parentId ? { parentId } : {}), patches: freeze(patches), ...(input.metadata === undefined ? {} : { metadata: data(input.metadata, `revision event ${id} metadata`) }) });
  });
  return freeze({ protocol: "clank-revision-ledger/1", initialState: state, events: freeze(events) });
}

/** Replays deterministic data patches and returns the causal/correlation trace. */
export function inspectRevision(ledgerInput: RevisionLedger, revision = ledgerInput.events.length): RevisionInspection {
  const ledger = createRevisionLedger(ledgerInput.initialState, ledgerInput.events);
  const target = integer(revision, "revision", 0, ledger.events.length);
  let state = data(ledger.initialState, "initial revision state");
  for (const event of ledger.events.slice(0, target)) state = applyPatches(state, event.patches);
  const event = target === 0 ? null : ledger.events[target - 1]!;
  const trace = event ? traceFor(ledger.events, event) : [];
  return freeze({ protocol: "clank-revision-inspection/1", revision: target, state, event, trace: freeze(trace) });
}

export async function createReleaseProvenance(input: ReleaseMaterial): Promise<ReleaseProvenance> {
  if (!plain(input)) throw new TypeError("Release material must be an object.");
  exact(input, ["releaseId", "artifactSha256", "sourceRevision", "migrationIds", "configurationSha256", "frameworkVersion", "builder", "builtAt"], "release material");
  const material = normalizeRelease(input);
  const digest = await sha256(canonical({ protocol: "clank-provenance/1", ...material }));
  return freeze({ protocol: "clank-provenance/1", ...material, digest });
}

export async function verifyReleaseProvenance(input: ReleaseProvenance): Promise<boolean> {
  if (!plain(input) || input.protocol !== "clank-provenance/1" || !SHA256.test(input.digest)) return false;
  try {
    const { protocol: _protocol, digest, ...material } = input;
    return timingSafeEqual(digest, (await createReleaseProvenance(material)).digest);
  } catch { return false; }
}

export function createPromotionPlan(release: ReleaseProvenance, stagesInput: readonly PromotionStageInput[]): PromotionPlan {
  if (!plain(release) || release.protocol !== "clank-provenance/1" || !SHA256.test(release.digest)) throw new TypeError("A release provenance envelope is required.");
  if (!Array.isArray(stagesInput) || stagesInput.length === 0 || stagesInput.length > 20) throw new TypeError("Promotion stages must contain 1-20 entries.");
  let prior = -1;
  const names = new Set<string>();
  const stages = stagesInput.map((stage, index) => {
    if (!plain(stage)) throw new TypeError(`Promotion stage ${index} must be an object.`);
    exact(stage, ["name", "trafficPercent", "requiredChecks", "requiresApproval"], `promotion stage ${index}`);
    const name = token(stage.name, `promotion stage ${index} name`);
    if (names.has(name)) throw new TypeError(`Promotion stage is duplicated: ${name}.`);
    names.add(name);
    const trafficPercent = finite(stage.trafficPercent, `promotion stage ${name} traffic`, 0, 100);
    if (trafficPercent <= prior) throw new TypeError("Promotion traffic must increase at every stage.");
    prior = trafficPercent;
    const requiredChecks = list(stage.requiredChecks ?? [], `promotion stage ${name} checks`);
    return freeze({ name, trafficPercent, requiredChecks, requiresApproval: stage.requiresApproval === true });
  });
  if (stages.at(-1)?.trafficPercent !== 100) throw new TypeError("The final promotion stage must receive 100% of traffic.");
  return freeze({ protocol: "clank-promotion/1", release, stages: freeze(stages) });
}

export function nextPromotion(plan: PromotionPlan, evidenceInput: readonly PromotionEvidence[]): PromotionDecision {
  if (!plain(plan) || plan.protocol !== "clank-promotion/1") throw new TypeError("Promotion plan is invalid.");
  if (!Array.isArray(evidenceInput)) throw new TypeError("Promotion evidence must be an array.");
  const evidence = new Map(evidenceInput.map((item) => [item.stage, item]));
  for (const stage of plan.stages) {
    const current = evidence.get(stage.name);
    const blockers: string[] = [];
    if (!current) return freeze({ ready: false, stage: stage.name, blockers: freeze(["Stage has not run."]) });
    for (const check of stage.requiredChecks) if (current.checks?.[check] !== true) blockers.push(`Required check failed or is missing: ${check}.`);
    if (stage.requiresApproval && current.approved !== true) blockers.push("A human approval is required.");
    if (blockers.length) return freeze({ ready: false, stage: stage.name, blockers: freeze(blockers) });
  }
  return freeze({ ready: true, stage: null, blockers: freeze([]) });
}

export function assessRollout(metrics: RolloutMetrics, guardrails: RolloutGuardrails): RolloutDecision {
  if (!plain(metrics) || !plain(guardrails)) throw new TypeError("Rollout metrics and guardrails are required.");
  const samples = integer(metrics.samples, "rollout samples", 0, Number.MAX_SAFE_INTEGER);
  const minimum = integer(guardrails.minimumSamples ?? 100, "minimum rollout samples", 1, Number.MAX_SAFE_INTEGER);
  const errorRate = finite(metrics.errorRate, "rollout error rate", 0, 1);
  const p95 = finite(metrics.p95Ms, "rollout p95", 0, Number.MAX_SAFE_INTEGER);
  const maximumErrorRate = finite(guardrails.maximumErrorRate, "maximum error rate", 0, 1);
  const maximumP95 = finite(guardrails.maximumP95Ms, "maximum p95", 1, Number.MAX_SAFE_INTEGER);
  const reasons: string[] = [];
  if (samples < minimum) reasons.push(`Waiting for ${minimum - samples} more samples.`);
  if (errorRate > maximumErrorRate) reasons.push(`Error rate ${percent(errorRate)} exceeds ${percent(maximumErrorRate)}.`);
  if (p95 > maximumP95) reasons.push(`p95 ${p95}ms exceeds ${maximumP95}ms.`);
  const maximumSaturation = guardrails.maximumSaturation === undefined ? undefined : finite(guardrails.maximumSaturation, "maximum saturation", 0, 1);
  if (maximumSaturation !== undefined && finite(metrics.saturation ?? 0, "rollout saturation", 0, 1) > maximumSaturation) reasons.push("Runtime saturation exceeds its guardrail.");
  const breached = reasons.some((reason) => /exceeds/u.test(reason));
  return freeze({ action: breached && samples >= minimum ? "rollback" : reasons.length ? "pause" : "continue", reasons: freeze(reasons) });
}

export async function createPortableProjectExport(input: { name: string; frameworkVersion: string; files: readonly PortableProjectFileInput[]; exportedAt?: string | number | Date; maxBytes?: number; }): Promise<PortableProjectExport> {
  if (!plain(input)) throw new TypeError("Project export input is required.");
  const name = token(input.name, "project export name");
  const frameworkVersion = token(input.frameworkVersion, "project framework version");
  const exportedAt = new Date(time(input.exportedAt ?? Date.now(), "project export time")).toISOString();
  const maximum = integer(input.maxBytes ?? MAX_EXPORT_BYTES, "project export maximum bytes", 1, MAX_EXPORT_BYTES);
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 20_000) throw new TypeError("Project export must contain 1-20,000 files.");
  let total = 0;
  const paths = new Set<string>();
  const files: PortableProjectFile[] = [];
  for (const candidate of input.files) {
    const path = safePath(candidate.path);
    if (paths.has(path)) throw new TypeError(`Project export path is duplicated: ${path}.`);
    paths.add(path);
    if (!(candidate.bytes instanceof Uint8Array)) throw new TypeError(`Project export ${path} bytes are invalid.`);
    total += candidate.bytes.byteLength;
    if (total > maximum) throw new TypeError("Project export exceeds its byte limit.");
    const mode = candidate.mode ?? 0o644;
    if (![0o600, 0o644, 0o700, 0o755].includes(mode)) throw new TypeError(`Project export ${path} mode is invalid.`);
    files.push(freeze({ path, size: candidate.bytes.byteLength, sha256: await sha256(candidate.bytes), mode, content: base64url(candidate.bytes) }));
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const project = freeze({ name, frameworkVersion, exportedAt });
  const digest = await sha256(canonical({ protocol: "clank-project-export/1", project, files }));
  return freeze({ protocol: "clank-project-export/1", project, files: freeze(files), digest });
}

export async function verifyPortableProjectExport(bundle: PortableProjectExport, maxBytes = MAX_EXPORT_BYTES): Promise<boolean> {
  if (!plain(bundle) || bundle.protocol !== "clank-project-export/1" || !SHA256.test(bundle.digest) || !Array.isArray(bundle.files)) return false;
  try {
    exact(bundle, ["protocol", "project", "files", "digest"], "portable export");
    if (!plain(bundle.project)) return false;
    exact(bundle.project, ["name", "frameworkVersion", "exportedAt"], "portable export project");
    token(bundle.project.name, "portable export project name");
    token(bundle.project.frameworkVersion, "portable export framework version");
    if (iso(bundle.project.exportedAt, "portable export time") !== bundle.project.exportedAt) return false;
    if (bundle.files.length === 0 || bundle.files.length > 20_000) return false;
    const maximum = integer(maxBytes, "portable export maximum bytes", 1, MAX_EXPORT_BYTES);
    let total = 0;
    const seen = new Set<string>();
    let prior = "";
    for (const file of bundle.files) {
      if (!plain(file)) return false;
      exact(file, ["path", "size", "sha256", "mode", "content"], "portable export file");
      if (seen.has(file.path) || safePath(file.path) !== file.path || (prior && file.path <= prior) || !SHA256.test(file.sha256)) return false;
      seen.add(file.path);
      prior = file.path;
      integer(file.size, `portable export ${file.path} size`, 0, maximum);
      if (![0o600, 0o644, 0o700, 0o755].includes(file.mode)) return false;
      if (typeof file.content !== "string" || file.content.length > Math.ceil((maximum - total) * 4 / 3) + 4) return false;
      const bytes = fromBase64url(file.content);
      total += bytes.byteLength;
      if (total > maximum || bytes.byteLength !== file.size || base64url(bytes) !== file.content || !timingSafeEqual(await sha256(bytes), file.sha256)) return false;
    }
    const { digest, ...unsigned } = bundle;
    return timingSafeEqual(digest, await sha256(canonical(unsigned)));
  } catch { return false; }
}

export async function createSanitizedClone<T extends Record<string, unknown>>(rowsInput: readonly T[], policyInput: ClonePolicy, saltInput: string | Uint8Array): Promise<SanitizedClone<T>> {
  if (!Array.isArray(rowsInput) || rowsInput.length > 100_000) throw new TypeError("Clone rows must be an array of at most 100,000 entries.");
  if (!plain(policyInput) || !(TRANSFORMS as unknown[]).includes(policyInput.default)) throw new TypeError("Clone policy is invalid.");
  exact(policyInput, ["default", "fields"], "clone policy");
  const salt = typeof saltInput === "string" ? new TextEncoder().encode(saltInput) : saltInput;
  if (!(salt instanceof Uint8Array) || salt.byteLength < 16) throw new TypeError("Clone salt must contain at least 16 bytes.");
  const fields = policyInput.fields ?? {};
  if (!plain(fields) || Object.keys(fields).length > 10_000) throw new TypeError("Clone policy fields must be an object with at most 10,000 entries.");
  for (const [key, transform] of Object.entries(fields)) {
    text(key, "clone policy field", 500);
    if (!(TRANSFORMS as unknown[]).includes(transform)) throw new TypeError(`Clone transform for ${key} is invalid.`);
  }
  const redacted = new Set<string>();
  const rows: T[] = [];
  for (const row of rowsInput) {
    if (!plain(row)) throw new TypeError("Clone rows must contain objects.");
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(row)) {
      const transform = fields[key] ?? policyInput.default;
      if (!(TRANSFORMS as unknown[]).includes(transform)) throw new TypeError(`Clone transform for ${key} is invalid.`);
      if (transform === "drop") { redacted.add(key); continue; }
      if (transform === "keep") output[key] = data(value, `clone field ${key}`);
      else if (transform === "redact") { output[key] = "[redacted]"; redacted.add(key); }
      else {
        const digest = (await sha256(concat(salt, new TextEncoder().encode(canonical(value))))).slice(0, 24);
        output[key] = transform === "email" ? `preview+${digest}@example.invalid` : `hash_${digest}`;
        redacted.add(key);
      }
    }
    rows.push(freeze(output) as T);
  }
  return freeze({ protocol: "clank-sanitized-clone/1", rows: freeze(rows), redactedFields: freeze([...redacted].sort()) });
}

export function estimateCapacity(workload: CapacityWorkload, rateCard: CapacityRateCard): CapacityEstimate {
  if (!plain(workload) || !plain(rateCard)) throw new TypeError("Capacity workload and rate card are required.");
  const requests = integer(workload.requestsPerMonth, "monthly requests", 0, Number.MAX_SAFE_INTEGER);
  const transfer = integer(workload.transferBytesPerMonth, "monthly transfer", 0, Number.MAX_SAFE_INTEGER);
  const database = integer(workload.databaseBytes, "database bytes", 0, Number.MAX_SAFE_INTEGER);
  const artifacts = integer(workload.artifactBytes, "artifact bytes", 0, Number.MAX_SAFE_INTEGER);
  const connections = integer(workload.peakRealtimeConnections ?? 0, "peak realtime connections", 0, 10_000_000);
  const jobCpu = integer(workload.jobCpuMsPerMonth ?? 0, "monthly job CPU", 0, Number.MAX_SAFE_INTEGER);
  const replicas = integer(workload.minimumReplicas ?? 1, "minimum replicas", 1, 1_000);
  const processUnits = Math.max(replicas, Math.ceil(requests / 10_000_000), Math.ceil(connections / 2_000), Math.ceil(jobCpu / 86_400_000));
  const storageBytes = database + artifacts;
  const requestMillions = requests / 1_000_000;
  const transferGb = transfer / 1_000_000_000;
  const storageGb = storageBytes / 1_000_000_000;
  const monthlyCost = money(requestMillions * rate(rateCard.requestMillion, "request rate") + transferGb * rate(rateCard.transferGb, "transfer rate") + storageGb * rate(rateCard.storageGb, "storage rate") + processUnits * rate(rateCard.processUnit, "process rate"));
  return freeze({ protocol: "clank-capacity-estimate/1", processUnits, storageBytes, requestMillions, transferGb, monthlyCost, assumptions: freeze(["One process unit supports 10M monthly requests, 2,000 peak realtime connections, or one CPU-day of monthly jobs.", "Decimal GB units are used for transparent billing estimates.", "The estimate excludes taxes and third-party service charges."]) });
}

function normalizeRelease(input: ReleaseMaterial): ReleaseMaterial { return freeze({ releaseId: token(input.releaseId, "release ID"), artifactSha256: digest(input.artifactSha256, "artifact digest"), sourceRevision: token(input.sourceRevision, "source revision"), migrationIds: list(input.migrationIds, "migration IDs"), configurationSha256: digest(input.configurationSha256, "configuration digest"), frameworkVersion: token(input.frameworkVersion, "framework version"), builder: token(input.builder, "release builder"), builtAt: iso(input.builtAt, "release build time") }); }
function normalizePatch(patch: RevisionPatch, label: string): RevisionPatch { if (!plain(patch)) throw new TypeError(`${label} must be an object.`); exact(patch, ["op", "path", "value"], label); if (patch.op !== "set" && patch.op !== "delete") throw new TypeError(`${label} operation is invalid.`); const path = pointer(patch.path, label); if (patch.op === "delete" && patch.value !== undefined) throw new TypeError(`${label} delete cannot contain a value.`); if (patch.op === "set" && !("value" in patch)) throw new TypeError(`${label} set requires a value.`); return freeze({ op: patch.op, path, ...(patch.op === "set" ? { value: data(patch.value, `${label} value`) } : {}) }); }
function applyPatches(stateInput: unknown, patches: readonly RevisionPatch[]): unknown { let state = JSON.parse(canonical(stateInput)); for (const patch of patches) { if (patch.path === "") { state = patch.op === "delete" ? null : JSON.parse(canonical(patch.value)); continue; } const root = (state && typeof state === "object") ? state as any : {}; const pieces = patch.path.slice(1).split("/").map((piece) => piece.replace(/~1/gu, "/").replace(/~0/gu, "~")); let target = root; for (const piece of pieces.slice(0, -1)) { if (Array.isArray(target) && !ARRAY_INDEX.test(piece)) throw new TypeError("Revision patch arrays require canonical numeric indexes."); if (Array.isArray(target) && Number(piece) > 100_000) throw new TypeError("Revision patch array index exceeds 100,000."); if (!plain(target[piece]) && !Array.isArray(target[piece])) target[piece] = {}; target = target[piece]; } const leaf = pieces.at(-1)!; if (Array.isArray(target)) { if (!ARRAY_INDEX.test(leaf)) throw new TypeError("Revision patch arrays require canonical numeric indexes."); const index = Number(leaf); if (index > 100_000 || (patch.op === "set" && index > target.length)) throw new TypeError("Revision patch array index is outside its bounded state."); if (patch.op === "delete") { if (index < target.length) target.splice(index, 1); } else target[index] = JSON.parse(canonical(patch.value)); } else if (patch.op === "delete") delete target[leaf]; else target[leaf] = JSON.parse(canonical(patch.value)); state = root; } return data(state, "patched state"); }
function traceFor(events: readonly RevisionEvent[], event: RevisionEvent): RevisionEvent[] { const byId = new Map(events.map((item) => [item.id, item])); const ids = new Set<string>(); let cursor: RevisionEvent | undefined = event; while (cursor && !ids.has(cursor.id)) { ids.add(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; } if (event.correlationId) for (const item of events) if (item.correlationId === event.correlationId) ids.add(item.id); return events.filter((item) => ids.has(item.id)); }
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;
function pointer(value: unknown, label: string): string { if (typeof value !== "string" || value.length > 1_000 || (value !== "" && (!value.startsWith("/") || /~(?![01])/u.test(value)))) throw new TypeError(`${label} path is not a bounded JSON Pointer.`); const segments = value.slice(1).split("/").map((piece) => piece.replace(/~1/gu, "/").replace(/~0/gu, "~")); if (segments.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) throw new TypeError(`${label} path contains a dangerous object key.`); return value; }
function safePath(value: unknown): string { if (typeof value !== "string" || !SAFE_PATH.test(value) || value.split("/").some((part) => part === "" || part === ".") || value.includes("\0")) throw new TypeError("Project export path is invalid."); return value; }
function list(value: readonly string[], label: string): readonly string[] { if (!Array.isArray(value) || value.length > 1_000) throw new TypeError(`${label} must be an array.`); const output = value.map((item) => token(item, label)); if (new Set(output).size !== output.length) throw new TypeError(`${label} contains duplicates.`); return freeze(output); }
function token(value: unknown, label: string): string { if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${label} is invalid.`); return value; }
function digest(value: unknown, label: string): string { if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} is invalid.`); return value; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) throw new TypeError(`${label} is invalid.`); return value.trim(); }
function iso(value: unknown, label: string): string { return new Date(time(value, label)).toISOString(); }
function time(value: unknown, label: string): number { const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN; if (!Number.isFinite(result)) throw new TypeError(`${label} is invalid.`); return result; }
function integer(value: unknown, label: string, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`${label} must be an integer from ${min} through ${max}.`); return Number(value); }
function finite(value: unknown, label: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${label} must be from ${min} through ${max}.`); return value; }
function rate(value: unknown, label: string): number { return finite(value, label, 0, 1_000_000); }
function money(value: number): number { return Math.round(value * 100) / 100; }
function percent(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function data(value: unknown, label: string): any { try { return freezeDeep(JSON.parse(canonical(value))); } catch { throw new TypeError(`${label} must be JSON data.`); } }
function freezeDeep(value: any): any { if (value && typeof value === "object") { for (const item of Object.values(value)) freezeDeep(item); Object.freeze(value); } return value; }
function canonical(value: unknown): string { if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value); if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; throw new TypeError("Value is not JSON data."); }
async function sha256(value: string | Uint8Array): Promise<string> { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function concat(left: Uint8Array, right: Uint8Array): Uint8Array { const output = new Uint8Array(left.byteLength + right.byteLength); output.set(left); output.set(right, left.byteLength); return output; }
function base64url(value: Uint8Array): string { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, ""); }
function fromBase64url(value: unknown): Uint8Array { if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) throw new TypeError("Portable content is invalid."); const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4); const binary = atob(padded); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function timingSafeEqual(left: string, right: string): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index); return difference === 0; }
function plain(value: unknown): value is Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function exact(value: Record<string, any>, keys: readonly string[], label: string): void { const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label} contains unknown field ${key}.`); }
function freeze<T>(value: T): T { return Object.freeze(value); }
