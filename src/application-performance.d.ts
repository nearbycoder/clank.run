export interface ApplicationBudgets { readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationResource { readonly resource: string; readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationPolicyCheck { readonly name: string; readonly actual: number; readonly maximum: number; readonly passed: boolean; }
export interface ApplicationPerformanceOptions {
  pageId?: string; baseline?: unknown;
  maxLoadTimeMs?: number;
  resourceBudgets?: readonly { resource: string; maxBytes?: number; maxRequests?: number }[];
  regressionBudgets?: Partial<Record<keyof ApplicationBudgets, { absolute?: number; percent?: number }>>;
}
export interface ApplicationResourceGroup extends ApplicationBudgets { readonly group: string; }
export interface ApplicationPerformanceReport {
  readonly protocol: "clank-application-performance/1";
  readonly ok: boolean;
  readonly measurements: ApplicationBudgets;
  readonly loadTimeMs: number;
  readonly policyChecks: readonly ApplicationPolicyCheck[];
  readonly duplicateResources: readonly ApplicationResource[];
  readonly origins: readonly ApplicationResourceGroup[];
  readonly resourceTypes: readonly ApplicationResourceGroup[];
  readonly checks: readonly { readonly name: keyof ApplicationBudgets; readonly actual: number; readonly maximum: number; readonly passed: boolean }[];
  readonly resources: readonly ApplicationResource[];
  readonly changes: readonly (ApplicationResource & { readonly previousBytes: number; readonly deltaBytes: number })[];
  readonly issues: readonly string[];
}

export declare function assessApplicationPerformance(har: unknown, budgets: ApplicationBudgets, options?: ApplicationPerformanceOptions): ApplicationPerformanceReport;
