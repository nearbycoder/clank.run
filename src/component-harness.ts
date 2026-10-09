import { createAgentSurface, type Schema } from "./ai.ts";
import { onCleanup, type Cleanup } from "./core.ts";
import { h, hydrate, render, type Renderable } from "./dom.ts";
import { observeHydration, type HydrationDiagnostic } from "./hydration-inspection.ts";
import { createDomJourneyDriver, defineJourney, runJourney, type JourneyDefinition, type JourneyExpectation, type JourneyInput, type JourneyReport } from "./journey.ts";
import { renderToString } from "./ssr.ts";
import { createUiManifest, type UiManifest } from "./ui-foundation.ts";

const SPECIMEN = Symbol("clank.component.specimen");
export interface ComponentSpecimen<Props extends Record<string, unknown> = Record<string, unknown>> {
  readonly [SPECIMEN]: Props;
  readonly protocol: "clank-component-specimen/1";
  readonly name: string;
  readonly label: string;
  readonly revision: string;
}
export interface ComponentSpecimenInstance {
  readonly view: Renderable;
  readonly manifest: () => UiManifest;
  readonly dispose: Cleanup;
}
export interface ComponentSpecimenInput<Props extends Record<string, unknown>> {
  readonly name: string;
  readonly label?: string;
  readonly revision: string;
  readonly props: Schema<Props>;
  readonly value: Props;
  /** Runs inside the renderer's component scope, including during SSR. */
  readonly create: (props: Readonly<Props>) => ComponentSpecimenInstance;
  /** Part names from the manifest mapped to persistent semantic fixture targets. */
  readonly parts: Readonly<Record<string, string>>;
  readonly assertions: readonly JourneyExpectation[];
  readonly journeys: readonly JourneyInput[];
}
export interface ComponentSpecimenSnapshot {
  readonly protocol: "clank-component-snapshot/1";
  readonly name: string;
  readonly fingerprint: string;
  readonly contract: UiManifest;
}
export interface ComponentHarnessSnapshot {
  readonly protocol: "clank-component-harness/1";
  readonly name: string;
  readonly phase: "hydrated" | "mounted" | "disposed";
  readonly generation: number;
  readonly instancesCreated: number;
  readonly instancesDisposed: number;
  readonly contract: UiManifest | null;
  readonly hydration: readonly HydrationDiagnostic[];
  readonly truncated: boolean;
}
export interface ComponentHarness {
  snapshot(): ComponentHarnessSnapshot;
  reset(): void;
  select(specimen: ComponentSpecimen<any>): void;
  /** Reads current semantic/part state; full keyboard journeys run through Chrome. */
  check(): Promise<JourneyReport | null>;
  exportAssertions(): string;
  dispose(): void;
}

interface Definition {
  specimen: ComponentSpecimen<any>;
  value: string;
  create: ComponentSpecimenInput<any>["create"];
  parts: Readonly<Record<string, string>>;
  assertions: readonly JourneyExpectation[];
  journeys: readonly JourneyDefinition[];
  identity: string;
}
const definitions = new WeakMap<object, Definition>();
const documents = new WeakMap<Document, object>();
const harnesses = new WeakMap<ComponentHarness, HTMLElement>();
const MAX_BYTES = 256 * 1024;

/** Captures a typed, bounded disposable fixture and its data-only journeys. */
export function defineComponentSpecimen<Props extends Record<string, unknown>>(input: ComponentSpecimenInput<Props>): ComponentSpecimen<Props> {
  exact(input, ["name", "label", "revision", "props", "value", "create", "parts", "assertions", "journeys"]);
  const name = identifier(input.name), label = boundedText(input.label ?? name, 128), revision = boundedText(input.revision, 128);
  const props = input.props, create = input.create;
  if (!props || typeof props.parse !== "function" || typeof create !== "function") throw new TypeError("A specimen requires a schema and synchronous instance factory.");
  const value = canonical(props.parse(JSON.parse(canonical(input.value, 64 * 1024))), 64 * 1024);
  const parts = JSON.parse(canonical(input.parts, 16 * 1024)) as Record<string, string>;
  if (!parts || Array.isArray(parts) || typeof parts !== "object" || Object.keys(parts).length > 64) throw new TypeError("A specimen permits at most 64 mapped parts.");
  for (const [part, target] of Object.entries(parts)) { identifier(part); identifier(target); }
  if (new Set(Object.values(parts)).size !== Object.keys(parts).length) throw new TypeError("Specimen part targets must be unique.");
  if (!Array.isArray(input.assertions) || !input.assertions.length || input.assertions.length > 64) throw new TypeError("A specimen requires 1–64 current-state assertions.");
  const assertions = defineJourney({ name, steps: input.assertions.map(expect => ({ expect })) }).steps.map(step => (step as { expect: JourneyExpectation }).expect);
  if (Object.keys(parts).length + assertions.length > 100) throw new TypeError("Mapped parts and assertions exceed the journey step limit.");
  if (!Array.isArray(input.journeys) || !input.journeys.length || input.journeys.length > 10) throw new TypeError("A specimen requires 1–10 journeys.");
  const journeys = input.journeys.map(journey => defineJourney(journey));
  if (new Set(journeys.map(journey => journey.name)).size !== journeys.length) throw new TypeError("Specimen journey names must be unique.");
  const specimen = Object.freeze({ [SPECIMEN]: undefined as unknown as Props, protocol: "clank-component-specimen/1" as const, name, label, revision });
  const identity = canonical({ name, revision, value: JSON.parse(value), parts, assertions, journeys });
  definitions.set(specimen, { specimen, value, create, parts: freeze(parts), assertions: freeze(assertions), journeys: freeze(journeys), identity });
  return specimen;
}

/** Deterministic, CLI-compatible assertion suite; excludes fixture props and timing data. */
export function exportComponentAssertions(specimen: ComponentSpecimen<any>): string {
  const definition = registered(specimen);
  return canonical({ protocol: "clank-component-assertions/1", specimen: specimen.name, revision: specimen.revision, parts: definition.parts, assertions: definition.assertions, journeys: definition.journeys }) + "\n";
}

/** SSR executes the same instance factory inside an owned render scope and releases it. */
export async function renderComponentSpecimen(specimen: ComponentSpecimen<any>): Promise<{ readonly html: string; readonly snapshot: ComponentSpecimenSnapshot }> {
  const definition = registered(specimen), fingerprint = await digest(definition.identity);
  let contract: UiManifest | undefined;
  const html = await renderToString(h(function ComponentSpecimenRoot() {
    const instance = createInstance(definition);
    onCleanup(instance.dispose);
    contract = contractOf(definition, instance.manifest());
    return instance.view;
  }));
  if (new TextEncoder().encode(html).byteLength > MAX_BYTES || !contract) throw new TypeError("Specimen SSR output exceeds its contract.");
  return Object.freeze({ html, snapshot: freeze({ protocol: "clank-component-snapshot/1" as const, name: specimen.name, fingerprint, contract }) });
}

/** Mount one isolated specimen in a dedicated document. Reset/select release the prior instance. */
export function mountComponentSpecimen(root: HTMLElement, specimen: ComponentSpecimen<any>): ComponentHarness {
  const definition = registered(specimen), token = reserve(root), document = root.ownerDocument;
  try { return start(root, definition, token); }
  catch (error) { if (documents.get(document) === token) documents.delete(document); throw error; }
}

/** Validate a detached SSR snapshot before attaching. Abort permits cancellation while hashing. */
export async function hydrateComponentSpecimen(root: HTMLElement, specimen: ComponentSpecimen<any>, snapshot: ComponentSpecimenSnapshot,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ComponentHarness> {
  const definition = registered(specimen), signal = options.signal;
  exact(snapshot, ["protocol", "name", "fingerprint", "contract"]);
  const captured = JSON.parse(canonical(snapshot)) as ComponentSpecimenSnapshot;
  if (captured.protocol !== "clank-component-snapshot/1" || captured.name !== specimen.name || !/^[a-f0-9]{64}$/.test(captured.fingerprint)) throw new TypeError("Invalid specimen snapshot.");
  const expected = contractOf(definition, captured.contract), token = reserve(root), document = root.ownerDocument;
  const aborted = () => { if (documents.get(document) === token) documents.delete(document); };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (signal?.aborted) throw new Error("Specimen hydration was aborted.");
    const fingerprint = await digest(definition.identity);
    if (signal?.aborted || documents.get(document) !== token) throw new Error("Specimen hydration was aborted.");
    if (root.ownerDocument !== document || !document.documentElement.contains(root)) throw new Error("Specimen hydration root changed.");
    if (fingerprint !== captured.fingerprint) throw new TypeError("Specimen fixture revision does not match its SSR snapshot.");
    return start(root, definition, token, expected);
  } catch (error) { aborted(); throw error; }
  finally { signal?.removeEventListener("abort", aborted); }
}

function start(root: HTMLElement, initial: Definition, token: object, expected?: UiManifest): ComponentHarness {
  const document = root.ownerDocument, window = document.defaultView!;
  let definition = initial, disposeView: Cleanup | undefined, current: ComponentSpecimenInstance | undefined;
  let phase: ComponentHarnessSnapshot["phase"] = expected ? "hydrated" : "mounted", generation = 0, created = 0, disposed = 0;
  let collecting = false, truncated = false;
  const hydration: HydrationDiagnostic[] = [];
  const stop = observeHydration(event => { if (collecting) { if (hydration.length < 1000) hydration.push(event); else truncated = true; } });
  const dispose = () => {
    if (phase === "disposed") return;
    phase = "disposed"; generation++;
    try { disposeView?.(); } finally {
      current = undefined; disposeView = undefined; stop(); hydration.length = 0;
      root.replaceChildren(); if (documents.get(document) === token) documents.delete(document);
    }
  };
  const paint = (server?: UiManifest) => {
    generation++;
    const view = h(function ComponentSpecimenRoot() {
      const instance = createInstance(definition); created++; current = instance;
      onCleanup(() => { try { instance.dispose(); } finally { disposed++; if (current === instance) current = undefined; } });
      const contract = contractOf(definition, instance.manifest());
      if (server && canonical(contract) !== canonical(server)) throw new TypeError("Specimen instance contract differs from SSR.");
      return instance.view;
    });
    try { collecting = !!server; disposeView = server ? hydrate(root, view) : render(root, view); }
    catch (error) { dispose(); throw error; }
    finally { collecting = false; }
  };
  const active = () => { if (phase === "disposed" || documents.get(document) !== token) throw new Error("Specimen harness is disposed."); };
  const harness: ComponentHarness = Object.freeze({
    snapshot() { return freeze({ protocol: "clank-component-harness/1" as const, name: definition.specimen.name, phase, generation,
      instancesCreated: created, instancesDisposed: disposed, contract: current ? contractOf(definition, current.manifest()) : null,
      hydration: [...hydration], truncated }); },
    reset() { active(); try { disposeView?.(); } catch (error) { dispose(); throw error; } disposeView = undefined; phase = "mounted"; paint(); },
    select(next: ComponentSpecimen<any>) { active(); const selected = registered(next); try { disposeView?.(); } catch (error) { dispose(); throw error; } disposeView = undefined; definition = selected; phase = "mounted"; hydration.length = 0; truncated = false; paint(); },
    async check() {
      active(); const observed = generation, config = definition, contract = contractOf(config, current!.manifest());
      const surface = createAgentSurface(document), present = new Set<string>();
      const visit = (nodes: ReturnType<typeof surface.inspect>) => { for (const node of nodes) { if (node.id) present.add(node.id); if (node.children) visit(node.children); } };
      visit(surface.inspect());
      // Required parts describe component anatomy; conditionally unmounted
      // parts are asserted in their declared states, rather than invented here.
      const automatic = Object.entries(config.parts).filter(([, target]) => present.has(target)).map(([part, target]) => {
        const role = contract.parts.find(entry => entry.name === part)?.role;
        return { expect: { target, ...(role ? { state: { role } } : {}) } };
      });
      const path = window.location.pathname + window.location.search + window.location.hash;
      const journey = defineJourney({ name: config.specimen.name + " current assertions", start: path,
        steps: [...automatic, ...config.assertions.map(expect => ({ expect }))] });
      const driver = createDomJourneyDriver(window, surface);
      const report = await runJourney(journey, driver, { baseUrl: window.location.origin, timeoutMs: 10000 });
      return generation === observed && phase !== "disposed" ? report : null;
    },
    exportAssertions() { active(); return exportComponentAssertions(definition.specimen); },
    dispose,
  });
  try { paint(expected); harnesses.set(harness, root); return harness; }
  catch (error) { dispose(); throw error; }
}

/** Plain native controls for switching/resetting specimens and reviewing/exporting assertions. */
export function mountComponentHarnessControls(container: HTMLElement, harness: ComponentHarness, specimens: readonly ComponentSpecimen<any>[]): Cleanup {
  if (!container?.ownerDocument || !harness || !Array.isArray(specimens) || !specimens.length || specimens.length > 50) throw new TypeError("Harness controls require 1–50 registered specimens.");
  const entries = [...specimens]; entries.forEach(registered);
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new TypeError("Harness specimen names must be unique.");
  const root = harnesses.get(harness), initial = harness.snapshot();
  if (!root || root.ownerDocument !== container.ownerDocument || root === container || root.contains(container)
    || initial.phase === "disposed" || !entries.some(entry => entry.name === initial.name)) throw new TypeError("Controls require the current harness document and an outside container.");
  const document = container.ownerDocument, panel = document.createElement("section"), select = document.createElement("select");
  panel.setAttribute("aria-label", "Component specimen controls"); select.setAttribute("aria-label", "Component specimen");
  for (const specimen of entries) { const option = document.createElement("option"); option.value = specimen.name; option.textContent = specimen.label; select.append(option); }
  select.value = initial.name;
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const output = document.createElement("textarea"); output.readOnly = true; output.hidden = true; output.setAttribute("aria-label", "Component assertion JSON");
  const reset = document.createElement("button"), check = document.createElement("button"), exported = document.createElement("button"), end = document.createElement("button");
  for (const [button, label] of [[reset, "Reset specimen"], [check, "Check current assertions"], [exported, "Export component assertions"], [end, "Dispose specimen"]] as const) { button.type = "button"; button.textContent = label; }
  panel.append(select, reset, check, exported, end, status, output); container.append(panel);
  let disposed = false, busy = false, operation = 0;
  const controls = [select, reset, check, exported, end];
  const refresh = () => { for (const control of controls) control.disabled = control === end ? disposed : busy || disposed; };
  const clear = () => { operation++; output.value = ""; output.hidden = true; };
  select.onchange = () => { if (disposed || busy) return; clear(); try { harness.select(entries.find(entry => entry.name === select.value)!); status.textContent = "Specimen mounted."; } catch { status.textContent = "Specimen could not be mounted."; } };
  reset.onclick = () => { if (disposed || busy) return; clear(); try { harness.reset(); status.textContent = "Specimen reset."; } catch { status.textContent = "Specimen could not be reset."; } };
  check.onclick = async () => {
    if (disposed || busy) return; const currentOperation = ++operation, wasFocused = document.activeElement === check;
    busy = true; refresh(); status.textContent = "Checking current assertions…";
    try { const report = await harness.check(); if (!disposed && currentOperation === operation) status.textContent = report ? report.ok ? "Current assertions passed." : "Current assertions failed." : "Specimen changed during the check."; }
    catch { if (!disposed && currentOperation === operation) status.textContent = "Current assertions could not be checked."; }
    finally { if (!disposed && currentOperation === operation) { busy = false; refresh(); if (wasFocused && document.activeElement === document.body) check.focus(); } }
  };
  exported.onclick = () => { if (disposed || busy) return; try { output.value = harness.exportAssertions(); output.hidden = false; status.textContent = "Assertions exported for the Chrome journey runner."; } catch { status.textContent = "Assertions could not be exported."; } };
  end.onclick = () => { if (disposed) return; clear(); let failed = false; try { harness.dispose(); } catch { failed = true; } finally { disposed = true; refresh(); status.textContent = failed ? "Specimen disposal failed." : "Specimen disposed."; } };
  return () => { if (!disposed) { disposed = true; clear(); try { harness.dispose(); } finally { panel.remove(); } } else panel.remove(); };
}

function registered(specimen: ComponentSpecimen<any>): Definition {
  const definition = specimen && definitions.get(specimen);
  if (!definition) throw new TypeError("Use a registered component specimen.");
  return definition;
}
function reserve(root: HTMLElement): object {
  const document = root?.ownerDocument;
  if (!document?.defaultView || root.nodeType !== 1 || root === document.body || root === document.documentElement
    || !document.documentElement.contains(root) || documents.has(document)) throw new TypeError("A dedicated connected specimen root and isolated document are required.");
  const token = {}; documents.set(document, token); return token;
}
function createInstance(definition: Definition): ComponentSpecimenInstance {
  const instance = definition.create(freeze(JSON.parse(definition.value)));
  if (!instance || typeof instance !== "object" || typeof instance.manifest !== "function" || typeof instance.dispose !== "function" || !Object.hasOwn(instance, "view")) {
    void Promise.resolve(instance).catch(() => undefined);
    if (typeof instance?.dispose === "function") instance.dispose();
    throw new TypeError("Specimen factories must return an instance synchronously with view, manifest and disposal.");
  }
  let disposed = false;
  const dispose = instance.dispose.bind(instance);
  return { view: instance.view, manifest: instance.manifest.bind(instance), dispose() { if (!disposed) { disposed = true; dispose(); } } };
}
function contractOf(definition: Definition, value: UiManifest): UiManifest {
  // A malformed async manifest must not leave a rejection behind when JSON
  // validation rejects its unsupported value. No manifest result is awaited.
  void Promise.resolve(value).catch(() => undefined);
  const raw = JSON.parse(canonical(value, 64 * 1024)) as UiManifest;
  if (raw.protocol !== "clank-ui/1" || raw.parts?.length > 64 || raw.actions?.length > 64) throw new TypeError("Invalid specimen UI contract.");
  const contract = createUiManifest(raw);
  for (const part of Object.keys(definition.parts)) if (!contract.parts.some(entry => entry.name === part)) throw new TypeError("Mapped specimen part is absent from the UI contract.");
  for (const part of contract.parts) if (part.required && !Object.hasOwn(definition.parts, part.name)) throw new TypeError("Required UI parts must have semantic fixture mappings.");
  return contract;
}
async function digest(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new TypeError("Invalid specimen identifier.");
  return value;
}
function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new TypeError("Invalid specimen text.");
  return value.trim();
}
function exact(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("Invalid component harness contract.");
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value: unknown, limit = MAX_BYTES): string {
  let nodes = 0, characters = 0;
  const normalize = (current: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 16) throw new TypeError("Component fixture data exceeds its bounds.");
    if (typeof current === "string") { characters += current.length + 2; if (characters > limit) throw new TypeError("Component fixture data exceeds its byte limit."); return current; }
    if (current === null || typeof current === "boolean" || typeof current === "number" && Number.isFinite(current)) return current;
    if (Array.isArray(current)) return current.map(entry => normalize(entry, depth + 1));
    if (current && typeof current === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(current))) {
      return Object.fromEntries(Object.keys(current).sort().filter(key => (current as Record<string, unknown>)[key] !== undefined)
        .map(key => { characters += key.length + 2; if (characters > limit) throw new TypeError("Component fixture data exceeds its byte limit."); return [key, normalize((current as Record<string, unknown>)[key], depth + 1)]; }));
    }
    throw new TypeError("Component fixtures require finite JSON data.");
  };
  const output = JSON.stringify(normalize(value, 0));
  if (new TextEncoder().encode(output).byteLength > limit) throw new TypeError("Component fixture data exceeds its byte limit.");
  return output;
}
