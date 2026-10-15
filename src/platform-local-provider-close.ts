export interface PlatformOwnedLocalProviderBinding {
  readonly owned: boolean;
  readonly service?: { close(): void | Promise<void> };
  readonly ownership?: object;
}

export class PlatformLocalProviderCloseError extends AggregateError {
  readonly kind: "unresolved-root" | "service-close";
  constructor(kind: "unresolved-root" | "service-close", failures: readonly unknown[]) {
    super(failures, kind === "unresolved-root"
      ? "A platform-owned provider root is still held by an incomplete factory open."
      : "Platform-owned local provider services could not close cleanly.");
    this.kind = kind;
  }
}

/** Allow nested scopes to finish only inside an evacuation admitted before close. */
export function createEvacuationAdmissionScope(AsyncLocalStorage: new () => {
  getStore(): unknown;
  run<T>(store: object, callback: () => T): T;
}) {
  const scope = new AsyncLocalStorage();
  return Object.freeze({
    run<T>(callback: () => T): T { return scope.run(Object.freeze({}), callback); },
    assertAllowed(closing: boolean, closed: boolean): void {
      if ((closing || closed) && !scope.getStore()) throw new Error("Original platform is closing and cannot admit a new fallback operation.");
    },
  });
}

/** Wait for the captured fallback operations before beginning owned cleanup. */
export async function drainPlatformLocalFallbackOperations<T>(
  operations: Iterable<Promise<unknown>>,
  afterDrain: () => T | Promise<T>,
): Promise<T> {
  await Promise.all([...operations].map(operation => operation.catch(() => undefined)));
  return await afterDrain();
}

/** Preflight every retained root before closing any platform-owned service. */
export async function closePlatformOwnedLocalProviders(
  entries: Iterable<readonly [string, PlatformOwnedLocalProviderBinding]>,
  remove: (nodeId: string, service: NonNullable<PlatformOwnedLocalProviderBinding["service"]>) => void,
): Promise<void> {
  const bindings = [...entries];
  const unresolved = bindings.filter(([, binding]) => binding.owned && binding.ownership);
  if (unresolved.length) throw new PlatformLocalProviderCloseError("unresolved-root", unresolved.map(([nodeId]) => new Error(`Factory binding ${nodeId} still owns a provider root.`)));
  const failures: unknown[] = [];
  for (const [nodeId, binding] of bindings) {
    if (!binding.owned || !binding.service) continue;
    try { await binding.service.close(); remove(nodeId, binding.service); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new PlatformLocalProviderCloseError("service-close", failures);
}
