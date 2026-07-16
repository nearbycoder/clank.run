import {
  batch,
  createRoot,
  effect,
  isSignal,
  onCleanup,
  signal,
  type Cleanup,
  type Computed,
  type ReactiveSignal,
} from "./core.ts";
import { assertSafeAttributeValue } from "./security.ts";

export const VNODE = Symbol.for("clank.vnode");
export const Fragment = Symbol.for("clank.fragment");
export const EXPRESSION = Symbol.for("clank.expression");
export const KEYED = Symbol.for("clank.keyed");

export type Primitive = string | number | bigint | boolean | null | undefined;
export type Renderable = Primitive | Node | VNode | Renderable[] | ReactiveSignal<any> | Computed<any> | ReactiveExpression | KeyedBlock<any> | ((...args: any[]) => Renderable) | Promise<Renderable>;
export type Component<P extends Record<string, unknown> = Record<string, unknown>> = (props: P & { children: Renderable[] }) => Renderable;
export type ElementType = string | Component<any> | typeof Fragment;

export interface VNode {
  readonly [VNODE]: true;
  type: ElementType;
  props: Record<string, unknown>;
  key?: PropertyKey;
}

export interface ReactiveExpression<T = unknown> {
  readonly [EXPRESSION]: true;
  readonly read: () => T;
}

export interface KeyedBlock<T> {
  readonly [KEYED]: true;
  readonly each: T[] | ReactiveSignal<T[]> | Computed<T[]> | ReactiveExpression<T[]> | (() => T[]);
  readonly by?: keyof T | ((item: T, index: number) => PropertyKey);
  readonly fallback?: Renderable;
  readonly renderItem: (item: T, index: () => number) => Renderable;
}

interface Mounted {
  nodes: Node[];
  dispose(remove?: boolean): void;
}

interface MountContext {
  namespace?: string;
  contexts: Map<symbol, unknown>;
}

interface ComponentFrame {
  contexts: Map<symbol, unknown>;
  mounts: Array<() => void | Cleanup>;
}

export interface ComponentEvaluation {
  output: Renderable;
  contexts: Map<symbol, unknown>;
  mounts: Array<() => void | Cleanup>;
}

export interface ClankContext<T> {
  readonly id: symbol;
  readonly defaultValue: T;
}

let currentFrame: ComponentFrame | null = null;

export function h(
  type: ElementType,
  props: Record<string, unknown> | null = null,
  ...children: Renderable[]
): VNode {
  const input = props ?? {};
  const declared = input.children;
  const normalizedChildren = children.length > 0
    ? children
    : declared === undefined
      ? []
      : Array.isArray(declared)
        ? declared
        : [declared as Renderable];
  const output = { ...input, children: normalizedChildren };
  return {
    [VNODE]: true,
    type,
    props: output,
    key: input.key as PropertyKey | undefined,
  };
}

export const createElement = h;
export const jsx = h;
export const jsxs = h;
export const jsxDEV = h;

/** Compiler marker for an expression that should be evaluated inside a narrow reactive binding. */
export function expression<T>(read: () => T): ReactiveExpression<T> {
  return { [EXPRESSION]: true, read };
}

export function isExpression(value: unknown): value is ReactiveExpression {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[EXPRESSION]);
}

export function isVNode(value: unknown): value is VNode {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[VNODE]);
}

export function render(root: Element | DocumentFragment, view: Renderable): Cleanup {
  let disposeRoot: Cleanup = () => {};
  while (root.firstChild) root.removeChild(root.firstChild);
  createRoot((dispose) => {
    disposeRoot = dispose;
    const mounted = mountValue(root, view, null, { contexts: new Map() });
    onCleanup(() => mounted.dispose());
  });
  return () => {
    disposeRoot();
    while (root.firstChild) root.removeChild(root.firstChild);
  };
}

/** Attaches reactive bindings and events to Clank SSR markers without recreating matching DOM. */
export function hydrate(root: Element, view: Renderable): Cleanup {
  let disposeRoot: Cleanup = () => {};
  try {
    createRoot((dispose) => {
      disposeRoot = dispose;
      const cursor: HydrationCursor = { node: root.firstChild };
      const mounted = hydrateValue(root, view, cursor, { contexts: new Map() });
      if (cursor.node !== null) throw new HydrationMismatch("Unexpected trailing server-rendered nodes.");
      onCleanup(() => mounted.dispose());
    });
  } catch (error) {
    disposeRoot();
    root.setAttribute("data-clank-hydration", "remounted");
    console.warn("Clank hydration mismatch; remounting the root.", error);
    return render(root, view);
  }
  root.setAttribute("data-clank-hydration", "attached");
  return () => {
    disposeRoot();
    while (root.firstChild) root.removeChild(root.firstChild);
  };
}

interface HydrationCursor {
  node: Node | null;
}

class HydrationMismatch extends Error {
  readonly name = "HydrationMismatch";
}

function hydrateValue(parent: Node, input: Renderable, cursor: HydrationCursor, context: MountContext): Mounted {
  if (isExpression(input)) return hydrateDynamic(parent, input.read as () => Renderable, cursor, context);
  if (isSignal(input)) return hydrateDynamic(parent, () => input.value as Renderable, cursor, context);
  if (isKeyedBlock(input)) return hydrateKeyed(parent, input, cursor, context);
  if (typeof input === "function") return hydrateDynamic(parent, input as () => Renderable, cursor, context);
  if (input instanceof Promise) throw new HydrationMismatch("Promises cannot be synchronously hydrated.");
  if (Array.isArray(input)) return hydrateFragment(parent, input, cursor, context);
  if (isVNode(input)) return hydrateVNode(parent, input, cursor, context);
  if (typeof Node !== "undefined" && input instanceof Node) {
    if (cursor.node !== input) throw new HydrationMismatch("Client Node does not match the server Node.");
    cursor.node = input.nextSibling;
    return simpleMount([input]);
  }
  if (input === null || input === undefined || input === false || input === true) {
    const marker = expectComment(cursor, "clank");
    return simpleMount([marker]);
  }
  const node = cursor.node;
  const value = String(input);
  if (value === "") return simpleMount([]);
  if (!(node instanceof Text)) {
    const found = node instanceof Comment ? `<!--${node.data}-->` : node instanceof Element ? `<${node.localName}>` : String(node);
    throw new HydrationMismatch(`Expected server-rendered text ${JSON.stringify(value)}; found ${found}.`);
  }
  if (node.data !== value && node.data.startsWith(value)) {
    const remainder = document.createTextNode(node.data.slice(value.length));
    node.data = value;
    parent.insertBefore(remainder, node.nextSibling);
    cursor.node = remainder;
  } else {
    if (node.data !== value) node.data = value;
    cursor.node = node.nextSibling;
  }
  return simpleMount([node]);
}

function hydrateFragment(parent: Node, values: Renderable[], cursor: HydrationCursor, context: MountContext): Mounted {
  const mounted = values.map((value) => hydrateValue(parent, value, cursor, context));
  return {
    get nodes() { return mounted.flatMap((entry) => entry.nodes); },
    dispose(remove = true) {
      for (const entry of mounted.splice(0).reverse()) entry.dispose(remove);
    },
  };
}

function hydrateDynamic(parent: Node, read: () => Renderable, cursor: HydrationCursor, context: MountContext): Mounted {
  const start = expectComment(cursor, "clank:start");
  const initial = unwrapReactive(read());
  let current: Mounted;
  if (isTextValue(initial) && String(initial) === "" && cursor.node instanceof Comment && cursor.node.data === "clank:end") {
    const text = document.createTextNode("");
    parent.insertBefore(text, cursor.node);
    current = simpleMount([text]);
  } else {
    current = hydrateValue(parent, initial, cursor, context);
  }
  const end = expectComment(cursor, "clank:end");
  let currentValue: Renderable = initial;
  let first = true;
  const stop = effect(() => {
    const next = unwrapReactive(read());
    if (first) {
      first = false;
      currentValue = next;
      return;
    }
    if (Object.is(next, currentValue)) return;
    if (isTextValue(next) && current.nodes.length === 1 && current.nodes[0] instanceof Text) {
      const text = String(next);
      if (current.nodes[0].data !== text) current.nodes[0].data = text;
      currentValue = next;
      return;
    }
    current.dispose();
    current = mountValue(parent, next, end, context);
    currentValue = next;
  });
  let active = true;
  return {
    get nodes() { return [start, ...current.nodes, end]; },
    dispose(remove = true) {
      if (!active) return;
      active = false;
      stop();
      current.dispose(remove);
      if (remove) {
        start.parentNode?.removeChild(start);
        end.parentNode?.removeChild(end);
      }
    },
  };
}

function hydrateVNode(parent: Node, vnode: VNode, cursor: HydrationCursor, context: MountContext): Mounted {
  if (vnode.type === Fragment) return hydrateFragment(parent, vnode.props.children as Renderable[], cursor, context);
  if (typeof vnode.type === "function") return hydrateComponent(parent, vnode, cursor, context);
  return hydrateElement(parent, vnode, cursor, context);
}

function hydrateComponent(parent: Node, vnode: VNode, cursor: HydrationCursor, parentContext: MountContext): Mounted {
  let mounted!: Mounted;
  let disposeScope: Cleanup = () => {};
  try {
    createRoot((dispose) => {
      disposeScope = dispose;
      const evaluation = evaluateComponent(vnode, parentContext.contexts);
      mounted = hydrateValue(parent, evaluation.output, cursor, { ...parentContext, contexts: evaluation.contexts });
      for (const callback of evaluation.mounts) {
        const cleanup = callback();
        if (typeof cleanup === "function") onCleanup(cleanup);
      }
      onCleanup(() => mounted.dispose());
    });
  } catch (error) {
    disposeScope();
    throw error;
  }
  let active = true;
  return {
    get nodes() { return mounted.nodes; },
    dispose(remove = true) {
      if (!active) return;
      active = false;
      if (!remove) mounted.dispose(false);
      disposeScope();
    },
  };
}

function hydrateElement(parent: Node, vnode: VNode, cursor: HydrationCursor, context: MountContext): Mounted {
  const node = cursor.node;
  const tag = vnode.type as string;
  if (!(node instanceof Element) || node.localName !== tag.toLowerCase()) {
    throw new HydrationMismatch(`Expected server-rendered <${tag}>.`);
  }
  cursor.node = node.nextSibling;
  const namespace = context.namespace === "svg" || tag === "svg" ? "svg" : undefined;
  const cleanups: Cleanup[] = [];
  for (const [name, value] of Object.entries(vnode.props)) {
    if (name === "children" || name === "key") continue;
    const cleanup = bindProperty(node, name, value);
    if (cleanup) cleanups.push(cleanup);
  }
  const rawHTML = vnode.props.dangerouslySetInnerHTML;
  let children: Mounted | undefined;
  if (rawHTML === undefined) {
    const childCursor: HydrationCursor = { node: node.firstChild };
    children = hydrateFragment(node, vnode.props.children as Renderable[], childCursor, { ...context, namespace });
    if (childCursor.node !== null) throw new HydrationMismatch(`Unexpected children in server-rendered <${tag}>.`);
  }
  const ref = vnode.props.ref;
  if (typeof ref === "function") (ref as (element: Element) => void)(node);
  else if (isSignal(ref)) (ref as ReactiveSignal<Element | null>).value = node;
  return simpleMount([node], () => {
    children?.dispose(false);
    for (const cleanup of cleanups.reverse()) cleanup();
    if (isSignal(ref) && (ref as ReactiveSignal<Element | null>).peek() === node) {
      (ref as ReactiveSignal<Element | null>).value = null;
    }
  });
}

function expectComment(cursor: HydrationCursor, data: string): Comment {
  const node = cursor.node;
  if (!(node instanceof Comment) || node.data !== data) throw new HydrationMismatch(`Expected <!--${data}--> hydration marker.`);
  cursor.node = node.nextSibling;
  return node;
}

function mountValue(parent: Node, input: Renderable, before: Node | null, context: MountContext): Mounted {
  if (isExpression(input)) return mountDynamic(parent, input.read as () => Renderable, before, context);
  if (isSignal(input)) return mountDynamic(parent, () => input.value as Renderable, before, context);
  if (isKeyedBlock(input)) return mountKeyed(parent, input, before, context);
  if (typeof input === "function") return mountDynamic(parent, input as () => Renderable, before, context);
  if (input instanceof Promise) return mountPromise(parent, input, before, context);
  if (Array.isArray(input)) return mountFragment(parent, input, before, context);
  if (isVNode(input)) return mountVNode(parent, input, before, context);
  if (typeof Node !== "undefined" && input instanceof Node) {
    parent.insertBefore(input, before);
    return simpleMount([input]);
  }
  if (input === null || input === undefined || input === false || input === true) {
    const marker = document.createComment("clank");
    parent.insertBefore(marker, before);
    return simpleMount([marker]);
  }
  const text = document.createTextNode(String(input));
  parent.insertBefore(text, before);
  return simpleMount([text]);
}

function simpleMount(nodes: Node[], cleanup?: Cleanup): Mounted {
  let active = true;
  return {
    nodes,
    dispose(remove = true) {
      if (!active) return;
      active = false;
      cleanup?.();
      if (remove) for (const node of nodes) node.parentNode?.removeChild(node);
    },
  };
}

function mountFragment(parent: Node, values: Renderable[], before: Node | null, context: MountContext): Mounted {
  const mounted = values.map((value) => mountValue(parent, value, before, context));
  return {
    get nodes() { return mounted.flatMap((entry) => entry.nodes); },
    dispose(remove = true) {
      for (const entry of mounted.splice(0).reverse()) entry.dispose(remove);
    },
  };
}

function mountDynamic(parent: Node, read: () => Renderable, before: Node | null, context: MountContext): Mounted {
  const start = document.createComment("clank:start");
  const end = document.createComment("clank:end");
  parent.insertBefore(start, before);
  parent.insertBefore(end, before);
  let current: Mounted | undefined;
  let currentValue: Renderable | undefined;
  const stop = effect(() => {
    const next = unwrapReactive(read());
    if (Object.is(next, currentValue) && current) return;
    if (isTextValue(next) && current?.nodes.length === 1 && current.nodes[0] instanceof Text) {
      const text = String(next);
      if (current.nodes[0].data !== text) current.nodes[0].data = text;
      currentValue = next;
      return;
    }
    current?.dispose();
    current = mountValue(parent, next, end, context);
    currentValue = next;
  });
  let active = true;
  return {
    get nodes() { return [start, ...(current?.nodes ?? []), end]; },
    dispose(remove = true) {
      if (!active) return;
      active = false;
      stop();
      current?.dispose(remove);
      current = undefined;
      if (remove) {
        start.parentNode?.removeChild(start);
        end.parentNode?.removeChild(end);
      }
    },
  };
}

function unwrapReactive(input: Renderable): Renderable {
  let value = input;
  const seen = new Set<unknown>();
  while (isExpression(value) || isSignal(value)) {
    if (seen.has(value)) throw new Error("Circular reactive expression.");
    seen.add(value);
    value = (isExpression(value) ? value.read() : value.value) as Renderable;
  }
  return value;
}

function isTextValue(value: Renderable): value is string | number | bigint {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint";
}

function isKeyedBlock(value: unknown): value is KeyedBlock<any> {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[KEYED]);
}

interface KeyedEntry<T> {
  key: unknown;
  updateItem(item: T): void;
  index: ReactiveSignal<number>;
  mounted: Mounted;
}

function mountKeyed<T>(parent: Node, block: KeyedBlock<T>, before: Node | null, context: MountContext): Mounted {
  const start = document.createComment("clank:for");
  const end = document.createComment("clank:/for");
  parent.insertBefore(start, before);
  parent.insertBefore(end, before);
  let entries = new Map<unknown, KeyedEntry<T>>();
  let ordered: KeyedEntry<T>[] = [];
  let fallback: Mounted | undefined;

  const keyOf = (item: T, index: number): unknown => {
    if (typeof block.by === "function") return block.by(item, index);
    if (block.by !== undefined) return (item as Record<PropertyKey, unknown>)[block.by as PropertyKey] as PropertyKey;
    if ((typeof item === "object" && item !== null) || typeof item === "function") return item;
    return `${typeof item}:${String(item)}:${index}`;
  };

  const stop = effect(() => {
    const values = unwrapReactive(block.each as Renderable) as T[];
    if (!Array.isArray(values)) throw new TypeError("For expects an array, signal, computed value, or array accessor.");
    const keyedValues = values.map((item, index) => ({ item, index, key: keyOf(item, index) }));
    const uniqueKeys = new Set<unknown>();
    for (const { key } of keyedValues) {
      if (uniqueKeys.has(key)) throw new Error(`Duplicate key in For: ${String(key)}`);
      uniqueKeys.add(key);
    }
    const next = new Map<unknown, KeyedEntry<T>>();
    const nextOrdered: KeyedEntry<T>[] = [];

    keyedValues.forEach(({ item, index, key }) => {
      let entry = entries.get(key);
      if (entry) {
        entry.updateItem(item);
        entry.index.value = index;
      } else {
        const indexState = signal(index);
        const reactiveItem = createReactiveItem(item);
        entry = {
          key,
          updateItem: reactiveItem.update,
          index: indexState,
          mounted: mountValue(parent, block.renderItem(reactiveItem.value, () => indexState.value), end, context),
        };
      }
      next.set(key, entry);
      nextOrdered.push(entry);
    });

    for (const [key, entry] of entries) if (!next.has(key)) entry.mounted.dispose();
    entries = next;
    ordered = nextOrdered;

    if (ordered.length === 0) {
      fallback ??= mountValue(parent, block.fallback ?? null, end, context);
    } else {
      fallback?.dispose();
      fallback = undefined;
      let cursor: Node = end;
      for (let index = ordered.length - 1; index >= 0; index--) {
        const nodes = ordered[index].mounted.nodes;
        if (nodes.length > 0 && nodes[nodes.length - 1].nextSibling === cursor) {
          cursor = nodes[0];
          continue;
        }
        for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
          parent.insertBefore(nodes[nodeIndex], cursor);
          cursor = nodes[nodeIndex];
        }
      }
    }
  });

  let active = true;
  return {
    get nodes() { return [start, ...(fallback?.nodes ?? ordered.flatMap((entry) => entry.mounted.nodes)), end]; },
    dispose(remove = true) {
      if (!active) return;
      active = false;
      stop();
      fallback?.dispose(remove);
      for (const entry of ordered.reverse()) entry.mounted.dispose(remove);
      entries.clear();
      ordered = [];
      if (remove) {
        start.parentNode?.removeChild(start);
        end.parentNode?.removeChild(end);
      }
    },
  };
}

function hydrateKeyed<T>(parent: Node, block: KeyedBlock<T>, cursor: HydrationCursor, context: MountContext): Mounted {
  const start = expectComment(cursor, "clank:for");
  const keyOf = (item: T, index: number): unknown => {
    if (typeof block.by === "function") return block.by(item, index);
    if (block.by !== undefined) return (item as Record<PropertyKey, unknown>)[block.by as PropertyKey] as PropertyKey;
    if ((typeof item === "object" && item !== null) || typeof item === "function") return item;
    return `${typeof item}:${String(item)}:${index}`;
  };
  const initial = unwrapReactive(block.each as Renderable) as T[];
  if (!Array.isArray(initial)) throw new HydrationMismatch("For did not resolve to an array during hydration.");
  const initialKeys = new Set<unknown>();
  for (let index = 0; index < initial.length; index++) {
    const key = keyOf(initial[index], index);
    if (initialKeys.has(key)) throw new Error(`Duplicate key in For: ${String(key)}`);
    initialKeys.add(key);
  }

  let entries = new Map<unknown, KeyedEntry<T>>();
  let ordered: KeyedEntry<T>[] = [];
  let fallback: Mounted | undefined;
  if (initial.length === 0) {
    fallback = hydrateValue(parent, unwrapReactive(block.fallback ?? null), cursor, context);
  } else {
    initial.forEach((item, index) => {
      const key = keyOf(item, index);
      const indexState = signal(index);
      const reactiveItem = createReactiveItem(item);
      const entry: KeyedEntry<T> = {
        key,
        updateItem: reactiveItem.update,
        index: indexState,
        mounted: hydrateValue(parent, block.renderItem(reactiveItem.value, () => indexState.value), cursor, context),
      };
      entries.set(key, entry);
      ordered.push(entry);
    });
  }
  const end = expectComment(cursor, "clank:/for");

  let first = true;
  const stop = effect(() => {
    const values = unwrapReactive(block.each as Renderable) as T[];
    if (!Array.isArray(values)) throw new TypeError("For expects an array, signal, computed value, or array accessor.");
    if (first) {
      first = false;
      return;
    }
    const keyedValues = values.map((item, index) => ({ item, index, key: keyOf(item, index) }));
    const uniqueKeys = new Set<unknown>();
    for (const { key } of keyedValues) {
      if (uniqueKeys.has(key)) throw new Error(`Duplicate key in For: ${String(key)}`);
      uniqueKeys.add(key);
    }
    const next = new Map<unknown, KeyedEntry<T>>();
    const nextOrdered: KeyedEntry<T>[] = [];
    keyedValues.forEach(({ item, index, key }) => {
      let entry = entries.get(key);
      if (entry) {
        entry.updateItem(item);
        entry.index.value = index;
      } else {
        const indexState = signal(index);
        const reactiveItem = createReactiveItem(item);
        entry = {
          key,
          updateItem: reactiveItem.update,
          index: indexState,
          mounted: mountValue(parent, block.renderItem(reactiveItem.value, () => indexState.value), end, context),
        };
      }
      next.set(key, entry);
      nextOrdered.push(entry);
    });

    for (const [key, entry] of entries) if (!next.has(key)) entry.mounted.dispose();
    entries = next;
    ordered = nextOrdered;
    if (ordered.length === 0) {
      fallback ??= mountValue(parent, block.fallback ?? null, end, context);
    } else {
      fallback?.dispose();
      fallback = undefined;
      let position: Node = end;
      for (let index = ordered.length - 1; index >= 0; index--) {
        const nodes = ordered[index].mounted.nodes;
        if (nodes.length > 0 && nodes[nodes.length - 1].nextSibling === position) {
          position = nodes[0];
          continue;
        }
        for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
          parent.insertBefore(nodes[nodeIndex], position);
          position = nodes[nodeIndex];
        }
      }
    }
  });

  let active = true;
  return {
    get nodes() { return [start, ...(fallback?.nodes ?? ordered.flatMap((entry) => entry.mounted.nodes)), end]; },
    dispose(remove = true) {
      if (!active) return;
      active = false;
      stop();
      fallback?.dispose(remove);
      for (const entry of ordered.reverse()) entry.mounted.dispose(remove);
      entries.clear();
      ordered = [];
      if (remove) {
        start.parentNode?.removeChild(start);
        end.parentNode?.removeChild(end);
      }
    },
  };
}

interface ReactiveItem<T> {
  value: T;
  update(next: T): void;
}

function createReactiveItem<T>(initial: T): ReactiveItem<T> {
  if (typeof initial !== "object" || initial === null) {
    return { value: initial, update() {} };
  }
  let current: T = initial;
  const properties = new Map<PropertyKey, ReactiveSignal<unknown>>();
  const shape = signal(0);
  const readProperty = (target: T, key: PropertyKey): unknown => {
    const value = Reflect.get(target as object, key, target as object);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const value = new Proxy({}, {
    get(_target, key) {
      let property = properties.get(key);
      if (!property) {
        property = signal(readProperty(current, key));
        properties.set(key, property);
      }
      return property.value;
    },
    has(_target, key) {
      shape.value;
      return key in (current as object);
    },
    ownKeys() {
      shape.value;
      return Reflect.ownKeys(current as object);
    },
    getOwnPropertyDescriptor(_target, key) {
      shape.value;
      const descriptor = Reflect.getOwnPropertyDescriptor(current as object, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  }) as T;
  return {
    value,
    update(next) {
      if (Object.is(current, next)) return;
      batch(() => {
        current = next;
        for (const [key, property] of properties) property.value = readProperty(next, key);
        shape.update((version) => version + 1);
      });
    },
  };
}

function mountPromise(parent: Node, promise: Promise<Renderable>, before: Node | null, context: MountContext): Mounted {
  const marker = document.createComment("clank:pending");
  parent.insertBefore(marker, before);
  let current: Mounted | undefined;
  let active = true;
  void promise.then(
    (value) => {
      if (!active || !marker.parentNode) return;
      current = mountValue(parent, value, marker, context);
      marker.parentNode.removeChild(marker);
    },
    (error) => {
      if (!active) return;
      const message = document.createTextNode(error instanceof Error ? error.message : String(error));
      parent.insertBefore(message, marker);
      marker.parentNode?.removeChild(marker);
      current = simpleMount([message]);
    },
  );
  return {
    get nodes() { return current?.nodes ?? [marker]; },
    dispose(remove = true) {
      if (!active) return;
      active = false;
      current?.dispose(remove);
      if (remove) marker.parentNode?.removeChild(marker);
    },
  };
}

function mountVNode(parent: Node, vnode: VNode, before: Node | null, context: MountContext): Mounted {
  if (vnode.type === Fragment) {
    return mountFragment(parent, vnode.props.children as Renderable[], before, context);
  }
  if (typeof vnode.type === "function") return mountComponent(parent, vnode, before, context);
  return mountElement(parent, vnode, before, context);
}

function mountComponent(parent: Node, vnode: VNode, before: Node | null, parentContext: MountContext): Mounted {
  let mounted!: Mounted;
  let disposeScope: Cleanup = () => {};
  try {
    createRoot((dispose) => {
      disposeScope = dispose;
      const evaluation = evaluateComponent(vnode, parentContext.contexts);
      mounted = mountValue(parent, evaluation.output, before, { ...parentContext, contexts: evaluation.contexts });
      for (const callback of evaluation.mounts) {
        const cleanup = callback();
        if (typeof cleanup === "function") onCleanup(cleanup);
      }
      onCleanup(() => mounted.dispose());
    });
  } catch (error) {
    disposeScope();
    throw error;
  }
  let active = true;
  return {
    get nodes() { return mounted.nodes; },
    dispose(remove = true) {
      if (!active) return;
      active = false;
      if (!remove) mounted.dispose(false);
      disposeScope();
    },
  };
}

/** @internal Evaluates one component with context/lifecycle ownership for DOM and SSR renderers. */
export function evaluateComponent(vnode: VNode, parentContexts: Map<symbol, unknown>): ComponentEvaluation {
  if (typeof vnode.type !== "function") throw new TypeError("evaluateComponent expects a component VNode.");
  const frame: ComponentFrame = {
    contexts: new Map(parentContexts),
    mounts: [],
  };
  const previous = currentFrame;
  currentFrame = frame;
  try {
    return {
      output: (vnode.type as Component)(componentProps(vnode.props)),
      contexts: frame.contexts,
      mounts: frame.mounts,
    };
  } finally {
    currentFrame = previous;
  }
}

function componentProps(props: Record<string, unknown>): Record<string, unknown> & { children: Renderable[] } {
  return new Proxy(props, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return isExpression(value) ? value.read() : value;
    },
  }) as Record<string, unknown> & { children: Renderable[] };
}

function mountElement(parent: Node, vnode: VNode, before: Node | null, context: MountContext): Mounted {
  const tag = vnode.type as string;
  const namespace = context.namespace === "svg" || tag === "svg" ? "svg" : undefined;
  const element = namespace
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  const cleanups: Cleanup[] = [];
  for (const [name, value] of Object.entries(vnode.props)) {
    if (name === "children" || name === "key") continue;
    const cleanup = bindProperty(element, name, value);
    if (cleanup) cleanups.push(cleanup);
  }
  const rawHTML = vnode.props.dangerouslySetInnerHTML;
  const children = rawHTML === undefined
    ? mountFragment(element, vnode.props.children as Renderable[], null, { ...context, namespace })
    : undefined;
  parent.insertBefore(element, before);
  const ref = vnode.props.ref;
  if (typeof ref === "function") (ref as (node: Element) => void)(element);
  else if (isSignal(ref)) (ref as ReactiveSignal<Element | null>).value = element;
  return simpleMount([element], () => {
    children?.dispose(false);
    for (const cleanup of cleanups.reverse()) cleanup();
    if (isSignal(ref) && (ref as ReactiveSignal<Element | null>).peek() === element) {
      (ref as ReactiveSignal<Element | null>).value = null;
    }
  });
}

function bindProperty(element: Element, name: string, input: unknown): Cleanup | undefined {
  if (name === "ref") return undefined;
  if (name === "use") {
    const actions = Array.isArray(input) ? input : [input];
    const cleanups = actions
      .filter((entry): entry is (node: Element) => void | Cleanup => typeof entry === "function")
      .map((action) => action(element))
      .filter((entry): entry is Cleanup => typeof entry === "function");
    return () => cleanups.reverse().forEach((cleanup) => cleanup());
  }
  if (name.startsWith("bind:")) return bindTwoWay(element, name.slice(5), input);
  if (isEventProperty(name)) {
    if (typeof input !== "function") throw new TypeError(`${name} expects an event listener function.`);
    return bindEvent(element, name, input as EventListener);
  }
  if (isExpression(input)) {
    if (name === "classList") return bindDynamicClassList(element, input.read);
    if (name === "style") return bindDynamicStyle(element as HTMLElement, input.read);
    return effect(() => setProperty(element, name, resolve(input)));
  }
  if (name === "classList" && input && typeof input === "object") return bindClassList(element, input as Record<string, unknown>);
  if (name === "style" && input && typeof input === "object" && !isSignal(input)) return bindStyle(element as HTMLElement, input as Record<string, unknown>);
  if (isSignal(input) || typeof input === "function") {
    return effect(() => setProperty(element, name, resolve(input)));
  }
  setProperty(element, name, input);
  return undefined;
}

function resolve(value: unknown): unknown {
  let current = value;
  const seen = new Set<unknown>();
  while (isExpression(current) || isSignal(current) || typeof current === "function") {
    if (seen.has(current)) throw new Error("Circular reactive value.");
    seen.add(current);
    current = isExpression(current)
      ? current.read()
      : isSignal(current)
        ? current.value
        : (current as () => unknown)();
  }
  return current;
}

function isEventProperty(name: string): boolean {
  return /^on(?::|[a-z])/i.test(name);
}

function bindEvent(element: Element, property: string, listener: EventListener): Cleanup {
  const colon = property.startsWith("on:");
  let name = colon ? property.slice(3) : property.slice(2);
  let capture = false;
  let once = false;
  let passive = false;
  for (const [suffix, apply] of [
    ["Capture", () => { capture = true; }],
    ["Once", () => { once = true; }],
    ["Passive", () => { passive = true; }],
  ] as const) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      apply();
    }
  }
  name = name.toLowerCase();
  const options = { capture, once, passive };
  element.addEventListener(name, listener, options);
  return () => element.removeEventListener(name, listener, options);
}

function bindTwoWay(element: Element, property: string, input: unknown): Cleanup {
  if (!["checked", "selected", "selectedIndex", "value"].includes(property)) {
    throw new TypeError(`bind:${property} is not allowed. Bind form state through value, checked, selected, or selectedIndex.`);
  }
  if (!isSignal(input)) throw new TypeError(`bind:${property} expects a signal.`);
  const target = element as Element & Record<string, unknown>;
  const state = input as ReactiveSignal<unknown>;
  const stop = effect(() => { target[property] = state.value; });
  const eventName = property === "value" ? "input" : "change";
  const listener = () => { state.value = target[property]; };
  element.addEventListener(eventName, listener);
  return () => {
    stop();
    element.removeEventListener(eventName, listener);
  };
}

function bindClassList(element: Element, classes: Record<string, unknown>): Cleanup {
  const stops = Object.entries(classes).map(([name, value]) => effect(() => {
    const enabled = Boolean(resolve(value));
    for (const token of name.split(/\s+/).filter(Boolean)) element.classList.toggle(token, enabled);
  }));
  return () => stops.reverse().forEach((stop) => stop());
}

function bindDynamicClassList(element: Element, read: () => unknown): Cleanup {
  let previous = new Set<string>();
  return effect(() => {
    const value = read();
    const next = new Set<string>();
    if (value && typeof value === "object") {
      for (const [names, enabled] of Object.entries(value as Record<string, unknown>)) {
        if (Boolean(resolve(enabled))) for (const token of names.split(/\s+/).filter(Boolean)) next.add(token);
      }
    }
    for (const token of previous) if (!next.has(token)) element.classList.remove(token);
    for (const token of next) if (!previous.has(token)) element.classList.add(token);
    previous = next;
  });
}

function bindStyle(element: HTMLElement, styles: Record<string, unknown>): Cleanup {
  const stops = Object.entries(styles).map(([name, value]) => effect(() => {
    const next = resolve(value);
    if (name.startsWith("--") || name.includes("-")) {
      element.style.setProperty(name, next === null || next === undefined ? "" : String(next));
    } else {
      (element.style as unknown as Record<string, unknown>)[name] = next ?? "";
    }
  }));
  return () => stops.reverse().forEach((stop) => stop());
}

function bindDynamicStyle(element: HTMLElement, read: () => unknown): Cleanup {
  let previous = new Map<string, unknown>();
  return effect(() => {
    const value = read();
    const styles = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const next = new Map(Object.entries(styles).map(([name, entry]) => [name, resolve(entry)]));
    for (const name of previous.keys()) if (!next.has(name)) setStyleValue(element, name, undefined);
    for (const [name, entry] of next) {
      if (!previous.has(name) || !Object.is(previous.get(name), entry)) setStyleValue(element, name, entry);
    }
    previous = next;
  });
}

function setStyleValue(element: HTMLElement, name: string, value: unknown): void {
  if (name.startsWith("--") || name.includes("-")) {
    element.style.setProperty(name, value === null || value === undefined ? "" : String(value));
  } else {
    (element.style as unknown as Record<string, unknown>)[name] = value ?? "";
  }
}

const attributeAliases: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  agentId: "data-clank-id",
  agentLabel: "data-clank-label",
  agentAction: "data-clank-action",
  agentDescription: "data-clank-description",
  agentHidden: "data-clank-hidden",
  intent: "data-clank-intent",
};

function setProperty(element: Element, property: string, value: unknown): void {
  if (property === "dangerouslySetInnerHTML") {
    const html = typeof value === "object" && value ? (value as { __html?: unknown }).__html : value;
    const next = html === null || html === undefined ? "" : String(html);
    if (element.innerHTML !== next) element.innerHTML = next;
    return;
  }
  if (property === "agentLabel") {
    setAttributeValue(element, "data-clank-label", value);
    if (isInteractiveElement(element)) setAttributeValue(element, "aria-label", value);
    return;
  }
  if (property === "class") value = normalizeClass(value);
  const name = attributeAliases[property] ?? property;
  if (/^on/i.test(name)) throw new TypeError(`Inline event property ${name} is not allowed; pass a listener function.`);
  assertSafeAttributeValue(element.localName, name, value);
  if (name.startsWith("aria-") && typeof value === "boolean") {
    setAttributeValue(element, name, String(value));
    return;
  }
  if (value === false || value === null || value === undefined) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
    if (property in element && !name.startsWith("data-") && !name.startsWith("aria-")) {
      try {
        const target = element as Element & Record<string, unknown>;
        const next = property === "value" ? "" : false;
        if (!Object.is(target[property], next)) target[property] = next;
      } catch { /* readonly */ }
    }
    return;
  }
  if (value === true) {
    if (!element.hasAttribute(name)) element.setAttribute(name, "");
    return;
  }
  if (property in element && !name.startsWith("data-") && !name.startsWith("aria-") && property !== "className" && property !== "htmlFor") {
    try {
      const target = element as Element & Record<string, unknown>;
      if (!Object.is(target[property], value)) target[property] = value;
      return;
    } catch { /* fall through to an attribute */ }
  }
  const next = String(value);
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

function setAttributeValue(element: Element, name: string, value: unknown): void {
  if (value === false || value === null || value === undefined) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
    return;
  }
  const next = value === true ? "" : String(value);
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

function isInteractiveElement(element: Element): boolean {
  return ["A", "BUTTON", "INPUT", "SELECT", "SUMMARY", "TEXTAREA"].includes(element.tagName);
}

function normalizeClass(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizeClass).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => Boolean(resolve(enabled)))
      .map(([name]) => name)
      .join(" ");
  }
  return value === null || value === undefined || value === false ? "" : String(value);
}

export function onMount(callback: () => void | Cleanup): void {
  if (!currentFrame) throw new Error("onMount() must run while a component is being created.");
  currentFrame.mounts.push(callback);
}

export function createContext<T>(defaultValue: T): ClankContext<T> {
  return { id: Symbol("ClankContext"), defaultValue };
}

export function provideContext<T>(context: ClankContext<T>, value: T): void {
  if (!currentFrame) throw new Error("provideContext() must run inside a component.");
  currentFrame.contexts.set(context.id, value);
}

export function useContext<T>(context: ClankContext<T>): T {
  if (!currentFrame) return context.defaultValue;
  return currentFrame.contexts.has(context.id)
    ? currentFrame.contexts.get(context.id) as T
    : context.defaultValue;
}

export function Show(props: {
  when: unknown;
  fallback?: Renderable;
  children: Renderable | Renderable[];
}): Renderable {
  return () => Boolean(resolve(props.when))
    ? (Array.isArray(props.children) ? props.children : [props.children])
    : (props.fallback ?? null);
}

export function For<T>(props: {
  each: T[] | ReactiveSignal<T[]> | Computed<T[]> | (() => T[]);
  by?: keyof T | ((item: T, index: number) => PropertyKey);
  fallback?: Renderable;
  children: ((item: T, index: () => number) => Renderable) | Array<(item: T, index: () => number) => Renderable>;
}): KeyedBlock<T> {
  const renderItem = Array.isArray(props.children) ? props.children[0] : props.children;
  if (typeof renderItem !== "function") throw new TypeError("For expects a render function as its child.");
  return {
    [KEYED]: true,
    each: expression(() => props.each as T[]),
    by: props.by,
    fallback: expression(() => props.fallback ?? null),
    renderItem,
  };
}

export function Match(props: { when: unknown; children: Renderable | Renderable[] }): VNode {
  const children = Array.isArray(props.children) ? props.children : [props.children];
  return h(Fragment, { __match: expression(() => props.when) }, ...children);
}

export function Switch(props: { fallback?: Renderable; children: Renderable | Renderable[] }): Renderable {
  return () => {
    const children = Array.isArray(props.children) ? props.children : [props.children];
    for (const child of children) {
      if (isVNode(child) && "__match" in child.props && Boolean(resolve(child.props.__match))) {
        return child.props.children as Renderable[];
      }
    }
    return props.fallback ?? null;
  };
}

export function lazy(loader: () => Promise<{ default: Component } | Component>): Component {
  let loaded: Component | undefined;
  let pending: Promise<Component> | undefined;
  return (props) => {
    if (loaded) return h(loaded, props);
    pending ??= loader().then((module) => {
      loaded = typeof module === "function" ? module : module.default;
      return loaded;
    });
    return pending.then((component) => h(component, props));
  };
}
