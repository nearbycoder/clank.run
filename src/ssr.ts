import { ROOT_CLEANUP_STATE, createRoot, isSignal, type Cleanup } from "./core.ts";
import { agentActionPath, type AgentActionTarget } from "./agent-contract.ts";
import {
  Fragment,
  KEYED,
  PORTAL,
  VNODE,
  createRenderContexts,
  evaluateComponent,
  isExpression,
  type KeyedBlock,
  type PortalBlock,
  type Renderable,
  type VNode,
} from "./dom.ts";
import { assertSafeAttributeValue, isInertAttributeName } from "./security.ts";

export interface RenderStringOptions {
  markers?: boolean;
}

type Rendered = string | Promise<string>;

interface SSRContext {
  contexts: Map<symbol, unknown>;
  markers: boolean;
  /** Roots of components that rendered inline, released when the current synchronous pass ends. */
  release: Cleanup[];
  selection?: { values: Set<string>; multiple: boolean; matched: boolean };
  selectionBefore?: Rendered;
  text?: Rendered[];
}

/** Renders Clank TSX/VNodes to escaped HTML without requiring a DOM. */
export async function renderToString(view: Renderable, options: RenderStringOptions = {}): Promise<string> {
  const context: SSRContext = { contexts: createRenderContexts(), markers: options.markers !== false, release: [] };
  const rendered = renderValue(view, context);
  // Cleanup never runs inside the caller's stack: yield once before releasing inline components.
  if (context.release.length > 0) await undefined;
  return endPass(rendered, context);
}

/**
 * Close one synchronous rendering pass: dispose every component that rendered
 * inline during it. Components keep their owned values until their siblings
 * have been evaluated, so disposal waits for the whole pass rather than for
 * each component's own return.
 */
function endPass(rendered: Rendered, context: SSRContext): Rendered {
  const pending = context.release;
  if (pending.length === 0) return rendered;
  let failure: { error: unknown } | undefined;
  // Children finish before their parents, so this order releases innermost roots first.
  for (let index = 0; index < pending.length; index++) {
    try { pending[index]!(); } catch (error) { failure ??= { error }; }
  }
  pending.length = 0;
  if (!failure) return rendered;
  const { error } = failure;
  // A rendering failure outranks a cleanup failure; otherwise the cleanup error rejects the render.
  return typeof rendered === "string" ? Promise.reject(error) : rendered.then(() => { throw error; });
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
  const len = json.length;
  let out = "";
  let last = 0;
  for (let i = 0; i < len; i++) {
    const c = json.charCodeAt(i);
    let esc: string;
    if (c === 60) esc = "\\u003c";
    else if (c === 62) esc = "\\u003e";
    else if (c === 38) esc = "\\u0026";
    else if (c === 0x2028) esc = "\\u2028";
    else if (c === 0x2029) esc = "\\u2029";
    else continue;
    if (last < i) out += json.slice(last, i);
    out += esc;
    last = i + 1;
  }
  return last === 0 ? json : last < len ? out + json.slice(last) : out;
}

export function readState<Value = unknown>(id = "__CLANK_STATE__", root: ParentNode = document): Value | undefined {
  const element = root.querySelector(`#${cssEscape(id)}`);
  if (!element) return undefined;
  const text = element.textContent;
  return text ? JSON.parse(text) as Value : undefined;
}

function renderValue(input: Renderable, context: SSRContext): Rendered {
  try {
    // Text and elements are nearly every node, so they are recognised before the rarer reactive wrappers.
    if (typeof input === "string") {
      context.text?.push(input);
      return escapeText(input);
    }
    if (typeof input === "object" && input !== null) {
      if (Array.isArray(input)) return renderList(input, context);
      if ((input as unknown as Record<PropertyKey, unknown>)[VNODE]) return renderVNode(input as VNode, context);
      if (isExpression(input)) return renderDynamic(input.read as () => Renderable, context);
      if (isSignal(input)) {
        const content = renderValue(resolveReactive(input.value), context);
        return context.markers ? wrapRendered(content, "<!--clank:start-->", "<!--clank:end-->") : content;
      }
      if (isKeyedBlock(input)) return renderKeyed(input, context);
      if (isPortalBlock(input)) return renderPortal(input, context);
      if (input instanceof Promise) {
        if (!context.text) return renderPromise(input as Promise<unknown>, context);
        const text: Rendered[] = [];
        const rendered = renderPromise(input as Promise<unknown>, { ...context, text });
        context.text.push(rendered.then(() => joinRendered(text)));
        return rendered;
      }
    } else {
      if (typeof input === "function") return renderDynamic(input as () => Renderable, context);
      if (input === null || input === undefined || input === false || input === true) return context.markers ? "<!--clank-->" : "";
      if (typeof input === "number" || typeof input === "bigint") {
        // Numeric text never contains markup characters.
        const text = String(input);
        context.text?.push(text);
        return text;
      }
    }
    if (typeof Node !== "undefined" && input instanceof Node) {
      context.text?.push(input.textContent ?? "");
      return input instanceof Element ? input.outerHTML : escapeText(input.textContent ?? "");
    }
    throw new TypeError(`Cannot server-render value: ${String(input)}`);
  } catch (error) {
    // Keep failures asynchronous so all sibling results reach Promise.all and
    // already-started async children retain rejection handlers and cleanup.
    return Promise.reject(error);
  }
}

async function renderPromise(input: Promise<unknown>, context: SSRContext): Promise<string> {
  // Await external promises so renderer chains use a native promise even when
  // an input subclass customizes methods such as finally.
  const resolved = await input;
  // This continuation is its own synchronous pass with its own inline components.
  const passContext = { ...context, release: [] };
  return endPass(renderValue(resolved as Renderable, passContext), passContext);
}

function joinRendered(values: Rendered[]): Rendered {
  return values.every((value) => typeof value === "string")
    ? values.join("")
    : Promise.all(values).then(joinParts);
}

function joinParts(parts: string[]): string {
  return parts.join("");
}

/** Renders sibling values, concatenating directly for as long as every result is already a string. */
function renderList(values: readonly Renderable[], context: SSRContext): Rendered {
  if (context.selection && !context.selection.multiple) return renderSiblings(values as Renderable[], renderValue, context);
  let text = "";
  let parts: Rendered[] | undefined;
  for (let index = 0; index < values.length; index++) {
    // Start every child now, including its rejection handlers.
    const rendered = renderValue(values[index], context);
    if (parts) parts.push(rendered);
    else if (typeof rendered === "string") text += rendered;
    else parts = [text, rendered];
  }
  return parts ? Promise.all(parts).then(joinParts) : text;
}

function renderSiblings<T>(values: T[], render: (value: T, context: SSRContext) => Rendered, context: SSRContext): Rendered {
  const ordered = context.selection && !context.selection.multiple;
  let previous = context.selectionBefore;
  return joinRendered(values.map((value) => {
    const child = ordered ? { ...context, selectionBefore: previous } : context;
    const rendered = render(value, child);
    // Start all children now, including their rejection handlers. Only a
    // single select's selection decisions wait for preceding DOM siblings.
    if (ordered) previous = previous instanceof Promise ? Promise.all([previous, rendered]).then(() => "", () => "") : rendered;
    return rendered;
  }));
}

function wrapRendered(content: Rendered, before: string, after: string): Rendered {
  return typeof content === "string" ? before + content + after : content.then((value) => before + value + after);
}

function renderDynamic(read: () => Renderable, context: SSRContext): Rendered {
  const content = renderValue(resolveReactive(read()), context);
  return context.markers ? wrapRendered(content, "<!--clank:start-->", "<!--clank:end-->") : content;
}

function renderKeyed(block: KeyedBlock<any>, context: SSRContext): Rendered {
  const values = resolveReactive(block.each as Renderable);
  if (!Array.isArray(values)) throw new TypeError("For expects an array during server rendering.");
  let content: Rendered;
  if (values.length === 0) content = renderValue(resolveReactive(block.fallback ?? null), context);
  else if (context.selection && !context.selection.multiple) {
    content = renderSiblings(values.map((item, index) => ({ item, index })), ({ item, index }, childContext) => {
      try { return renderValue(block.renderItem(item, () => index), childContext); }
      catch (error) { return Promise.reject(error); }
    }, context);
  } else {
    let text = "";
    let parts: Rendered[] | undefined;
    for (let index = 0; index < values.length; index++) {
      let rendered: Rendered;
      try { rendered = renderValue(block.renderItem(values[index], () => index), context); }
      catch (error) { rendered = Promise.reject(error); }
      if (parts) parts.push(rendered);
      else if (typeof rendered === "string") text += rendered;
      else parts = [text, rendered];
    }
    content = parts ? Promise.all(parts).then(joinParts) : text;
  }
  return context.markers ? wrapRendered(content, "<!--clank:for-->", "<!--clank:/for-->") : content;
}

function renderPortal(portal: PortalBlock, context: SSRContext): Rendered {
  const content = renderValue(portal.children, context);
  return context.markers ? wrapRendered(content, "<!--clank:portal-->", "<!--clank:/portal-->") : content;
}

function renderVNode(vnode: VNode, context: SSRContext): Rendered {
  const type = vnode.type;
  if (typeof type === "string") return renderElement(vnode, context);
  if (type === Fragment) return renderValue(vnode.props.children as Renderable[], context);
  if (typeof type === "function") return renderComponent(vnode, context);
  return renderElement(vnode, context);
}

function renderComponent(vnode: VNode, context: SSRContext): Rendered {
  let dispose: Cleanup | undefined;
  let rendered: Rendered;
  try {
    const evaluation = createRoot((cleanup) => {
      dispose = cleanup;
      return evaluateComponent(vnode, context.contexts);
    });
    rendered = renderValue(
      evaluation.output,
      evaluation.contexts === context.contexts ? context : { ...context, contexts: evaluation.contexts },
    );
  } catch (error) {
    rendered = Promise.reject(error);
  }
  // Assigned inside the root callback, which control-flow analysis cannot see.
  const release = dispose as (Cleanup & { [ROOT_CLEANUP_STATE]?: { cleanups: Cleanup[]; escaped?: boolean } }) | undefined;
  if (!release) return rendered;
  if (typeof rendered === "string") {
    const state = release[ROOT_CLEANUP_STATE];
    if (state !== undefined && state.cleanups.length === 0 && !state.escaped) return rendered;
    // An inline component stays a plain string, so its ancestors can stay
    // synchronous too. Its root is released when this pass ends: after its
    // siblings, which may still read values it owns.
    context.release.push(release);
    return rendered;
  }
  // Keep component-owned values alive through async children.
  return rendered.then(
    (value) => { release(); return value; },
    (error) => { try { release(); } catch {} throw error; },
  );
}

const SAFE_TAG = /^[A-Za-z][A-Za-z0-9:._-]*$/;
const SAFE_ATTRIBUTE = /^[A-Za-z_:][A-Za-z0-9:._-]*$/;
const MAX_NAME_CACHE = 1024;
/** Validated tag names and their lower-case form. Templates reuse a small vocabulary. */
const knownTags = new Map<string, string>();
/** Validated attribute names: 1 = aria, 2 = inline event, 4 = value needs the URL/raw-HTML policy. */
const knownAttributes = new Map<string, number>();
const knownStyles = new Map<string, string>();
const knownClasses = new Map<string, string>();

function lowerTagName(tag: string): string {
  let lower = knownTags.get(tag);
  if (lower === undefined) {
    if (!SAFE_TAG.test(tag)) throw new TypeError(`Unsafe HTML tag name: ${tag}`);
    lower = tag.toLowerCase();
    if (knownTags.size < MAX_NAME_CACHE) knownTags.set(tag, lower);
  }
  return lower;
}

/** Deduplicate and normalise a class list, exactly as `[...new Set(tokens)].join(" ")` would. */
function classTokens(value: string): string {
  let normalized = knownClasses.get(value);
  if (normalized === undefined) {
    normalized = [...new Set(value.split(/\s+/).filter(Boolean))].join(" ");
    if (value.length <= 256) {
      if (knownClasses.size >= 4096) knownClasses.clear();
      knownClasses.set(value, normalized);
    }
  }
  return normalized;
}

/** Ordered attribute list with Map semantics: a repeated name keeps its first position and takes the last value. */
interface Attributes { names: string[]; values: Array<string | true>; }

function putAttribute(attributes: Attributes, name: string, value: string | true): void {
  const index = attributes.names.indexOf(name);
  if (index === -1) { attributes.names.push(name); attributes.values.push(value); }
  else attributes.values[index] = value;
}

function openingTag(tag: string, attributes: Attributes): string {
  const { names, values } = attributes;
  let html = `<${tag}`;
  for (let index = 0; index < names.length; index++) {
    const value = values[index]!;
    html += value === true ? ` ${names[index]}` : ` ${names[index]}="${escapeAttribute(value)}"`;
  }
  return `${html}>`;
}

function renderElement(vnode: VNode, context: SSRContext): Rendered {
  const tag = vnode.type as string;
  const lowerTag = lowerTagName(tag);
  const props = vnode.props;
  const control = lowerTag === "textarea" || lowerTag === "select";
  const isSelectOrOption = lowerTag === "select" || lowerTag === "option";

  // Fast path: non-select/option elements without alias/bind/agent props build the
  // opening tag string directly in a single pass with zero attribute-array allocations.
  if (!isSelectOrOption) {
    if ((vnode as VNode & { _p?: boolean })._p === false) {
      const open = `<${tag}>`;
      if (VOID_ELEMENTS.has(lowerTag)) return open;
      const ch = props.children as Renderable[];
      if (ch.length === 1 && typeof ch[0] === "string") {
        const str = ch[0];
        context.text?.push(str);
        return `${open}${escapeText(str)}</${tag}>`;
      }
      const children = renderList(ch, context);
      return typeof children === "string"
        ? `${open}${children}</${tag}>`
        : children.then((content) => `${open}${content}</${tag}>`);
    }
    let open = `<${tag}`;
    let baseClassName = "";
    let classListName = "";
    let hasValue = false;
    let controlValue: unknown;
    let slow = false;
    for (const property in props) {
      if (property === "children" || property === "key" || property === "ref" || property === "use" || property === "dangerouslySetInnerHTML") continue;
      const first = property.charCodeAt(0);
      if ((first === 111 || first === 79) && /^on(?::|[a-z])/i.test(property)) continue;
      if (
        (first === 98 && property.startsWith("bind:"))
        || (first === 97 && (property === "agentLabel" || property === "agentAction" || property === "agentId" || property === "agentDescription" || property === "agentHidden"))
        || property === "htmlFor"
        || property === "intent"
      ) {
        slow = true;
        break;
      }
      const raw = props[property];
      if (control && property === "value") {
        hasValue = true;
        controlValue = resolveReactive(raw);
        if (controlValue === false) controlValue = "";
        continue;
      }
      if (property === "class" || property === "className") {
        baseClassName = normalizeClass(resolveReactive(raw));
        continue;
      }
      if (property === "classList") {
        const list = resolveReactive(raw);
        if (list && typeof list === "object") {
          const rec = list as Record<string, unknown>;
          for (const names in rec) {
            if (Boolean(resolveReactive(rec[names]))) classListName = classListName ? `${classListName} ${names}` : names;
          }
        }
        continue;
      }
      if (property === "style") {
        const style = styleString(resolveReactive(raw));
        if (style) open += ` style="${escapeAttribute(style)}"`;
        continue;
      }
      const value = resolveReactive(raw);
      const flags = attributeFlags(property);
      if (flags & 1 && typeof value === "boolean") {
        open += ` ${property}="${value ? "true" : "false"}"`;
        continue;
      }
      if (value === false || value === null || value === undefined) continue;
      if (flags & 2) throw new TypeError(`Inline event attribute ${property} is not allowed.`);
      if (flags & 4) assertSafeAttributeValue(lowerTag, property, value);
      open += value === true ? ` ${property}` : ` ${property}="${escapeAttribute(String(value))}"`;
    }
    if (!slow) {
      if (baseClassName || classListName) {
        const className = classTokens(baseClassName && classListName ? `${baseClassName} ${classListName}` : baseClassName || classListName);
        if (className) open += ` class="${escapeAttribute(className)}"`;
      }
      open += ">";
      if (VOID_ELEMENTS.has(lowerTag)) return open;
      if (lowerTag === "textarea" && hasValue) {
        const text = String(controlValue ?? "");
        context.text?.push(text);
        return `${open}${text.length > 0 && (text.charCodeAt(0) === 10 || text.charCodeAt(0) === 13) ? "\n" : ""}${escapeText(text)}</${tag}>`;
      }
      const rawHTML = props.dangerouslySetInnerHTML;
      if (rawHTML === undefined) {
        const ch = props.children as Renderable[];
        if (ch.length === 1 && typeof ch[0] === "string") {
          const str = ch[0];
          context.text?.push(str);
          return `${open}${escapeText(str)}</${tag}>`;
        }
        const children = renderList(ch, context);
        return typeof children === "string"
          ? `${open}${children}</${tag}>`
          : children.then((content) => `${open}${content}</${tag}>`);
      }
      const html = String(resolveReactive(rawHTML && typeof rawHTML === "object" ? (rawHTML as { __html?: unknown }).__html : rawHTML) ?? "");
      return `${open}${html}</${tag}>`;
    }
  }

  const attributes: Attributes = { names: [], values: [] };
  let baseClassName = "";
  let classListName = "";
  let hasValue = false;
  let controlValue: unknown;

  for (const property in props) {
    if (property === "children" || property === "key" || property === "ref" || property === "use" || property === "dangerouslySetInnerHTML") continue;
    const first = property.charCodeAt(0);
    if ((first === 111 || first === 79) && /^on(?::|[a-z])/i.test(property)) continue;
    const raw = props[property];
    if (control && (property === "value" || property === "bind:value")) {
      hasValue = true;
      controlValue = resolveReactive(raw);
      if (property === "value" && controlValue === false) controlValue = "";
      continue;
    }
    if (property === "class" || property === "className") {
      baseClassName = normalizeClass(resolveReactive(raw));
      continue;
    }
    if (property === "classList") {
      const list = resolveReactive(raw);
      if (list && typeof list === "object") {
        const rec = list as Record<string, unknown>;
        for (const names in rec) {
          if (Boolean(resolveReactive(rec[names]))) classListName = classListName ? `${classListName} ${names}` : names;
        }
      }
      continue;
    }
    if (property === "style") {
      const style = styleString(resolveReactive(raw));
      if (style) putAttribute(attributes, "style", style);
      continue;
    }
    if (first === 98 && property.startsWith("bind:")) {
      setSSRAttribute(attributes, property.slice(5), resolveReactive(raw), lowerTag);
      continue;
    }
    if (property === "agentLabel") {
      const value = resolveReactive(raw);
      setSSRAttribute(attributes, "data-clank-label", value, lowerTag);
      if (isInteractiveTag(lowerTag)) setSSRAttribute(attributes, "aria-label", value, lowerTag);
      continue;
    }
    if (property === "agentAction") {
      setSSRAttribute(
        attributes,
        "data-clank-action",
        resolveAgentAction(raw),
        lowerTag,
      );
      continue;
    }
    setSSRAttribute(attributes, attributeName(property), resolveReactive(raw), lowerTag);
  }
  if (baseClassName || classListName) {
    const className = classTokens(baseClassName && classListName ? `${baseClassName} ${classListName}` : baseClassName || classListName);
    if (className) putAttribute(attributes, "class", className);
  }

  if (VOID_ELEMENTS.has(lowerTag)) return openingTag(tag, attributes);

  if (lowerTag === "textarea" && hasValue) {
    const text = String(controlValue ?? "");
    context.text?.push(text);
    // HTML parsing removes one leading line feed from textarea content.
    return `${openingTag(tag, attributes)}${/^[\r\n]/.test(text) ? "\n" : ""}${escapeText(text)}</${tag}>`;
  }

  const rawHTML = props.dangerouslySetInnerHTML;
  if (!isSelectOrOption) {
    // Nothing below can change this element's attributes, so its tag is final now.
    const opening = openingTag(tag, attributes);
    const children = rawHTML === undefined
      ? renderValue(props.children as Renderable[], context)
      : String(resolveReactive(rawHTML && typeof rawHTML === "object" ? (rawHTML as { __html?: unknown }).__html : rawHTML) ?? "");
    return typeof children === "string"
      ? `${opening}${children}</${tag}>`
      : children.then((content) => `${opening}${content}</${tag}>`);
  }

  let childContext = context;
  if (lowerTag === "select") {
    const multiple = attributes.names.includes("multiple");
    const selected = multiple && Array.isArray(controlValue)
      ? controlValue.map(String)
      : [String(controlValue ?? "")];
    childContext = { ...context, selection: hasValue ? { values: new Set(selected), multiple, matched: false } : undefined, selectionBefore: undefined };
  }
  const optionText: Rendered[] | undefined = lowerTag === "option" && context.selection && !attributes.names.includes("value") ? [] : undefined;
  if (optionText) childContext = { ...childContext, text: optionText };

  const children = rawHTML === undefined
    ? renderValue(props.children as Renderable[], childContext)
    : String(resolveReactive(rawHTML && typeof rawHTML === "object" ? (rawHTML as { __html?: unknown }).__html : rawHTML) ?? "");
  const finish = (content: Rendered, text?: string) => {
    if (lowerTag === "option" && context.selection) {
      const position = attributes.names.indexOf("value");
      const explicit = position === -1 ? undefined : attributes.values[position];
      const value = explicit === undefined ? (text ?? "").replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "") : explicit === true ? "" : explicit;
      const selected = attributes.names.indexOf("selected");
      if (context.selection.values.has(value) && (context.selection.multiple || !context.selection.matched)) {
        putAttribute(attributes, "selected", true);
        context.selection.matched = true;
      } else if (selected !== -1) {
        attributes.names.splice(selected, 1);
        attributes.values.splice(selected, 1);
      }
    }
    return wrapRendered(content, openingTag(tag, attributes), `</${tag}>`);
  };
  const orderedFinish = (content: Rendered, text?: string): Rendered => lowerTag === "option" && context.selectionBefore instanceof Promise
    ? Promise.all([context.selectionBefore, content]).then(([, content]) => finish(content, text))
    : finish(content, text);
  if (optionText) {
    const text = joinRendered(optionText);
    return typeof text === "string" ? orderedFinish(children, text) : Promise.all([children, text]).then(([content, text]) => orderedFinish(content, text));
  }
  return orderedFinish(children);
}

function resolveReactive(input: unknown): any {
  // Most props are plain values; only wrappers need the unwrapping loop.
  if (typeof input !== "function" && (typeof input !== "object" || input === null)) return input;
  let value: unknown = input;
  let first: unknown = resolveReactive;
  let seen: Set<unknown> | undefined;
  while (isExpression(value) || isSignal(value) || typeof value === "function") {
    if (value === first || seen?.has(value)) throw new Error("Circular reactive value during server rendering.");
    // One hop is the norm; a set is only worth building for chains.
    if (first === resolveReactive) first = value;
    else (seen ??= new Set()).add(value);
    value = isExpression(value)
      ? value.read()
      : isSignal(value)
        ? value.value
        : (value as () => unknown)();
  }
  return value;
}

function resolveAgentAction(input: unknown): string {
  let value = input;
  const seen = new Set<unknown>();
  while (true) {
    try {
      return agentActionPath(value as AgentActionTarget);
    } catch {
      // Reactive wrappers are resolved below; other invalid values fail at the end.
    }
    if (!(isExpression(value) || isSignal(value) || typeof value === "function")) {
      return agentActionPath(value as AgentActionTarget);
    }
    if (seen.has(value)) throw new Error("Circular reactive agent action during server rendering.");
    seen.add(value);
    value = isExpression(value)
      ? value.read()
      : isSignal(value)
        ? value.value
        : (value as () => unknown)();
  }
}

function isKeyedBlock(value: unknown): value is KeyedBlock<any> {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[KEYED]);
}

function isPortalBlock(value: unknown): value is PortalBlock {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[PORTAL]);
}

function normalizeClass(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let names = "";
    for (let i = 0; i < value.length; i++) {
      const part = normalizeClass(value[i]);
      if (part) names = names ? `${names} ${part}` : part;
    }
    return names;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    let names = "";
    for (const name in rec) {
      if (Object.hasOwn(rec, name) && Boolean(resolveReactive(rec[name]))) {
        names = names ? `${names} ${name}` : name;
      }
    }
    return names;
  }
  return value === null || value === undefined || value === false ? "" : String(value);
}

function styleProperty(name: string): string {
  let property = knownStyles.get(name);
  if (property === undefined) {
    property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (!/^(?:--[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9_-]*)$/.test(property)) throw new TypeError(`Unsafe CSS property: ${name}`);
    if (knownStyles.size < MAX_NAME_CACHE) knownStyles.set(name, property);
  }
  return property;
}

function styleString(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const rec = value as Record<string, unknown>;
  let style = "";
  for (const name in rec) {
    if (!Object.hasOwn(rec, name)) continue;
    const entry = resolveReactive(rec[name]);
    if (entry === null || entry === undefined || entry === false) continue;
    const declaration = `${styleProperty(name)}:${String(entry)}`;
    style = style ? `${style};${declaration}` : declaration;
  }
  return style;
}

function attributeFlags(name: string): number {
  let flags = knownAttributes.get(name);
  if (flags === undefined) {
    if (!SAFE_ATTRIBUTE.test(name)) throw new TypeError(`Unsafe HTML attribute name: ${name}`);
    flags = (name.startsWith("aria-") ? 1 : 0) | (/^on/i.test(name) ? 2 : 0) | (isInertAttributeName(name) ? 0 : 4);
    if (knownAttributes.size < MAX_NAME_CACHE) knownAttributes.set(name, flags);
  }
  return flags;
}

function setSSRAttribute(attributes: Attributes, name: string, value: unknown, tag: string): void {
  const flags = attributeFlags(name);
  if (flags & 1 && typeof value === "boolean") {
    putAttribute(attributes, name, String(value));
    return;
  }
  if (value === false || value === null || value === undefined) return;
  if (flags & 2) throw new TypeError(`Inline event attribute ${name} is not allowed.`);
  if (flags & 4) assertSafeAttributeValue(tag, name, value);
  putAttribute(attributes, name, value === true ? true : String(value));
}

const ATTRIBUTE_NAMES: Record<string, string> = Object.assign(Object.create(null), {
  htmlFor: "for",
  agentId: "data-clank-id",
  agentAction: "data-clank-action",
  agentDescription: "data-clank-description",
  agentHidden: "data-clank-hidden",
  intent: "data-clank-intent",
});

function attributeName(property: string): string {
  return ATTRIBUTE_NAMES[property] ?? property;
}

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "summary", "textarea"]);
function isInteractiveTag(tag: string): boolean {
  return INTERACTIVE_TAGS.has(tag);
}

function escapeText(value: string): string {
  const len = value.length;
  let out = "";
  let last = 0;
  for (let i = 0; i < len; i++) {
    const c = value.charCodeAt(i);
    let esc: string;
    if (c === 38) esc = "&amp;";
    else if (c === 60) esc = "&lt;";
    else if (c === 62) esc = "&gt;";
    else continue;
    if (last < i) out += value.slice(last, i);
    out += esc;
    last = i + 1;
  }
  return last === 0 ? value : last < len ? out + value.slice(last) : out;
}

function escapeAttribute(value: string): string {
  const len = value.length;
  let out = "";
  let last = 0;
  for (let i = 0; i < len; i++) {
    const c = value.charCodeAt(i);
    let esc: string;
    if (c === 34) esc = "&quot;";
    else if (c === 38) esc = "&amp;";
    else if (c === 39) esc = "&#39;";
    else if (c === 60) esc = "&lt;";
    else if (c === 62) esc = "&gt;";
    else continue;
    if (last < i) out += value.slice(last, i);
    out += esc;
    last = i + 1;
  }
  return last === 0 ? value : last < len ? out + value.slice(last) : out;
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
