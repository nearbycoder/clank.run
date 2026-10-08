import type { BackendDefinition } from "./backend.js";
import type { MutationReceiptOptions } from "./mutation-receipts.js";
export interface OpenAPIOptions {
  readonly title: string;
  readonly version: string;
  readonly serverUrl: string;
  readonly prefix?: string;
  readonly offlineMutations?: MutationReceiptOptions;
}
export interface OpenAPIDocument {
  readonly openapi: "3.1.1";
  readonly info: { readonly title: string; readonly version: string };
  readonly servers: readonly { readonly url: string }[];
  readonly paths: Readonly<Record<string, { readonly post: Readonly<Record<string, unknown>> }>>;
  readonly components: Readonly<Record<string, unknown>>;
}
export declare function exportBackendOpenAPI(definition: BackendDefinition<any, any, any, any>, options: OpenAPIOptions): OpenAPIDocument;
