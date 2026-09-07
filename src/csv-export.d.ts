export interface CsvExportColumn { field: string; label: string; }
export interface CsvExportOptions { delimiter?: "," | ";" | "\t"; bom?: boolean; maxRows?: number; maxBytes?: number; }
export type CsvExportRecord = Readonly<Record<string, unknown>>;
export declare function exportCsv(records: readonly CsvExportRecord[], columns: readonly CsvExportColumn[], options?: CsvExportOptions): string;
export declare function streamCsvExport(records: AsyncIterable<CsvExportRecord>, columns: readonly CsvExportColumn[], options?: CsvExportOptions): ReadableStream<Uint8Array>;
export declare function csvExportResponse(records: AsyncIterable<CsvExportRecord>, columns: readonly CsvExportColumn[], options?: CsvExportOptions & { filename?: string }): Response;
export declare function mountCsvExporter(container: HTMLElement, options: { columns: readonly CsvExportColumn[]; records(): readonly CsvExportRecord[]; filename?: string; limits?: CsvExportOptions }): () => void;
