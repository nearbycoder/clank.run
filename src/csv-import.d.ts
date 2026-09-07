export type CsvValue = string | number | boolean | null;
export interface CsvColumn { source: string; target: string; type: "text" | "number" | "integer" | "boolean" | "date"; required?: boolean; }
export interface CsvImportOptions { columns: readonly CsvColumn[]; delimiter?: "," | ";" | "\t"; uniqueBy?: readonly string[]; existing?: readonly Readonly<Record<string, CsvValue>>[]; duplicates?: "error" | "skip"; maxRows?: number; }
export interface CsvIssue { row: number; column: string; code: "required" | "type" | "duplicate"; }
export interface CsvImportPlan { readonly id: string; readonly ok: boolean; readonly sourceRows: number; readonly skipped: number; readonly records: readonly Readonly<Record<string, CsvValue>>[]; readonly issues: readonly CsvIssue[]; }
export interface ParsedCsv { headers: readonly string[]; rows: readonly (readonly string[])[]; }
export declare function parseCsv(text: string, options?: { delimiter?: "," | ";" | "\t"; maxRows?: number }): ParsedCsv;
export declare function planCsvImport(text: string, options: CsvImportOptions): CsvImportPlan;
export declare function commitCsvImport(plan: CsvImportPlan, commit: (records: CsvImportPlan["records"], context: { idempotencyKey: string; signal: AbortSignal }) => Promise<void>, signal?: AbortSignal): Promise<number>;
export interface CsvImporterOptions {
  fields: readonly { name: string; type: CsvColumn["type"]; required?: boolean }[];
  uniqueBy?: readonly string[];
  commit: Parameters<typeof commitCsvImport>[1];
}
export declare function mountCsvImporter(container: HTMLElement, options: CsvImporterOptions): () => void;
