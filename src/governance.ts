/**
 * One policy vocabulary for humans, agents, feature delivery, and hosted limits.
 * Policies are deliberately data-only so they can be stored, audited, diffed,
 * signed, and evaluated in an application process without a policy service.
 */

export type PolicyEffect = "allow" | "deny" | "approval";
export type PolicyPrincipalKind = "user" | "agent" | "service";

export interface PolicyPrincipal {
  readonly id: string;
  readonly kind: PolicyPrincipalKind;
  readonly roles?: readonly string[];
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface PolicyRule {
  readonly id: string;
  readonly actions: readonly string[];
  readonly effect: PolicyEffect;
  readonly roles?: readonly string[];
  readonly principalKinds?: readonly PolicyPrincipalKind[];
  readonly resource?: string;
  readonly when?: Readonly<Record<string, string | number | boolean>>;
  readonly reason?: string;
  /** Approval validity for an approval rule. Defaults to five minutes. */
  readonly approvalTtlMs?: number;
}

export interface EntitlementDefinition {
  readonly key: string;
  readonly limit: number | boolean;
  readonly description?: string;
}

export interface FeatureFlagVariant {
  readonly name: string;
  readonly weight: number;
  readonly value: unknown;
}

export interface FeatureFlagDefinition {
  readonly key: string;
  readonly enabled: boolean;
  readonly default: unknown;
  readonly variants?: readonly FeatureFlagVariant[];
  readonly allowRoles?: readonly string[];
  readonly allowPrincipalIds?: readonly string[];
  /** Optional UTC activation and expiration boundaries. */
  readonly startsAt?: string;
  readonly endsAt?: string;
}

export interface GovernancePolicyInput {
  readonly revision: string;
  readonly rules?: readonly PolicyRule[];
  readonly entitlements?: readonly EntitlementDefinition[];
  readonly flags?: readonly FeatureFlagDefinition[];
}

export interface GovernancePolicy {
  readonly protocol: "clank-governance/1";
  readonly revision: string;
  readonly rules: readonly PolicyRule[];
  readonly entitlements: readonly EntitlementDefinition[];
  readonly flags: readonly FeatureFlagDefinition[];
}

export interface PolicyRequest {
  readonly action: string;
  readonly principal: PolicyPrincipal;
  readonly resource?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface PolicyDecision {
  readonly protocol: "clank-policy-decision/1";
  readonly policyRevision: string;
  readonly effect: PolicyEffect;
  readonly ruleId: string | null;
  readonly reason: string;
  readonly approvalTtlMs?: number;
}

export interface FeatureFlagContext {
  readonly principal?: PolicyPrincipal;
  readonly subject?: string;
  readonly now?: string | number | Date;
}

export interface FeatureFlagEvaluation {
  readonly protocol: "clank-feature-evaluation/1";
  readonly policyRevision: string;
  readonly key: string;
  readonly enabled: boolean;
  readonly variant: string;
  readonly value: unknown;
  readonly reason: "disabled" | "scheduled" | "targeted" | "rollout" | "default";
}

export interface ApprovalGrant {
  readonly protocol: "clank-approval/1";
  readonly id: string;
  readonly policyRevision: string;
  readonly ruleId: string;
  readonly action: string;
  readonly resource: string | null;
  readonly principalId: string;
  readonly approvedBy: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly signature: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const PATTERN = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:/@-]{0,198}\*?)$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PRINCIPAL_KINDS = new Set<PolicyPrincipalKind>(["user", "agent", "service"]);

export function defineGovernancePolicy(input: GovernancePolicyInput): GovernancePolicy {
  if (!plain(input)) throw new TypeError("Governance policy must be an object.");
  exactKeys(input, ["protocol", "revision", "rules", "entitlements", "flags"], "governance policy");
  if ((input as GovernancePolicy).protocol !== undefined && (input as GovernancePolicy).protocol !== "clank-governance/1") {
    throw new TypeError("Governance policy protocol is invalid.");
  }
  const revision = identifier(input.revision, "policy revision", REVISION);
  if (!Array.isArray(input.rules ?? []) || (input.rules?.length ?? 0) > 10_000) throw new TypeError("Governance policy may contain at most 10,000 rules.");
  if (!Array.isArray(input.entitlements ?? []) || (input.entitlements?.length ?? 0) > 10_000) throw new TypeError("Governance policy may contain at most 10,000 entitlements.");
  if (!Array.isArray(input.flags ?? []) || (input.flags?.length ?? 0) > 10_000) throw new TypeError("Governance policy may contain at most 10,000 feature flags.");
  const ruleIds = new Set<string>();
  const rules = (input.rules ?? []).map((candidate, index) => {
    if (!plain(candidate)) throw new TypeError(`Policy rule ${index} must be an object.`);
    exactKeys(candidate, ["id", "actions", "effect", "roles", "principalKinds", "resource", "when", "reason", "approvalTtlMs"], `policy rule ${index}`);
    const id = identifier(candidate.id, `policy rule ${index} id`, REVISION);
    if (ruleIds.has(id)) throw new TypeError(`Policy rule ID is duplicated: ${id}.`);
    ruleIds.add(id);
    if (!Array.isArray(candidate.actions) || candidate.actions.length === 0 || candidate.actions.length > 64) {
      throw new TypeError(`Policy rule ${id} must contain 1-64 actions.`);
    }
    const actions = unique(candidate.actions.map((action) => identifier(action, `policy rule ${id} action`, PATTERN)));
    if (!(["allow", "deny", "approval"] as unknown[]).includes(candidate.effect)) {
      throw new TypeError(`Policy rule ${id} effect is invalid.`);
    }
    const roles = optionalTokens(candidate.roles, `policy rule ${id} roles`);
    const principalKinds = candidate.principalKinds === undefined ? undefined : candidate.principalKinds.map((kind) => {
      if (!PRINCIPAL_KINDS.has(kind)) throw new TypeError(`Policy rule ${id} principal kind is invalid.`);
      return kind;
    });
    const resource = candidate.resource === undefined ? undefined : identifier(candidate.resource, `policy rule ${id} resource`, PATTERN);
    const when = candidate.when === undefined ? undefined : attributes(candidate.when, `policy rule ${id} conditions`);
    const reason = candidate.reason === undefined ? undefined : boundedText(candidate.reason, `policy rule ${id} reason`, 500);
    const approvalTtlMs = candidate.effect === "approval"
      ? integer(candidate.approvalTtlMs ?? 300_000, `policy rule ${id} approvalTtlMs`, 1_000, 86_400_000)
      : undefined;
    return freeze({ id, actions, effect: candidate.effect, ...(roles ? { roles } : {}), ...(principalKinds ? { principalKinds: freeze(principalKinds) } : {}), ...(resource ? { resource } : {}), ...(when ? { when } : {}), ...(reason ? { reason } : {}), ...(approvalTtlMs ? { approvalTtlMs } : {}) });
  });

  const entitlementKeys = new Set<string>();
  const entitlements = (input.entitlements ?? []).map((candidate, index) => {
    if (!plain(candidate)) throw new TypeError(`Entitlement ${index} must be an object.`);
    exactKeys(candidate, ["key", "limit", "description"], `entitlement ${index}`);
    const key = identifier(candidate.key, `entitlement ${index} key`, TOKEN);
    if (entitlementKeys.has(key)) throw new TypeError(`Entitlement is duplicated: ${key}.`);
    entitlementKeys.add(key);
    if (typeof candidate.limit !== "boolean" && (!Number.isSafeInteger(candidate.limit) || candidate.limit < 0)) {
      throw new TypeError(`Entitlement ${key} limit must be a boolean or non-negative integer.`);
    }
    const description = candidate.description === undefined ? undefined : boundedText(candidate.description, `entitlement ${key} description`, 500);
    return freeze({ key, limit: candidate.limit, ...(description ? { description } : {}) });
  });

  const flagKeys = new Set<string>();
  const flags = (input.flags ?? []).map((candidate, index) => normalizeFlag(candidate, index, flagKeys));
  return freeze({ protocol: "clank-governance/1", revision, rules: freeze(rules), entitlements: freeze(entitlements), flags: freeze(flags) });
}

/** Deny-by-default, first-match evaluator. Put explicit deny rules first. */
export function evaluatePolicy(policyInput: GovernancePolicy, request: PolicyRequest): PolicyDecision {
  const policy = defineGovernancePolicy(policyInput);
  const checked = normalizeRequest(request);
  for (const rule of policy.rules) {
    if (!rule.actions.some((pattern) => matches(pattern, checked.action))) continue;
    if (rule.roles && !rule.roles.some((role) => checked.principal.roles.includes(role))) continue;
    if (rule.principalKinds && !rule.principalKinds.includes(checked.principal.kind)) continue;
    if (rule.resource && !matches(rule.resource, checked.resource ?? "")) continue;
    if (rule.when && !Object.entries(rule.when).every(([key, value]) => checked.attributes[key] === value)) continue;
    return freeze({
      protocol: "clank-policy-decision/1",
      policyRevision: policy.revision,
      effect: rule.effect,
      ruleId: rule.id,
      reason: rule.reason ?? (rule.effect === "allow" ? "Allowed by policy." : rule.effect === "approval" ? "Human approval is required." : "Denied by policy."),
      ...(rule.approvalTtlMs ? { approvalTtlMs: rule.approvalTtlMs } : {}),
    });
  }
  return freeze({ protocol: "clank-policy-decision/1", policyRevision: policy.revision, effect: "deny", ruleId: null, reason: "No policy rule allowed this action." });
}

export function entitlement(policyInput: GovernancePolicy, keyInput: string): number | boolean | undefined {
  const policy = defineGovernancePolicy(policyInput);
  const key = identifier(keyInput, "entitlement key", TOKEN);
  return policy.entitlements.find((item) => item.key === key)?.limit;
}

/**
 * Resolves ordered entitlement layers. Unknown keys and type changes fail
 * closed so plan, workspace, and operator overrides cannot invent capacity.
 */
export function resolveEntitlements<T extends Readonly<Record<string, number | boolean>>>(
  defaultsInput: T,
  ...layers: readonly Readonly<Partial<T>>[]
): Readonly<T> {
  if (!plain(defaultsInput) || Object.keys(defaultsInput).length === 0) {
    throw new TypeError("Entitlement defaults must be a non-empty object.");
  }
  const output: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(defaultsInput)) {
    identifier(key, "entitlement key", TOKEN);
    if (typeof value !== "boolean" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`Entitlement ${key} default is invalid.`);
    }
    output[key] = value;
  }
  for (const layer of layers) {
    if (!plain(layer)) throw new TypeError("Entitlement override layer must be an object.");
    for (const [key, value] of Object.entries(layer)) {
      if (!Object.hasOwn(output, key)) throw new TypeError(`Entitlement override is unknown: ${key}.`);
      if (value === undefined) continue;
      if (typeof value !== typeof output[key]
        || (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))) {
        throw new TypeError(`Entitlement override ${key} is invalid.`);
      }
      output[key] = value;
    }
  }
  return freeze(output) as Readonly<T>;
}

export function evaluateFeatureFlag(policyInput: GovernancePolicy, keyInput: string, context: FeatureFlagContext = {}): FeatureFlagEvaluation {
  const policy = defineGovernancePolicy(policyInput);
  const key = identifier(keyInput, "feature flag key", TOKEN);
  const flag = policy.flags.find((item) => item.key === key);
  if (!flag) throw new Error(`Unknown feature flag: ${key}.`);
  const principal = context.principal ? normalizePrincipal(context.principal) : undefined;
  const now = instant(context.now ?? Date.now(), "feature evaluation time");
  if (!flag.enabled) return flagResult(policy, flag, false, "off", flag.default, "disabled");
  if ((flag.startsAt && now < Date.parse(flag.startsAt)) || (flag.endsAt && now >= Date.parse(flag.endsAt))) {
    return flagResult(policy, flag, false, "scheduled", flag.default, "scheduled");
  }
  const targeted = Boolean(principal && (
    flag.allowPrincipalIds?.includes(principal.id)
    || flag.allowRoles?.some((role) => principal.roles.includes(role))
  ));
  if (targeted) {
    const first = flag.variants?.[0];
    return flagResult(policy, flag, true, first?.name ?? "on", first?.value ?? true, "targeted");
  }
  if (!flag.variants?.length) return flagResult(policy, flag, true, "on", true, "default");
  const subject = boundedText(context.subject ?? principal?.id ?? "anonymous", "feature flag subject", 500);
  const bucket = stableBucket(`${policy.revision}\0${key}\0${subject}`);
  let cursor = 0;
  for (const variant of flag.variants) {
    cursor += variant.weight;
    if (bucket < cursor) return flagResult(policy, flag, true, variant.name, variant.value, "rollout");
  }
  return flagResult(policy, flag, true, "default", flag.default, "default");
}

export async function issueApproval(input: {
  policy: GovernancePolicy;
  request: PolicyRequest;
  approvedBy: string;
  secret: string | Uint8Array;
  now?: string | number | Date;
  randomBytes?: (size: number) => Uint8Array;
}): Promise<ApprovalGrant> {
  const policy = defineGovernancePolicy(input.policy);
  const request = normalizeRequest(input.request);
  const decision = evaluatePolicy(policy, request);
  if (decision.effect !== "approval" || !decision.ruleId || !decision.approvalTtlMs) {
    throw new Error("The policy decision does not require approval.");
  }
  const now = instant(input.now ?? Date.now(), "approval time");
  const approvedBy = identifier(input.approvedBy, "approver ID", TOKEN);
  const bytes = input.randomBytes?.(18) ?? crypto.getRandomValues(new Uint8Array(18));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 18) throw new TypeError("Approval random source must return 18 bytes.");
  const unsigned = {
    protocol: "clank-approval/1" as const,
    id: `approval_${base64url(bytes)}`,
    policyRevision: policy.revision,
    ruleId: decision.ruleId,
    action: request.action,
    resource: request.resource ?? null,
    principalId: request.principal.id,
    approvedBy,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + decision.approvalTtlMs).toISOString(),
    nonce: base64url(bytes),
  };
  const signature = await signApproval(unsigned, input.secret);
  return freeze({ ...unsigned, signature });
}

export async function verifyApproval(input: {
  grant: ApprovalGrant;
  policy: GovernancePolicy;
  request: PolicyRequest;
  secret: string | Uint8Array;
  now?: string | number | Date;
  usedNonces?: ReadonlySet<string>;
}): Promise<boolean> {
  try {
    const policy = defineGovernancePolicy(input.policy);
    const request = normalizeRequest(input.request);
    const grant = input.grant;
    if (!plain(grant) || grant.protocol !== "clank-approval/1") return false;
    exactKeys(grant, ["protocol", "id", "policyRevision", "ruleId", "action", "resource", "principalId", "approvedBy", "issuedAt", "expiresAt", "nonce", "signature"], "approval grant");
    for (const [value, label] of [[grant.id, "approval ID"], [grant.policyRevision, "approval policy revision"], [grant.ruleId, "approval rule"], [grant.action, "approval action"], [grant.principalId, "approval principal"], [grant.approvedBy, "approval approver"]] as const) identifier(value, label, TOKEN);
    if (grant.resource !== null) identifier(grant.resource, "approval resource", TOKEN);
    if (!/^[A-Za-z0-9_-]{24}$/u.test(grant.nonce) || !/^[A-Za-z0-9_-]{43}$/u.test(grant.signature)) return false;
    if (grant.policyRevision !== policy.revision || grant.principalId !== request.principal.id || grant.action !== request.action || grant.resource !== (request.resource ?? null)) return false;
    if (input.usedNonces?.has(grant.nonce)) return false;
    const now = instant(input.now ?? Date.now(), "approval verification time");
    const issuedAt = Date.parse(grant.issuedAt);
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) return false;
    const decision = evaluatePolicy(policy, request);
    if (decision.effect !== "approval" || decision.ruleId !== grant.ruleId) return false;
    const { signature, ...unsigned } = grant;
    const expected = await signApproval(unsigned, input.secret);
    return timingSafeEqual(signature, expected);
  } catch { return false; }
}

function normalizeFlag(candidate: FeatureFlagDefinition, index: number, keys: Set<string>): FeatureFlagDefinition {
  if (!plain(candidate)) throw new TypeError(`Feature flag ${index} must be an object.`);
  exactKeys(candidate, ["key", "enabled", "default", "variants", "allowRoles", "allowPrincipalIds", "startsAt", "endsAt"], `feature flag ${index}`);
  const key = identifier(candidate.key, `feature flag ${index} key`, TOKEN);
  if (keys.has(key)) throw new TypeError(`Feature flag is duplicated: ${key}.`);
  keys.add(key);
  if (typeof candidate.enabled !== "boolean") throw new TypeError(`Feature flag ${key} enabled must be boolean.`);
  if (candidate.variants !== undefined && (!Array.isArray(candidate.variants) || candidate.variants.length > 100)) throw new TypeError(`Feature flag ${key} may contain at most 100 variants.`);
  const variants = candidate.variants?.map((variant, variantIndex) => {
    if (!plain(variant)) throw new TypeError(`Feature flag ${key} variant ${variantIndex} must be an object.`);
    exactKeys(variant, ["name", "weight", "value"], `feature flag ${key} variant ${variantIndex}`);
    return freeze({ name: identifier(variant.name, `feature flag ${key} variant name`, REVISION), weight: integer(variant.weight, `feature flag ${key} variant weight`, 1, 10_000), value: cloneData(variant.value, `feature flag ${key} variant value`) });
  });
  if (variants && new Set(variants.map((item) => item.name)).size !== variants.length) throw new TypeError(`Feature flag ${key} variant names must be unique.`);
  if (variants && variants.reduce((sum, item) => sum + item.weight, 0) > 10_000) throw new TypeError(`Feature flag ${key} variant weights exceed 10,000.`);
  const allowRoles = optionalTokens(candidate.allowRoles, `feature flag ${key} roles`);
  const allowPrincipalIds = optionalTokens(candidate.allowPrincipalIds, `feature flag ${key} principal IDs`);
  const startsAt = candidate.startsAt === undefined ? undefined : new Date(instant(candidate.startsAt, `feature flag ${key} startsAt`)).toISOString();
  const endsAt = candidate.endsAt === undefined ? undefined : new Date(instant(candidate.endsAt, `feature flag ${key} endsAt`)).toISOString();
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) throw new TypeError(`Feature flag ${key} schedule is empty.`);
  return freeze({ key, enabled: candidate.enabled, default: cloneData(candidate.default, `feature flag ${key} default`), ...(variants ? { variants: freeze(variants) } : {}), ...(allowRoles ? { allowRoles } : {}), ...(allowPrincipalIds ? { allowPrincipalIds } : {}), ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) });
}

function normalizeRequest(request: PolicyRequest) {
  if (!plain(request)) throw new TypeError("Policy request must be an object.");
  exactKeys(request, ["action", "principal", "resource", "attributes"], "policy request");
  return freeze({ action: identifier(request.action, "policy action", TOKEN), principal: normalizePrincipal(request.principal), ...(request.resource === undefined ? {} : { resource: identifier(request.resource, "policy resource", TOKEN) }), attributes: attributes(request.attributes ?? {}, "policy attributes") });
}

function normalizePrincipal(principal: PolicyPrincipal) {
  if (!plain(principal)) throw new TypeError("Policy principal must be an object.");
  exactKeys(principal, ["id", "kind", "roles", "attributes"], "policy principal");
  if (!PRINCIPAL_KINDS.has(principal.kind)) throw new TypeError("Policy principal kind is invalid.");
  return freeze({ id: identifier(principal.id, "principal ID", TOKEN), kind: principal.kind, roles: optionalTokens(principal.roles, "principal roles") ?? freeze([]), attributes: attributes(principal.attributes ?? {}, "principal attributes") });
}

function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
}

function flagResult(policy: GovernancePolicy, flag: FeatureFlagDefinition, enabled: boolean, variant: string, value: unknown, reason: FeatureFlagEvaluation["reason"]): FeatureFlagEvaluation {
  return freeze({ protocol: "clank-feature-evaluation/1", policyRevision: policy.revision, key: flag.key, enabled, variant, value: cloneData(value, `feature flag ${flag.key} result`), reason });
}

function stableBucket(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % 10_000;
}

async function signApproval(value: object, secret: string | Uint8Array): Promise<string> {
  const bytes = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32) throw new TypeError("Approval secret must contain at least 32 bytes.");
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical(value)))));
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Policy values must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new TypeError("Policy values must be JSON data.");
}

function cloneData(value: unknown, label: string): unknown {
  try { return JSON.parse(canonical(value)); } catch { throw new TypeError(`${label} must be JSON data.`); }
}

function attributes(value: Readonly<Record<string, string | number | boolean>>, label: string) {
  if (!plain(value)) throw new TypeError(`${label} must be an object.`);
  const output: Record<string, string | number | boolean> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    identifier(key, `${label} key`, TOKEN);
    if (typeof item !== "string" && typeof item !== "boolean" && (typeof item !== "number" || !Number.isFinite(item))) throw new TypeError(`${label}.${key} is invalid.`);
    output[key] = item;
  }
  return freeze(output);
}

function optionalTokens(value: readonly string[] | undefined, label: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new TypeError(`${label} must contain 1-128 values.`);
  return freeze(unique(value.map((item) => identifier(item, label, TOKEN))));
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function identifier(value: unknown, label: string, expression: RegExp): string { if (typeof value !== "string" || !expression.test(value)) throw new TypeError(`${label} is invalid.`); return value; }
function boundedText(value: unknown, label: string, maximum: number): string { if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${label} is invalid.`); return value.trim(); }
function integer(value: unknown, label: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`); return Number(value); }
function instant(value: unknown, label: string): number { const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN; if (!Number.isFinite(time)) throw new TypeError(`${label} is invalid.`); return time; }
function plain(value: unknown): value is Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function exactKeys(value: Record<string, any>, allowed: readonly string[], label: string): void { const permitted = new Set(allowed); for (const key of Object.keys(value)) if (!permitted.has(key)) throw new TypeError(`${label} contains unknown field ${key}.`); }
function freeze<T>(value: T): T { return Object.freeze(value); }
function base64url(value: Uint8Array): string { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, ""); }
function timingSafeEqual(left: string, right: string): boolean { if (left.length !== right.length) return false; let mismatch = 0; for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index); return mismatch === 0; }
