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

/** Diagnose observed query shapes. Repetition is evidence to investigate, not proof of an N+1 bug. */
export function adviseQueries(queries: readonly DatabaseQueryDiagnostic[], options: { slowMs?: number; repeatedRuns?: number } = {}): readonly QueryAdvice[] {
  const slow = options.slowMs ?? 25;
  const repeated = options.repeatedRuns ?? 20;
  if (!Number.isFinite(slow) || slow < 0 || !Number.isSafeInteger(repeated) || repeated < 2 || !Array.isArray(queries) || queries.length > 500) throw new TypeError("Invalid query advisor limits.");
  return Object.freeze(queries.map((query) => {
    const findings: string[] = [];
    if (query.maximumMs >= slow) findings.push("Slow execution observed; compare the plan and representative data before changing indexes.");
    if (query.runs >= repeated) findings.push("Repeated query shape; inspect loops, batching, and cache invalidations.");
    if (query.plan.some((step) => /^SCAN /u.test(step))) findings.push("SQLite scans a table or index; check selectivity on representative data.");
    if (query.plan.some((step) => step.includes("TEMP B-TREE"))) findings.push("SQLite builds a temporary sorting structure.");
    if (query.suggestedIndex) findings.push("Candidate index requires migration review and a before/after plan comparison.");
    return Object.freeze({ query, averageMs: query.runs ? query.totalMs / query.runs : 0, findings: Object.freeze(findings) });
  }).sort((a, b) => b.query.totalMs - a.query.totalMs));
}
