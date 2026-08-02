import type { Action } from "./ai.ts";
import { createAppPlan, type AppBlueprint, type AppPlan } from "./blueprint.ts";

/** Review envelope used by conversational App Studio clients. */
export interface StudioReview { readonly protocol: "clank-studio-review/1"; readonly intent: string; readonly plan: AppPlan; readonly approvalDigest: string; readonly questions: readonly string[]; }

export interface VisualImage { readonly width: number; readonly height: number; readonly rgba: Uint8Array; }
export interface VisualRegressionOptions { readonly channelTolerance?: number; readonly maximumChangedRatio?: number; readonly ignoreRegions?: readonly { x: number; y: number; width: number; height: number }[]; }
export interface VisualRegressionReport { readonly protocol: "clank-visual-regression/1"; readonly matches: boolean; readonly changedPixels: number; readonly changedRatio: number; readonly maximumDelta: number; readonly width: number; readonly height: number; readonly reason: string; }

export interface RuntimeContract { readonly nodeMajor: number; readonly database: "sqlite" | "postgres"; readonly isolation: "process" | "container" | "microvm"; readonly region?: string; readonly environmentNames: readonly string[]; readonly migrations: readonly string[]; readonly services?: readonly string[]; }
export interface ParityFinding { readonly severity: "error" | "warning"; readonly field: string; readonly local: unknown; readonly production: unknown; readonly message: string; }
export interface ProductionParityReport { readonly protocol: "clank-production-parity/1"; readonly ok: boolean; readonly findings: readonly ParityFinding[]; }

export type SchemaColumnType = "text" | "integer" | "real" | "blob" | "json" | "boolean";
export interface SchemaColumn { readonly type: SchemaColumnType; readonly nullable?: boolean; readonly default?: string | number | boolean | null; }
export interface SchemaSnapshot { readonly tables: Readonly<Record<string, { readonly columns: Readonly<Record<string, SchemaColumn>>; readonly indexes?: Readonly<Record<string, readonly string[]>>; }>>; }
export interface SchemaChange { readonly safety: "safe" | "review" | "destructive"; readonly kind: "create-table" | "drop-table" | "add-column" | "drop-column" | "alter-column" | "create-index" | "drop-index"; readonly table: string; readonly name?: string; readonly sql: string; readonly message: string; }
export interface SchemaWorkbenchReport { readonly protocol: "clank-schema-workbench/1"; readonly safe: boolean; readonly changes: readonly SchemaChange[]; readonly migrationSql: string; }

export interface ContractTestCase { readonly name: string; readonly input: unknown; readonly expected: "success" | "validation-error"; }
export interface ContractTestReport { readonly protocol: "clank-contract-test/1"; readonly action: string; readonly ok: boolean; readonly cases: readonly { readonly name: string; readonly passed: boolean; readonly message?: string }[]; }

export interface UpgradeManifest { readonly from: string; readonly to: string; readonly minimumNodeMajor: number; readonly removedExports?: readonly string[]; readonly renamedExports?: Readonly<Record<string, string>>; readonly configChanges?: readonly string[]; readonly migrationNotes?: readonly string[]; }
export interface UpgradePlan { readonly protocol: "clank-upgrade-plan/1"; readonly from: string; readonly to: string; readonly ready: boolean; readonly blockers: readonly string[]; readonly edits: readonly { readonly kind: "rename-export" | "config" | "migration"; readonly message: string }[]; }

export interface PlaygroundCall { readonly action: string; readonly input: unknown; readonly principal?: string; readonly scopes?: readonly string[]; }
export interface PlaygroundTranscript { readonly protocol: "clank-agent-playground/1"; readonly action: string; readonly status: "succeeded" | "denied" | "failed"; readonly input: unknown; readonly output?: unknown; readonly error?: string; readonly durationMs: number; }
export interface AgentPlayground { readonly actions: readonly Action["manifest"][]; call(request: PlaygroundCall): Promise<PlaygroundTranscript>; }

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;
const TYPES = new Set<SchemaColumnType>(["text", "integer", "real", "blob", "json", "boolean"]);

/** Converts an AI/data blueprint into the exact digest a human approves. */
export async function createStudioReview(input: { intent: string; blueprint: AppBlueprint; questions?: readonly string[] }): Promise<StudioReview> {
  if (!input || typeof input !== "object") throw new TypeError("Studio review input is required.");
  const intent = bounded(input.intent, "studio intent", 20_000);
  const plan = await createAppPlan(input.blueprint);
  const questions = (input.questions ?? []).map((question) => bounded(question, "studio question", 1_000));
  if (questions.length > 20) throw new TypeError("Studio review may contain at most 20 questions.");
  return deepFreeze({ protocol: "clank-studio-review/1", intent, plan, approvalDigest: plan.digest, questions });
}

/** Pixel comparator suitable for deterministic PNG decoders or browser screenshot adapters. */
export function compareVisuals(baseline: VisualImage, current: VisualImage, options: VisualRegressionOptions = {}): VisualRegressionReport {
  const left = image(baseline, "baseline");
  const right = image(current, "current");
  if (left.width !== right.width || left.height !== right.height) return deepFreeze({ protocol: "clank-visual-regression/1", matches: false, changedPixels: Math.max(left.width * left.height, right.width * right.height), changedRatio: 1, maximumDelta: 255, width: right.width, height: right.height, reason: `Viewport changed from ${left.width}×${left.height} to ${right.width}×${right.height}.` });
  const tolerance = integer(options.channelTolerance ?? 8, "visual channel tolerance", 0, 255);
  const maximumRatio = finite(options.maximumChangedRatio ?? 0.001, "maximum changed ratio", 0, 1);
  if (!Array.isArray(options.ignoreRegions ?? []) || (options.ignoreRegions?.length ?? 0) > 100) throw new TypeError("Visual comparison may ignore at most 100 regions.");
  const ignored = (options.ignoreRegions ?? []).map((region, index) => rectangle(region, index, left.width, left.height));
  let compared = 0;
  let changed = 0;
  let maximumDelta = 0;
  for (let y = 0; y < left.height; y++) for (let x = 0; x < left.width; x++) {
    if (ignored.some((region) => x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height)) continue;
    compared++;
    const offset = (y * left.width + x) * 4;
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel++) pixelDelta = Math.max(pixelDelta, Math.abs(left.rgba[offset + channel]! - right.rgba[offset + channel]!));
    maximumDelta = Math.max(maximumDelta, pixelDelta);
    if (pixelDelta > tolerance) changed++;
  }
  const ratio = compared ? changed / compared : 0;
  const matches = ratio <= maximumRatio;
  return deepFreeze({ protocol: "clank-visual-regression/1", matches, changedPixels: changed, changedRatio: ratio, maximumDelta, width: left.width, height: left.height, reason: matches ? "Visual change is within the approved threshold." : `${changed} pixels (${(ratio * 100).toFixed(3)}%) exceed the visual threshold.` });
}

/** Compares local and hosted runtime inputs without ever comparing secret values. */
export function checkProductionParity(localInput: RuntimeContract, productionInput: RuntimeContract): ProductionParityReport {
  const local = runtime(localInput, "local runtime");
  const production = runtime(productionInput, "production runtime");
  const findings: ParityFinding[] = [];
  scalar("nodeMajor", local.nodeMajor, production.nodeMajor, "error", "Node major versions differ.", findings);
  scalar("database", local.database, production.database, "error", "Database engines differ.", findings);
  scalar("isolation", local.isolation, production.isolation, "warning", "Runtime isolation differs; verify filesystem and process assumptions.", findings);
  if (local.region && production.region && local.region !== production.region) scalar("region", local.region, production.region, "warning", "Network region differs.", findings);
  setDifference("environmentNames", local.environmentNames, production.environmentNames, "Environment variable names differ; values remain secret.", findings);
  setDifference("migrations", local.migrations, production.migrations, "Migration histories differ.", findings, "error");
  setDifference("services", local.services, production.services, "Service capabilities differ.", findings);
  return deepFreeze({ protocol: "clank-production-parity/1", ok: !findings.some((finding) => finding.severity === "error"), findings });
}

/** Produces reviewable SQL while classifying every destructive schema change. */
export function diffSchemas(currentInput: SchemaSnapshot, targetInput: SchemaSnapshot): SchemaWorkbenchReport {
  const current = schema(currentInput, "current schema");
  const target = schema(targetInput, "target schema");
  const changes: SchemaChange[] = [];
  for (const [table, definition] of Object.entries(target.tables)) {
    const before = current.tables[table];
    if (!before) {
      const columns = Object.entries(definition.columns).map(([name, column]) => `${quote(name)} ${sqlType(column)}${column.nullable ? "" : " NOT NULL"}${column.default === undefined ? "" : ` DEFAULT ${literal(column.default)}`}`).join(",\n  ");
      changes.push(change("safe", "create-table", table, undefined, `CREATE TABLE ${quote(table)} (\n  ${columns}\n);`, `Create table ${table}.`));
      for (const [index, fields] of Object.entries(definition.indexes ?? {})) changes.push(indexChange("create-index", table, index, fields));
      continue;
    }
    for (const [column, definitionColumn] of Object.entries(definition.columns)) {
      const old = before.columns[column];
      if (!old) changes.push(change(definitionColumn.nullable || definitionColumn.default !== undefined ? "safe" : "review", "add-column", table, column, `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${sqlType(definitionColumn)}${definitionColumn.nullable ? "" : " NOT NULL"}${definitionColumn.default === undefined ? "" : ` DEFAULT ${literal(definitionColumn.default)}`};`, `Add ${table}.${column}.`));
      else if (canonical(old) !== canonical(definitionColumn)) changes.push(change("review", "alter-column", table, column, `-- Rebuild ${quote(table)} to alter ${quote(column)} from ${sqlType(old)} to ${sqlType(definitionColumn)}.`, `Review the type/nullability change for ${table}.${column}.`));
    }
    for (const column of Object.keys(before.columns)) if (!definition.columns[column]) changes.push(change("destructive", "drop-column", table, column, `ALTER TABLE ${quote(table)} DROP COLUMN ${quote(column)};`, `Dropping ${table}.${column} deletes data.`));
    const oldIndexes = before.indexes ?? {};
    const newIndexes = definition.indexes ?? {};
    for (const [index, fields] of Object.entries(newIndexes)) if (!oldIndexes[index] || canonical(oldIndexes[index]) !== canonical(fields)) { if (oldIndexes[index]) changes.push(change("safe", "drop-index", table, index, `DROP INDEX ${quote(index)};`, `Replace index ${index}.`)); changes.push(indexChange("create-index", table, index, fields)); }
    for (const index of Object.keys(oldIndexes)) if (!newIndexes[index]) changes.push(change("safe", "drop-index", table, index, `DROP INDEX ${quote(index)};`, `Drop unused index ${index}.`));
  }
  for (const table of Object.keys(current.tables)) if (!target.tables[table]) changes.push(change("destructive", "drop-table", table, undefined, `DROP TABLE ${quote(table)};`, `Dropping ${table} deletes the table and all rows.`));
  return deepFreeze({ protocol: "clank-schema-workbench/1", safe: !changes.some((item) => item.safety === "destructive"), changes, migrationSql: `${changes.map((item) => `-- ${item.safety.toUpperCase()}: ${item.message}\n${item.sql}`).join("\n\n")}${changes.length ? "\n" : "-- No schema changes.\n"}` });
}

/** Generates and executes positive/negative cases directly from an action schema. */
export async function testActionContract(action: Action<any, any>, context: Record<string, unknown> = {}): Promise<ContractTestReport> {
  if (typeof action !== "function" || !action.manifest) throw new TypeError("A Clank action is required.");
  const cases = generateContractCases(action.manifest.inputSchema);
  const results: Array<{ name: string; passed: boolean; message?: string }> = [];
  for (const candidate of cases) {
    try {
      await action(candidate.input, context);
      results.push({ name: candidate.name, passed: candidate.expected === "success", ...(candidate.expected === "success" ? {} : { message: "Invalid input was accepted." }) });
    } catch (error) {
      results.push({ name: candidate.name, passed: candidate.expected === "validation-error", ...(candidate.expected === "validation-error" ? {} : { message: error instanceof Error ? error.message : "Action failed." }) });
    }
  }
  return deepFreeze({ protocol: "clank-contract-test/1", action: action.manifest.name, ok: results.every((result) => result.passed), cases: results });
}

export function generateContractCases(schemaInput: Record<string, unknown>): readonly ContractTestCase[] {
  if (!plain(schemaInput)) throw new TypeError("Action JSON Schema must be an object.");
  const valid = sample(schemaInput);
  return deepFreeze([
    { name: "accepts generated valid input", input: valid, expected: "success" },
    { name: "rejects null input", input: null, expected: schemaAllowsNull(schemaInput) ? "success" : "validation-error" },
    ...(schemaInput.type === "object" && Array.isArray(schemaInput.required) && schemaInput.required.length ? [{ name: `rejects missing required ${String(schemaInput.required[0])}`, input: { ...(valid as Record<string, unknown>), [String(schemaInput.required[0])]: undefined }, expected: "validation-error" as const }] : []),
  ]);
}

export function planFrameworkUpgrade(manifest: UpgradeManifest, environment: { nodeMajor: number; usedExports?: readonly string[] }): UpgradePlan {
  if (!plain(manifest) || !VERSION.test(manifest.from) || !VERSION.test(manifest.to)) throw new TypeError("Upgrade manifest versions are invalid.");
  const minimum = integer(manifest.minimumNodeMajor, "minimum Node major", 18, 99);
  const used = new Set(environment.usedExports ?? []);
  const blockers: string[] = [];
  const edits: Array<{ kind: "rename-export" | "config" | "migration"; message: string }> = [];
  if (environment.nodeMajor < minimum) blockers.push(`Node ${minimum}+ is required; found ${environment.nodeMajor}.`);
  for (const removed of manifest.removedExports ?? []) if (used.has(removed) && !manifest.renamedExports?.[removed]) blockers.push(`Used export ${removed} was removed without a replacement.`);
  for (const [from, to] of Object.entries(manifest.renamedExports ?? {})) if (used.has(from)) edits.push({ kind: "rename-export", message: `Rename ${from} to ${to}.` });
  for (const message of manifest.configChanges ?? []) edits.push({ kind: "config", message: bounded(message, "config change", 1_000) });
  for (const message of manifest.migrationNotes ?? []) edits.push({ kind: "migration", message: bounded(message, "migration note", 1_000) });
  return deepFreeze({ protocol: "clank-upgrade-plan/1", from: manifest.from, to: manifest.to, ready: blockers.length === 0, blockers, edits });
}

/** Runs the application's real action objects with redacted, bounded transcripts. */
export function createAgentPlayground(actionsInput: readonly Action<any, any>[], options: { authorize?: (call: PlaygroundCall, action: Action<any, any>) => boolean | Promise<boolean>; redactKeys?: readonly string[]; now?: () => number } = {}): AgentPlayground {
  if (!Array.isArray(actionsInput) || actionsInput.length === 0 || actionsInput.length > 2_048) throw new TypeError("Agent playground requires 1-2,048 actions.");
  const actions = new Map<string, Action<any, any>>();
  for (const action of actionsInput) { if (typeof action !== "function" || !action.manifest || actions.has(action.manifest.name)) throw new TypeError("Agent playground actions must be unique Clank actions."); actions.set(action.manifest.name, action); }
  const redactions = new Set((options.redactKeys ?? ["password", "token", "secret", "authorization", "cookie"]).map((key) => key.toLowerCase()));
  const now = options.now ?? Date.now;
  return deepFreeze({
    actions: [...actions.values()].map((action) => action.manifest),
    async call(call: PlaygroundCall): Promise<PlaygroundTranscript> {
      const started = now();
      const actionName = typeof call?.action === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(call.action) ? call.action : "invalid-action";
      const action = actions.get(actionName);
      if (!action) return deepFreeze({ protocol: "clank-agent-playground/1", action: actionName, status: "failed", input: redact(call?.input, redactions), error: "Unknown action.", durationMs: Math.max(0, now() - started) });
      if (options.authorize && !await options.authorize(call, action)) return deepFreeze({ protocol: "clank-agent-playground/1", action: call.action, status: "denied", input: redact(call.input, redactions), error: "Playground policy denied this action.", durationMs: Math.max(0, now() - started) });
      try { const output = await action(call.input, { playground: true, principal: call.principal, scopes: call.scopes }); return deepFreeze({ protocol: "clank-agent-playground/1", action: actionName, status: "succeeded", input: redact(call.input, redactions), output: redact(output, redactions), durationMs: Math.max(0, now() - started) }); }
      catch (error) { return deepFreeze({ protocol: "clank-agent-playground/1", action: actionName, status: "failed", input: redact(call.input, redactions), error: safeError(error), durationMs: Math.max(0, now() - started) }); }
    },
  });
}

function image(value: VisualImage, label: string): VisualImage { if (!value || typeof value !== "object") throw new TypeError(`${label} image is invalid.`); const width = integer(value.width, `${label} width`, 1, 20_000); const height = integer(value.height, `${label} height`, 1, 20_000); if (!(value.rgba instanceof Uint8Array) || value.rgba.byteLength !== width * height * 4) throw new TypeError(`${label} RGBA bytes do not match its dimensions.`); return value; }
function rectangle(value: any, index: number, width: number, height: number) { if (!value || typeof value !== "object") throw new TypeError(`Ignore region ${index} is invalid.`); const x = integer(value.x, "ignore x", 0, width); const y = integer(value.y, "ignore y", 0, height); const regionWidth = integer(value.width, "ignore width", 0, width - x); const regionHeight = integer(value.height, "ignore height", 0, height - y); return { x, y, width: regionWidth, height: regionHeight }; }
function runtime(value: RuntimeContract, label: string) { if (!plain(value)) throw new TypeError(`${label} is invalid.`); return { nodeMajor: integer(value.nodeMajor, `${label} Node major`, 18, 99), database: member(value.database, ["sqlite", "postgres"], `${label} database`), isolation: member(value.isolation, ["process", "container", "microvm"], `${label} isolation`), ...(value.region ? { region: bounded(value.region, `${label} region`, 100) } : {}), environmentNames: sorted(value.environmentNames, `${label} environment names`), migrations: sorted(value.migrations, `${label} migrations`), services: sorted(value.services ?? [], `${label} services`) }; }
function scalar(field: string, local: unknown, production: unknown, severity: "error" | "warning", message: string, findings: ParityFinding[]) { if (canonical(local) !== canonical(production)) findings.push({ severity, field, local, production, message }); }
function setDifference(field: string, local: readonly string[], production: readonly string[], message: string, findings: ParityFinding[], severity: "error" | "warning" = "warning") { scalar(field, local, production, severity, message, findings); }
function schema(value: SchemaSnapshot, label: string): SchemaSnapshot {
  if (!plain(value) || !plain(value.tables) || Object.keys(value).some((key) => key !== "tables")) throw new TypeError(`${label} is invalid.`);
  const tableEntries = Object.entries(value.tables);
  if (tableEntries.length > 1_000) throw new TypeError(`${label} may contain at most 1,000 tables.`);
  const tables: Record<string, any> = Object.create(null);
  for (const [name, table] of tableEntries) {
    identifier(name, `${label} table`);
    if (!plain(table) || !plain(table.columns) || Object.keys(table).some((key) => !["columns", "indexes"].includes(key))) throw new TypeError(`${label} table ${name} is invalid.`);
    const columnEntries = Object.entries(table.columns);
    if (columnEntries.length === 0 || columnEntries.length > 1_000) throw new TypeError(`${label} table ${name} must contain 1-1,000 columns.`);
    const columns: Record<string, SchemaColumn> = Object.create(null);
    for (const [column, definition] of columnEntries) {
      identifier(column, `${label} column`);
      if (!plain(definition) || !TYPES.has(definition.type) || Object.keys(definition).some((key) => !["type", "nullable", "default"].includes(key)) || (definition.nullable !== undefined && typeof definition.nullable !== "boolean") || !validColumnDefault(definition)) throw new TypeError(`${label} column ${name}.${column} is invalid.`);
      columns[column] = definition;
    }
    if (!plain(table.indexes ?? {})) throw new TypeError(`${label} table ${name} indexes are invalid.`);
    const indexEntries = Object.entries(table.indexes ?? {});
    if (indexEntries.length > 1_000) throw new TypeError(`${label} table ${name} may contain at most 1,000 indexes.`);
    const indexes: Record<string, readonly string[]> = Object.create(null);
    for (const [index, fields] of indexEntries) {
      identifier(index, `${label} index`);
      indexes[index] = sorted(fields, `${label} index fields`, 1);
      for (const field of fields) if (!columns[field]) throw new TypeError(`${label} index ${index} references an unknown column.`);
    }
    tables[name] = { columns, indexes };
  }
  return deepFreeze({ tables });
}
function change(safety: SchemaChange["safety"], kind: SchemaChange["kind"], table: string, name: string | undefined, sql: string, message: string): SchemaChange { return { safety, kind, table, ...(name ? { name } : {}), sql, message }; }
function indexChange(kind: "create-index", table: string, index: string, fields: readonly string[]): SchemaChange { return change("safe", kind, table, index, `CREATE INDEX ${quote(index)} ON ${quote(table)} (${fields.map(quote).join(", ")});`, `Create index ${index} on ${table}.`); }
function sqlType(column: SchemaColumn): string { return ({ text: "TEXT", integer: "INTEGER", real: "REAL", blob: "BLOB", json: "TEXT", boolean: "INTEGER" } as const)[column.type]; }
function quote(value: string): string { return `"${value.replace(/"/gu, '""')}"`; }
function literal(value: string | number | boolean | null): string { if (value === null) return "NULL"; if (typeof value === "boolean") return value ? "1" : "0"; if (typeof value === "number") return String(value); return `'${value.replace(/'/gu, "''")}'`; }
function sample(schema: Record<string, any>): unknown { if (schema.default !== undefined) return clone(schema.default); if (schema.const !== undefined) return clone(schema.const); if (Array.isArray(schema.enum)) return clone(schema.enum[0]); if (Array.isArray(schema.anyOf)) return sample(schema.anyOf[0] ?? {}); switch (schema.type) { case "object": { const output: Record<string, unknown> = {}; for (const key of schema.required ?? Object.keys(schema.properties ?? {})) output[key] = sample(schema.properties?.[key] ?? {}); return output; } case "array": return schema.minItems > 0 ? [sample(schema.items ?? {})] : []; case "string": return schema.format === "email" ? "test@example.com" : schema.format === "date" ? "2026-08-01" : schema.format === "date-time" ? "2026-08-01T00:00:00.000Z" : schema.format === "uri" ? "https://example.com" : "x".repeat(Math.max(1, schema.minLength ?? 1)); case "integer": return schema.minimum ?? 1; case "number": return schema.minimum ?? 1; case "boolean": return true; case "null": return null; default: return {}; } }
function schemaAllowsNull(schema: Record<string, any>): boolean { return schema.type === "null" || (Array.isArray(schema.anyOf) && schema.anyOf.some((member) => member?.type === "null")); }
function redact(value: unknown, keys: ReadonlySet<string>, depth = 0): unknown { if (depth > 20) return "[depth-limited]"; if (value === undefined) return null; if (value === null || typeof value === "number" || typeof value === "boolean") return value; if (typeof value === "string") return value.length > 16_000 ? `${value.slice(0, 16_000)}…` : value; if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redact(item, keys, depth + 1)); if (plain(value)) { const output: Record<string, unknown> = Object.create(null); for (const [key, item] of Object.entries(value).slice(0, 1_000)) output[key] = keys.has(key.toLowerCase()) ? "[redacted]" : redact(item, keys, depth + 1); return output; } return String(value).slice(0, 16_000); }
function safeError(error: unknown): string { const message = error instanceof Error ? error.message : "Action failed."; return message.replace(/[\r\n\0]/gu, " ").slice(0, 1_000); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !NAME.test(value)) throw new TypeError(`${label} is invalid.`); return value; }
function bounded(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) throw new TypeError(`${label} is invalid.`); return value.trim(); }
function integer(value: unknown, label: string, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`${label} must be an integer from ${min} through ${max}.`); return Number(value); }
function finite(value: unknown, label: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${label} must be from ${min} through ${max}.`); return value; }
function sorted(value: unknown, label: string, minimum = 0): readonly string[] { if (!Array.isArray(value) || value.length < minimum || value.length > 10_000 || value.some((item) => typeof item !== "string" || item.length > 500 || item.includes("\0"))) throw new TypeError(`${label} is invalid.`); return deepFreeze([...new Set(value)].sort()); }
function validColumnDefault(column: SchemaColumn): boolean { const value = column.default; if (value === undefined) return true; if (value === null) return column.nullable === true; if (column.type === "text" || column.type === "json" || column.type === "blob") return typeof value === "string"; if (column.type === "integer") return Number.isSafeInteger(value); if (column.type === "real") return typeof value === "number" && Number.isFinite(value); return column.type === "boolean" && typeof value === "boolean"; }
function member<T extends string>(value: unknown, values: readonly T[], label: string): T { if (!values.includes(value as T)) throw new TypeError(`${label} is invalid.`); return value as T; }
function clone(value: unknown): any { return JSON.parse(canonical(value)); }
function canonical(value: unknown): string { if (value === undefined) return "null"; if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value); if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; throw new TypeError("Value must be JSON data."); }
function plain(value: unknown): value is Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as any)) deepFreeze(child); Object.freeze(value); } return value; }
