export const SIGNAL = Symbol.for("clank.signal");
export const STORE = Symbol.for("clank.store");

export type Cleanup = () => void;
export type Equality<T> = false | ((previous: T, next: T) => boolean);

interface Source {
  _obs1: Observer | null;
  _obs: Observer[] | null;
  seen: number;
}

// Sources stay in read order: re-reading them in that order only moves
// `cursor`; `stale` is the old tail once reads diverge.
interface Observer {
  sources: Source[];
  cursor: number;
  stale: Source[] | null;
  pass: number;
  active: boolean;
  schedule(source?: Source): void;
}

interface Scope {
  parent: Scope | null;
  cleanups: Cleanup[];
  active: boolean;
  escaped?: boolean;
}

const EMPTY_SOURCES: Source[] = [];
const EMPTY_OBSERVERS: ReadonlySet<Observer> = new Set();
const RAW_SYMBOL = Symbol.for("clank.raw");
/** @internal Marks a createRoot disposer whose scope has no cleanups and did not escape via getOwner(). */
export const ROOT_CLEANUP_STATE = Symbol.for("clank.root-cleanups");

let activeObserver: Observer | null = null;
let activeScope: Scope | null = null;
let tracking = true;
let batchDepth = 0;
let passes = 0;
let flushing = false;
let hasDiagnostics = false;
let pending: ReactiveEffect[] = [];
let pendingSpare: ReactiveEffect[] = [];
const transactionStack: Array<Map<ReactiveSignal<unknown>, unknown>> = [];

function addObserver(source: Source, observer: Observer): void {
  const obs = source._obs;
  if (obs !== null) { obs.push(observer); return; }
  const first = source._obs1;
  if (first === null) { source._obs1 = observer; return; }
  if (first === observer) return;
  source._obs = [first, observer];
  source._obs1 = null;
}

function removeObserver(source: Source, observer: Observer): void {
  if (source._obs1 === observer) { source._obs1 = null; return; }
  const obs = source._obs;
  if (obs === null) return;
  const last = obs.length - 1;
  if (obs[last] === observer) {
    obs.pop();
  } else {
    const i = obs.indexOf(observer);
    if (i !== -1) obs.splice(i, 1);
  }
  if (obs.length === 0) source._obs = null;
}

function observersView(source: Source): Set<Observer> {
  if (source._obs !== null) return new Set(source._obs);
  if (source._obs1 !== null) return new Set([source._obs1]);
  return EMPTY_OBSERVERS as Set<Observer>;
}

function endBatch(): void {
  if (--batchDepth === 0 && pending.length > 0 && !flushing) flushEffects();
}

export interface ReactiveDiagnostic {
  readonly type: "dependency" | "invalidate" | "run" | "dispose";
  readonly id: number;
  readonly sourceId?: number;
  readonly kind: "signal" | "computed" | "effect";
  readonly name?: string;
  readonly durationMs?: number;
  readonly dependencies?: number;
}
const diagnosticListeners = new Set<(event: ReactiveDiagnostic) => void>();
let diagnosticIds = new WeakMap<object, number>();
let nextDiagnosticId = 0;
let reportingDiagnostic = false;
function diagnosticId(value: object): number {
  let id = diagnosticIds.get(value);
  if (id === undefined) { id = ++nextDiagnosticId; diagnosticIds.set(value, id); }
  return id;
}
function diagnostic(type: ReactiveDiagnostic["type"], target: Source | Observer, source?: Source, durationMs?: number): void {
  if (!hasDiagnostics || reportingDiagnostic) return;
  const event = Object.freeze({ type, id: diagnosticId(target),
    kind: target instanceof ReactiveSignal ? "signal" as const : target instanceof Computed ? "computed" as const : "effect" as const,
    ...(source ? { sourceId: diagnosticId(source) } : {}),
    ...("name" in target && typeof target.name === "string" ? { name: target.name.slice(0, 128) } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...("sources" in target ? { dependencies: new Set(target.sources).size } : {}) });
  reportingDiagnostic = true;
  const previousTracking = tracking;
  tracking = false;
  try { for (const listener of diagnosticListeners) { try { listener(event); } catch {} } }
  finally { tracking = previousTracking; reportingDiagnostic = false; }
}
export function observeReactivity(listener: (event: ReactiveDiagnostic) => void): Cleanup {
  diagnosticListeners.add(listener);
  hasDiagnostics = true;
  return () => {
    diagnosticListeners.delete(listener);
    hasDiagnostics = diagnosticListeners.size > 0;
    if (!hasDiagnostics) diagnosticIds = new WeakMap();
  };
}

function track(source: Source): void {
  const observer = activeObserver;
  if (!tracking || observer === null || !observer.active) return;
  const pass = observer.pass;
  if (source.seen === pass) return;
  const cursor = observer.cursor;
  let sources = observer.sources;
  if (observer.stale === null && sources[cursor] === source) {
    source.seen = pass;
    observer.cursor = cursor + 1;
    if (hasDiagnostics) diagnostic("dependency", observer, source);
    return;
  }
  if (reads(observer, source)) {
    source.seen = pass;
    return;
  }
  source.seen = pass;
  if (sources === EMPTY_SOURCES) {
    observer.sources = [source];
    observer.cursor = 1;
    addObserver(source, observer);
  } else {
    if (observer.stale === null && cursor < sources.length) observer.stale = sources.splice(cursor);
    observer.cursor = sources.push(source);
    if (observer.stale === null || !observer.stale.includes(source)) addObserver(source, observer);
  }
  if (hasDiagnostics) diagnostic("dependency", observer, source);
}

function reads(observer: Observer, source: Source): boolean {
  const cursor = observer.cursor;
  if (cursor === 0) return false;
  const sources = observer.sources;
  for (let i = 0; i < cursor; i++) if (sources[i] === source) return true;
  return false;
}

function settle(observer: Observer): void {
  const sources = observer.sources;
  let stale = observer.stale;
  observer.stale = null;
  if (!observer.active || (stale === null && observer.cursor === sources.length)) return;
  stale ??= sources.splice(observer.cursor);
  const kept = stale.length * sources.length > 4096 ? new Set(sources) : null;
  const pass = observer.pass;
  for (let i = 0; i < stale.length; i++) {
    const source = stale[i]!;
    if (source.seen !== pass && !(kept ? kept.has(source) : sources.includes(source))) removeObserver(source, observer);
  }
}

function detach(observer: Observer): void {
  const sources = observer.sources;
  for (let i = 0; i < sources.length; i++) removeObserver(sources[i]!, observer);
  const stale = observer.stale;
  if (stale !== null) {
    for (let i = 0; i < stale.length; i++) removeObserver(stale[i]!, observer);
  }
  observer.sources = EMPTY_SOURCES;
  observer.stale = null;
}

function notify(source: Source): void {
  if (hasDiagnostics) diagnostic("invalidate", source);
  const first = source._obs1;
  if (first !== null) {
    first.schedule(source);
    return;
  }
  const obs = source._obs;
  if (obs === null) return;
  // Invalidate all siblings before flushing effects.
  batchDepth++;
  try {
    for (let i = 0; i < obs.length; i++) obs[i]!.schedule(source);
  } finally {
    endBatch();
  }
}

function flushEffects(): void {
  if (flushing || batchDepth > 0 || pending.length === 0) return;
  flushing = true;
  let flushPasses = 0;
  try {
    while (pending.length > 0) {
      if (++flushPasses > 10_000) {
        for (let i = 0; i < pending.length; i++) pending[i]!.queued = false;
        pending.length = 0;
        throw new Error("Clank detected a reactive cycle after 10,000 updates.");
      }
      const effects = pending;
      pending = pendingSpare;
      pending.length = 0;
      pendingSpare = effects;
      const count = effects.length;
      for (let index = 0; index < count; index++) {
        const eff = effects[index]!;
        if (!eff.queued) continue;
        eff.queued = false;
        try {
          eff.run();
        } catch (error) {
          for (let rest = index + 1; rest < count; rest++) {
            const remaining = effects[rest]!;
            if (remaining.active) {
              remaining.queued = true;
              pending.push(remaining);
            }
          }
          effects.length = 0;
          throw error;
        }
      }
      effects.length = 0;
    }
  } finally {
    flushing = false;
  }
}

function registerCleanup(cleanup: Cleanup): Cleanup {
  if (activeScope !== null && activeScope.active) activeScope.cleanups.push(cleanup);
  return cleanup;
}

export interface SignalOptions<T> {
  name?: string;
  equals?: Equality<T>;
}

export class ReactiveSignal<T> implements Source {
  declare readonly [SIGNAL]: true;
  declare _obs1: Observer | null;
  declare _obs: Observer[] | null;
  declare seen: number;
  declare readonly name?: string;
  declare readonly equals: Equality<T>;
  declare _v: T;

  constructor(value: T, options?: SignalOptions<T>) {
    this._v = value;
    this._obs1 = null;
    this._obs = null;
    this.seen = 0;
    this.name = options?.name;
    this.equals = options?.equals ?? Object.is;
  }

  get observers(): Set<Observer> {
    return observersView(this);
  }

  get value(): T {
    if (activeObserver !== null) track(this);
    return this._v;
  }

  set value(next: T) {
    this.set(next);
  }

  get(): T {
    if (activeObserver !== null) track(this);
    return this._v;
  }

  peek(): T {
    return this._v;
  }

  set(next: T | ((current: T) => T)): T {
    return this._set(typeof next === "function" ? (next as (current: T) => T)(this._v) : next);
  }

  /** @internal Direct value write without updater-function interpretation. */
  _set(value: T): T {
    const prev = this._v;
    const eq = this.equals;
    if (eq === Object.is ? Object.is(prev, value) : eq !== false && eq(prev, value)) return prev;
    if (transactionStack.length > 0) {
      const transaction = transactionStack[transactionStack.length - 1]!;
      if (!transaction.has(this as ReactiveSignal<unknown>)) {
        transaction.set(this as ReactiveSignal<unknown>, prev);
      }
    }
    this._v = value;
    notify(this);
    return value;
  }

  update(updater: (current: T) => T): T {
    return this.set(updater);
  }

  subscribe(listener: (value: T, previous: T) => void, immediate = false): Cleanup {
    let previous = this._v;
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

  _restore(value: T): void {
    if (Object.is(this._v, value)) return;
    this._v = value;
    notify(this);
  }

  toJSON(): T {
    return this._v;
  }
}
Object.defineProperty(ReactiveSignal.prototype, SIGNAL, { value: true });

export function signal<T>(value: T, options?: SignalOptions<T>): ReactiveSignal<T> {
  return new ReactiveSignal(value, options);
}

export function isSignal(value: unknown): value is ReactiveSignal<unknown> | Computed<unknown> {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[SIGNAL]);
}

export class Computed<T> implements Source, Observer {
  declare readonly [SIGNAL]: true;
  declare _obs1: Observer | null;
  declare _obs: Observer[] | null;
  declare seen: number;
  declare sources: Source[];
  declare cursor: number;
  declare stale: Source[] | null;
  declare pass: number;
  declare active: boolean;
  declare _dirty: boolean;
  declare _eval: boolean;
  declare _v: T;
  declare readonly derive: () => T;
  declare readonly name?: string;

  constructor(derive: () => T, name?: string) {
    this.derive = derive;
    this.name = name;
    this._obs1 = null;
    this._obs = null;
    this.seen = 0;
    this.sources = EMPTY_SOURCES;
    this.cursor = 0;
    this.stale = null;
    this.pass = 0;
    this.active = true;
    this._dirty = true;
    this._eval = false;
    this._v = undefined as T;
  }

  get observers(): Set<Observer> {
    return observersView(this);
  }

  get dependencies(): Set<Source> {
    return new Set(this.sources);
  }

  get value(): T {
    if (activeObserver !== null) track(this);
    if (this._dirty) this.evaluate();
    return this._v;
  }

  get(): T {
    if (activeObserver !== null) track(this);
    if (this._dirty) this.evaluate();
    return this._v;
  }

  peek(): T {
    if (!this._dirty) return this._v;
    const previous = activeObserver;
    activeObserver = null;
    try {
      this.evaluate();
      return this._v;
    } finally {
      activeObserver = previous;
    }
  }

  schedule(): void {
    if (this._dirty || !this.active) return;
    this._dirty = true;
    notify(this);
  }

  private evaluate(): void {
    if (this._eval) throw new Error(`Circular computed${this.name ? ` \"${this.name}\"` : ""}.`);
    this._eval = true;
    const diagnosticStarted = hasDiagnostics ? performance.now() : 0;
    this.pass = ++passes;
    this.cursor = 0;
    const previous = activeObserver;
    activeObserver = this;
    try {
      this._v = this.derive();
      this._dirty = false;
    } finally {
      activeObserver = previous;
      if (this.stale !== null || this.cursor !== this.sources.length) settle(this);
      this._eval = false;
      if (hasDiagnostics) diagnostic("run", this, undefined, performance.now() - diagnosticStarted);
    }
  }

  dispose(): void {
    if (hasDiagnostics) diagnostic("dispose", this);
    this.active = false;
    detach(this);
    this._obs1 = null;
    this._obs = null;
  }

  toJSON(): T {
    return this.peek();
  }
}
Object.defineProperty(Computed.prototype, SIGNAL, { value: true });

export function computed<T>(derive: () => T, options?: { name?: string }): Computed<T> {
  const value = new Computed(derive, options?.name);
  if (activeScope !== null && activeScope.active) activeScope.cleanups.push(() => value.dispose());
  return value;
}

class ReactiveEffect implements Observer {
  sources: Source[] = EMPTY_SOURCES;
  cursor = 0;
  stale: Source[] | null = null;
  pass = 0;
  active = true;
  queued = false;
  _running = false;
  _reading = false;
  _init = false;
  _cleanup: Cleanup | undefined;
  _register: ((cleanup: Cleanup) => void) | undefined;

  declare readonly callback: (onCleanup: (cleanup: Cleanup) => void) => void | Cleanup;
  constructor(callback: (onCleanup: (cleanup: Cleanup) => void) => void | Cleanup) {
    this.callback = callback;
  }

  schedule(source?: Source): void {
    if (!this.active || (this._running && (!this._reading || (source !== undefined && source.seen !== this.pass && !reads(this, source))))) return;
    if (!this.queued) {
      this.queued = true;
      pending.push(this);
    }
    if (!flushing && batchDepth === 0) flushEffects();
  }

  run(): void {
    if (!this.active || this._running) return;
    this._running = true;
    const initial = !this._init;
    this._init = true;
    const diagnosticStarted = hasDiagnostics ? performance.now() : 0;
    this.queued = false;
    const previous = activeObserver;
    try {
      const previousCleanup = this._cleanup;
      if (previousCleanup !== undefined) {
        this._cleanup = undefined;
        activeObserver = null;
        previousCleanup();
      }
      this.pass = ++passes;
      this.cursor = 0;
      this._reading = true;
      activeObserver = this;
      const nextCleanup = this.callback.length === 0
        ? (this.callback as () => void | Cleanup)()
        : this.callback(this._register ??= (next) => { this._cleanup = next; });
      if (typeof nextCleanup === "function") this._cleanup = nextCleanup;
    } catch (error) {
      if (initial) {
        activeObserver = previous;
        try { this.dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "A Clank effect and its cleanup both failed."); }
      }
      throw error;
    } finally {
      activeObserver = previous;
      if (this._reading) {
        this._reading = false;
        if (this.stale !== null || this.cursor !== this.sources.length) settle(this);
      }
      this._running = false;
      if (hasDiagnostics) diagnostic("run", this, undefined, performance.now() - diagnosticStarted);
    }
  }

  dispose(): void {
    if (!this.active) return;
    if (hasDiagnostics) diagnostic("dispose", this);
    this.active = false;
    this.queued = false;
    detach(this);
    const cleanup = this._cleanup;
    if (cleanup !== undefined) {
      this._cleanup = undefined;
      const previous = activeObserver;
      activeObserver = null;
      try { cleanup(); } finally { activeObserver = previous; }
    }
  }
}

export interface EffectOptions {
  defer?: boolean;
}

export function effect(
  callback: (onCleanup: (cleanup: Cleanup) => void) => void | Cleanup,
  options?: EffectOptions,
): Cleanup {
  const observer = new ReactiveEffect(callback);
  const dispose = () => observer.dispose();
  if (activeScope !== null && activeScope.active) activeScope.cleanups.push(dispose);
  if (!options?.defer) {
    const wasFlushing = flushing;
    flushing = true;
    try { observer.run(); } finally { flushing = wasFlushing; }
    if (pending.length > 0 && !flushing && batchDepth === 0) flushEffects();
  } else observer.schedule();
  return dispose;
}

export function batch<T>(callback: () => T): T {
  batchDepth++;
  try {
    return callback();
  } finally {
    endBatch();
  }
}

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
  const dispose: Cleanup & { [ROOT_CLEANUP_STATE]?: Scope } = () => {
    if (!scope.active) return;
    scope.active = false;
    const list = scope.cleanups;
    if (list.length === 0) return;
    const errors: unknown[] = [];
    const previous = activeObserver;
    activeObserver = null;
    try {
      for (const cleanup of list.splice(0).reverse()) {
        try { cleanup(); } catch (error) { errors.push(error); }
      }
    } finally {
      activeObserver = previous;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Multiple Clank cleanup callbacks failed.");
  };
  dispose[ROOT_CLEANUP_STATE] = scope;
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
  if (activeScope !== null) activeScope.escaped = true;
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
  const cachedProxy = proxyByRaw.get(initial);
  if (cachedProxy !== undefined) return cachedProxy as T;
  if (rawByProxy.has(initial)) return initial;
  const signals = new Map<PropertyKey, ReactiveSignal<unknown>>();
  const iteration = new ReactiveSignal(0);
  const isArray = Array.isArray(initial);
  const proxied = new Proxy(initial, {
    get(target, key, receiver) {
      if (key === STORE) return true;
      if (key === RAW_SYMBOL) return target;
      let entry = signals.get(key);
      if (entry === undefined) {
        entry = new ReactiveSignal<unknown>(Reflect.get(target, key, receiver));
        signals.set(key, entry);
      }
      const value = entry.get();
      if (value === null || typeof value !== "object") return value;
      return proxyByRaw.get(value as object) ?? store(value as object);
    },
    set(target, key, value, receiver) {
      const owned = Object.hasOwn(target, key);
      const raw = value !== null && typeof value === "object" ? (rawByProxy.get(value as object) ?? value) : value;
      if (!isArray && owned && key !== "__proto__") {
        const result = Reflect.set(target, key, raw, receiver);
        signals.get(key)?._set(Reflect.get(target, key, receiver));
        return result;
      }
      const array = isArray ? target as unknown[] : undefined;
      const previousLength = array ? array.length : 0;
      const previousKeyCount = array && key === "length" && (typeof raw !== "number" || raw < previousLength)
        ? Reflect.ownKeys(target).length
        : 0;
      const result = key === "__proto__"
        ? Reflect.defineProperty(target, key, { value: raw, enumerable: true, configurable: true, writable: true })
        : Reflect.set(target, key, raw, receiver);
      batchDepth++;
      try {
        signals.get(key)?._set(Reflect.get(target, key, receiver));
        if (array && key === "length" && array.length < previousLength) {
          for (const [property, cached] of signals) {
            const index = typeof property === "string" ? Number(property) : NaN;
            if (Number.isInteger(index) && index >= array.length && index < previousLength && String(index) === property) {
              cached._set(Reflect.get(target, property, receiver));
            }
          }
          if (Reflect.ownKeys(target).length < previousKeyCount) iteration._set(iteration._v + 1);
        }
        if (array && key !== "length" && array.length !== previousLength) signals.get("length")?._set(array.length);
        if (owned !== Object.hasOwn(target, key)) iteration._set(iteration._v + 1);
      } finally { endBatch(); }
      return result;
    },
    deleteProperty(target, key) {
      const owned = Object.hasOwn(target, key);
      const result = Reflect.deleteProperty(target, key);
      if (!result || !owned) return result;
      batchDepth++;
      try {
        signals.get(key)?._set(Reflect.get(target, key, proxied));
        iteration._set(iteration._v + 1);
      } finally { endBatch(); }
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

export async function consumeStream<T>(
  iterable: AsyncIterable<T>,
  initial: T,
  reduce: (current: T, chunk: T) => T = (_current, chunk) => chunk,
): Promise<ReactiveSignal<T>> {
  const output = signal(initial);
  for await (const chunk of iterable) output.update((current) => reduce(current, chunk));
  return output;
}
