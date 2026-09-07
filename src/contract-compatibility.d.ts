export interface CompatibilityFinding { readonly action: string; readonly path: string; readonly severity: "breaking" | "review" | "info"; readonly message: string; }
export interface CompatibilityReport { readonly protocol: "clank-contract-compatibility/1"; readonly ok: boolean; readonly findings: readonly CompatibilityFinding[]; }
export declare function compareContracts(baseline: unknown, candidate: unknown): CompatibilityReport;
