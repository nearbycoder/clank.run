import type { FunctionReference } from "./backend.ts";

const ACTION_PATH = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const CONTRACT_REVISION = /^mcp-[a-f0-9]{32}$/u;
const MAX_SURFACE_BYTES = 8 * 1024 * 1024;
const MAX_CONTROLS = 10_000;
const MAX_FUNCTIONS = 2_048;

export type AgentActionTarget =
  | string
  | FunctionReference<"query" | "mutation", any, any>;

export interface AgentActionControl {
  path: string;
  id?: string;
  label?: string;
  tag: string;
}

export interface AgentBackendFunctionManifest {
  name: string;
  kind: "query" | "mutation";
  agent: boolean;
  description?: string;
}

export interface AgentBackendManifest {
  protocol: "clank-live/1";
  contractRevision: string | null;
  functions: readonly AgentBackendFunctionManifest[];
}

export type AgentActionParityIssueCode =
  | "REVISION_MISMATCH"
  | "MCP_DISABLED"
  | "MISSING_CONTROL_ID"
  | "DUPLICATE_CONTROL_ID"
  | "UNKNOWN_ACTION"
  | "INTERNAL_ACTION"
  | "MISSING_DESCRIPTION"
  | "MISSING_UI_ACTION";

export interface AgentActionParityIssue {
  code: AgentActionParityIssueCode;
  message: string;
  action?: string;
  controlId?: string;
}

export interface AgentActionParityOptions {
  /** Actions that must be represented by at least one rendered control. */
  requiredActions?: readonly AgentActionTarget[];
  /** Expected deployment-sensitive backend/MCP contract revision. */
  expectedRevision?: string | null;
  /** Require precise descriptions for UI-addressable actions. Defaults to true. */
  requireDescriptions?: boolean;
}

export interface AgentActionParityReport {
  protocol: "clank-agent-action-parity/1";
  ok: boolean;
  contractRevision: string | null;
  controls: readonly AgentActionControl[];
  uiActions: readonly string[];
  agentActions: readonly string[];
  requiredActions: readonly string[];
  issues: readonly AgentActionParityIssue[];
}

export interface VerifyAgentActionParityOptions extends AgentActionParityOptions {
  manifestUrl?: string;
  fetch?: typeof fetch;
  maxManifestBytes?: number;
}

export class AgentActionParityError extends Error {
  readonly name = "AgentActionParityError";

  constructor(readonly report: AgentActionParityReport) {
    super(
      report.issues.length === 1
        ? report.issues[0].message
        : `UI and agent action contracts differ in ${report.issues.length} places.`,
    );
  }
}

/** Resolves a literal or typed backend reference into its MCP/browser action path. */
export function agentActionPath(target: AgentActionTarget): string {
  let path: unknown = target;
  if (typeof target !== "string" && target && (typeof target === "object" || typeof target === "function")) {
    try {
      path = (target as { readonly path?: unknown }).path;
    } catch {
      path = undefined;
    }
  }
  if (typeof path !== "string" || !ACTION_PATH.test(path)) {
    throw new TypeError("agentAction must be a valid backend function reference or action path.");
  }
  return path;
}

/** Extracts stable server-action controls from SSR HTML or a rendered DOM root. */
export function inspectAgentActions(surface: string | ParentNode): readonly AgentActionControl[] {
  const controls = typeof surface === "string"
    ? inspectHtmlActions(surface)
    : inspectDomActions(surface);
  return Object.freeze(controls.map((control) => Object.freeze(control)));
}

/** Compares rendered UI actions with the backend manifest used to derive MCP tools. */
export function checkAgentActionParity(
  surface: string | ParentNode | readonly AgentActionControl[],
  manifestInput: AgentBackendManifest | unknown,
  options: AgentActionParityOptions = {},
): AgentActionParityReport {
  const manifest = parseAgentBackendManifest(manifestInput);
  if (isControlArray(surface) && surface.length > MAX_CONTROLS) {
    throw new TypeError(`Agent action surfaces may contain at most ${MAX_CONTROLS} controls.`);
  }
  const controls = isControlArray(surface)
    ? Object.freeze(surface.map((control) => normalizeControl(control)))
    : inspectAgentActions(surface);
  const requiredInput = options.requiredActions ?? [];
  if (requiredInput.length > MAX_FUNCTIONS) {
    throw new TypeError(`Agent action parity may require at most ${MAX_FUNCTIONS} actions.`);
  }
  const requiredActions = Object.freeze(
    [...new Set(requiredInput.map(agentActionPath))].sort(),
  );
  const functions = new Map(manifest.functions.map((entry) => [entry.name, entry]));
  const uiActions = Object.freeze([...new Set(controls.map((control) => control.path))].sort());
  const agentActions = Object.freeze(
    manifest.functions.filter((entry) => entry.agent).map((entry) => entry.name).sort(),
  );
  const issues: AgentActionParityIssue[] = [];
  if (controls.length > 0 && manifest.contractRevision === null) {
    issues.push({
      code: "MCP_DISABLED",
      message: "The UI exposes backend actions, but this backend has no MCP agent contract.",
    });
  }
  const expectedRevision = options.expectedRevision;
  if (expectedRevision !== undefined && manifest.contractRevision !== expectedRevision) {
    issues.push({
      code: "REVISION_MISMATCH",
      message: `Expected agent contract ${expectedRevision ?? "disabled"}, received ${manifest.contractRevision ?? "disabled"}.`,
    });
  }

  const ids = new Map<string, string>();
  const undocumented = new Set<string>();
  for (const control of controls) {
    if (!control.id) {
      issues.push({
        code: "MISSING_CONTROL_ID",
        action: control.path,
        message: `UI action ${control.path} requires a stable agentId or element id.`,
      });
    } else {
      const previous = ids.get(control.id);
      if (previous) {
        issues.push({
          code: "DUPLICATE_CONTROL_ID",
          action: control.path,
          controlId: control.id,
          message: previous === control.path
            ? `Control id ${control.id} is used by more than one ${control.path} control.`
            : `Control id ${control.id} maps to both ${previous} and ${control.path}.`,
        });
      } else {
        ids.set(control.id, control.path);
      }
    }
    const backendFunction = functions.get(control.path);
    if (!backendFunction) {
      issues.push({
        code: "UNKNOWN_ACTION",
        action: control.path,
        ...(control.id ? { controlId: control.id } : {}),
        message: `UI action ${control.path} is not present in the backend manifest.`,
      });
      continue;
    }
    if (!backendFunction.agent) {
      issues.push({
        code: "INTERNAL_ACTION",
        action: control.path,
        ...(control.id ? { controlId: control.id } : {}),
        message: `UI action ${control.path} is internal and cannot be discovered through MCP.`,
      });
    }
    if (
      options.requireDescriptions !== false
      && (!backendFunction.description || backendFunction.description.trim().length === 0)
      && !undocumented.has(control.path)
    ) {
      undocumented.add(control.path);
      issues.push({
        code: "MISSING_DESCRIPTION",
        action: control.path,
        ...(control.id ? { controlId: control.id } : {}),
        message: `UI action ${control.path} requires a backend description for agents.`,
      });
    }
  }

  for (const path of requiredActions) {
    if (!uiActions.includes(path)) {
      issues.push({
        code: "MISSING_UI_ACTION",
        action: path,
        message: `Required backend action ${path} has no rendered UI control.`,
      });
    }
  }

  return deepFreeze({
    protocol: "clank-agent-action-parity/1",
    ok: issues.length === 0,
    contractRevision: manifest.contractRevision,
    controls,
    uiActions,
    agentActions,
    requiredActions,
    issues,
  });
}

export function assertAgentActionParity(
  surface: string | ParentNode | readonly AgentActionControl[],
  manifest: AgentBackendManifest | unknown,
  options: AgentActionParityOptions = {},
): AgentActionParityReport {
  const report = checkAgentActionParity(surface, manifest, options);
  if (!report.ok) throw new AgentActionParityError(report);
  return report;
}

/**
 * Fetches the no-store backend manifest and verifies the currently rendered UI.
 * It throws AgentActionParityError for a semantic mismatch.
 */
export async function verifyAgentActionParity(
  surface: string | ParentNode,
  options: VerifyAgentActionParityOptions = {},
): Promise<AgentActionParityReport> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available in this runtime.");
  const response = await fetcher(options.manifestUrl ?? "/__clank/manifest", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Agent action manifest request failed with ${response.status}.`);
  }
  const maxBytes = positiveInteger(options.maxManifestBytes ?? 1024 * 1024, "maxManifestBytes");
  const manifest = JSON.parse(await boundedResponseText(response, maxBytes)) as unknown;
  const headerRevision = response.headers.get("x-clank-contract-revision");
  let report = checkAgentActionParity(surface, manifest, {
    ...options,
    expectedRevision: undefined,
  });
  const revisions = new Set<string | null>();
  if (headerRevision) revisions.add(headerRevision);
  if (options.expectedRevision !== undefined) revisions.add(options.expectedRevision);
  const revisionIssues = [...revisions]
    .filter((revision) => report.contractRevision !== revision)
    .map((revision): AgentActionParityIssue => ({
      code: "REVISION_MISMATCH",
      message: `Expected agent contract ${revision ?? "disabled"}, received ${report.contractRevision ?? "disabled"}.`,
    }));
  if (revisionIssues.length) {
    report = deepFreeze({
      ...report,
      ok: false,
      issues: [...report.issues, ...revisionIssues],
    });
  }
  if (!report.ok) throw new AgentActionParityError(report);
  return report;
}

function inspectHtmlActions(html: string): AgentActionControl[] {
  if (new TextEncoder().encode(html).byteLength > MAX_SURFACE_BYTES) {
    throw new TypeError(`Agent action HTML may not exceed ${MAX_SURFACE_BYTES} bytes.`);
  }
  const controls: AgentActionControl[] = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:._-]*)\b[^>]*>/gu;
  for (const match of html.matchAll(tagPattern)) {
    const source = match[0];
    const rawAction = htmlAttribute(source, "data-clank-action");
    if (rawAction === undefined) continue;
    controls.push({
      path: agentActionPath(rawAction),
      ...(htmlAttribute(source, "data-clank-id") ?? htmlAttribute(source, "id")
        ? { id: htmlAttribute(source, "data-clank-id") ?? htmlAttribute(source, "id") }
        : {}),
      ...(htmlAttribute(source, "data-clank-label") ?? htmlAttribute(source, "aria-label")
        ? { label: htmlAttribute(source, "data-clank-label") ?? htmlAttribute(source, "aria-label") }
        : {}),
      tag: match[1].toLowerCase(),
    });
    if (controls.length > MAX_CONTROLS) {
      throw new TypeError(`Agent action surfaces may contain at most ${MAX_CONTROLS} controls.`);
    }
  }
  return controls;
}

function inspectDomActions(root: ParentNode): AgentActionControl[] {
  if (!root || typeof root.querySelectorAll !== "function") {
    throw new TypeError("Agent action inspection requires SSR HTML or a DOM ParentNode.");
  }
  const candidate = root as ParentNode & {
    getAttribute?: (name: string) => string | null;
    localName?: string;
  };
  const rootElement = (
    typeof candidate.getAttribute === "function"
    && typeof candidate.localName === "string"
    && candidate.getAttribute("data-clank-action") !== null
  )
    ? candidate as Element
    : null;
  const elements: Element[] = rootElement ? [rootElement] : [];
  for (const element of root.querySelectorAll("[data-clank-action]")) {
    if (elements.length === MAX_CONTROLS) {
      throw new TypeError(`Agent action surfaces may contain at most ${MAX_CONTROLS} controls.`);
    }
    elements.push(element);
  }
  return elements.map((element) => ({
    path: agentActionPath(element.getAttribute("data-clank-action") ?? ""),
    ...(element.getAttribute("data-clank-id") ?? element.getAttribute("id")
      ? { id: element.getAttribute("data-clank-id") ?? element.getAttribute("id") ?? undefined }
      : {}),
    ...(element.getAttribute("data-clank-label") ?? element.getAttribute("aria-label")
      ? { label: element.getAttribute("data-clank-label") ?? element.getAttribute("aria-label") ?? undefined }
      : {}),
    tag: element.localName,
  }));
}

function parseAgentBackendManifest(input: unknown): AgentBackendManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Agent backend manifest must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (value.protocol !== "clank-live/1") {
    throw new TypeError("Agent backend manifest protocol must be clank-live/1.");
  }
  if (
    value.contractRevision !== null
    && (typeof value.contractRevision !== "string" || !CONTRACT_REVISION.test(value.contractRevision))
  ) {
    throw new TypeError("Agent backend manifest has an invalid contract revision.");
  }
  if (!Array.isArray(value.functions) || value.functions.length > MAX_FUNCTIONS) {
    throw new TypeError(`Agent backend manifest must contain at most ${MAX_FUNCTIONS} functions.`);
  }
  const names = new Set<string>();
  const functions = value.functions.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`Agent backend function ${index} must be an object.`);
    }
    const entry = raw as Record<string, unknown>;
    const name = agentActionPath(entry.name as string);
    if (names.has(name)) throw new TypeError(`Agent backend manifest repeats ${name}.`);
    names.add(name);
    if (entry.kind !== "query" && entry.kind !== "mutation") {
      throw new TypeError(`Agent backend function ${name} has an invalid kind.`);
    }
    if (typeof entry.agent !== "boolean") {
      throw new TypeError(`Agent backend function ${name} has an invalid agent flag.`);
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      throw new TypeError(`Agent backend function ${name} has an invalid description.`);
    }
    return Object.freeze({
      name,
      kind: entry.kind,
      agent: entry.agent,
      ...(entry.description === undefined ? {} : { description: entry.description }),
    }) as AgentBackendFunctionManifest;
  });
  return Object.freeze({
    protocol: "clank-live/1",
    contractRevision: value.contractRevision as string | null,
    functions: Object.freeze(functions),
  });
}

function normalizeControl(control: AgentActionControl): AgentActionControl {
  if (!control || typeof control !== "object") throw new TypeError("Agent action control must be an object.");
  const tag = typeof control.tag === "string" && /^[a-z][a-z0-9:._-]*$/u.test(control.tag)
    ? control.tag
    : (() => { throw new TypeError("Agent action control has an invalid tag."); })();
  return Object.freeze({
    path: agentActionPath(control.path),
    ...(control.id === undefined ? {} : { id: boundedText(control.id, "control id", 256) }),
    ...(control.label === undefined ? {} : { label: boundedText(control.label, "control label", 1_024) }),
    tag,
  });
}

function isControlArray(
  value: string | ParentNode | readonly AgentActionControl[],
): value is readonly AgentActionControl[] {
  return Array.isArray(value);
}

function htmlAttribute(source: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(source);
  return match?.[1];
}

async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    throw new Error(`Agent action manifest exceeds ${maximum} bytes.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error(`Agent action manifest exceeds ${maximum} bytes.`);
    }
    chunks.push(next.value);
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function boundedText(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value;
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry, seen);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}
