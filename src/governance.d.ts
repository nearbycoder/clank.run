export type PolicyEffect = "allow" | "deny" | "approval";
export type PolicyPrincipalKind = "user" | "agent" | "service";
export interface PolicyPrincipal { readonly id: string; readonly kind: PolicyPrincipalKind; readonly roles?: readonly string[]; readonly attributes?: Readonly<Record<string, string | number | boolean>>; }
export interface PolicyRule { readonly id: string; readonly actions: readonly string[]; readonly effect: PolicyEffect; readonly roles?: readonly string[]; readonly principalKinds?: readonly PolicyPrincipalKind[]; readonly resource?: string; readonly when?: Readonly<Record<string, string | number | boolean>>; readonly reason?: string; readonly approvalTtlMs?: number; }
export interface EntitlementDefinition { readonly key: string; readonly limit: number | boolean; readonly description?: string; }
export interface FeatureFlagVariant { readonly name: string; readonly weight: number; readonly value: unknown; }
export interface FeatureFlagDefinition { readonly key: string; readonly enabled: boolean; readonly default: unknown; readonly variants?: readonly FeatureFlagVariant[]; readonly allowRoles?: readonly string[]; readonly allowPrincipalIds?: readonly string[]; readonly startsAt?: string; readonly endsAt?: string; }
export interface GovernancePolicyInput { readonly revision: string; readonly rules?: readonly PolicyRule[]; readonly entitlements?: readonly EntitlementDefinition[]; readonly flags?: readonly FeatureFlagDefinition[]; }
export interface GovernancePolicy { readonly protocol: "clank-governance/1"; readonly revision: string; readonly rules: readonly PolicyRule[]; readonly entitlements: readonly EntitlementDefinition[]; readonly flags: readonly FeatureFlagDefinition[]; }
export interface PolicyRequest { readonly action: string; readonly principal: PolicyPrincipal; readonly resource?: string; readonly attributes?: Readonly<Record<string, string | number | boolean>>; }
export interface PolicyDecision { readonly protocol: "clank-policy-decision/1"; readonly policyRevision: string; readonly effect: PolicyEffect; readonly ruleId: string | null; readonly reason: string; readonly approvalTtlMs?: number; }
export interface FeatureFlagContext { readonly principal?: PolicyPrincipal; readonly subject?: string; readonly now?: string | number | Date; }
export interface FeatureFlagEvaluation { readonly protocol: "clank-feature-evaluation/1"; readonly policyRevision: string; readonly key: string; readonly enabled: boolean; readonly variant: string; readonly value: unknown; readonly reason: "disabled" | "scheduled" | "targeted" | "rollout" | "default"; }
export interface ApprovalGrant { readonly protocol: "clank-approval/1"; readonly id: string; readonly policyRevision: string; readonly ruleId: string; readonly action: string; readonly resource: string | null; readonly principalId: string; readonly approvedBy: string; readonly issuedAt: string; readonly expiresAt: string; readonly nonce: string; readonly signature: string; }
export declare function defineGovernancePolicy(input: GovernancePolicyInput): GovernancePolicy;
export declare function evaluatePolicy(policyInput: GovernancePolicy, request: PolicyRequest): PolicyDecision;
export declare function entitlement(policyInput: GovernancePolicy, keyInput: string): number | boolean | undefined;
export declare function resolveEntitlements<T extends Readonly<Record<string, number | boolean>>>(defaultsInput: T, ...layers: readonly Readonly<Partial<T>>[]): Readonly<T>;
export declare function evaluateFeatureFlag(policyInput: GovernancePolicy, keyInput: string, context?: FeatureFlagContext): FeatureFlagEvaluation;
export declare function issueApproval(input: { policy: GovernancePolicy; request: PolicyRequest; approvedBy: string; secret: string | Uint8Array; now?: string | number | Date; randomBytes?: (size: number) => Uint8Array; }): Promise<ApprovalGrant>;
export declare function verifyApproval(input: { grant: ApprovalGrant; policy: GovernancePolicy; request: PolicyRequest; secret: string | Uint8Array; now?: string | number | Date; usedNonces?: ReadonlySet<string>; }): Promise<boolean>;
