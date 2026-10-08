import type { AnyBackendFunction, BackendDefinition, FunctionTree } from "./backend.ts";
import type { MutationReceiptOptions } from "./mutation-receipts.ts";

export interface OpenAPIOptions {
  readonly title: string;
  readonly version: string;
  /** Absolute deployment URL, used to resolve automatic secure cookie names. */
  readonly serverUrl: string;
  readonly prefix?: string;
  /** Must match the runtime's offlineMutations configuration. */
  readonly offlineMutations?: MutationReceiptOptions;
}
export interface OpenAPIDocument {
  readonly openapi: "3.1.1";
  readonly info: { readonly title: string; readonly version: string };
  readonly servers: readonly { readonly url: string }[];
  readonly paths: Readonly<Record<string, { readonly post: Readonly<Record<string, unknown>> }>>;
  readonly components: Readonly<Record<string, unknown>>;
}

const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "anyOf", "enum", "const", "description", "default", "format", "pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]);
interface ExportBudget { nodes: number; characters: number; }
function budgetNode(budget: ExportBudget, text = ""): void {
  if (++budget.nodes > 100000 || (budget.characters += text.length) > 1024 * 1024) throw new RangeError("OpenAPI schema exceeds its node or text budget.");
}
/** Export the JSON HTTP query/mutation contract. Live SSE and MCP retain their own contracts. */
export function exportBackendOpenAPI(definition: BackendDefinition<any, any, any, any>, options: OpenAPIOptions): OpenAPIDocument {
  if (typeof options.title !== "string" || !options.title || options.title.length > 200 || typeof options.version !== "string" || !options.version || options.version.length > 100) throw new TypeError("OpenAPI requires a bounded title and version.");
  const server = new URL(options.serverUrl);
  if (!["https:", "http:"].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== "/") throw new TypeError("OpenAPI needs an HTTP deployment origin without credentials, path, query or fragment; use prefix for the mount path.");
  const prefix = options.prefix ?? "/__clank";
  if (!/^\/[A-Za-z0-9_/-]+$/u.test(prefix) || prefix.endsWith("/") || prefix.includes("//")) throw new TypeError("Invalid backend prefix.");
  const functions = new Map<string, AnyBackendFunction>(), stack = new Set<object>();
  const budget: ExportBudget = { nodes: 0, characters: 0 }; let treeNodes = 0;
  const visit = (tree: FunctionTree, path: string[] = []) => {
    if (++treeNodes > 10000) throw new RangeError("OpenAPI function tree exceeds its node budget.");
    if (!tree || typeof tree !== "object" || Array.isArray(tree) || stack.has(tree) || path.length > 32) throw new TypeError("Invalid or cyclic backend function tree.");
    stack.add(tree);
    for (const [name, value] of Object.entries(tree)) {
      if (name.length > 200 || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) throw new TypeError("Invalid backend function segment.");
      const segments = [...path, name];
      if (value && (value.kind === "query" || value.kind === "mutation")) functions.set(segments.join("."), value as AnyBackendFunction);
      else visit(value as FunctionTree, segments);
      if (functions.size > 1000) throw new RangeError("OpenAPI is limited to 1,000 functions.");
    }
    stack.delete(tree);
  };
  visit(definition.functions);
  const schemas: Record<string, unknown> = { Problem: { type: "object", required: ["ok", "error"], properties: { ok: { const: false }, error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, issues: { type: "array", items: {} } } } } } };
  const paths: Record<string, { post: Record<string, unknown> }> = Object.create(null);
  const problem = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Problem" } } } });
  const authentication = definition.auth;
  if (options.offlineMutations && (!authentication || !Number.isSafeInteger(options.offlineMutations.retentionMs ?? 7 * 86400000) || (options.offlineMutations.retentionMs ?? 7 * 86400000) < 60000 || (options.offlineMutations.retentionMs ?? 7 * 86400000) > 30 * 86400000 || !Number.isSafeInteger(options.offlineMutations.maxEntries ?? 10000) || (options.offlineMutations.maxEntries ?? 10000) < 1 || (options.offlineMutations.maxEntries ?? 10000) > 100000)) throw new TypeError("OpenAPI replay settings must match a valid authenticated runtime policy.");
  const secure = authentication && (authentication.cookie.secure === "auto" ? server.protocol === "https:" : authentication.cookie.secure);
  for (const [name, fn] of [...functions].sort(([a], [b]) => a.localeCompare(b))) {
    if (!fn.returns) throw new TypeError(`OpenAPI requires an explicit returns schema for ${name}.`);
    if (fn.returns.safeParse(undefined).success) throw new TypeError(`OpenAPI requires a defined JSON result for ${name}.`);
    const input = exactSchema(fn.args.toJSONSchema(), `${name} arguments`, budget), output = exactSchema(fn.returns.toJSONSchema(), `${name} result`, budget);
    // Preserve the full path in schema keys and operation IDs; flattening dots
    // into underscores could make distinct namespaces collide.
    const key = `${fn.kind}.${name}`;
    // The runtime normalizes a JSON null body to {} before parsing arguments.
    schemas[`${key}.input`] = fn.args.safeParse({}).success ? { anyOf: [input, { type: "null" }] } : input;
    schemas[`${key}.output`] = { type: "object", required: ["ok", "value", "version"], properties: { ok: { const: true }, value: output, version: { type: "integer", minimum: 0 } } };
    const mutation = fn.kind === "mutation", required = fn.access === "required";
    if (required && !authentication) throw new TypeError(`Required function ${name} needs authentication.`);
    const parameters: Record<string, unknown>[] = [];
    if (mutation && authentication) parameters.push({ in: "header", name: "x-clank-csrf", required, schema: { type: "string" }, description: "Required whenever a browser session cookie is present, including public mutations." });
    if (mutation && options.offlineMutations) {
      parameters.push({ in: "header", name: "x-clank-mutation-key", required: false, schema: { type: "string", pattern: "^[0-9]{13}\\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" }, description: "Use one timestamp.UUID-v4 key for exact-input retries within the configured retention window." });
      parameters.push({ in: "header", name: "x-clank-offline-user", required: false, schema: { type: "string" }, description: "Required with a mutation key; must equal the current authenticated account ID." });
    }
    paths[`${prefix}/${fn.kind}/${name}`] = { post: {
      operationId: key, ...(fn.description ? { description: fn.description } : {}),
      security: required ? [{ sessionCookie: [] }] : [], parameters,
      requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${key}.input` } } } },
      responses: { "200": { description: "Accepted result and committed database revision.", content: { "application/json": { schema: { $ref: `#/components/schemas/${key}.output` } } } },
        "400": problem("Malformed request or intentional input failure."), "401": problem("Authentication required or expired."),
        "403": problem("Origin, CSRF, verification or authorization rejected."), "404": problem("Function or authorized resource unavailable."),
        "409": problem("Version, replay key or application conflict."), "410": problem("Expired mutation key or retired resource; never retry as a new operation without reconciliation."),
        "413": problem("Request or retained result exceeds its limit."), "422": problem("Runtime schema validation failed."), "503": problem("Configured admission capacity reached."), "500": problem("Backend operation failed; internal details are withheld.") },
      "x-clank-agent-exposed": fn.agent !== false && fn.agent.enabled !== false,
      "x-clank-idempotency": mutation && options.offlineMutations ? { enabled: true, retentionMs: options.offlineMutations.retentionMs ?? 7 * 86400000, expiredKeys: "reject", replay: "same-account-and-exact-input", atomic: true } : { enabled: false },
    } };
  }
  const document: OpenAPIDocument = { openapi: "3.1.1", info: { title: options.title, version: options.version }, servers: [{ url: server.href.replace(/\/$/u, "") }], paths,
    components: { schemas, securitySchemes: authentication ? { sessionCookie: { type: "apiKey", in: "cookie", name: authentication.cookie.name ?? (secure ? "__Host-clank-id" : "clank-id") } } : {} } };
  if (new TextEncoder().encode(JSON.stringify(document)).length > 1024 * 1024) throw new RangeError("OpenAPI document exceeds 1 MiB.");
  return document;
}

function exactSchema(source: Record<string, unknown>, label: string, budget: ExportBudget): Record<string, unknown> {
  if (source.optional) throw new TypeError(`${label}: optional root schemas cannot guarantee a JSON result.`);
  const walk = (schema: unknown, depth: number, objectField = false): unknown => {
    budgetNode(budget);
    if (depth > 32 || !schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError(`${label}: unsupported schema shape.`);
    if ((schema as Record<string, unknown>).optional && !objectField) throw new TypeError(`${label}: optional values outside object fields cannot guarantee JSON representation.`);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(schema)) {
      if (key === "optional") continue; // optional object fields are represented by required[]
      if (key === "table" && typeof value === "string") { result["x-clank-table"] = value; continue; }
      if (!KEYWORDS.has(key)) throw new TypeError(`${label}: unsupported schema keyword ${key}; coercion and custom refinements require an explicit adapter contract.`);
      if (key === "properties") result[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, property]) => { budgetNode(budget, name); return [name, walk(property, depth + 1, true)]; }));
      else if (key === "anyOf") result[key] = (value as unknown[]).map(member => walk(member, depth + 1));
      else if (key === "items" || key === "additionalProperties" && typeof value === "object") result[key] = walk(value, depth + 1);
      else result[key] = jsonValue(value, depth + 1, label, budget);
    }
    return result;
  };
  return walk(source, 0) as Record<string, unknown>;
}

function jsonValue(value: unknown, depth: number, label: string, budget: ExportBudget): unknown {
  budgetNode(budget, typeof value === "string" ? value : "");
  if (depth > 32) throw new TypeError(`${label}: JSON schema metadata is too deeply nested.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1, label, budget));
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).map(([key, item]) => { budgetNode(budget, key); return [key, jsonValue(item, depth + 1, label, budget)]; }));
  throw new TypeError(`${label}: schema metadata contains a value JSON cannot represent faithfully.`);
}
