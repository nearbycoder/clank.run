export interface CompileOptions {
  filename?: string;
  jsxImportSource?: string;
  sourceMap?: boolean;
  hydrationDiagnostics?: boolean;
}

export interface TransformTSXOptions {
  importSource?: string;
  filename?: string;
  hydrationDiagnostics?: boolean;
}

export interface TransformTSXResult {
  code: string;
  transformed: boolean;
}

export declare function compile(source: string, options?: CompileOptions): string;
export declare function transformTSX(source: string, options?: TransformTSXOptions): TransformTSXResult;
