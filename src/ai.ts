import { batch, computed, signal, type Computed, type ReactiveSignal } from "./core.ts";
import type { Component } from "./dom.ts";
import {
  RequestInputError,
  publicValidationIssues,
  readJsonRequest,
  requestOriginAllowed,
} from "./security.ts";

export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
  expected?: string;
  received?: unknown;
}

export class ValidationError extends Error {
  readonly name = "ValidationError";
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "value"}: ${issue.message}`).join("; "));
  }
}

export interface Schema<T = unknown> {
  readonly description?: string;
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: ValidationError };
  toJSONSchema(): Record<string, unknown>;
}

declare const DOCUMENT_ID_TABLE: unique symbol;
export type DocumentId<Table extends string> = string & { readonly [DOCUMENT_ID_TABLE]: Table };

type Parser<T> = (input: unknown, path: Array<string | number>) => T;

class SchemaValue<T> implements Schema<T> {
  constructor(
    private readonly parser: Parser<T>,
    private readonly json: Record<string, unknown>,
    readonly description?: string,
  ) {}

  parse(input: unknown): T {
    return this.parser(input, []);
  }

  safeParse(input: unknown): { success: true; data: T } | { success: false; error: ValidationError } {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error: error instanceof ValidationError ? error : new ValidationError([{ path: [], message: String(error) }]) };
    }
  }

  toJSONSchema(): Record<string, unknown> {
    const output = structuredClone(this.json);
    return this.description ? { ...output, description: this.description } : output;
  }
}

function issue(path: Array<string | number>, message: string, expected?: string, received?: unknown): never {
  throw new ValidationError([{ path, message, expected, received }]);
}

function schemaValue<T>(parser: Parser<T>, json: Record<string, unknown>, description?: string): Schema<T> {
  return new SchemaValue(parser, json, description);
}

export type InferSchema<S> = S extends Schema<infer T> ? T : never;
export type SchemaShape = Record<string, Schema<any>>;
export type InferSchemaShape<S extends SchemaShape> = {
  [K in keyof S as undefined extends InferSchema<S[K]> ? never : K]: InferSchema<S[K]>
} & {
  [K in keyof S as undefined extends InferSchema<S[K]> ? K : never]?: Exclude<InferSchema<S[K]>, undefined>
};
type Infer<S> = InferSchema<S>;
type Shape = SchemaShape;
type InferShape<S extends Shape> = InferSchemaShape<S>;

export const s = {
  id<const Table extends string>(table: Table, description?: string): Schema<DocumentId<Table>> {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table)) throw new TypeError(`Invalid table name for ID: ${table}`);
    return schemaValue((input, path) => typeof input === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(input)
      ? input as DocumentId<Table>
      : issue(path, `Expected an ID for ${table}.`, `id<${table}>`, input), {
      type: "string",
      format: "clank-id",
      table,
    }, description);
  },

  string(options: { description?: string; min?: number; max?: number; pattern?: RegExp } = {}): Schema<string> {
    const settings = {
      ...options,
      ...(options.pattern ? { pattern: new RegExp(options.pattern.source, options.pattern.flags) } : {}),
    };
    return schemaValue((input, path) => {
      if (typeof input !== "string") return issue(path, "Expected a string.", "string", input);
      if (settings.min !== undefined && input.length < settings.min) return issue(path, `Must contain at least ${settings.min} characters.`);
      if (settings.max !== undefined && input.length > settings.max) return issue(path, `Must contain at most ${settings.max} characters.`);
      if (settings.pattern) {
        settings.pattern.lastIndex = 0;
        if (!settings.pattern.test(input)) return issue(path, `Must match ${settings.pattern}.`);
      }
      return input;
    }, {
      type: "string",
      ...(settings.min === undefined ? {} : { minLength: settings.min }),
      ...(settings.max === undefined ? {} : { maxLength: settings.max }),
      ...(settings.pattern ? { pattern: settings.pattern.source } : {}),
    }, settings.description);
  },

  email(options: { description?: string; min?: number; max?: number } = {}): Schema<string> {
    const settings = { ...options };
    return schemaValue((input, path) => {
      if (typeof input !== "string") return issue(path, "Expected an email address.", "email", input);
      if (settings.min !== undefined && input.length < settings.min) return issue(path, `Must contain at least ${settings.min} characters.`);
      if (settings.max !== undefined && input.length > settings.max) return issue(path, `Must contain at most ${settings.max} characters.`);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input)) return issue(path, "Expected a valid email address.", "email", input);
      return input;
    }, {
      type: "string",
      format: "email",
      ...(settings.min === undefined ? {} : { minLength: settings.min }),
      ...(settings.max === undefined ? {} : { maxLength: settings.max }),
    }, settings.description);
  },

  url(options: {
    description?: string;
    protocols?: readonly ("http" | "https")[];
  } = {}): Schema<string> {
    const protocols = Object.freeze([...(options.protocols ?? ["http", "https"])]);
    if (protocols.length === 0) throw new TypeError("s.url() requires at least one allowed protocol.");
    return schemaValue((input, path) => {
      if (typeof input !== "string") return issue(path, "Expected a URL.", "url", input);
      let parsed: URL;
      try { parsed = new URL(input); }
      catch { return issue(path, "Expected an absolute URL.", "url", input); }
      if (!protocols.includes(parsed.protocol.slice(0, -1) as "http" | "https")) {
        return issue(path, `URL protocol must be one of: ${protocols.join(", ")}.`, "url", input);
      }
      return input;
    }, {
      type: "string",
      format: "uri",
      "x-clank-protocols": protocols,
    }, options.description);
  },

  date(description?: string): Schema<string> {
    return schemaValue((input, path) => {
      if (typeof input !== "string" || !validDate(input)) return issue(path, "Expected a calendar date in YYYY-MM-DD format.", "date", input);
      return input;
    }, { type: "string", format: "date" }, description);
  },

  datetime(description?: string): Schema<string> {
    return schemaValue((input, path) => {
      if (
        typeof input !== "string"
        || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(input)
        || !Number.isFinite(Date.parse(input))
      ) return issue(path, "Expected an ISO 8601 date-time with a timezone.", "date-time", input);
      return input;
    }, { type: "string", format: "date-time" }, description);
  },

  number(options: { description?: string; min?: number; max?: number; integer?: boolean } = {}): Schema<number> {
    const settings = { ...options };
    return schemaValue((input, path) => {
      if (typeof input !== "number" || !Number.isFinite(input)) return issue(path, "Expected a finite number.", "number", input);
      if (settings.integer && !Number.isInteger(input)) return issue(path, "Expected an integer.", "integer", input);
      if (settings.min !== undefined && input < settings.min) return issue(path, `Must be at least ${settings.min}.`);
      if (settings.max !== undefined && input > settings.max) return issue(path, `Must be at most ${settings.max}.`);
      return input;
    }, {
      type: settings.integer ? "integer" : "number",
      ...(settings.min === undefined ? {} : { minimum: settings.min }),
      ...(settings.max === undefined ? {} : { maximum: settings.max }),
    }, settings.description);
  },

  boolean(description?: string): Schema<boolean> {
    return schemaValue((input, path) => typeof input === "boolean" ? input : issue(path, "Expected a boolean.", "boolean", input), { type: "boolean" }, description);
  },

  literal<const T extends string | number | boolean | null>(value: T, description?: string): Schema<T> {
    return schemaValue((input, path) => Object.is(input, value) ? value : issue(path, `Expected ${JSON.stringify(value)}.`, JSON.stringify(value), input), { const: value }, description);
  },

  enum<const T extends readonly string[]>(values: T, description?: string): Schema<T[number]> {
    const members = Object.freeze([...values]) as readonly string[];
    if (members.length === 0) throw new TypeError("s.enum() requires at least one value.");
    if (new Set(members).size !== members.length) throw new TypeError("s.enum() values must be unique.");
    return schemaValue((input, path) => typeof input === "string" && members.includes(input)
      ? input as T[number]
      : issue(path, `Expected one of: ${members.join(", ")}.`, "enum", input), { type: "string", enum: [...members] }, description);
  },

  unknown(description?: string): Schema<unknown> {
    return schemaValue((input) => input, {}, description);
  },

  array<T>(item: Schema<T>, options: { description?: string; min?: number; max?: number } = {}): Schema<T[]> {
    const settings = { ...options };
    return schemaValue((input, path) => {
      if (!Array.isArray(input)) return issue(path, "Expected an array.", "array", input);
      if (settings.min !== undefined && input.length < settings.min) return issue(path, `Must contain at least ${settings.min} items.`);
      if (settings.max !== undefined && input.length > settings.max) return issue(path, `Must contain at most ${settings.max} items.`);
      const issues: ValidationIssue[] = [];
      const output = input.map((entry, index) => {
        try { return parseAt(item, entry, [...path, index]); }
        catch (error) {
          if (error instanceof ValidationError) issues.push(...error.issues);
          return undefined as T;
        }
      });
      if (issues.length) throw new ValidationError(issues);
      return output;
    }, {
      type: "array",
      items: item.toJSONSchema(),
      ...(settings.min === undefined ? {} : { minItems: settings.min }),
      ...(settings.max === undefined ? {} : { maxItems: settings.max }),
    }, settings.description);
  },

  record<T>(
    value: Schema<T>,
    options: { description?: string; keyPattern?: RegExp } = {},
  ): Schema<Record<string, T>> {
    const keyPattern = options.keyPattern
      ? new RegExp(options.keyPattern.source, options.keyPattern.flags)
      : undefined;
    return schemaValue((input, path) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return issue(path, "Expected a record object.", "record", input);
      const output: Record<string, T> = {};
      const issues: ValidationIssue[] = [];
      for (const [key, entry] of Object.entries(input)) {
        if (FORBIDDEN_RECORD_KEYS.has(key)) {
          issues.push({ path: [...path, key], message: "Unsafe record key." });
          continue;
        }
        if (keyPattern) {
          keyPattern.lastIndex = 0;
          if (!keyPattern.test(key)) {
            issues.push({ path: [...path, key], message: `Key must match ${keyPattern}.` });
            continue;
          }
        }
        try { output[key] = parseAt(value, entry, [...path, key]); }
        catch (error) { if (error instanceof ValidationError) issues.push(...error.issues); }
      }
      if (issues.length) throw new ValidationError(issues);
      return output;
    }, {
      type: "object",
      additionalProperties: value.toJSONSchema(),
      ...(keyPattern ? { propertyNames: { pattern: keyPattern.source } } : {}),
    }, options.description);
  },

  object<S extends Shape>(shape: S, options: { description?: string; strict?: boolean } = {}): Schema<InferShape<S>> {
    const safeShape = Object.freeze({ ...shape }) as S;
    const settings = { ...options };
    const required = Object.entries(safeShape)
      .filter(([, value]) => !(value.toJSONSchema() as { optional?: boolean }).optional)
      .map(([key]) => key);
    const properties = Object.fromEntries(Object.entries(safeShape).map(([key, value]) => {
      const json = value.toJSONSchema();
      delete json.optional;
      return [key, json];
    }));
    return schemaValue((input, path) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return issue(path, "Expected an object.", "object", input);
      const source = input as Record<string, unknown>;
      const output: Record<string, unknown> = settings.strict === false ? { ...source } : {};
      const issues: ValidationIssue[] = [];
      for (const [key, value] of Object.entries(safeShape)) {
        try { output[key] = parseAt(value, source[key], [...path, key]); }
        catch (error) { if (error instanceof ValidationError) issues.push(...error.issues); }
      }
      if (settings.strict !== false) {
        for (const key of Object.keys(source)) if (!Object.hasOwn(safeShape, key)) issues.push({ path: [...path, key], message: "Unknown property." });
      }
      if (issues.length) throw new ValidationError(issues);
      return output as InferShape<S>;
    }, {
      type: "object",
      properties,
      required,
      additionalProperties: settings.strict === false,
    }, settings.description);
  },

  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    return schemaValue((input, path) => input === undefined ? undefined : parseAt(inner, input, path), { ...inner.toJSONSchema(), optional: true });
  },

  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return schemaValue((input, path) => input === null ? null : parseAt(inner, input, path), { anyOf: [inner.toJSONSchema(), { type: "null" }] });
  },

  default<T>(inner: Schema<T>, fallback: T): Schema<T> {
    const snapshot = structuredClone(fallback);
    return schemaValue(
      (input, path) => input === undefined ? structuredClone(snapshot) : parseAt(inner, input, path),
      { ...inner.toJSONSchema(), default: structuredClone(snapshot), optional: true },
      inner.description,
    );
  },

  refine<T>(
    inner: Schema<T>,
    predicate: (value: T) => boolean,
    message: string,
    description?: string,
  ): Schema<T> {
    if (!message.trim()) throw new TypeError("s.refine() requires an error message.");
    return schemaValue((input, path) => {
      const value = parseAt(inner, input, path);
      return predicate(value) ? value : issue(path, message);
    }, inner.toJSONSchema(), description ?? inner.description);
  },

  union<T extends readonly Schema[]>(members: T, description?: string): Schema<Infer<T[number]>> {
    const alternatives = Object.freeze([...members]) as readonly Schema[];
    return schemaValue((input, path) => {
      const errors: ValidationIssue[] = [];
      for (const member of alternatives) {
        try { return parseAt(member, input, path) as Infer<T[number]>; }
        catch (error) { if (error instanceof ValidationError) errors.push(...error.issues); }
      }
      return issue(path, `Did not match any union member (${errors.map((entry) => entry.message).join("; ")}).`, "union", input);
    }, { anyOf: alternatives.map((member) => member.toJSONSchema()) }, description);
  },

  coerce: {
    number(options: { description?: string; min?: number; max?: number; integer?: boolean } = {}): Schema<number> {
      const settings = { ...options };
      return schemaValue((input, path) => {
        const value = typeof input === "number"
          ? input
          : typeof input === "string" && input.trim() !== ""
            ? Number(input)
            : Number.NaN;
        if (!Number.isFinite(value)) return issue(path, "Expected a number or numeric string.", "number", input);
        if (settings.integer && !Number.isInteger(value)) return issue(path, "Expected an integer.", "integer", input);
        if (settings.min !== undefined && value < settings.min) return issue(path, `Must be at least ${settings.min}.`);
        if (settings.max !== undefined && value > settings.max) return issue(path, `Must be at most ${settings.max}.`);
        return value;
      }, {
        type: settings.integer ? "integer" : "number",
        ...(settings.min === undefined ? {} : { minimum: settings.min }),
        ...(settings.max === undefined ? {} : { maximum: settings.max }),
        "x-clank-coerce": true,
      }, settings.description);
    },

    boolean(description?: string): Schema<boolean> {
      return schemaValue((input, path) => {
        if (typeof input === "boolean") return input;
        if (input === "true" || input === "1" || input === 1) return true;
        if (input === "false" || input === "0" || input === 0) return false;
        return issue(path, "Expected a boolean or true/false string.", "boolean", input);
      }, { type: "boolean", "x-clank-coerce": true }, description);
    },
  },
};

const FORBIDDEN_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function validDate(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseAt<T>(schema: Schema<T>, input: unknown, path: Array<string | number>): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(error.issues.map((entry) => ({ ...entry, path: [...path, ...entry.path] })));
    }
    throw error;
  }
}

export interface ActionContext {
  request?: Request;
  user?: unknown;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface ActionDefinition<I, O> {
  name: string;
  description: string;
  input: Schema<I>;
  output?: Schema<O>;
  handler: (input: I, context: ActionContext) => O | Promise<O>;
  sideEffects?: "none" | "read" | "write" | "destructive";
  confirmation?: "never" | "write" | "always";
  authorize?: (input: I, context: ActionContext) => boolean | Promise<boolean>;
}

export interface Action<I = unknown, O = unknown> {
  (input: I, context?: ActionContext): Promise<O>;
  readonly definition: ActionDefinition<I, O>;
  readonly manifest: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    sideEffects: string;
    confirmation: string;
  };
}

export function defineAction<I, O>(definition: ActionDefinition<I, O>): Action<I, O> {
  if (!/^[a-z][a-z0-9_.-]*$/i.test(definition.name)) throw new TypeError(`Invalid action name: ${definition.name}`);
  const invoke = async (raw: I, context: ActionContext = {}): Promise<O> => {
    const input = definition.input.parse(raw);
    if (definition.authorize && !await definition.authorize(input, context)) throw new ActionError("FORBIDDEN", "Action is not authorized.", 403);
    const output = await definition.handler(input, context);
    if (!definition.output) return output;
    try {
      return definition.output.parse(output);
    } catch (error) {
      throw new ActionOutputError(error);
    }
  };
  Object.defineProperties(invoke, {
    definition: { value: Object.freeze({ ...definition }), enumerable: true },
    manifest: {
      value: Object.freeze({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.input.toJSONSchema(),
        ...(definition.output ? { outputSchema: definition.output.toJSONSchema() } : {}),
        sideEffects: definition.sideEffects ?? "write",
        confirmation: definition.confirmation ?? (definition.sideEffects === "destructive" ? "always" : "write"),
      }),
      enumerable: true,
    },
  });
  return invoke as Action<I, O>;
}

class ActionOutputError extends Error {
  readonly name = "ActionOutputError";
  constructor(readonly cause: unknown) {
    super("The action returned an invalid result.");
  }
}

export class ActionError extends Error {
  readonly name = "ActionError";
  constructor(readonly code: string, message: string, readonly status = 400, readonly details?: unknown) {
    super(message);
  }
}

export interface AgentBridge {
  readonly actions: ReadonlyMap<string, Action<any, any>>;
  manifest(): { protocol: "clank-agent/1"; actions: Action["manifest"][] };
  invoke(name: string, input: unknown, context?: ActionContext): Promise<unknown>;
  handle(request: Request, context?: ActionContext): Promise<Response>;
}

export interface AgentBridgeOptions {
  allowedOrigins?: readonly string[];
  requireOrigin?: boolean;
  maxRequestBytes?: number;
  exposeErrors?: boolean;
}

export function createAgentBridge(actions: Action<any, any>[], options: AgentBridgeOptions = {}): AgentBridge {
  const registry = new Map<string, Action<any, any>>();
  for (const action of actions) {
    if (registry.has(action.manifest.name)) throw new TypeError(`Duplicate action: ${action.manifest.name}`);
    registry.set(action.manifest.name, action);
  }
  const bridge: AgentBridge = {
    actions: registry,
    manifest: () => ({ protocol: "clank-agent/1", actions: [...registry.values()].map((action) => action.manifest) }),
    async invoke(name, input, context = {}) {
      const action = registry.get(name);
      if (!action) throw new ActionError("NOT_FOUND", `Unknown action: ${name}`, 404);
      return action(input, context);
    },
    async handle(request, context = {}) {
      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname.endsWith("/.well-known/clank") || url.pathname.endsWith("/manifest"))) {
        return Response.json(bridge.manifest(), { headers: { "cache-control": "no-store" } });
      }
      const marker = "/actions/";
      const index = url.pathname.lastIndexOf(marker);
      if (request.method !== "POST" || index === -1) return problem(404, "NOT_FOUND", "Agent endpoint not found.");
      try {
        if (!requestOriginAllowed(request, options)) return problem(403, "ORIGIN_MISMATCH", "Cross-origin agent request rejected.");
        let name: string;
        try {
          name = decodeURIComponent(url.pathname.slice(index + marker.length));
        } catch {
          throw new RequestInputError(400, "INVALID_PATH", "The action path is not valid URL encoding.");
        }
        const action = registry.get(name);
        if (!action) throw new ActionError("NOT_FOUND", "Action not found.", 404);
        const needsConfirmation = action.manifest.confirmation === "always"
          || (action.manifest.confirmation === "write"
            && (action.manifest.sideEffects === "write" || action.manifest.sideEffects === "destructive"));
        const confirmation = request.headers.get("x-clank-confirmation")
          ?? request.headers.get("x-proact-confirmation");
        if (needsConfirmation && confirmation !== "confirmed") {
          throw new ActionError(
            "CONFIRMATION_REQUIRED",
            "This action requires explicit confirmation.",
            428,
          );
        }
        const input = await readJsonRequest(request, options.maxRequestBytes ?? 64 * 1024);
        const output = await action(input, { ...context, request, signal: request.signal });
        return Response.json({ ok: true, output });
      } catch (error) {
        if (error instanceof RequestInputError) return problem(error.status, error.code, error.message);
        if (error instanceof ValidationError) return problem(422, "INVALID_INPUT", error.message, publicValidationIssues(error.issues));
        if (error instanceof ActionError) return problem(error.status, error.code, error.message, error.details);
        return problem(500, "ACTION_FAILED", options.exposeErrors
          ? error instanceof Error ? error.message : String(error)
          : "The action failed.");
      }
    },
  };
  return bridge;
}

function problem(status: number, code: string, message: string, details?: unknown): Response {
  return Response.json(
    { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export interface ActionRunner<I, O> {
  pending: ReactiveSignal<boolean>;
  data: ReactiveSignal<O | undefined>;
  error: ReactiveSignal<unknown>;
  canRun: Computed<boolean>;
  run(input: I, context?: ActionContext): Promise<O | undefined>;
  reset(): void;
}

export function actionRunner<I, O>(action: Action<I, O>): ActionRunner<I, O> {
  const pending = signal(false);
  const data = signal<O | undefined>(undefined);
  const error = signal<unknown>(undefined);
  const canRun = computed(() => !pending.value);
  let revision = 0;
  return {
    pending,
    data,
    error,
    canRun,
    async run(input, context) {
      const run = ++revision;
      batch(() => { pending.value = true; error.value = undefined; });
      try {
        const output = await action(input, context);
        if (run === revision) batch(() => { data.value = output; pending.value = false; });
        return output;
      } catch (reason) {
        if (run === revision) batch(() => { error.value = reason; pending.value = false; });
        return undefined;
      }
    },
    reset() {
      revision++;
      batch(() => { pending.value = false; data.value = undefined; error.value = undefined; });
    },
  };
}

export interface ViewDefinition<P extends Record<string, unknown>> {
  name: string;
  description: string;
  props?: Schema<P>;
  render: Component<P>;
}

export type AgentView<P extends Record<string, unknown>> = Component<P> & {
  viewManifest: { name: string; description: string; propsSchema?: Record<string, unknown> };
};

export function defineView<P extends Record<string, unknown>>(definition: ViewDefinition<P>): AgentView<P> {
  const view = ((props: P & { children: import("./dom.ts").Renderable[] }) => {
    const { children, ...input } = props;
    const parsed = definition.props ? definition.props.parse(input) : input as unknown as P;
    return definition.render({ ...parsed, children: props.children });
  }) as AgentView<P>;
  Object.defineProperty(view, "viewManifest", {
    value: Object.freeze({
      name: definition.name,
      description: definition.description,
      ...(definition.props ? { propsSchema: definition.props.toJSONSchema() } : {}),
    }),
  });
  return view;
}

export interface AgentNode {
  id?: string;
  tag: string;
  role?: string;
  label?: string;
  description?: string;
  intent?: string;
  action?: string;
  name?: string;
  type?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  invalid?: boolean;
  expanded?: boolean;
  checked?: boolean;
  multiple?: boolean;
  value?: string | string[];
  placeholder?: string;
  href?: string;
  children?: AgentNode[];
}

/** Produces a compact semantic UI tree so agents do not need pixels or brittle selectors. */
export function inspectAgentSurface(root: ParentNode): AgentNode[] {
  const visit = (element: Element): AgentNode | null => {
    const tag = element.tagName.toLowerCase();
    const inputType = tag === "input" ? (element.getAttribute("type") ?? "text").toLowerCase() : undefined;
    if (
      element.hasAttribute("data-clank-hidden")
      || element.hasAttribute("hidden")
      || element.getAttribute("aria-hidden") === "true"
      || inputType === "hidden"
    ) return null;
    const children = [...element.children].map(visit).filter((entry): entry is AgentNode => entry !== null);
    const role = element.getAttribute("role") ?? implicitRole(tag, inputType, element);
    const id = element.getAttribute("data-clank-id") ?? element.getAttribute("id") ?? undefined;
    const interactive = Boolean(id || role || ["a", "button", "input", "select", "textarea", "summary"].includes(tag));
    const semantic = interactive || element.hasAttribute("data-clank-intent") || element.hasAttribute("data-clank-action");
    if (!semantic && children.length === 0) return null;
    const control = element as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
    const label = accessibleLabel(root, element, semantic);
    const disabled = Boolean(control.disabled) || element.getAttribute("aria-disabled") === "true";
    const readOnly = Boolean(control.readOnly) || element.getAttribute("aria-readonly") === "true";
    const required = Boolean(control.required) || element.getAttribute("aria-required") === "true";
    const invalid = element.getAttribute("aria-invalid");
    const expanded = element.getAttribute("aria-expanded");
    const name = element.getAttribute("name") ?? undefined;
    const placeholder = element.getAttribute("placeholder") ?? undefined;
    const multiple = tag === "select" && Boolean(control.multiple);
    const checked = inputType === "checkbox" || inputType === "radio"
      ? Boolean(control.checked)
      : undefined;
    const value = agentControlValue(element, tag, inputType, multiple);
    return {
      ...(id ? { id } : {}),
      tag,
      ...(role ? { role } : {}),
      ...(label ? { label } : {}),
      ...(element.getAttribute("data-clank-description") ? { description: element.getAttribute("data-clank-description")! } : {}),
      ...(element.getAttribute("data-clank-intent") ? { intent: element.getAttribute("data-clank-intent")! } : {}),
      ...(element.getAttribute("data-clank-action") ? { action: element.getAttribute("data-clank-action")! } : {}),
      ...(name ? { name } : {}),
      ...(inputType ? { type: inputType } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(readOnly ? { readonly: true } : {}),
      ...(required ? { required: true } : {}),
      ...(invalid === "true" ? { invalid: true } : {}),
      ...(expanded === "true" ? { expanded: true } : expanded === "false" ? { expanded: false } : {}),
      ...(checked === undefined ? {} : { checked }),
      ...(multiple ? { multiple: true } : {}),
      ...(value === undefined ? {} : { value }),
      ...(placeholder ? { placeholder } : {}),
      ...(tag === "a" && typeof (control as unknown as HTMLAnchorElement).href === "string"
        ? { href: (control as unknown as HTMLAnchorElement).href }
        : {}),
      ...(children.length ? { children } : {}),
    };
  };
  return [...root.children].map(visit).filter((entry): entry is AgentNode => entry !== null);
}

export interface AgentSurface {
  inspect(): AgentNode[];
  activate(id: string): boolean;
  input(id: string, value: string | number | boolean | readonly string[]): boolean;
}

export function createAgentSurface(root: ParentNode): AgentSurface {
  const find = (id: string): HTMLElement | null => {
    for (const element of root.querySelectorAll<HTMLElement>("[data-clank-id], [id]")) {
      if (element.getAttribute("data-clank-id") === id || element.id === id) return element;
    }
    return null;
  };
  return {
    inspect: () => inspectAgentSurface(root),
    activate(id) {
      const element = find(id);
      if (
        !element
        || (element as HTMLButtonElement).disabled
        || element.getAttribute("aria-disabled") === "true"
      ) return false;
      element.click();
      return true;
    },
    input(id, value) {
      const element = find(id) as (HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement) | null;
      if (
        !element
        || element.disabled
        || element.readOnly
        || element.getAttribute("aria-disabled") === "true"
        || element.getAttribute("aria-readonly") === "true"
      ) return false;
      const tag = element.tagName.toLowerCase();
      const type = tag === "input" ? (element.type || "text").toLowerCase() : "";
      if (type === "file" || type === "hidden") return false;
      if (type === "checkbox" || type === "radio") {
        if (typeof value !== "boolean") return false;
        element.checked = value;
      } else if (tag === "select" && element.multiple) {
        if (!Array.isArray(value)) return false;
        const selected = new Set(value.map(String));
        for (const option of element.options) option.selected = selected.has(option.value);
      } else if (element.isContentEditable) {
        if (typeof value === "boolean" || Array.isArray(value)) return false;
        element.textContent = String(value);
      } else {
        if (!("value" in element) || typeof value === "boolean" || Array.isArray(value)) return false;
        element.value = String(value);
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
  };
}

function implicitRole(tag: string, inputType: string | undefined, element: Element): string | undefined {
  if (tag === "button") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "select") return element.hasAttribute("multiple") ? "listbox" : "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (tag !== "input") return undefined;
  if (inputType === "checkbox") return "checkbox";
  if (inputType === "radio") return "radio";
  if (inputType === "range") return "slider";
  if (inputType === "button" || inputType === "submit" || inputType === "reset") return "button";
  return "textbox";
}

function accessibleLabel(root: ParentNode, element: Element, semantic: boolean): string | undefined {
  const direct = element.getAttribute("data-clank-label") ?? element.getAttribute("aria-label");
  if (direct?.trim()) return compactLabel(direct);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labels = labelledBy.split(/\s+/).flatMap((id) => {
      for (const candidate of root.querySelectorAll<HTMLElement>("[id]")) {
        if (candidate.id === id) return [candidate.textContent ?? ""];
      }
      return [];
    });
    const combined = compactLabel(labels.join(" "));
    if (combined) return combined;
  }
  const control = element as HTMLInputElement;
  const nativeLabels = control.labels ? [...control.labels].map((label) => label.textContent ?? "") : [];
  if (nativeLabels.length) {
    const combined = compactLabel(nativeLabels.join(" "));
    if (combined) return combined;
  }
  const id = element.getAttribute("id");
  if (id) {
    for (const label of root.querySelectorAll<HTMLElement>("label")) {
      if (label.getAttribute("for") === id) {
        const text = compactLabel(label.textContent ?? "");
        if (text) return text;
      }
    }
  }
  const implicit = element.closest?.("label");
  if (implicit) {
    const text = compactLabel(implicit.textContent ?? "");
    if (text) return text;
  }
  const fallback = element.getAttribute("placeholder")
    ?? element.getAttribute("title")
    ?? (semantic ? element.textContent : undefined);
  const text = compactLabel(fallback ?? "");
  return text || undefined;
}

function compactLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

function agentControlValue(
  element: Element,
  tag: string,
  inputType: string | undefined,
  multiple: boolean,
): string | string[] | undefined {
  if (tag === "input" && (inputType === "password" || inputType === "file")) return undefined;
  const control = element as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
  if (tag === "select" && multiple) return [...control.selectedOptions].map((option) => option.value);
  if ((tag === "input" || tag === "select" || tag === "textarea") && typeof control.value === "string") {
    return control.value;
  }
  if ((element as HTMLElement).isContentEditable) return element.textContent ?? "";
  return undefined;
}
