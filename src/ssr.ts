import { isSignal } from "./core.ts";
import {
  Fragment,
  KEYED,
  evaluateComponent,
  isExpression,
  isVNode,
  type KeyedBlock,
  type Renderable,
  type VNode,
} from "./dom.ts";
import { assertSafeAttributeValue } from "./security.ts";

export interface RenderStringOptions {
  markers?: boolean;
}

interface SSRContext {
  contexts: Map<symbol, unknown>;
  markers: boolean;
}

/** Renders Clank TSX/VNodes to escaped HTML without requiring a DOM. */
export async function renderToString(view: Renderable, options: RenderStringOptions = {}): Promise<string> {
  return renderValue(view, { contexts: new Map(), markers: options.markers !== false });
}

export interface RenderDocumentOptions extends RenderStringOptions {
  title?: string;
  lang?: string;
  head?: Renderable;
  rootId?: string;
  bodyClass?: string;
  state?: unknown;
  stateId?: string;
  scripts?: string[];
  stylesheets?: string[];
  /** CSP nonce applied to Clank's generated state and module script tags. */
  nonce?: string;
}

/** Renders a complete HTML document and safely embeds optional hydration data. */
export async function renderDocument(view: Renderable, options: RenderDocumentOptions = {}): Promise<string> {
  const rootId = options.rootId ?? "app";
  const nonce = options.nonce === undefined ? "" : nonceAttribute(options.nonce);
  const head = options.head === undefined ? "" : await renderToString(options.head, { markers: false });
  const styles = (options.stylesheets ?? []).map((href) => {
    assertSafeAttributeValue("link", "href", href);
    return `<link rel="stylesheet" href="${escapeAttribute(href)}">`;
  }).join("");
  const scripts = (options.scripts ?? []).map((src) => {
    assertSafeAttributeValue("script", "src", src);
    return `<script type="module"${nonce} src="${escapeAttribute(src)}"></script>`;
  }).join("");
  const state = options.state === undefined
    ? ""
    : `<script type="application/json"${nonce} id="${escapeAttribute(options.stateId ?? "__CLANK_STATE__")}">${serializeState(options.state)}</script>`;
  const bodyClass = options.bodyClass ? ` class="${escapeAttribute(options.bodyClass)}"` : "";
  return `<!doctype html><html lang="${escapeAttribute(options.lang ?? "en")}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">${options.title ? `<title>${escapeText(options.title)}</title>` : ""}${styles}${head}</head><body${bodyClass}><div id="${escapeAttribute(rootId)}">${await renderToString(view, options)}</div>${state}${scripts}</body></html>`;
}

export function serializeState(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("SSR state must be JSON serializable.");
  return json
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function readState<Value = unknown>(id = "__CLANK_STATE__", root: ParentNode = document): Value | undefined {
  const element = root.querySelector(`#${cssEscape(id)}`);
  if (!element) return undefined;
  const text = element.textContent;
  return text ? JSON.parse(text) as Value : undefined;
}

async function renderValue(input: Renderable, context: SSRContext): Promise<string> {
  if (isExpression(input)) return renderDynamic(input.read as () => Renderable, context);
  if (isSignal(input)) return renderDynamic(() => input.value as Renderable, context);
  if (isKeyedBlock(input)) return renderKeyed(input, context);
  if (typeof input === "function") return renderDynamic(input as () => Renderable, context);
  if (input instanceof Promise) {
    const resolved: unknown = await (input as Promise<unknown>);
    return renderValue(resolved as Renderable, context);
  }
  if (Array.isArray(input)) return (await Promise.all(input.map((entry) => renderValue(entry, context)))).join("");
  if (isVNode(input)) return renderVNode(input, context);
  if (input === null || input === undefined || input === false || input === true) return context.markers ? "<!--clank-->" : "";
  if (typeof input === "string" || typeof input === "number" || typeof input === "bigint") return escapeText(String(input));
  if (typeof Node !== "undefined" && input instanceof Node) {
    return input instanceof Element ? input.outerHTML : escapeText(input.textContent ?? "");
  }
  throw new TypeError(`Cannot server-render value: ${String(input)}`);
}

async function renderDynamic(read: () => Renderable, context: SSRContext): Promise<string> {
  const content = await renderValue(resolveReactive(read()), context);
  return context.markers ? `<!--clank:start-->${content}<!--clank:end-->` : content;
}

async function renderKeyed(block: KeyedBlock<any>, context: SSRContext): Promise<string> {
  const values = resolveReactive(block.each as Renderable);
  if (!Array.isArray(values)) throw new TypeError("For expects an array during server rendering.");
  const content = values.length === 0
    ? await renderValue(resolveReactive(block.fallback ?? null), context)
    : (await Promise.all(values.map((item, index) => renderValue(block.renderItem(item, () => index), context)))).join("");
  return context.markers ? `<!--clank:for-->${content}<!--clank:/for-->` : content;
}

async function renderVNode(vnode: VNode, context: SSRContext): Promise<string> {
  if (vnode.type === Fragment) return renderValue(vnode.props.children as Renderable[], context);
  if (typeof vnode.type === "function") {
    const evaluation = evaluateComponent(vnode, context.contexts);
    return renderValue(evaluation.output, { ...context, contexts: evaluation.contexts });
  }
  return renderElement(vnode, context);
}

async function renderElement(vnode: VNode, context: SSRContext): Promise<string> {
  const tag = vnode.type as string;
  if (!/^[A-Za-z][A-Za-z0-9:._-]*$/.test(tag)) throw new TypeError(`Unsafe HTML tag name: ${tag}`);
  const lowerTag = tag.toLowerCase();
  const props = vnode.props;
  const attributes = new Map<string, string | true>();
  let className = "";

  for (const [property, raw] of Object.entries(props)) {
    if (property === "children" || property === "key" || property === "ref" || property === "use" || property === "dangerouslySetInnerHTML") continue;
    if (/^on(?::|[a-z])/i.test(property)) continue;
    if (property === "class" || property === "className") {
      className = normalizeClass(resolveReactive(raw));
      continue;
    }
    if (property === "classList") {
      const list = resolveReactive(raw);
      if (list && typeof list === "object") {
        for (const [names, enabled] of Object.entries(list as Record<string, unknown>)) {
          if (Boolean(resolveReactive(enabled))) className = [className, names].filter(Boolean).join(" ");
        }
      }
      continue;
    }
    if (property === "style") {
      const style = styleString(resolveReactive(raw));
      if (style) attributes.set("style", style);
      continue;
    }
    if (property.startsWith("bind:")) {
      setSSRAttribute(attributes, property.slice(5), resolveReactive(raw), lowerTag);
      continue;
    }
    if (property === "agentLabel") {
      const value = resolveReactive(raw);
      setSSRAttribute(attributes, "data-clank-label", value, lowerTag);
      if (isInteractiveTag(lowerTag)) setSSRAttribute(attributes, "aria-label", value, lowerTag);
      continue;
    }
    setSSRAttribute(attributes, attributeName(property), resolveReactive(raw), lowerTag);
  }
  if (className) attributes.set("class", className.trim().replace(/\s+/g, " "));

  const serialized = [...attributes].map(([name, value]) => value === true
    ? ` ${name}`
    : ` ${name}="${escapeAttribute(value)}"`).join("");
  if (VOID_ELEMENTS.has(lowerTag)) return `<${tag}${serialized}>`;

  const rawHTML = props.dangerouslySetInnerHTML;
  const children = rawHTML === undefined
    ? await renderValue(props.children as Renderable[], context)
    : String(resolveReactive(rawHTML && typeof rawHTML === "object" ? (rawHTML as { __html?: unknown }).__html : rawHTML) ?? "");
  return `<${tag}${serialized}>${children}</${tag}>`;
}

function resolveReactive(input: unknown): any {
  let value = input;
  const seen = new Set<unknown>();
  while (isExpression(value) || isSignal(value) || typeof value === "function") {
    if (seen.has(value)) throw new Error("Circular reactive value during server rendering.");
    seen.add(value);
    value = isExpression(value)
      ? value.read()
      : isSignal(value)
        ? value.value
        : (value as () => unknown)();
  }
  return value;
}

function isKeyedBlock(value: unknown): value is KeyedBlock<any> {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[KEYED]);
}

function normalizeClass(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizeClass).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => Boolean(resolveReactive(enabled)))
      .map(([name]) => name)
      .join(" ");
  }
  return value === null || value === undefined || value === false ? "" : String(value);
}

function styleString(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>).flatMap(([name, raw]) => {
    const entry = resolveReactive(raw);
    if (entry === null || entry === undefined || entry === false) return [];
    const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (!/^(?:--[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9_-]*)$/.test(property)) throw new TypeError(`Unsafe CSS property: ${name}`);
    return `${property}:${String(entry)}`;
  }).join(";");
}

function setSSRAttribute(attributes: Map<string, string | true>, name: string, value: unknown, tag: string): void {
  if (!/^[A-Za-z_:][A-Za-z0-9:._-]*$/.test(name)) throw new TypeError(`Unsafe HTML attribute name: ${name}`);
  if (name.startsWith("aria-") && typeof value === "boolean") {
    attributes.set(name, String(value));
    return;
  }
  if (value === false || value === null || value === undefined) return;
  if (/^on/i.test(name)) throw new TypeError(`Inline event attribute ${name} is not allowed.`);
  assertSafeAttributeValue(tag, name, value);
  attributes.set(name, value === true ? true : String(value));
}

function attributeName(property: string): string {
  return ({
    htmlFor: "for",
    agentId: "data-clank-id",
    agentAction: "data-clank-action",
    agentDescription: "data-clank-description",
    agentHidden: "data-clank-hidden",
    intent: "data-clank-intent",
  } as Record<string, string>)[property] ?? property;
}

function isInteractiveTag(tag: string): boolean {
  return ["a", "button", "input", "select", "summary", "textarea"].includes(tag);
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function cssEscape(value: string): string {
  const escape = (globalThis as unknown as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
  return escape ? escape(value) : value.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
}

function nonceAttribute(value: string): string {
  if (!/^[A-Za-z0-9+/_=-]{16,256}$/.test(value)) {
    throw new TypeError("A CSP nonce must be a 16-256 character base64 or base64url value.");
  }
  return ` nonce="${escapeAttribute(value)}"`;
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
