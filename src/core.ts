export const SIGNAL = Symbol.for("clank.signal");
export const STORE = Symbol.for("clank.store");

export type Cleanup = () => void;
export type Equality<T> = false | ((previous: T, next: T) => boolean);

interface Source {
  obs: Observer | Observer[] | null;
  seen: number;
}

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

const E_SRC: Source[] = [];
const E_OBS: ReadonlySet<Observer> = new Set();
const RAW = Symbol.for("clank.raw");
export const ROOT_CLEANUP_STATE = Symbol.for("clank.root-cleanups");

let curObs: Observer | null = null;
let curScope: Scope | null = null;
let tracking = true;
let depth = 0;
let passes = 0;
let flushing = false;
let hasDiag = false;
let pending: ReactiveEffect[] = [];
const txStack: Array<Map<ReactiveSignal<unknown>, unknown>> = [];

function addObs(s: Source, o: Observer): void {
  const x = s.obs;
  if (!x) s.obs = o;
  else if (Array.isArray(x)) x.push(o);
  else if (x !== o) s.obs = [x, o];
}

function remObs(s: Source, o: Observer): void {
  const x = s.obs;
  if (x === o) s.obs = null;
  else if (Array.isArray(x)) {
    const i = x.indexOf(o);
    if (i >= 0) { x.splice(i, 1); if (!x.length) s.obs = null; }
  }
}

function obsView(s: Source): Set<Observer> {
  const x = s.obs;
  return !x ? E_OBS as Set<Observer> : new Set(Array.isArray(x) ? x : [x]);
}

function endBatch(): void {
  if (--depth === 0 && pending.length && !flushing) flush();
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
const dSet = new Set<(event: ReactiveDiagnostic) => void>();
let dIds = new WeakMap<object, number>();
let dSeq = 0;
let dBusy = false;
function dId(v: object): number {
  let id = dIds.get(v);
  if (id === undefined) dIds.set(v, id = ++dSeq);
  return id;
}
function emit(type: ReactiveDiagnostic["type"], target: Source | Observer, source?: Source, durationMs?: number): void {
  if (!hasDiag || dBusy) return;
  const ev = Object.freeze({ type, id: dId(target),
    kind: target instanceof ReactiveSignal ? "signal" as const : target instanceof Computed ? "computed" as const : "effect" as const,
    ...(source ? { sourceId: dId(source) } : {}),
    ...("name" in target && typeof target.name === "string" ? { name: target.name.slice(0, 128) } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...("sources" in target ? { dependencies: new Set(target.sources).size } : {}) });
  dBusy = true;
  const prev = tracking;
  tracking = false;
  try { for (const l of dSet) { try { l(ev); } catch {} } }
  finally { tracking = prev; dBusy = false; }
}
export function observeReactivity(listener: (event: ReactiveDiagnostic) => void): Cleanup {
  dSet.add(listener);
  hasDiag = true;
  return () => {
    dSet.delete(listener);
    if (!(hasDiag = dSet.size > 0)) dIds = new WeakMap();
  };
}

function track(s: Source): void {
  const o = curObs;
  if (!tracking || !o || !o.active) return;
  const pass = o.pass;
  if (s.seen === pass) return;
  const c = o.cursor, srcs = o.sources;
  if (!o.stale && srcs[c] === s) {
    s.seen = pass;
    o.cursor = c + 1;
    if (hasDiag) emit("dependency", o, s);
    return;
  }
  if (reads(o, s)) { s.seen = pass; return; }
  s.seen = pass;
  if (srcs === E_SRC) {
    o.sources = [s];
    o.cursor = 1;
    addObs(s, o);
  } else {
    if (!o.stale && c < srcs.length) o.stale = srcs.splice(c);
    o.cursor = srcs.push(s);
    if (!o.stale?.includes(s)) addObs(s, o);
  }
  if (hasDiag) emit("dependency", o, s);
}

function reads(o: Observer, s: Source): boolean {
  const c = o.cursor, a = o.sources;
  for (let i = 0; i < c; i++) if (a[i] === s) return true;
  return false;
}

function settle(o: Observer): void {
  const a = o.sources;
  let st = o.stale;
  o.stale = null;
  if (!o.active || (!st && o.cursor === a.length)) return;
  st ??= a.splice(o.cursor);
  const kept = st.length * a.length > 4096 ? new Set(a) : null;
  const pass = o.pass;
  for (let i = 0; i < st.length; i++) {
    const s = st[i]!;
    if (s.seen !== pass && !(kept ? kept.has(s) : a.includes(s))) remObs(s, o);
  }
}

function detach(o: Observer): void {
  for (const s of o.sources) remObs(s, o);
  if (o.stale) for (const s of o.stale) remObs(s, o);
  o.sources = E_SRC;
  o.stale = null;
}

function notify(s: Source): void {
  if (hasDiag) emit("invalidate", s);
  const x = s.obs;
  if (!x) return;
  if (!Array.isArray(x)) { x.schedule(s); return; }
  depth++;
  try { for (let i = 0; i < x.length; i++) x[i]!.schedule(s); }
  finally { endBatch(); }
}

function flush(): void {
  if (flushing || depth || !pending.length) return;
  flushing = true;
  let n = 0;
  try {
    while (pending.length) {
      if (++n > 10_000) {
        for (const e of pending) e.queued = false;
        pending.length = 0;
        throw new Error("Clank detected a reactive cycle after 10,000 updates.");
      }
      const list = pending;
      pending = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        if (!e.queued) continue;
        e.queued = false;
        try { e.run(); } catch (err) {
          for (let j = i + 1; j < list.length; j++) if (list[j]!.active) { list[j]!.queued = true; pending.push(list[j]!); }
          throw err;
        }
      }
    }
  } finally { flushing = false; }
}

function reg(cl: Cleanup): Cleanup {
  if (curScope?.active) curScope.cleanups.push(cl);
  return cl;
}

export interface SignalOptions<T> {
  name?: string;
  equals?: Equality<T>;
}

export class ReactiveSignal<T> implements Source {
  declare readonly [SIGNAL]: true;
  declare obs: Observer | Observer[] | null;
  declare seen: number;
  declare readonly name?: string;
  declare readonly equals: Equality<T>;
  declare _v: T;

  constructor(v: T, opts?: SignalOptions<T>) {
    this._v = v;
    this.obs = null;
    this.seen = 0;
    this.name = opts?.name;
    this.equals = opts?.equals ?? Object.is;
  }

  get observers(): Set<Observer> { return obsView(this); }
  get value(): T { return this.get(); }
  set value(v: T) { this.set(v); }
  get(): T { if (curObs) track(this); return this._v; }
  peek(): T { return this._v; }
  set(v: T | ((c: T) => T)): T { return this._set(typeof v === "function" ? (v as (c: T) => T)(this._v) : v); }

  _set(v: T): T {
    const p = this._v, eq = this.equals;
    if (eq === Object.is ? Object.is(p, v) : eq && eq(p, v)) return p;
    if (txStack.length) {
      const tx = txStack[txStack.length - 1]!;
      if (!tx.has(this as ReactiveSignal<unknown>)) tx.set(this as ReactiveSignal<unknown>, p);
    }
    this._v = v;
    notify(this);
    return v;
  }

  update(fn: (c: T) => T): T { return this.set(fn); }

  subscribe(fn: (v: T, p: T) => void, imm = false): Cleanup {
    let prev = this._v;
    if (imm) fn(prev, prev);
    return effect(() => {
      const next = this.get();
      if (!Object.is(prev, next)) { const b = prev; prev = next; fn(next, b); }
    });
  }

  _restore(v: T): void {
    if (!Object.is(this._v, v)) { this._v = v; notify(this); }
  }

  toJSON(): T { return this._v; }
}

export function signal<T>(v: T, opts?: SignalOptions<T>): ReactiveSignal<T> {
  return new ReactiveSignal(v, opts);
}

export function isSignal(v: unknown): v is ReactiveSignal<unknown> | Computed<unknown> {
  return Boolean(v && typeof v === "object" && (v as Record<PropertyKey, unknown>)[SIGNAL]);
}

export class Computed<T> implements Source, Observer {
  declare readonly [SIGNAL]: true;
  declare obs: Observer | Observer[] | null;
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
    this.obs = this.stale = null;
    this.seen = this.cursor = this.pass = 0;
    this.sources = E_SRC;
    this.active = this._dirty = true;
    this._eval = false;
    this._v = undefined as T;
  }

  get observers(): Set<Observer> { return obsView(this); }
  get dependencies(): Set<Source> { return new Set(this.sources); }
  get value(): T { return this.get(); }
  get(): T { if (curObs) track(this); if (this._dirty) this.evaluate(); return this._v; }

  peek(): T {
    if (!this._dirty) return this._v;
    const prev = curObs;
    curObs = null;
    try { this.evaluate(); return this._v; }
    finally { curObs = prev; }
  }

  schedule(): void {
    if (this._dirty || !this.active) return;
    this._dirty = true;
    notify(this);
  }

  private evaluate(): void {
    if (this._eval) throw new Error(`Circular computed${this.name ? ` "${this.name}"` : ""}.`);
    this._eval = true;
    const t0 = hasDiag ? performance.now() : 0;
    this.pass = ++passes;
    this.cursor = 0;
    const prev = curObs;
    curObs = this;
    try {
      this._v = this.derive();
      this._dirty = false;
    } finally {
      curObs = prev;
      if (this.stale || this.cursor !== this.sources.length) settle(this);
      this._eval = false;
      emit("run", this, undefined, hasDiag ? performance.now() - t0 : 0);
    }
  }

  dispose(): void {
    emit("dispose", this);
    this.active = false;
    detach(this);
    this.obs = null;
  }

  toJSON(): T { return this.peek(); }
}

for (const p of [ReactiveSignal.prototype, Computed.prototype]) Object.defineProperty(p, SIGNAL, { value: true });

export function computed<T>(derive: () => T, opts?: { name?: string }): Computed<T> {
  const v = new Computed(derive, opts?.name);
  reg(() => v.dispose());
  return v;
}

class ReactiveEffect implements Observer {
  declare sources: Source[];
  declare cursor: number;
  declare stale: Source[] | null;
  declare pass: number;
  declare active: boolean;
  declare queued: boolean;
  declare _run: boolean;
  declare _read: boolean;
  declare _init: boolean;
  declare _cl: Cleanup | undefined;
  declare _reg: ((cl: Cleanup) => void) | undefined;
  declare readonly cb: (onCleanup: (cl: Cleanup) => void) => void | Cleanup;

  constructor(cb: (onCleanup: (cl: Cleanup) => void) => void | Cleanup) {
    this.cb = cb;
    this.sources = E_SRC;
    this.stale = null;
    this.cursor = this.pass = 0;
    this.active = true;
    this.queued = this._run = this._read = this._init = false;
  }

  schedule(s?: Source): void {
    if (!this.active || (this._run && (!this._read || (s && s.seen !== this.pass && !reads(this, s))))) return;
    if (!this.queued) { this.queued = true; pending.push(this); }
    if (!flushing && !depth) flush();
  }

  run(): void {
    if (!this.active || this._run) return;
    this._run = true;
    const init = !this._init;
    this._init = true;
    const t0 = hasDiag ? performance.now() : 0;
    this.queued = false;
    const prev = curObs;
    try {
      const cl = this._cl;
      if (cl) { this._cl = undefined; curObs = null; cl(); }
      this.pass = ++passes;
      this.cursor = 0;
      this._read = true;
      curObs = this;
      const next = this.cb.length ? this.cb(this._reg ??= (c) => { this._cl = c; }) : (this.cb as () => void | Cleanup)();
      if (typeof next === "function") this._cl = next;
    } catch (err) {
      if (init) {
        curObs = prev;
        try { this.dispose(); }
        catch (ce) { throw new AggregateError([err, ce], "A Clank effect and its cleanup both failed."); }
      }
      throw err;
    } finally {
      curObs = prev;
      if (this._read) {
        this._read = false;
        if (this.stale || this.cursor !== this.sources.length) settle(this);
      }
      this._run = false;
      emit("run", this, undefined, hasDiag ? performance.now() - t0 : 0);
    }
  }

  dispose(): void {
    if (!this.active) return;
    emit("dispose", this);
    this.active = false;
    this.queued = false;
    detach(this);
    const cl = this._cl;
    if (cl) {
      this._cl = undefined;
      const prev = curObs;
      curObs = null;
      try { cl(); } finally { curObs = prev; }
    }
  }
}

export interface EffectOptions {
  defer?: boolean;
}

export function effect(
  cb: (onCleanup: (cl: Cleanup) => void) => void | Cleanup,
  opts?: EffectOptions,
): Cleanup {
  const o = new ReactiveEffect(cb);
  const dispose = reg(() => o.dispose());
  if (!opts?.defer) {
    const was = flushing;
    flushing = true;
    try { o.run(); } finally { flushing = was; }
    if (pending.length && !flushing && !depth) flush();
  } else o.schedule();
  return dispose;
}

export function batch<T>(cb: () => T): T {
  depth++;
  try { return cb(); }
  finally { endBatch(); }
}

export function transaction<T>(cb: () => T): T {
  return batch(() => {
    const j = new Map<ReactiveSignal<unknown>, unknown>();
    txStack.push(j);
    try {
      const res = cb();
      const parent = txStack.at(-2);
      if (parent) for (const [k, v] of j) if (!parent.has(k)) parent.set(k, v);
      return res;
    } catch (err) {
      for (const [k, v] of [...j].reverse()) k._restore(v);
      throw err;
    } finally { txStack.pop(); }
  });
}

export function untrack<T>(cb: () => T): T {
  const prev = tracking;
  tracking = false;
  try { return cb(); }
  finally { tracking = prev; }
}

export function onCleanup(cl: Cleanup): Cleanup {
  if (!curScope) throw new Error("onCleanup() must run inside createRoot() or a component.");
  return reg(cl);
}

export function createRoot<T>(cb: (dispose: Cleanup) => T): T {
  const parent = curScope;
  const scope: Scope = { parent, cleanups: [], active: true };
  const dispose: Cleanup & { [ROOT_CLEANUP_STATE]?: Scope } = () => {
    if (!scope.active) return;
    scope.active = false;
    if (!scope.cleanups.length) return;
    const errs: unknown[] = [];
    const prev = curObs;
    curObs = null;
    try {
      for (const cl of scope.cleanups.splice(0).reverse()) {
        try { cl(); } catch (err) { errs.push(err); }
      }
    } finally { curObs = prev; }
    if (errs.length === 1) throw errs[0];
    if (errs.length > 1) throw new AggregateError(errs, "Multiple Clank cleanup callbacks failed.");
  };
  dispose[ROOT_CLEANUP_STATE] = scope;
  curScope = scope;
  try { return cb(dispose); }
  catch (err) {
    try { dispose(); }
    catch (ce) { throw new AggregateError([err, ce], "A Clank root and its cleanup both failed."); }
    throw err;
  } finally { curScope = parent; }
}

export function getOwner(): object | null {
  if (curScope) curScope.escaped = true;
  return curScope;
}

export function runWithOwner<T>(owner: object | null, cb: () => T): T {
  const prev = curScope;
  curScope = owner as Scope | null;
  try { return cb(); }
  finally { curScope = prev; }
}

const toOrig = new WeakMap<object, object>();
const toProx = new WeakMap<object, object>();

export function store<T extends object>(initial: T): T {
  const cached = toProx.get(initial);
  if (cached) return cached as T;
  if (toOrig.has(initial)) return initial;
  const sigs = new Map<PropertyKey, ReactiveSignal<unknown>>();
  const iter = new ReactiveSignal(0);
  const isArr = Array.isArray(initial);
  const proxied = new Proxy(initial, {
    get(t, k, rec) {
      if (k === STORE) return true;
      if (k === RAW) return t;
      let e = sigs.get(k);
      if (!e) sigs.set(k, e = new ReactiveSignal<unknown>(Reflect.get(t, k, rec)));
      const v = e.get();
      return v && typeof v === "object" ? (toProx.get(v as object) ?? store(v as object)) : v;
    },
    set(t, k, v, rec) {
      const owned = Object.hasOwn(t, k), raw = toRaw(v);
      if (!isArr && owned && k !== "__proto__") {
        const r = Reflect.set(t, k, raw, rec);
        sigs.get(k)?._set(Reflect.get(t, k, rec));
        return r;
      }
      const arr = isArr ? t as unknown[] : undefined;
      const pLen = arr ? arr.length : 0;
      const pKeys = arr && k === "length" && (typeof raw !== "number" || raw < pLen) ? Reflect.ownKeys(t).length : 0;
      const r = k === "__proto__"
        ? Reflect.defineProperty(t, k, { value: raw, enumerable: true, configurable: true, writable: true })
        : Reflect.set(t, k, raw, rec);
      batch(() => {
        sigs.get(k)?._set(Reflect.get(t, k, rec));
        if (arr && k === "length" && arr.length < pLen) {
          for (const [p, s] of sigs) {
            const idx = typeof p === "string" ? Number(p) : NaN;
            if (Number.isInteger(idx) && idx >= arr.length && idx < pLen && String(idx) === p) s._set(Reflect.get(t, p, rec));
          }
          if (Reflect.ownKeys(t).length < pKeys) iter._set(iter._v + 1);
        }
        if (arr && k !== "length" && arr.length !== pLen) sigs.get("length")?._set(arr.length);
        if (owned !== Object.hasOwn(t, k)) iter._set(iter._v + 1);
      });
      return r;
    },
    deleteProperty(t, k) {
      const owned = Object.hasOwn(t, k);
      const r = Reflect.deleteProperty(t, k);
      if (!r || !owned) return r;
      batch(() => {
        sigs.get(k)?._set(Reflect.get(t, k, proxied));
        iter._set(iter._v + 1);
      });
      return r;
    },
    ownKeys(t) { iter.get(); return Reflect.ownKeys(t); },
    has(t, k) { iter.get(); return Reflect.has(t, k); },
  });
  toOrig.set(proxied, initial);
  toProx.set(initial, proxied);
  return proxied as T;
}

export function isStore(v: unknown): boolean {
  return Boolean(v && typeof v === "object" && (v as Record<PropertyKey, unknown>)[STORE]);
}

export function toRaw<T>(v: T): T {
  return ((v && typeof v === "object" ? toOrig.get(v as object) : undefined) ?? v) as T;
}

export function snapshot<T>(v: T): T {
  if (isSignal(v)) return snapshot(v.peek()) as T;
  if (Array.isArray(v)) return v.map(snapshot) as T;
  if (v && typeof v === "object") {
    const out: Record<PropertyKey, unknown> = {};
    for (const k of Reflect.ownKeys(v as object)) {
      Object.defineProperty(out, k, { value: snapshot((v as Record<PropertyKey, unknown>)[k]), enumerable: true, configurable: true, writable: true });
    }
    return out as T;
  }
  return v;
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
  opts: ResourceOptions<T> = {},
): Resource<T, P> {
  const data = signal<T | undefined>(opts.initial);
  const error = signal<unknown>(undefined);
  const status = signal<ResourceStatus>("idle");
  const loading = computed(() => status.value === "loading" || status.value === "refreshing");
  let ac: AbortController | undefined;
  let rev = 0;

  const reload = async (p?: P): Promise<T | undefined> => {
    ac?.abort();
    const c = ac = new AbortController();
    const r = ++rev;
    batch(() => { error.value = undefined; status.value = data.peek() === undefined ? "loading" : "refreshing"; });
    try {
      const next = await loader(p, { signal: c.signal, value: data.peek() });
      if (r !== rev || c.signal.aborted) return data.peek();
      batch(() => { data.value = next; status.value = "ready"; });
      return next;
    } catch (reason) {
      if (r !== rev || c.signal.aborted) return data.peek();
      batch(() => { error.value = reason; status.value = "error"; });
      return undefined;
    }
  };

  const res: Resource<T, P> = {
    data, error, status, loading, reload,
    mutate(v) { data.set(v); },
    abort() {
      rev++;
      ac?.abort();
      if (status.peek() === "loading" || status.peek() === "refreshing") status.value = "idle";
    },
  };
  reg(() => res.abort());
  if (opts.immediate !== false) void reload();
  return res;
}

export async function consumeStream<T>(
  iterable: AsyncIterable<T>,
  initial: T,
  reduce: (current: T, chunk: T) => T = (_c, chunk) => chunk,
): Promise<ReactiveSignal<T>> {
  const out = signal(initial);
  for await (const chunk of iterable) out.update((c) => reduce(c, chunk));
  return out;
}
