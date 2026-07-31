import type { AgentNode, AgentSurface } from "./ai.ts";

export interface JourneyExpectation {
  /** Stable agentId or native element ID that must be present. */
  target?: string;
  /** Exact path and query, or an absolute URL on the configured application origin. */
  url?: string;
  /** Normalized visible page text that must be present. */
  text?: string;
  /** Semantic state asserted against the target. */
  state?: Readonly<{
    label?: string;
    role?: string;
    checked?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    value?: string | readonly string[];
  }>;
}

export interface JourneySecretReference {
  /** Environment-style secret name resolved only while the journey runs. */
  readonly env: string;
}

export type JourneyInputValue = string | number | boolean | readonly string[] | JourneySecretReference;

export type JourneyStep =
  | Readonly<{ visit: string }>
  | Readonly<{ input: { target: string; value: JourneyInputValue } }>
  | Readonly<{ activate: string }>
  | Readonly<{ expect: JourneyExpectation }>
  | Readonly<{ wait: JourneyExpectation & { timeoutMs?: number } }>
  | Readonly<{ inspect: string }>;

export interface JourneyDefinition {
  readonly protocol: "clank-journey/1";
  readonly name: string;
  readonly description?: string;
  readonly start: string;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly steps: readonly JourneyStep[];
}

export interface JourneyInput {
  name: string;
  description?: string;
  /** Relative start path. Defaults to /. */
  start?: string;
  viewport?: { width: number; height: number };
  steps: readonly JourneyStep[];
}

export interface JourneyDriver {
  navigate(url: string): void | Promise<void>;
  currentUrl(): string | Promise<string>;
  inspect(): readonly AgentNode[] | Promise<readonly AgentNode[]>;
  activate(id: string): boolean | Promise<boolean>;
  input(
    id: string,
    value: string | number | boolean | readonly string[],
    options?: Readonly<{ secret: boolean }>,
  ): boolean | Promise<boolean>;
  visibleText(): string | Promise<string>;
  /** Wait for browser navigation, hydration, and queued DOM work to settle. */
  settle(): void | Promise<void>;
  setViewport?(viewport: { width: number; height: number }): void | Promise<void>;
}

export interface JourneyStepReport {
  readonly index: number;
  readonly kind: "visit" | "input" | "activate" | "expect" | "wait" | "inspect";
  readonly target?: string;
  readonly label?: string;
  readonly status: "passed" | "failed";
  readonly durationMs: number;
  readonly message?: string;
  readonly surface?: readonly AgentNode[];
}

export interface JourneyReport {
  readonly protocol: "clank-journey-report/1";
  readonly name: string;
  readonly ok: boolean;
  readonly origin: string;
  readonly path: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly JourneyStepReport[];
  readonly error?: string;
  readonly surface?: readonly AgentNode[];
}

export interface RunJourneyOptions {
  baseUrl: string;
  /** Overall timeout. Defaults to 2 minutes and is capped at 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Resolves secret references at execution time. Secret values never enter the report. */
  resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
  onStep?: (report: JourneyStepReport) => void;
}

const MAX_STEPS = 100;
const MAX_TEXT = 16 * 1024;
const STATE_KEYS = new Set(["label", "role", "checked", "expanded", "disabled", "readonly", "invalid", "value"]);

/** Validates and snapshots a data-only browser journey contract. */
export function defineJourney(input: JourneyInput): JourneyDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Journey definition must be an object.");
  }
  const name = text(input.name, "journey name", 128);
  const description = input.description === undefined
    ? undefined
    : text(input.description, "journey description", MAX_TEXT);
  const start = relativeLocation(input.start ?? "/", "journey start");
  const viewport = normalizeViewport(input.viewport);
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_STEPS) {
    throw new TypeError(`Journey steps must contain from 1 through ${MAX_STEPS} entries.`);
  }
  const steps = input.steps.map((step, index) => normalizeStep(step, index));
  return Object.freeze({
    protocol: "clank-journey/1" as const,
    name,
    ...(description ? { description } : {}),
    start,
    viewport,
    steps: Object.freeze(steps),
  });
}

/** Executes a journey through a real or test browser driver and returns a redacted report. */
export async function runJourney(
  journey: JourneyDefinition,
  driver: JourneyDriver,
  options: RunJourneyOptions,
): Promise<JourneyReport> {
  const definition = defineJourney(journey);
  if (!driver || typeof driver !== "object") throw new TypeError("Journey driver must be an object.");
  for (const method of ["navigate", "currentUrl", "inspect", "activate", "input", "visibleText", "settle"] as const) {
    if (typeof driver[method] !== "function") throw new TypeError(`Journey driver requires ${method}().`);
  }
  if (!options || typeof options !== "object") throw new TypeError("Journey run options are required.");
  const base = applicationBase(options.baseUrl);
  const timeoutMs = integer(options.timeoutMs ?? 2 * 60_000, "journey timeoutMs", 100, 10 * 60_000);
  const started = Date.now();
  const deadline = started + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Journey exceeded its overall timeout.")), timeoutMs);
  const abortFromCaller = () => controller.abort(
    options.signal?.reason instanceof Error ? options.signal.reason : new Error("Journey was aborted."),
  );
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const runSignal = controller.signal;
  const reports: JourneyStepReport[] = [];
  const publish = (report: JourneyStepReport) => {
    const frozen = Object.freeze(report);
    reports.push(frozen);
    try { options.onStep?.(frozen); } catch { /* Reporting cannot change the journey. */ }
  };
  let failure: string | undefined;
  let failureSurface: readonly AgentNode[] | undefined;
  try {
    await abortable(runSignal, driver.setViewport?.(definition.viewport));
    await navigateWithinOrigin(driver, new URL(definition.start, base).href, base.origin, runSignal);
    for (let index = 0; index < definition.steps.length; index++) {
      const step = definition.steps[index]!;
      const stepStarted = Date.now();
      const summary = stepSummary(step);
      try {
        ensureTime(deadline, runSignal);
        const surface = await executeStep(step, driver, base, deadline, options.resolveSecret, runSignal);
        await assertCurrentOrigin(driver, base.origin, runSignal);
        publish({
          index,
          ...summary,
          status: "passed",
          durationMs: Date.now() - stepStarted,
          ...(surface ? { surface } : {}),
        });
      } catch (error) {
        failure = safeError(error);
        failureSurface = await safeSurface(driver);
        publish({
          index,
          ...summary,
          status: "failed",
          durationMs: Date.now() - stepStarted,
          message: failure,
          ...(failureSurface ? { surface: failureSurface } : {}),
        });
        break;
      }
    }
  } catch (error) {
    failure = safeError(error);
    failureSurface = await safeSurface(driver);
  }
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abortFromCaller);
  const current = await safeCurrentUrl(driver, base);
  return Object.freeze({
    protocol: "clank-journey-report/1" as const,
    name: definition.name,
    ok: failure === undefined,
    origin: current.origin,
    path: current.pathname,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    steps: Object.freeze(reports),
    ...(failure ? { error: failure } : {}),
    ...(failureSurface ? { surface: failureSurface } : {}),
  });
}

/** Adapts the current browser document to the journey driver contract. */
export function createDomJourneyDriver(
  windowObject: Window,
  surface: AgentSurface,
): JourneyDriver {
  if (!windowObject?.document || !surface) throw new TypeError("A browser window and agent surface are required.");
  return Object.freeze({
    navigate(url) {
      const target = new URL(url, windowObject.location.href);
      if (target.href === windowObject.location.href) return;
      windowObject.history.pushState({}, "", target.href);
      windowObject.dispatchEvent(new windowObject.PopStateEvent("popstate", { state: windowObject.history.state }));
    },
    currentUrl: () => windowObject.location.href,
    inspect: () => surface.inspect(),
    activate: (id) => surface.activate(id),
    input: (id, value) => surface.input(id, value),
    visibleText: () => windowObject.document.body?.innerText ?? "",
    async settle() {
      await new Promise<void>((resolve) => windowObject.requestAnimationFrame(() =>
        windowObject.requestAnimationFrame(() => resolve())));
    },
  });
}

async function executeStep(
  step: JourneyStep,
  driver: JourneyDriver,
  base: URL,
  deadline: number,
  resolveSecret?: RunJourneyOptions["resolveSecret"],
  signal?: AbortSignal,
): Promise<readonly AgentNode[] | undefined> {
  if ("visit" in step) {
    await navigateWithinOrigin(driver, new URL(step.visit, base).href, base.origin, signal);
    return undefined;
  }
  if ("input" in step) {
    const secret = isSecretReference(step.input.value);
    const value = secret
      ? await resolvedSecret(step.input.value.env, resolveSecret, signal)
      : step.input.value;
    const accepted = await abortable(signal, driver.input(step.input.target, value, { secret }));
    if (!accepted) throw new Error(`Input target ${step.input.target} is missing, protected, or incompatible.`);
    await abortable(signal, driver.settle());
    return undefined;
  }
  if ("activate" in step) {
    const accepted = await abortable(signal, driver.activate(step.activate));
    if (!accepted) throw new Error(`Activation target ${step.activate} is missing or disabled.`);
    await abortable(signal, driver.settle());
    return undefined;
  }
  if ("expect" in step) {
    const mismatch = await expectationMismatch(step.expect, driver, base, signal);
    if (mismatch) throw new Error(mismatch);
    return undefined;
  }
  if ("wait" in step) {
    const timeout = integer(step.wait.timeoutMs ?? 10_000, "journey wait timeoutMs", 50, 60_000);
    const waitDeadline = Math.min(deadline, Date.now() + timeout);
    let mismatch = "Expectation was not met.";
    while (Date.now() <= waitDeadline) {
      ensureTime(deadline, signal);
      mismatch = await expectationMismatch(step.wait, driver, base, signal) ?? "";
      if (!mismatch) return undefined;
      await delay(50, signal);
    }
    throw new Error(`${mismatch} Waited ${timeout}ms.`);
  }
  return await safeSurface(driver);
}

async function expectationMismatch(
  expectation: JourneyExpectation,
  driver: JourneyDriver,
  base: URL,
  signal?: AbortSignal,
): Promise<string | null> {
  if (expectation.url !== undefined) {
    const expected = new URL(expectation.url, base);
    if (expected.origin !== base.origin) return "Journey URL expectations must stay on the application origin.";
    const current = new URL(await abortable(signal, driver.currentUrl()));
    if (current.origin !== expected.origin || current.pathname + current.search !== expected.pathname + expected.search) {
      return `Expected URL ${expected.pathname + expected.search}; received ${current.pathname + current.search}.`;
    }
  }
  if (expectation.text !== undefined) {
    const visible = normalizeSpace(await abortable(signal, driver.visibleText()));
    const expected = normalizeSpace(expectation.text);
    if (!visible.includes(expected)) return `Expected visible text ${JSON.stringify(expected)}.`;
  }
  if (expectation.target !== undefined) {
    const nodes = flattenNodes(await abortable(signal, driver.inspect()));
    const node = nodes.find((entry) => entry.id === expectation.target);
    if (!node) return `Expected semantic target ${expectation.target}.`;
    for (const [key, expected] of Object.entries(expectation.state ?? {})) {
      const actual = node[key as keyof AgentNode];
      if (!equalValue(actual, expected)) {
        return key === "value"
          ? `Expected ${expectation.target}.value to match the private journey value.`
          : `Expected ${expectation.target}.${key} to equal ${JSON.stringify(expected)}.`;
      }
    }
  }
  return null;
}

async function navigateWithinOrigin(
  driver: JourneyDriver,
  url: string,
  origin: string,
  signal?: AbortSignal,
): Promise<void> {
  const target = new URL(url);
  if (target.origin !== origin) throw new Error("Journey navigation cannot leave the configured application origin.");
  await abortable(signal, driver.navigate(target.href));
  await abortable(signal, driver.settle());
  await assertCurrentOrigin(driver, origin, signal);
}

async function assertCurrentOrigin(driver: JourneyDriver, origin: string, signal?: AbortSignal): Promise<void> {
  const current = new URL(await abortable(signal, driver.currentUrl()));
  if (current.origin !== origin) throw new Error("The application navigated outside the configured journey origin.");
}

function normalizeStep(raw: JourneyStep, index: number): JourneyStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Journey step[${index}] must be an object.`);
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) throw new TypeError(`Journey step[${index}] must contain exactly one operation.`);
  if ("visit" in raw) return Object.freeze({ visit: relativeLocation(raw.visit, `journey step[${index}].visit`) });
  if ("activate" in raw) return Object.freeze({ activate: identifier(raw.activate, `journey step[${index}].activate`) });
  if ("inspect" in raw) return Object.freeze({ inspect: text(raw.inspect, `journey step[${index}].inspect`, 128) });
  if ("input" in raw) {
    if (!raw.input || typeof raw.input !== "object" || Array.isArray(raw.input)) {
      throw new TypeError(`Journey step[${index}].input must be an object.`);
    }
    exactKeys(raw.input, ["target", "value"], `journey step[${index}].input`);
    const value = journeyInputValue(raw.input.value, `journey step[${index}].input.value`);
    return Object.freeze({ input: Object.freeze({
      target: identifier(raw.input.target, `journey step[${index}].input.target`),
      value,
    }) });
  }
  if ("expect" in raw) return Object.freeze({ expect: normalizeExpectation(raw.expect, index, false) });
  if ("wait" in raw) return Object.freeze({ wait: normalizeExpectation(raw.wait, index, true) });
  throw new TypeError(`Journey step[${index}] has an unknown operation.`);
}

function normalizeExpectation(raw: unknown, index: number, wait: boolean): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Journey step[${index}] expectation must be an object.`);
  }
  const source = raw as Record<string, unknown>;
  exactKeys(source, wait ? ["target", "url", "text", "state", "timeoutMs"] : ["target", "url", "text", "state"], `journey step[${index}] expectation`);
  if (source.target === undefined && source.url === undefined && source.text === undefined) {
    throw new TypeError(`Journey step[${index}] expectation requires target, url, or text.`);
  }
  const target = source.target === undefined ? undefined : identifier(source.target, `journey step[${index}].target`);
  const url = source.url === undefined ? undefined : location(source.url, `journey step[${index}].url`);
  const expectedText = source.text === undefined ? undefined : text(source.text, `journey step[${index}].text`, MAX_TEXT);
  let state: Record<string, unknown> | undefined;
  if (source.state !== undefined) {
    if (!target) throw new TypeError(`Journey step[${index}] state requires a target.`);
    if (!source.state || typeof source.state !== "object" || Array.isArray(source.state)) {
      throw new TypeError(`Journey step[${index}].state must be an object.`);
    }
    state = {};
    for (const [key, value] of Object.entries(source.state)) {
      if (!STATE_KEYS.has(key)) throw new TypeError(`Journey step[${index}].state contains unknown key ${key}.`);
      if (key === "label" || key === "role") state[key] = text(value, `journey step[${index}].state.${key}`, 512);
      else if (key === "value") state[key] = inputValue(value, `journey step[${index}].state.value`);
      else if (typeof value === "boolean") state[key] = value;
      else throw new TypeError(`Journey step[${index}].state.${key} must be boolean.`);
    }
    state = Object.freeze(state);
  }
  return Object.freeze({
    ...(target ? { target } : {}),
    ...(url ? { url } : {}),
    ...(expectedText ? { text: expectedText } : {}),
    ...(state ? { state } : {}),
    ...(wait && source.timeoutMs !== undefined
      ? { timeoutMs: integer(source.timeoutMs, `journey step[${index}].timeoutMs`, 50, 60_000) }
      : {}),
  });
}

function normalizeViewport(value: JourneyInput["viewport"]): Readonly<{ width: number; height: number }> {
  if (value === undefined) return Object.freeze({ width: 1280, height: 800 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Journey viewport must be an object.");
  exactKeys(value as any, ["width", "height"], "journey viewport");
  return Object.freeze({
    width: integer(value.width, "journey viewport width", 320, 3840),
    height: integer(value.height, "journey viewport height", 320, 2160),
  });
}

function stepSummary(step: JourneyStep): Pick<JourneyStepReport, "kind" | "target" | "label"> {
  if ("visit" in step) return { kind: "visit", label: step.visit };
  if ("input" in step) return { kind: "input", target: step.input.target };
  if ("activate" in step) return { kind: "activate", target: step.activate };
  if ("expect" in step) return { kind: "expect", ...(step.expect.target ? { target: step.expect.target } : {}) };
  if ("wait" in step) return { kind: "wait", ...(step.wait.target ? { target: step.wait.target } : {}) };
  return { kind: "inspect", label: step.inspect };
}

function flattenNodes(nodes: readonly AgentNode[]): AgentNode[] {
  const output: AgentNode[] = [];
  const visit = (node: AgentNode) => {
    output.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return output;
}

async function safeSurface(driver: JourneyDriver): Promise<readonly AgentNode[] | undefined> {
  try {
    const nodes = await driver.inspect();
    let remaining = 1_000;
    const redact = (node: AgentNode): AgentNode | null => {
      if (remaining-- <= 0) return null;
      const children = (node.children ?? []).map(redact).filter((entry): entry is AgentNode => entry !== null);
      const { value: _value, href, children: _children, ...safe } = node;
      return Object.freeze({
        ...safe,
        ...(href ? { href: safeHref(href) } : {}),
        ...(children.length ? { children: Object.freeze(children) } : {}),
      });
    };
    return Object.freeze(nodes.map(redact).filter((entry): entry is AgentNode => entry !== null));
  } catch {
    return undefined;
  }
}

async function safeCurrentUrl(driver: JourneyDriver, fallback: URL): Promise<URL> {
  try { return new URL(await driver.currentUrl()); } catch { return fallback; }
}

function applicationBase(value: unknown): URL {
  if (typeof value !== "string") throw new TypeError("Journey baseUrl must be a URL string.");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Journey baseUrl must use HTTP or HTTPS.");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

function relativeLocation(value: unknown, label: string): string {
  const normalized = location(value, label);
  const parsed = new URL(normalized, "https://journey.invalid");
  if (parsed.origin !== "https://journey.invalid") throw new TypeError(`${label} must be a relative application path.`);
  return parsed.pathname + parsed.search + parsed.hash;
}

function location(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded URL or path.`);
  }
  return value;
}

function inputValue(value: unknown, label: string): string | number | boolean | readonly string[] {
  if (typeof value === "string") return text(value, label, 16 * 1024, true);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 100) {
    return Object.freeze(value.map((entry, index) => text(entry, `${label}[${index}]`, 1_024, true)));
  }
  throw new TypeError(`${label} must be text, a finite number, a boolean, or a bounded text array.`);
}

function journeyInputValue(value: unknown, label: string): JourneyInputValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const reference = value as Record<string, unknown>;
    exactKeys(reference, ["env"], label);
    if (typeof reference.env !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(reference.env)) {
      throw new TypeError(`${label}.env must be an uppercase environment-style secret name.`);
    }
    return Object.freeze({ env: reference.env });
  }
  return inputValue(value, label);
}

function isSecretReference(value: JourneyInputValue): value is JourneySecretReference {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "env" in value);
}

async function resolvedSecret(
  name: string,
  resolver: RunJourneyOptions["resolveSecret"],
  signal?: AbortSignal,
): Promise<string> {
  if (!resolver) throw new Error(`Journey secret ${name} cannot be resolved.`);
  const value = await abortable(signal, resolver(name));
  if (value === undefined) throw new Error(`Journey secret ${name} is unavailable.`);
  return text(value, `journey secret ${name}`, 16 * 1024, true);
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0) || value.includes("\0")) {
    throw new TypeError(`${label} must be bounded text.`);
  }
  return allowEmpty ? value : value.trim();
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value, label, 256);
  if (!/^[a-z0-9][a-z0-9._:-]*$/iu.test(normalized)) throw new TypeError(`${label} is invalid.`);
  return normalized;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new TypeError(`${label} contains unknown key ${key}.`);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function equalValue(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((entry, index) => entry === right[index])
    : left === right;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f]/gu, " ").slice(0, 2_048) || "Journey failed.";
}

function safeHref(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/u, 1)[0]!.slice(0, 2_048);
  }
}

function ensureTime(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Journey was aborted.");
  if (Date.now() > deadline) throw new Error("Journey exceeded its overall timeout.");
}

async function abortable<Value>(signal: AbortSignal | undefined, value: Value | PromiseLike<Value>): Promise<Value> {
  if (!signal) return await value;
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Journey was aborted.");
  return await new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Journey was aborted."));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await abortable(signal, new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
}
