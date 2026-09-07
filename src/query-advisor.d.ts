export interface DatabaseQueryDiagnostic {
  readonly table: string;
  readonly sql: string;
  readonly runs: number;
  readonly rows: number;
  readonly totalMs: number;
  readonly maximumMs: number;
  readonly plan: readonly string[];
  readonly suggestedIndex: string | null;
}
export interface QueryAdvice { readonly query: DatabaseQueryDiagnostic; readonly averageMs: number; readonly findings: readonly string[]; }

export declare function adviseQueries(queries: readonly DatabaseQueryDiagnostic[], options?: { slowMs?: number; repeatedRuns?: number }): readonly QueryAdvice[];
