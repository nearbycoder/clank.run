import type {AuthClient} from "./auth.ts";
export type ProjectSloWindowMinutes = 5 | 60 | 1440 | 10080;
export type ProjectSloLatencyMs = 50 | 100 | 250 | 500 | 1000 | 2500 | 5000;
export type ProjectSloObjective = { readonly kind: "request-success" } | { readonly kind: "latency"; readonly maximumMs: ProjectSloLatencyMs };
export interface ProjectSloConfiguration {
  readonly name: string;
  readonly objective: ProjectSloObjective;
  readonly targetBasisPoints: number;
  readonly windowMinutes: ProjectSloWindowMinutes;
  readonly minimumRequests: number;
  readonly burnThreshold: number;
  readonly enabled: boolean;
}
/** Counts of native ingress terminal outcomes, grouped by completion minute. */
export interface ProjectSloBucket {
  readonly startedAt: number;
  readonly complete: boolean;
  readonly requests: number;
  readonly successful: number;
  readonly completed: number;
  readonly latency: readonly [number, number, number, number, number, number, number];
}
export interface ProjectSloEvaluation {
  readonly status: "insufficient-data" | "within-budget" | "budget-exhausted";
  readonly reason: "missing-measurements" | "not-enough-requests" | null;
  readonly from: number;
  readonly until: number;
  readonly coverage: { readonly complete: boolean; readonly expectedMinutes: number; readonly coveredMinutes: number; readonly missingMinutes: number };
  readonly requests: number;
  readonly good: number;
  readonly bad: number;
  readonly observedGoodFraction: number | null;
  readonly allowedBadRequests: number | null;
  readonly remainingBudgetRequests: number | null;
  readonly burnRate: number | null;
  readonly burning: boolean | null;
}
export interface ProjectSloPolicy extends ProjectSloConfiguration { readonly id: string; readonly projectId: string; readonly version: number; readonly createdAt: number; readonly updatedAt: number; }
export interface ProjectSloAlert { readonly id: string; readonly policyId: string; readonly projectId: string; readonly policyVersion: number; readonly state: "open" | "resolved" | "unknown" | "disabled"; readonly version: number; readonly observedAt: number; }
export interface ProjectSloAssessment { readonly policy: ProjectSloPolicy; readonly evaluation: ProjectSloEvaluation; readonly alert: ProjectSloAlert | null; }
export interface CreateProjectSloRequest { readonly configuration: ProjectSloConfiguration; readonly operationId: string; }
export interface ChangeProjectSloRequest extends CreateProjectSloRequest { readonly expectedVersion: number; }
export interface ProjectSloClient {
  list(projectId: string): Promise<readonly ProjectSloAssessment[]>;
  read(projectId: string, policyId: string): Promise<ProjectSloAssessment>;
  create(projectId: string, input: CreateProjectSloRequest): Promise<ProjectSloPolicy>;
  change(projectId: string, policyId: string, input: ChangeProjectSloRequest): Promise<ProjectSloPolicy>;
}
export interface ProjectSloClientOptions {
  url?: string; fetch?: typeof fetch; auth?: Pick<AuthClient<any>,"csrfHeader">; headers?:()=>HeadersInit; timeoutMs?:number;
}
const minute = 60000;
const bounds = [50, 100, 250, 500, 1000, 2500, 5000] as const;
const integer = (value: unknown, low: number, high: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < low || Number(value) > high) throw new TypeError("SLO number is outside its supported range.");
  return Number(value);
};
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("SLO input must be a plain object.");
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError("SLO input has unsupported fields.");
  return value as Record<string, unknown>;
};
/** Validate and detach a policy before it crosses a persistent or agent boundary. */
export function validateProjectSloConfiguration(value: unknown): ProjectSloConfiguration {
  const input = exact(value, ["name", "objective", "targetBasisPoints", "windowMinutes", "minimumRequests", "burnThreshold", "enabled"]);
  if (typeof input.name !== "string" || !input.name.trim() || new TextEncoder().encode(input.name).byteLength > 160 || /[\u0000-\u001f\u007f]/u.test(input.name)) throw new TypeError("Choose an SLO name of at most 160 UTF-8 bytes.");
  const kind = (input.objective as any)?.kind;
  const objective = exact(input.objective, kind === "latency" ? ["kind", "maximumMs"] : ["kind"]);
  if (kind !== "request-success" && kind !== "latency") throw new TypeError("Unsupported SLO objective.");
  if (kind === "latency" && !(bounds as readonly unknown[]).includes(objective.maximumMs)) throw new TypeError("Choose a supported SLO latency boundary.");
  if (![5, 60, 1440, 10080].includes(Number(input.windowMinutes)) || typeof input.windowMinutes !== "number") throw new TypeError("Choose a supported SLO window.");
  if (typeof input.burnThreshold !== "number" || !Number.isFinite(input.burnThreshold) || input.burnThreshold < 1 || input.burnThreshold > 1000) throw new TypeError("Choose an SLO burn threshold from 1 to 1000.");
  if (typeof input.enabled !== "boolean") throw new TypeError("SLO enabled must be boolean.");
  return {
    name: input.name, objective: kind === "latency" ? {kind, maximumMs: objective.maximumMs as ProjectSloLatencyMs} : {kind},
    targetBasisPoints: integer(input.targetBasisPoints, 9000, 9999), windowMinutes: input.windowMinutes as ProjectSloWindowMinutes,
    minimumRequests: integer(input.minimumRequests, 1, 1000000), burnThreshold: input.burnThreshold, enabled: input.enabled,
  };
}
/** Deterministic arithmetic. Missing or partial minutes never establish compliance. */
export function evaluateProjectSlo(configuration: ProjectSloConfiguration, buckets: readonly ProjectSloBucket[], until: number): ProjectSloEvaluation {
  const policy = validateProjectSloConfiguration(configuration);
  integer(until, policy.windowMinutes * minute, Number.MAX_SAFE_INTEGER);
  if (until % minute !== 0) throw new TypeError("SLO window must end on a closed UTC minute boundary.");
  if (!Array.isArray(buckets) || buckets.length > policy.windowMinutes) throw new TypeError("SLO measurement window exceeds its bound.");
  const from = until - policy.windowMinutes * minute, seen = new Set<number>();
  let requests = 0, good = 0, covered = 0;
  const latencyIndex = policy.objective.kind === "latency" ? bounds.indexOf(policy.objective.maximumMs) : -1;
  for (const input of buckets) {
    const bucket = exact(input, ["startedAt", "complete", "requests", "successful", "completed", "latency"]);
    const start = integer(bucket.startedAt, from, until - minute);
    if (start % minute !== 0 || seen.has(start)) throw new TypeError("SLO measurement minutes must be unique and aligned.");
    seen.add(start);
    if (typeof bucket.complete !== "boolean" || !Array.isArray(bucket.latency) || bucket.latency.length !== bounds.length) throw new TypeError("SLO measurement is incomplete or malformed.");
    const total = integer(bucket.requests, 0, Number.MAX_SAFE_INTEGER), completed = integer(bucket.completed, 0, total), successful = integer(bucket.successful, 0, completed);
    let prior = 0;
    for (const count of bucket.latency) { prior = integer(count, prior, completed); }
    if (bucket.complete) covered++;
    const accepted = latencyIndex < 0 ? successful : Number(bucket.latency[latencyIndex]);
    requests = integer(requests + total, 0, Number.MAX_SAFE_INTEGER);
    good = integer(good + accepted, 0, requests);
  }
  const complete = covered === policy.windowMinutes, bad = requests - good;
  const reason = !complete ? "missing-measurements" : requests < policy.minimumRequests ? "not-enough-requests" : null;
  const allowance = BigInt(requests) * BigInt(10000 - policy.targetBasisPoints), unsuccessful = BigInt(bad) * 10000n;
  const allowed = reason === null ? Number(allowance) / 10000 : null;
  const burn = allowed === null ? null : Number(unsuccessful) / Number(allowance);
  // Make decisions using integer ratios, even near the safe counter ceiling.
  const [whole, fraction = ""] = String(policy.burnThreshold).split("."), thresholdDenominator = 10n ** BigInt(fraction.length), thresholdNumerator = BigInt(whole! + fraction);
  const burning = reason === null ? unsuccessful * thresholdDenominator >= allowance * thresholdNumerator : null;
  return {
    status: reason !== null ? "insufficient-data" : unsuccessful > allowance ? "budget-exhausted" : "within-budget", reason, from, until,
    coverage: {complete, expectedMinutes: policy.windowMinutes, coveredMinutes: covered, missingMinutes: policy.windowMinutes - covered},
    requests, good, bad, observedGoodFraction: requests === 0 ? null : good / requests,
    allowedBadRequests: allowed, remainingBudgetRequests: allowed === null ? null : Number(allowance - unsuccessful) / 10000,
    burnRate: burn, burning,
  };
}

/** Browser-safe bounded transport. Explicit exact retries remain caller decisions. */
export function createProjectSloClient(options: ProjectSloClientOptions = {}): ProjectSloClient {
  const base = (options.url ?? "").replace(/\/$/u, "");
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 30000) throw new TypeError("SLO timeout must be 500–30000ms.");
  const identifier = (value: string) => {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new TypeError("Invalid project or SLO identifier.");
    return encodeURIComponent(value);
  };
  const request = async (projectId: string, suffix: string, method = "GET", body?: unknown) => {
    const headers = new Headers(options.headers?.());
    for (const [name, value] of Object.entries(options.auth?.csrfHeader() ?? {})) headers.set(name, value);
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > 16384) throw new Error("SLO request exceeds its bounded envelope.");
    if (text !== undefined) headers.set("content-type", "application/json");
    const maximum = 1024 * 1024, chunks: Uint8Array[] = [];
    let bytes = 0;
    const controller = new AbortController(), signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>, response: Response, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const expiration = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      const error = new Error("SLO transport timed out. Inspect current state before retrying the same operation.");
      controller.abort(error); reject(error);
    }, timeout); });
    try {
      const fetching = Promise.resolve().then(() => (options.fetch ?? fetch)(`${base}/api/projects/${identifier(projectId)}/slo-policies${suffix}`, {
        method, headers, signal, credentials: "same-origin", redirect: "error", ...(text === undefined ? {} : {body: text}),
      })).then(value => {
        if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw signal.reason; }
        return value;
      });
      response = await Promise.race([fetching, expiration]);
      if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error("SLO transport refused a redirected response."); }
      reader = response.body?.getReader();
      while (reader) {
        const value = await Promise.race([reader.read(), expiration]);
        if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > maximum) { void reader.cancel().catch(() => {}); throw new Error("SLO response exceeds its bounded envelope."); }
        chunks.push(value.value);
      }
    } finally { clearTimeout(timer!); if (signal.aborted) void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    let payload: any;
    try { payload = JSON.parse(new TextDecoder().decode(all)); } catch { throw new Error("SLO transport returned invalid JSON."); }
    if (!response.ok || payload?.ok !== true) {
      const error = new Error("SLO access changed or the operation was rejected. Refresh before retrying.") as Error & {status: number};
      error.status = response.status;
      throw error;
    }
    return payload;
  };
  return {
    list: async projectId => (await request(projectId, "")).policies,
    read: async (projectId, policyId) => (await request(projectId, `/${identifier(policyId)}`)).assessment,
    create: async (projectId, input) => (await request(projectId, "", "POST", input)).policy,
    change: async (projectId, policyId, input) => (await request(projectId, `/${identifier(policyId)}/change`, "POST", input)).policy,
  };
}
