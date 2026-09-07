export interface ApplicationBudgets { readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationResource { readonly resource: string; readonly requests: number; readonly bodyBytes: number; readonly javascriptBytes: number; readonly cssBytes: number; }
export interface ApplicationPerformanceReport {
  readonly protocol: "clank-application-performance/1";
  readonly ok: boolean;
  readonly measurements: ApplicationBudgets;
  readonly checks: readonly { readonly name: keyof ApplicationBudgets; readonly actual: number; readonly maximum: number; readonly passed: boolean }[];
  readonly resources: readonly ApplicationResource[];
  readonly changes: readonly (ApplicationResource & { readonly previousBytes: number; readonly deltaBytes: number })[];
  readonly issues: readonly string[];
}

export declare function assessApplicationPerformance(har: unknown, budgets: ApplicationBudgets, options?: { pageId?: string; baseline?: unknown }): ApplicationPerformanceReport;
