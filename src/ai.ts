import { batch, computed, signal, type Computed, type ReactiveSignal } from "./core.ts";
import type { Component } from "./dom.ts";
import { registerBuiltinSchema } from "./schema-internal.ts";
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
  declare readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "value"}: ${issue.message}`).join("; "));
    this.issues = issues;
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

type Parser<T> = (input: unknown, path: ReadonlyArray<string | number>) => T;
/** Sentinel returned by fast validators when input fails and needs slow-path issue reporting. */
const FAST_FAIL = Symbol("clank.fast-fail");
type FastValidator = (input: unknown) => unknown;
const fastValidators = new WeakMap<Schema<any>, FastValidator>();
/** Inline primitive validator kinds: 1 = plain string, 2 = plain finite number, 3 = boolean. */
const fastKinds = new WeakMap<Schema<any>, number>();
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
/**
 * Every schema parses from its own root: a parent adds its key to a child's
 * issues only when one is thrown. Parsers therefore share one empty path and
 * never retain it, so a successful parse allocates no path arrays at all.
 */
const ROOT_PATH: ReadonlyArray<string | number> = Object.freeze([]);

class SchemaValue<T> implements Schema<T> {
  declare readonly description?: string;
  readonly _parser: Parser<T>;
  readonly _fast: FastValidator | undefined;
  readonly _json: Record<string, unknown>;
  constructor(parser: Parser<T>, json: Record<string, unknown>, description?: string, fast?: FastValidator) {
    this._parser = parser;
    this._fast = fast;
    this._json = json;
    this.description = description;
  }

  parse(input: unknown): T {
    const fast = this._fast;
    if (fast !== undefined) {
      const result = fast(input);
      if (result !== FAST_FAIL) return result as T;
    }
    return this._parser(input, ROOT_PATH);
  }

  safeParse(input: unknown): { success: true; data: T } | { success: false; error: ValidationError } {
    const fast = this._fast;
    if (fast !== undefined) {
      const result = fast(input);
      if (result !== FAST_FAIL) return { success: true, data: result as T };
    }
    try {
      return { success: true, data: this._parser(input, ROOT_PATH) };
    } catch (error) {
      return { success: false, error: error instanceof ValidationError ? error : new ValidationError([{ path: [], message: String(error) }]) };
    }
  }

  toJSONSchema(): Record<string, unknown> {
    const output = structuredClone(this._json);
    return this.description ? { ...output, description: this.description } : output;
  }
}

function issue(path: ReadonlyArray<string | number>, message: string, expected?: string, received?: unknown): never {
  throw new ValidationError([{ path: [...path], message, expected, received }]);
}

function schemaValue<T>(
  parser: Parser<T>,
  json: Record<string, unknown>,
  description?: string,
  children: readonly Schema[] | false = [],
  fast?: FastValidator,
  kind?: number,
): Schema<T> {
  const schema = new SchemaValue(parser, json, description, fast);
  if (fast !== undefined) fastValidators.set(schema, fast);
  if (kind !== undefined) fastKinds.set(schema, kind);
  if (children) registerBuiltinSchema(schema, children);
  return schema;
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
    return schemaValue((input, path) => typeof input === "string" && ID_PATTERN.test(input)
      ? input as DocumentId<Table>
      : issue(path, `Expected an ID for ${table}.`, `id<${table}>`, input), {
      type: "string",
      format: "clank-id",
      table,
    }, description, [], (input) => typeof input === "string" && ID_PATTERN.test(input) ? input : FAST_FAIL);
  },

  string(options: { description?: string; min?: number; max?: number; pattern?: RegExp } = {}): Schema<string> {
    const min = options.min;
    const max = options.max;
    const pattern = options.pattern ? new RegExp(options.pattern.source, options.pattern.flags) : undefined;
    const plain = min === undefined && max === undefined && pattern === undefined;
    const fast: FastValidator = plain
      ? (input) => typeof input === "string" ? input : FAST_FAIL
      : (input) => {
          if (typeof input !== "string") return FAST_FAIL;
          if (min !== undefined && input.length < min) return FAST_FAIL;
          if (max !== undefined && input.length > max) return FAST_FAIL;
          if (pattern !== undefined) {
            pattern.lastIndex = 0;
            if (!pattern.test(input)) return FAST_FAIL;
          }
          return input;
        };
    return schemaValue((input, path) => {
      if (typeof input !== "string") return issue(path, "Expected a string.", "string", input);
      if (min !== undefined && input.length < min) return issue(path, `Must contain at least ${min} characters.`);
      if (max !== undefined && input.length > max) return issue(path, `Must contain at most ${max} characters.`);
      if (pattern) {
        pattern.lastIndex = 0;
        if (!pattern.test(input)) return issue(path, `Must match ${pattern}.`);
      }
      return input;
    }, {
      type: "string",
      ...(min === undefined ? {} : { minLength: min }),
      ...(max === undefined ? {} : { maxLength: max }),
      ...(pattern ? { pattern: pattern.source,
        ...(pattern.flags ? { "x-clank-pattern-flags": pattern.flags } : {}) } : {}),
    }, options.description, [], fast, plain ? 1 : undefined);
  },

  email(options: { description?: string; min?: number; max?: number } = {}): Schema<string> {
    const min = options.min;
    const max = options.max;
    const fast: FastValidator = (input) => {
      if (typeof input !== "string") return FAST_FAIL;
      if (min !== undefined && input.length < min) return FAST_FAIL;
      if (max !== undefined && input.length > max) return FAST_FAIL;
      return EMAIL_PATTERN.test(input) ? input : FAST_FAIL;
    };
    return schemaValue((input, path) => {
      if (typeof input !== "string") return issue(path, "Expected an email address.", "email", input);
      if (min !== undefined && input.length < min) return issue(path, `Must contain at least ${min} characters.`);
      if (max !== undefined && input.length > max) return issue(path, `Must contain at most ${max} characters.`);
      if (!EMAIL_PATTERN.test(input)) return issue(path, "Expected a valid email address.", "email", input);
      return input;
    }, {
      type: "string",
      format: "email",
      ...(min === undefined ? {} : { minLength: min }),
      ...(max === undefined ? {} : { maxLength: max }),
    }, options.description, [], fast);
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
        || !validDate(input.slice(0, 10))
        || !Number.isFinite(Date.parse(input))
      ) return issue(path, "Expected an ISO 8601 date-time with a timezone.", "date-time", input);
      return input;
    }, { type: "string", format: "date-time" }, description);
  },

  number(options: { description?: string; min?: number; max?: number; integer?: boolean } = {}): Schema<number> {
    const min = options.min;
    const max = options.max;
    const integer = options.integer === true;
    const plain = !integer && min === undefined && max === undefined;
    const fast: FastValidator = plain
      ? (input) => typeof input === "number" && Number.isFinite(input) ? input : FAST_FAIL
      : (input) => {
          if (typeof input !== "number" || !Number.isFinite(input)) return FAST_FAIL;
          if (integer && !Number.isInteger(input)) return FAST_FAIL;
          if (min !== undefined && input < min) return FAST_FAIL;
          if (max !== undefined && input > max) return FAST_FAIL;
          return input;
        };
    return schemaValue((input, path) => {
      if (typeof input !== "number" || !Number.isFinite(input)) return issue(path, "Expected a finite number.", "number", input);
      if (integer && !Number.isInteger(input)) return issue(path, "Expected an integer.", "integer", input);
      if (min !== undefined && input < min) return issue(path, `Must be at least ${min}.`);
      if (max !== undefined && input > max) return issue(path, `Must be at most ${max}.`);
      return input;
    }, {
      type: integer ? "integer" : "number",
      ...(min === undefined ? {} : { minimum: min }),
      ...(max === undefined ? {} : { maximum: max }),
    }, options.description, [], fast, plain ? 2 : undefined);
  },

  boolean(description?: string): Schema<boolean> {
    return schemaValue(
      (input, path) => typeof input === "boolean" ? input : issue(path, "Expected a boolean.", "boolean", input),
      { type: "boolean" },
      description,
      [],
      (input) => typeof input === "boolean" ? input : FAST_FAIL,
      3,
    );
  },

  literal<const T extends string | number | boolean | null>(value: T, description?: string): Schema<T> {
    return schemaValue(
      (input, path) => Object.is(input, value) ? value : issue(path, `Expected ${JSON.stringify(value)}.`, JSON.stringify(value), input),
      { const: value },
      description,
      [],
      (input) => Object.is(input, value) ? value : FAST_FAIL,
    );
  },

  enum<const T extends readonly string[]>(values: T, description?: string): Schema<T[number]> {
    const members = Object.freeze([...values]) as readonly string[];
    if (members.length === 0) throw new TypeError("s.enum() requires at least one value.");
    const lookup = new Set(members);
    if (lookup.size !== members.length) throw new TypeError("s.enum() values must be unique.");
    return schemaValue((input, path) => typeof input === "string" && lookup.has(input)
      ? input as T[number]
      : issue(path, `Expected one of: ${members.join(", ")}.`, "enum", input), { type: "string", enum: [...members] }, description, [],
      (input) => typeof input === "string" && lookup.has(input) ? input : FAST_FAIL);
  },

  unknown(description?: string): Schema<unknown> {
    return schemaValue((input) => input, { optional: true }, description, [], (input) => input);
  },

  array<T>(item: Schema<T>, options: { description?: string; min?: number; max?: number } = {}): Schema<T[]> {
    const min = options.min;
    const max = options.max;
    const itemFast = fastValidators.get(item);
    const itemKind = fastKinds.get(item);
    const fast: FastValidator | undefined = itemKind === 1 && min === undefined && max === undefined
      ? (input) => {
          if (!Array.isArray(input)) return FAST_FAIL;
          const length = input.length;
          for (let i = 0; i < length; i++) if (typeof input[i] !== "string") return FAST_FAIL;
          return input.slice();
        }
      : itemKind === 2 && min === undefined && max === undefined
        ? (input) => {
            if (!Array.isArray(input)) return FAST_FAIL;
            const length = input.length;
            for (let i = 0; i < length; i++) {
              const v = input[i];
              if (typeof v !== "number" || !Number.isFinite(v)) return FAST_FAIL;
            }
            return input.slice();
          }
        : itemFast
          ? (input) => {
              if (!Array.isArray(input)) return FAST_FAIL;
              const length = input.length;
              if (min !== undefined && length < min) return FAST_FAIL;
              if (max !== undefined && length > max) return FAST_FAIL;
              const output = new Array<T>(length);
              for (let index = 0; index < length; index++) {
                const parsed = itemFast(input[index]);
                if (parsed === FAST_FAIL) return FAST_FAIL;
                output[index] = parsed as T;
              }
              return output;
            }
          : undefined;
    return schemaValue((input, path) => {
      if (!Array.isArray(input)) return issue(path, "Expected an array.", "array", input);
      if (min !== undefined && input.length < min) return issue(path, `Must contain at least ${min} items.`);
      if (max !== undefined && input.length > max) return issue(path, `Must contain at most ${max} items.`);
      const issues: ValidationIssue[] = [];
      const output = new Array<T>(input.length);
      for (let index = 0; index < input.length; index++) {
        try { output[index] = parseAt(item, input[index], path, index); }
        catch (error) {
          if (error instanceof ValidationError) issues.push(...error.issues);
          else throw error;
        }
      }
      if (issues.length) throw new ValidationError(issues);
      return output;
    }, {
      type: "array",
      items: item.toJSONSchema(),
      ...(min === undefined ? {} : { minItems: min }),
      ...(max === undefined ? {} : { maxItems: max }),
    }, options.description, [item], fast);
  },

  record<T>(
    value: Schema<T>,
    options: { description?: string; keyPattern?: RegExp } = {},
  ): Schema<Record<string, T>> {
    const keyPattern = options.keyPattern
      ? new RegExp(options.keyPattern.source, options.keyPattern.flags)
      : undefined;
    const valueFast = fastValidators.get(value);
    const fast: FastValidator | undefined = valueFast
      ? (input) => {
          if (!input || typeof input !== "object" || Array.isArray(input)) return FAST_FAIL;
          const source = input as Record<string, unknown>;
          const output: Record<string, T> = {};
          for (const key in source) {
            if (!Object.hasOwn(source, key)) continue;
            if (key === "__proto__" || key === "prototype" || key === "constructor") return FAST_FAIL;
            if (keyPattern !== undefined) {
              keyPattern.lastIndex = 0;
              if (!keyPattern.test(key)) return FAST_FAIL;
            }
            const parsed = valueFast(source[key]);
            if (parsed === FAST_FAIL) return FAST_FAIL;
            output[key] = parsed as T;
          }
          return output;
        }
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
        try { output[key] = parseAt(value, entry, path, key); }
        catch (error) { if (error instanceof ValidationError) issues.push(...error.issues); else throw error; }
      }
      if (issues.length) throw new ValidationError(issues);
      return output;
    }, {
      type: "object",
      additionalProperties: value.toJSONSchema(),
      ...(keyPattern ? { propertyNames: { pattern: keyPattern.source,
        ...(keyPattern.flags ? { "x-clank-pattern-flags": keyPattern.flags } : {}) } } : {}),
    }, options.description, [value], fast);
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
    // The shape is frozen, so its keys and members are fixed for every parse.
    const keys = Object.keys(safeShape);
    const members = keys.map((key) => safeShape[key]!);
    const loose = settings.strict === false;
    const memberFasts = members.map((member) => fastValidators.get(member));
    const memberKinds = members.map((member) => fastKinds.get(member) ?? 0);
    const hasProtoKey = keys.includes("__proto__");
    const safeKeys = keys.every((key) => !(key in Object.prototype));
    const allFast = !hasProtoKey && safeKeys && memberFasts.every((fn) => fn !== undefined);
    const keyCount = keys.length;
    const fast: FastValidator | undefined = allFast
      ? keyCount === 0
        ? (input) => {
            if (!input || typeof input !== "object" || Array.isArray(input)) return FAST_FAIL;
            const output: Record<string, unknown> = { ...(input as Record<string, unknown>) };
            if (!loose) { for (const _ in output) return FAST_FAIL; }
            return output;
          }
        : (input) => {
            if (!input || typeof input !== "object" || Array.isArray(input)) return FAST_FAIL;
            const source = input as Record<string, unknown>;
            const output: Record<string, unknown> = { ...source };
            let matched = 0;
            for (let index = 0; index < keyCount; index++) {
              const key = keys[index]!;
              const val = output[key];
              const kind = memberKinds[index]!;
              if (val !== undefined) {
                matched++;
                if (kind === 1) { if (typeof val !== "string") return FAST_FAIL; continue; }
                if (kind === 2) { if (typeof val !== "number" || !Number.isFinite(val)) return FAST_FAIL; continue; }
                if (kind === 3) { if (typeof val !== "boolean") return FAST_FAIL; continue; }
                const parsed = memberFasts[index]!(val);
                if (parsed === FAST_FAIL) return FAST_FAIL;
                if (parsed !== val) output[key] = parsed;
              } else {
                const own = Object.hasOwn(output, key);
                if (!own && Object.hasOwn(source, key)) return FAST_FAIL;
                if (kind !== 0) return FAST_FAIL;
                const parsed = memberFasts[index]!(undefined);
                if (parsed === FAST_FAIL) return FAST_FAIL;
                output[key] = parsed;
                matched++;
              }
            }
            if (!loose) {
              let ownCount = 0;
              for (const _ in output) ownCount++;
              if (ownCount !== matched) return FAST_FAIL;
            }
            return output;
          }
      : undefined;
    return schemaValue((input, path) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return issue(path, "Expected an object.", "object", input);
      const source = input as Record<string, unknown>;
      const output: Record<string, unknown> = loose ? { ...source } : {};
      let issues: ValidationIssue[] | undefined;
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        try {
          const parsed = parseAt(members[index]!, Object.hasOwn(source, key) ? source[key] : undefined, path, key);
          // Assignment defines an own property for every key except the one that names the prototype.
          if (key === "__proto__") Object.defineProperty(output, key, { value: parsed, enumerable: true, writable: true, configurable: true });
          else output[key] = parsed;
        }
        catch (error) { if (error instanceof ValidationError) (issues ??= []).push(...error.issues); else throw error; }
      }
      if (!loose) {
        for (const key of Object.keys(source)) if (!Object.hasOwn(safeShape, key)) (issues ??= []).push({ path: [...path, key], message: "Unknown property." });
      }
      if (issues) throw new ValidationError(issues);
      return output as InferShape<S>;
    }, {
      type: "object",
      properties,
      required,
      additionalProperties: settings.strict === false,
    }, settings.description, Object.values(safeShape), fast);
  },

  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    const innerFast = fastValidators.get(inner);
    return schemaValue(
      (input, path) => input === undefined ? undefined : parseAt(inner, input, path),
      { ...inner.toJSONSchema(), optional: true },
      undefined,
      [inner],
      innerFast ? (input) => input === undefined ? undefined : innerFast(input) : undefined,
    );
  },

  nullable<T>(inner: Schema<T>): Schema<T | null> {
    const json = { ...inner.toJSONSchema() }, optional = json.optional === true;
    delete json.optional;
    const innerFast = fastValidators.get(inner);
    return schemaValue((input, path) => input === null ? null : parseAt(inner, input, path), {
      anyOf: [json, { type: "null" }], ...(optional ? { optional: true } : {}),
    }, undefined, [inner], innerFast ? (input) => input === null ? null : innerFast(input) : undefined);
  },

  default<T>(inner: Schema<T>, fallback: T): Schema<T> {
    const snapshot = structuredClone(fallback);
    const primitiveFallback = snapshot === null || typeof snapshot !== "object";
    const innerFast = fastValidators.get(inner);
    return schemaValue(
      (input, path) => input === undefined ? (primitiveFallback ? snapshot : structuredClone(snapshot)) : parseAt(inner, input, path),
      { ...inner.toJSONSchema(), default: structuredClone(snapshot), optional: true },
      inner.description,
      [inner],
      innerFast ? (input) => input === undefined ? (primitiveFallback ? snapshot : structuredClone(snapshot)) : innerFast(input) : undefined,
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
      const approved: unknown = predicate(value);
      if (typeof approved !== "boolean") {
        // Predicates are synchronous. Contain a rejected promise/thenable from
        // an incorrectly implemented JavaScript predicate before failing closed.
        void Promise.resolve(approved).catch(() => undefined);
        throw new TypeError("s.refine() predicates must return booleans synchronously.");
      }
      return approved ? value : issue(path, message);
    }, { ...inner.toJSONSchema(), "x-clank-refinement": true }, description ?? inner.description, false);
  },

  union<T extends readonly Schema[]>(members: T, description?: string): Schema<Infer<T[number]>> {
    const alternatives = Object.freeze([...members]) as readonly Schema[];
    const schemas = alternatives.map(member => ({ ...member.toJSONSchema() })), optional = schemas.some(schema => schema.optional === true);
    for (const schema of schemas) delete schema.optional;
    return schemaValue((input, path) => {
      const errors: ValidationIssue[] = [];
      for (const member of alternatives) {
        try { return parseAt(member, input, path) as Infer<T[number]>; }
        catch (error) { if (error instanceof ValidationError) errors.push(...error.issues); else throw error; }
      }
      return issue(path, `Did not match any union member (${errors.map((entry) => entry.message).join("; ")}).`, "union", input);
    }, { anyOf: schemas, ...(optional ? { optional: true } : {}) }, description, alternatives);
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

/** Parse a member, locating any issue it reports under `path` (and `key`, when the member is a property or item). */
function parseAt<T>(schema: Schema<T>, input: unknown, path: ReadonlyArray<string | number>, key?: string | number): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(error.issues.map((entry) => ({
        ...entry,
        path: key === undefined ? [...path, ...entry.path] : [...path, key, ...entry.path],
      })));
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
  declare readonly cause: unknown;
  constructor(cause: unknown) {
    super("The action returned an invalid result.");
    this.cause = cause;
  }
}

export class ActionError extends Error {
  readonly name = "ActionError";
  declare readonly code: string; declare readonly status: number; declare readonly details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code; this.status = status; this.details = details;
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
        return problem(500, "ACTION_FAILED", "The action failed.");
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
  checked?: boolean | "mixed";
  selected?: boolean;
  pressed?: boolean | "mixed";
  current?: boolean | string;
  orientation?: "horizontal" | "vertical";
  activeDescendant?: string;
  hasPopup?: string;
  valueMin?: number;
  valueMax?: number;
  valueNow?: number;
  valueText?: string;
  part?: string;
  state?: string;
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
    const multiple = (tag === "select" && Boolean(control.multiple)) || element.getAttribute("aria-multiselectable") === "true";
    const ariaChecked = booleanOrMixed(element.getAttribute("aria-checked"));
    const checked = inputType === "checkbox" || inputType === "radio"
      ? Boolean(control.checked)
      : ariaChecked;
    const selected = booleanAttribute(element.getAttribute("aria-selected"));
    const pressed = booleanOrMixed(element.getAttribute("aria-pressed"));
    const current = currentAttribute(element.getAttribute("aria-current"));
    const orientation = orientationAttribute(element.getAttribute("aria-orientation"));
    const activeDescendant = element.getAttribute("aria-activedescendant") ?? undefined;
    const hasPopup = element.getAttribute("aria-haspopup") ?? undefined;
    const valueMin = numberAttribute(element.getAttribute("aria-valuemin"));
    const valueMax = numberAttribute(element.getAttribute("aria-valuemax"));
    const valueNow = numberAttribute(element.getAttribute("aria-valuenow"));
    const valueText = element.getAttribute("aria-valuetext") ?? undefined;
    const part = element.getAttribute("data-clank-part") ?? undefined;
    const state = element.getAttribute("data-state") ?? undefined;
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
      ...(selected === undefined ? {} : { selected }),
      ...(pressed === undefined ? {} : { pressed }),
      ...(current === undefined ? {} : { current }),
      ...(orientation ? { orientation } : {}),
      ...(activeDescendant ? { activeDescendant } : {}),
      ...(hasPopup ? { hasPopup } : {}),
      ...(valueMin === undefined ? {} : { valueMin }),
      ...(valueMax === undefined ? {} : { valueMax }),
      ...(valueNow === undefined ? {} : { valueNow }),
      ...(valueText ? { valueText } : {}),
      ...(part ? { part } : {}),
      ...(state ? { state } : {}),
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

function booleanAttribute(value: string | null): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

function booleanOrMixed(value: string | null): boolean | "mixed" | undefined {
  return value === "mixed" ? "mixed" : booleanAttribute(value);
}

function currentAttribute(value: string | null): boolean | string | undefined {
  if (value === null || value === "false") return value === "false" ? false : undefined;
  return value === "true" ? true : value;
}

function orientationAttribute(value: string | null): "horizontal" | "vertical" | undefined {
  return value === "horizontal" || value === "vertical" ? value : undefined;
}

function numberAttribute(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
