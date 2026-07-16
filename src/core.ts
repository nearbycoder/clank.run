/** Clank's fine-grained reactive kernel. It has no platform dependencies. */

export const SIGNAL = Symbol.for("clank.signal");
export const STORE = Symbol.for("clank.store");

export type Cleanup = () => void;
export type Equality<T> = false | ((previous: T, next: T) => boolean);

interface Source {
  observers: Set<Observer>;
}

interface Observer {
  dependencies: Set<Source>;
  active: boolean;
  schedule(): void;
}

interface Scope {
  parent: Scope | null;
  cleanups: Cleanup[];
  active: boolean;
}

let activeObserver: Observer | null = null;
let activeScope: Scope | null = null;
let tracking = true;
let batchDepth = 0;
let flushing = false;
const pendingEffects = new Set<ReactiveEffect>();
const transactionStack: Array<Map<ReactiveSignal<unknown>, unknown>> = [];

function track(source: Source): void {
  if (!tracking || activeObserver === null || !activeObserver.active) return;
  source.observers.add(activeObserver);
  activeObserver.dependencies.add(source);
}

function detach(observer: Observer): void {
  for (const source of observer.dependencies) source.observers.delete(observer);
  observer.dependencies.clear();
}

function notify(source: Source): void {
  for (const observer of [...source.observers]) observer.schedule();
}

function flushEffects(): void {
  if (flushing || batchDepth > 0) return;
  flushing = true;
  let passes = 0;
  try {
    while (pendingEffects.size > 0) {
      if (++passes > 10_000) {
        pendingEffects.clear();
        throw new Error("Clank detected a reactive cycle after 10,000 updates.");
      }
      const effects = [...pendingEffects];
      pendingEffects.clear();
      for (let index = 0; index < effects.length; index++) {
        try {
          effects[index].run();
        } catch (error) {
          for (const remaining of effects.slice(index + 1)) if (remaining.active) pendingEffects.add(remaining);
          throw error;
        }
      }
    }
  } finally {
    flushing = false;
  }
}

function registerCleanup(cleanup: Cleanup): Cleanup {
  if (activeScope?.active) activeScope.cleanups.push(cleanup);
  return cleanup;
}

export interface SignalOptions<T> {
  name?: string;
  equals?: Equality<T>;
}

export class ReactiveSignal<T> implements Source {
  readonly [SIGNAL] = true;
  readonly observers = new Set<Observer>();
  readonly name?: string;
  readonly equals: Equality<T>;
  #value: T;

  constructor(value: T, options: SignalOptions<T> = {}) {
    this.#value = value;
    this.name = options.name;
    this.equals = options.equals ?? Object.is;
  }

  get value(): T {
    return this.get();
  }

  set value(next: T) {
    this.set(next);
  }

  get(): T {
    track(this);
    return this.#value;
  }

  peek(): T {
    return this.#value;
  }

  set(next: T | ((current: T) => T)): T {
    const value = typeof next === "function"
      ? (next as (current: T) => T)(this.#value)
      : next;
    const equal = this.equals !== false && this.equals(this.#value, value);
    if (equal) return this.#value;
    const transaction = transactionStack.at(-1);
    if (transaction && !transaction.has(this as ReactiveSignal<unknown>)) {
      transaction.set(this as ReactiveSignal<unknown>, this.#value);
    }
    this.#value = value;
    notify(this);
    flushEffects();
    return value;
  }

  update(updater: (current: T) => T): T {
    return this.set(updater);
  }

  subscribe(listener: (value: T, previous: T) => void, immediate = false): Cleanup {
    let previous = this.peek();
    if (immediate) listener(previous, previous);
    return effect(() => {
      const next = this.get();
      if (!Object.is(previous, next)) {
        const before = previous;
        previous = next;
        listener(next, before);
      }
    });
  }

  /** @internal Restores a failed transaction without creating another journal entry. */
  _restore(value: T): void {
    if (Object.is(this.#value, value)) return;
    this.#value = value;
    notify(this);
  }

  toJSON(): T {
    return this.peek();
  }
}

export function signal<T>(value: T, options?: SignalOptions<T>): ReactiveSignal<T> {
  return new ReactiveSignal(value, options);
}

export function isSignal(value: unknown): value is ReactiveSignal<unknown> | Computed<unknown> {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[SIGNAL]);
}

export class Computed<T> implements Source, Observer {
  readonly [SIGNAL] = true;
  readonly observers = new Set<Observer>();
  readonly dependencies = new Set<Source>();
  active = true;
  #dirty = true;
  #evaluating = false;
  #value!: T;

  constructor(readonly derive: () => T, readonly name?: string) {}

  get value(): T {
    return this.get();
  }

  get(): T {
    track(this);
    if (this.#dirty) this.evaluate();
    return this.#value;
  }

  peek(): T {
    if (!this.#dirty) return this.#value;
    const previous = activeObserver;
    activeObserver = null;
    try {
      this.evaluate();
      return this.#value;
    } finally {
      activeObserver = previous;
    }
  }

  schedule(): void {
    if (this.#dirty || !this.active) return;
    this.#dirty = true;
    notify(this);
  }

  private evaluate(): void {
    if (this.#evaluating) throw new Error(`Circular computed${this.name ? ` \"${this.name}\"` : ""}.`);
    this.#evaluating = true;
    detach(this);
    const previous = activeObserver;
    activeObserver = this;
    try {
      this.#value = this.derive();
      this.#dirty = false;
    } finally {
      activeObserver = previous;
      this.#evaluating = false;
    }
  }

  dispose(): void {
    this.active = false;
    detach(this);
    this.observers.clear();
  }

  toJSON(): T {
    return this.peek();
  }
}

export function computed<T>(derive: () => T, options: { name?: string } = {}): Computed<T> {
  const value = new Computed(derive, options.name);
  registerCleanup(() => value.dispose());
  return value;
}

class ReactiveEffect implements Observer {
  readonly dependencies = new Set<Source>();
  active = true;
  #running = false;
  #cleanup: Cleanup | undefined;

  constructor(readonly callback: (onCleanup: (cleanup: Cleanup) => void) => void | Cleanup) {}

  schedule(): void {
    if (!this.active) return;
    pendingEffects.add(this);
    flushEffects();
  }

  run(): void {
    if (!this.active || this.#running) return;
    this.#running = true;
    pendingEffects.delete(this);
    const previous = activeObserver;
    try {
      const previousCleanup = this.#cleanup;
      this.#cleanup = undefined;
      previousCleanup?.();
      detach(this);
      activeObserver = this;
      const nextCleanup = this.callback((next) => { this.#cleanup = next; });
      if (typeof nextCleanup === "function") this.#cleanup = nextCleanup;
    } finally {
      activeObserver = previous;
      this.#running = false;
    }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    pendingEffects.delete(this);
    detach(this);
    const cleanup = this.#cleanup;
    this.#cleanup = undefined;
    cleanup?.();
  }
}

export interface EffectOptions {
  defer?: boolean;
}

export function effect(
  callback: (onCleanup: (cleanup: Cleanup) => void) => void | Cleanup,
  options: EffectOptions = {},
): Cleanup {
  const observer = new ReactiveEffect(callback);
  const dispose = registerCleanup(() => observer.dispose());
  if (!options.defer) observer.run();
  else observer.schedule();
  return dispose;
}

export function batch<T>(callback: () => T): T {
  batchDepth++;
  try {
    return callback();
  } finally {
    batchDepth--;
    flushEffects();
  }
}

/** Batches writes and atomically rolls signal values back if the callback throws. */
export function transaction<T>(callback: () => T): T {
  return batch(() => {
    const journal = new Map<ReactiveSignal<unknown>, unknown>();
    transactionStack.push(journal);
    try {
      const result = callback();
      const parent = transactionStack.at(-2);
      if (parent) {
        for (const [entry, value] of journal) if (!parent.has(entry)) parent.set(entry, value);
      }
      return result;
    } catch (error) {
      for (const [entry, value] of [...journal].reverse()) entry._restore(value);
      throw error;
    } finally {
      transactionStack.pop();
    }
  });
}

export function untrack<T>(callback: () => T): T {
  const previous = tracking;
  tracking = false;
  try {
    return callback();
  } finally {
    tracking = previous;
  }
}

export function onCleanup(cleanup: Cleanup): Cleanup {
  if (!activeScope) throw new Error("onCleanup() must run inside createRoot() or a component.");
  return registerCleanup(cleanup);
}

export function createRoot<T>(callback: (dispose: Cleanup) => T): T {
  const parent = activeScope;
  const scope: Scope = { parent, cleanups: [], active: true };
  const dispose = () => {
    if (!scope.active) return;
    scope.active = false;
    const errors: unknown[] = [];
    for (const cleanup of scope.cleanups.splice(0).reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Multiple Clank cleanup callbacks failed.");
  };
  activeScope = scope;
  try {
    return callback(dispose);
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "A Clank root and its cleanup both failed.");
    }
    throw error;
  } finally {
    activeScope = parent;
  }
}

export function getOwner(): object | null {
  return activeScope;
}

export function runWithOwner<T>(owner: object | null, callback: () => T): T {
  const previous = activeScope;
  activeScope = owner as Scope | null;
  try {
    return callback();
  } finally {
    activeScope = previous;
  }
}

const rawByProxy = new WeakMap<object, object>();
const proxyByRaw = new WeakMap<object, object>();

export function store<T extends object>(initial: T): T {
  if (proxyByRaw.has(initial)) return proxyByRaw.get(initial) as T;
  const signals = new Map<PropertyKey, ReactiveSignal<unknown>>();
  const iteration = signal(0);
  const proxied = new Proxy(initial, {
    get(target, key, receiver) {
      if (key === STORE) return true;
      if (key === Symbol.for("clank.raw")) return target;
      let entry: ReactiveSignal<unknown>;
      const existing = signals.get(key);
      if (existing) entry = existing;
      else {
        entry = signal<unknown>(Reflect.get(target, key, receiver), { equals: Object.is });
        signals.set(key, entry);
      }
      const value = entry.get();
      return value && typeof value === "object" ? store(value as object) : value;
    },
    set(target, key, value, receiver) {
      const existed = Reflect.has(target, key);
      const raw = toRaw(value);
      const result = key === "__proto__"
        ? Reflect.defineProperty(target, key, {
            value: raw,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        : Reflect.set(target, key, raw, receiver);
      const entry = signals.get(key);
      if (!entry) signals.set(key, signal<unknown>(raw, { equals: Object.is }));
      else entry.set(raw);
      if (!existed) iteration.update((count) => count + 1);
      return result;
    },
    deleteProperty(target, key) {
      if (!Reflect.has(target, key)) return true;
      const result = Reflect.deleteProperty(target, key);
      signals.get(key)?.set(undefined);
      iteration.update((count) => count + 1);
      return result;
    },
    ownKeys(target) {
      iteration.get();
      return Reflect.ownKeys(target);
    },
    has(target, key) {
      iteration.get();
      return Reflect.has(target, key);
    },
  });
  rawByProxy.set(proxied, initial);
  proxyByRaw.set(initial, proxied);
  return proxied as T;
}

export function isStore(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[STORE]);
}

export function toRaw<T>(value: T): T {
  return ((value && typeof value === "object" ? rawByProxy.get(value as object) : undefined) ?? value) as T;
}

export function snapshot<T>(value: T): T {
  if (isSignal(value)) return snapshot(value.peek()) as T;
  if (Array.isArray(value)) return value.map((entry) => snapshot(entry)) as T;
  if (value && typeof value === "object") {
    const output: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(value as object)) {
      Object.defineProperty(output, key, {
        value: snapshot((value as Record<PropertyKey, unknown>)[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output as T;
  }
  return value;
}

export type ResourceStatus = "idle" | "loading" | "ready" | "refreshing" | "error";

export interface ResourceContext<T> {
  signal: AbortSignal;
  value: T | undefined;
}

export interface Resource<T, P = void> {
  data: ReactiveSignal<T | undefined>;
  error: ReactiveSignal<unknown>;
  status: ReactiveSignal<ResourceStatus>;
  loading: Computed<boolean>;
  reload(parameter?: P): Promise<T | undefined>;
  mutate(value: T | undefined | ((current: T | undefined) => T | undefined)): void;
  abort(): void;
}

export interface ResourceOptions<T> {
  initial?: T;
  immediate?: boolean;
}

export function resource<T, P = void>(
  loader: (parameter: P | undefined, context: ResourceContext<T>) => Promise<T> | T,
  options: ResourceOptions<T> = {},
): Resource<T, P> {
  const data = signal<T | undefined>(options.initial);
  const error = signal<unknown>(undefined);
  const status = signal<ResourceStatus>("idle");
  const loading = computed(() => status.value === "loading" || status.value === "refreshing");
  let controller: AbortController | undefined;
  let revision = 0;

  const reload = async (parameter?: P): Promise<T | undefined> => {
    controller?.abort();
    controller = new AbortController();
    const currentRevision = ++revision;
    batch(() => {
      error.value = undefined;
      status.value = data.peek() === undefined ? "loading" : "refreshing";
    });
    try {
      const next = await loader(parameter, { signal: controller.signal, value: data.peek() });
      if (currentRevision !== revision || controller.signal.aborted) return data.peek();
      batch(() => {
        data.value = next;
        status.value = "ready";
      });
      return next;
    } catch (reason) {
      if (currentRevision !== revision || controller.signal.aborted) return data.peek();
      batch(() => {
        error.value = reason;
        status.value = "error";
      });
      return undefined;
    }
  };

  const result: Resource<T, P> = {
    data,
    error,
    status,
    loading,
    reload,
    mutate(value) { data.set(value); },
    abort() {
      revision++;
      controller?.abort();
      if (status.peek() === "loading" || status.peek() === "refreshing") status.value = "idle";
    },
  };
  onCleanupIfOwned(() => result.abort());
  if (options.immediate !== false) void reload();
  return result;
}

function onCleanupIfOwned(cleanup: Cleanup): void {
  if (activeScope) registerCleanup(cleanup);
}

/** Reduces an async iterable into a live signal, useful for model-token streams. */
export async function consumeStream<T>(
  iterable: AsyncIterable<T>,
  initial: T,
  reduce: (current: T, chunk: T) => T = (_current, chunk) => chunk,
): Promise<ReactiveSignal<T>> {
  const output = signal(initial);
  for await (const chunk of iterable) output.update((current) => reduce(current, chunk));
  return output;
}
