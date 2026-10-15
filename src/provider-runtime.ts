export const DEPLOYMENT_RUNTIME_INGRESS_PROTOCOL = "clank-provider-ingress/1";

/** Private admission before an original native owner performs expensive verification. */
export async function providerRuntimeRequestAuthorized(request: Request, input: DeploymentRuntimeIngressBinding): Promise<boolean> {
  if (!(request instanceof Request) || request.url.length > 8192) return false;
  try {
    const binding = await normalizeBinding(input), url = new URL(request.url);
    if (url.pathname !== binding.path && !url.pathname.startsWith(binding.path + "/")) return false;
    return await authorized(request.headers, binding);
  } catch { return false; }
}

export interface DeploymentRuntimeIngressBinding {
  readonly protocol: "clank-runtime/1";
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  /** Provider-local route selected by the runtime capsule. */
  readonly path: string;
  /** High-entropy route credential. Only its SHA-256 digest is retained. */
  readonly token: string;
  /** Loopback origin of the isolated application runtime. */
  readonly upstream: string;
}

export interface DeploymentRuntimeIngressState {
  readonly protocol: typeof DEPLOYMENT_RUNTIME_INGRESS_PROTOCOL;
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly path: string;
  readonly activatedAt: number;
  readonly inFlight: number;
  /** True for the highest accepted generation of this project. */
  readonly latest: boolean;
}

export interface DeploymentRuntimeIngressDeactivateResult {
  readonly removed: boolean;
  readonly drained: boolean;
}

export interface DeploymentRuntimeIngress {
  /** Atomically publishes a newer generation or idempotently accepts the exact current one. */
  activate(binding: DeploymentRuntimeIngressBinding): Promise<DeploymentRuntimeIngressState>;
  /** Returns active non-secret binding metadata. */
  inspect(): readonly DeploymentRuntimeIngressState[];
  /** Handles the private provider route called by Clank managed ingress. */
  handle(request: Request): Promise<Response>;
  /** Waits for requests already assigned to an exact generation. */
  drain(projectId: string, generation: number, timeoutMs?: number): Promise<boolean>;
  /**
   * Atomically revokes an exact generation, then drains its assigned requests.
   * A retry waits for an already-draining generation.
   */
  deactivate(
    projectId: string,
    generation: number,
    timeoutMs?: number,
  ): Promise<DeploymentRuntimeIngressDeactivateResult>;
  /**
   * Releases an inactive project's generation high-water mark after its
   * provider-owned state has been permanently deleted.
   */
  forget(projectId: string, generation: number): boolean;
  /** Revokes every route and drains outstanding requests. */
  close(timeoutMs?: number): Promise<boolean>;
}

export interface DeploymentRuntimeIngressOptions {
  fetch?: typeof fetch;
  /** Per-request deadline including bounded body intake. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Maximum request body forwarded to a runtime. Defaults to 25 MiB. */
  maxBodyBytes?: number;
  /** Maximum private request URL. Defaults to 8 KiB. */
  maxUrlLength?: number;
  /** Maximum tracked projects and combined published/draining generations. Defaults to 10,000. */
  maxBindings?: number;
  /** Receives private upstream failures. */
  onError?: (error: unknown) => void;
}

interface RuntimeBinding {
  protocol: "clank-runtime/1";
  projectId: string;
  releaseId: string;
  generation: number;
  path: string;
  tokenDigest: Uint8Array;
  upstream: string;
  activatedAt: number;
  leases: Set<symbol>;
  waiters: Set<() => void>;
}

type FallbackStoppedIngressAuthority = ReturnType<typeof import("./provider-service.ts").providerFallbackIngressStoppedContext>;
type FallbackSourceStoppedIngressAuthority = ReturnType<typeof import("./provider-service.ts").providerFallbackSourceIngressStoppedContext>;
type FallbackReactivationAuthority = ReturnType<typeof import("./provider-service.ts").providerFallbackIngressReactivationContext>;
const fallbackIngresses = new WeakMap<object, {
  capture(authority: FallbackStoppedIngressAuthority): Promise<object | undefined>;
  captureSource(authority: FallbackSourceStoppedIngressAuthority): Promise<object | undefined>;
  reactivate(authority: FallbackReactivationAuthority): Promise<DeploymentRuntimeIngressState>;
}>();
const fallbackTombstones = new WeakMap<object, { ingress: DeploymentRuntimeIngress; binding: RuntimeBinding; request?: import("./provider.ts").DeploymentProviderRequest; source?: FallbackSourceStoppedIngressAuthority["identity"]; consumed: boolean }>();

/** Private original-service cleanup receipt; caller-shaped permits grant no authority. */
export async function captureProviderRuntimeFallbackTombstone(ingress: object, permit: object): Promise<object | undefined> {
  const authority = (await import("./provider-service.ts")).providerFallbackIngressStoppedContext(permit);
  const held = fallbackIngresses.get(ingress);
  if (!held || authority.ingress !== ingress) throw new Error("Fallback stopped ingress is not its original service binding.");
  authority.check(); return held.capture(authority);
}

/** Distinct source STOPPED receipt; only original finalized recovery can mint it. */
export async function captureProviderRuntimeFallbackSourceTombstone(ingress: object, permit: object): Promise<object | undefined> {
  const authority = (await import("./provider-service.ts")).providerFallbackSourceIngressStoppedContext(permit);
  const held = fallbackIngresses.get(ingress);
  if (!held || authority.ingress !== ingress) throw new Error("Fallback stopped source ingress is not its original service binding.");
  authority.check(); return held.captureSource(authority);
}

/** Publish a genuine newer original operation over its exact drained tombstone. */
export async function reactivateProviderRuntimeFallbackIngress(ingress: object, permit: object): Promise<DeploymentRuntimeIngressState> {
  const authority = (await import("./provider-service.ts")).providerFallbackIngressReactivationContext(permit);
  const held = fallbackIngresses.get(ingress);
  if (!held || authority.ingress !== ingress) throw new Error("Fallback reactivation ingress is not its original service binding.");
  authority.check(); return held.reactivate(authority);
}

const BINDING_HEADERS = [
  "x-clank-project-id",
  "x-clank-runtime-protocol",
  "x-clank-runtime-generation",
  "x-clank-runtime-ingress",
] as const;

/**
 * Creates the provider-private hop between generation-bound managed ingress
 * and loopback application runtimes. This component publishes routes; it does
 * not launch processes or persist application secrets.
 */
export function createDeploymentRuntimeIngress(
  options: DeploymentRuntimeIngressOptions = {},
): DeploymentRuntimeIngress {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = integer(options.timeoutMs ?? 30_000, "timeoutMs", 100, 5 * 60_000);
  const maxBodyBytes = integer(
    options.maxBodyBytes ?? 25 * 1024 * 1024,
    "maxBodyBytes",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const maxUrlLength = integer(options.maxUrlLength ?? 8 * 1024, "maxUrlLength", 256, 1024 * 1024);
  const maxBindings = integer(options.maxBindings ?? 10_000, "maxBindings", 1, 100_000);
  const published = new Map<string, RuntimeBinding>();
  const routes = new Map<string, Map<string, RuntimeBinding>>();
  const latestByProject = new Map<string, RuntimeBinding>();
  const draining = new Map<string, RuntimeBinding>();
  let closed = false;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot affect private application traffic.
    }
  };

  const retire = (binding: RuntimeBinding): void => {
    const key = bindingKey(binding.projectId, binding.generation);
    draining.set(key, binding);
    if (binding.leases.size === 0) draining.delete(key);
  };

  const releaseBinding = (binding: RuntimeBinding, lease: symbol): void => {
    if (!binding.leases.delete(lease) || binding.leases.size !== 0) return;
    for (const resolve of binding.waiters) resolve();
    binding.waiters.clear();
    const key = bindingKey(binding.projectId, binding.generation);
    if (draining.get(key) === binding) draining.delete(key);
  };

  const waitForBinding = async (binding: RuntimeBinding, timeoutInput: number): Promise<boolean> => {
    if (binding.leases.size === 0) {
      draining.delete(bindingKey(binding.projectId, binding.generation));
      return true;
    }
    const waitMs = integer(timeoutInput, "drain timeout", 100, 30_000);
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    binding.waiters.add(resolveDrained);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      drained.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!result) {
      binding.waiters.delete(resolveDrained);
    }
    return result;
  };

  const runtimeIngress: DeploymentRuntimeIngress = {
    async activate(input) {
      if (closed) throw new Error("Deployment runtime ingress is closed.");
      const binding = await normalizeBinding(input);
      if (closed) throw new Error("Deployment runtime ingress is closed.");
      const key = bindingKey(binding.projectId, binding.generation);
      const exact = published.get(key);
      if (exact) {
        if (!sameBinding(exact, binding)) {
          throw new Error("Deployment runtime ingress generation conflicts with the active binding.");
        }
        return publicState(exact, latestByProject);
      }
      if (draining.has(key)) {
        throw new Error("Deployment runtime ingress generation is still draining.");
      }
      const latest = latestByProject.get(binding.projectId);
      if (latest && binding.generation < latest.generation) {
        throw new Error("Deployment runtime ingress generation is stale.");
      }
      if (latest && binding.generation === latest.generation) {
        if (!sameBinding(latest, binding)) {
          throw new Error("Deployment runtime ingress generation conflicts with the active binding.");
        }
        throw new Error("Deployment runtime ingress generation was deactivated.");
      }
      const route = routes.get(binding.path);
      if (route && [...route.values()].some((entry) => entry.projectId !== binding.projectId)) {
        throw new Error("Deployment runtime ingress path is already assigned.");
      }
      pruneRetired(draining);
      if (!latest && latestByProject.size >= maxBindings) {
        throw new Error("Deployment runtime ingress project limit reached.");
      }
      const projected = published.size + draining.size + 1;
      if (projected > maxBindings) {
        throw new Error("Deployment runtime ingress binding limit reached.");
      }
      published.set(key, binding);
      const group = route ?? new Map<string, RuntimeBinding>();
      group.set(key, binding);
      routes.set(binding.path, group);
      if (!latest || binding.generation > latest.generation) {
        latestByProject.set(binding.projectId, binding);
      }
      return publicState(binding, latestByProject);
    },

    inspect() {
      return Object.freeze(
        [...published.values()]
          .sort((left, right) =>
            left.projectId.localeCompare(right.projectId)
              || left.generation - right.generation)
          .map((binding) => publicState(binding, latestByProject)),
      );
    },

    async handle(request) {
      if (closed) return runtimeUnavailable();
      if (!(request instanceof Request)) {
        return problem(400, "INVALID_REQUEST", "Runtime ingress request is invalid.");
      }
      if (request.url.length > maxUrlLength) {
        return problem(414, "URI_TOO_LONG", "Runtime ingress request URL is too long.");
      }
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return problem(400, "INVALID_REQUEST", "Runtime ingress request URL is invalid.");
      }
      const binding = findBinding(routes, url.pathname, request.headers);
      if (!binding) return runtimeUnavailable();
      // Reserve the selected generation before the asynchronous token digest.
      // A concurrent activation can then retire and drain this request safely.
      const lease = Symbol(binding.projectId);
      binding.leases.add(lease);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        releaseBinding(binding, lease);
      };
      try {
        if (!await authorized(request.headers, binding)) {
          release();
          return runtimeUnavailable();
        }
      } catch {
        release();
        return runtimeUnavailable();
      }
      let declared: number | null;
      try {
        declared = contentLength(request.headers);
      } catch (error) {
        release();
        if (error instanceof RuntimeIngressRequestError) {
          return problem(error.status, error.code, error.message);
        }
        return problem(400, "INVALID_REQUEST", "Runtime ingress request is invalid.");
      }
      if (declared !== null && declared > maxBodyBytes) {
        release();
        return problem(413, "REQUEST_TOO_LARGE", `Request exceeds ${maxBodyBytes} bytes.`);
      }

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Deployment runtime request timed out.")),
        timeoutMs,
      );
      try {
        let body: Uint8Array | undefined;
        if (request.body && !["GET", "HEAD"].includes(request.method)) {
          body = await readBoundedBody(
            request.body,
            maxBodyBytes,
            AbortSignal.any([controller.signal, request.signal]),
          );
        }
        const target = new URL(binding.upstream);
        const suffix = url.pathname.slice(binding.path.length);
        target.pathname = suffix || "/";
        target.search = url.search;
        const headers = runtimeRequestHeaders(request.headers);
        const response = await fetcher(target, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.any([controller.signal, request.signal]),
        });
        const output = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: runtimeResponseHeaders(response.headers),
        });
        if (!output.body) {
          release();
          return output;
        }
        const reader = output.body.getReader();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const part = await reader.read();
              if (part.done) {
                release();
                stream.close();
              } else {
                stream.enqueue(part.value);
              }
            } catch (error) {
              release();
              stream.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        }), {
          status: output.status,
          statusText: output.statusText,
          headers: output.headers,
        });
      } catch (error) {
        release();
        if (error instanceof RuntimeIngressRequestError) {
          return problem(error.status, error.code, error.message);
        }
        report(error);
        return problem(
          controller.signal.aborted ? 504 : 502,
          controller.signal.aborted ? "RUNTIME_TIMEOUT" : "RUNTIME_UPSTREAM_FAILED",
          controller.signal.aborted
            ? "Runtime request timed out."
            : "Runtime upstream could not be reached.",
        );
      } finally {
        clearTimeout(timer);
      }
    },

    async drain(projectIdInput, generationInput, timeout = 2_000) {
      const projectId = identifier(projectIdInput, "projectId");
      const generation = positiveInteger(generationInput, "generation");
      const key = bindingKey(projectId, generation);
      const binding = published.get(key) ?? draining.get(key);
      if (!binding) return true;
      return waitForBinding(binding, timeout);
    },

    async deactivate(projectIdInput, generationInput, timeout = 2_000) {
      const projectId = identifier(projectIdInput, "projectId");
      const generation = positiveInteger(generationInput, "generation");
      const key = bindingKey(projectId, generation);
      const binding = published.get(key);
      if (!binding) {
        const existingDrain = draining.get(key);
        if (existingDrain) {
          return Object.freeze({
            removed: false,
            drained: await waitForBinding(existingDrain, timeout),
          });
        }
        return Object.freeze({ removed: false, drained: true });
      }
      published.delete(key);
      const route = routes.get(binding.path);
      route?.delete(key);
      if (route?.size === 0) routes.delete(binding.path);
      retire(binding);
      return Object.freeze({
        removed: true,
        drained: await waitForBinding(binding, timeout),
      });
    },

    forget(projectIdInput, generationInput) {
      const projectId = identifier(projectIdInput, "projectId");
      const generation = positiveInteger(generationInput, "generation");
      if (
        [...published.values(), ...draining.values()]
          .some((binding) => binding.projectId === projectId)
      ) {
        throw new Error("Deployment runtime ingress project still has a live generation.");
      }
      const latest = latestByProject.get(projectId);
      if (!latest || latest.generation !== generation) return false;
      latestByProject.delete(projectId);
      return true;
    },

    async close(timeout = 2_000) {
      if (!closed) {
        closed = true;
        for (const binding of published.values()) retire(binding);
        published.clear();
        routes.clear();
        latestByProject.clear();
      }
      const results = await Promise.all(
        [...draining.values()].map((binding) => waitForBinding(binding, timeout)),
      );
      return results.every(Boolean);
    },
  };
  const inactive = (projectId: string, binding?: RuntimeBinding) => {
    if (closed) throw new Error("Deployment runtime ingress is closed.");
    if ([...published.values(), ...draining.values()].some(value => value.projectId === projectId)
      || [...routes.values()].some(group => [...group.values()].some(value => value.projectId === projectId))
      || binding && (latestByProject.get(projectId) !== binding || binding.leases.size !== 0 || binding.waiters.size !== 0)) throw new Error("Fallback ingress is not its exact fully drained generation.");
  };
  fallbackIngresses.set(runtimeIngress, {
    async capture(authority) {
      authority.check();
      const request = authority.request, runtime = request.runtime, projectId = request.operation.projectId, latest = latestByProject.get(projectId);
      if (authority.ingress !== runtimeIngress || !runtime || request.desired.state !== "running") throw new Error("Fallback stopped ingress request differs.");
      inactive(projectId, latest);
      if (!latest) return undefined;
      if (latest.generation !== request.desired.generation || latest.releaseId !== request.desired.releaseId) throw new Error("Fallback stopped ingress generation changed.");
      const expected = await normalizeBinding({ protocol: "clank-runtime/1", projectId, releaseId: request.desired.releaseId, generation: request.desired.generation,
        path: runtime.manifest.ingress.route, token: runtime.manifest.ingress.token, upstream: latest.upstream });
      authority.check(); inactive(projectId, latest);
      if (!sameBinding(latest, expected)) throw new Error("Fallback stopped ingress differs from its original capsule.");
      const receipt = Object.freeze({});
      fallbackTombstones.set(receipt, { ingress: runtimeIngress, binding: latest, request, consumed: false });
      return receipt;
    },
    async captureSource(authority) {
      authority.check(); const source = authority.identity, latest = latestByProject.get(source.projectId);
      if (authority.ingress !== runtimeIngress) throw new Error("Fallback stopped source ingress differs.");
      inactive(source.projectId, latest); if (!latest) return undefined;
      if (latest.generation !== source.generation || latest.releaseId !== source.releaseId) throw new Error("Fallback stopped source ingress generation changed.");
      const expected = await normalizeBinding({ protocol: "clank-runtime/1", projectId: source.projectId, releaseId: source.releaseId, generation: source.generation, path: source.route, token: source.token, upstream: latest.upstream });
      authority.check(); inactive(source.projectId, latest);
      if (!sameBinding(latest, expected)) throw new Error("Fallback stopped source ingress differs from its approved capsule.");
      const receipt = Object.freeze({}); fallbackTombstones.set(receipt, { ingress: runtimeIngress, binding: latest, source, consumed: false }); return receipt;
    },
    async reactivate(authority) {
      authority.check();
      const receipt = fallbackTombstones.get(authority.tombstone), request = authority.request, runtime = request.runtime;
      if (!receipt || receipt.ingress !== runtimeIngress || authority.ingress !== runtimeIngress || receipt.consumed || !runtime || request.desired.state !== "running") throw new Error("Fallback reactivation lacks its exact newer original operation and stopped receipt.");
      if (receipt.source) {
        const source = receipt.source;
        if (request.operation.projectId !== source.projectId || request.operation.id === source.operationId || request.operation.fence <= source.minimumFence
          || request.desired.generation !== source.generation || request.desired.releaseId !== source.releaseId || runtime.sha256 !== source.capsuleSha256) throw new Error("Fallback source reactivation lacks its exact newer original operation and stopped receipt.");
      } else if (!receipt.request?.runtime || request.operation.projectId !== receipt.request.operation.projectId
        || request.operation.id === receipt.request.operation.id || request.operation.fence <= receipt.request.operation.fence
        || request.desired.generation !== receipt.request.desired.generation || request.desired.releaseId !== receipt.request.desired.releaseId
        || runtime.sha256 !== receipt.request.runtime.sha256) throw new Error("Fallback reactivation lacks its exact newer original operation and stopped receipt.");
      const previous = receipt.binding, projectId = request.operation.projectId;
      inactive(projectId, previous);
      const binding = await normalizeBinding(authority.binding);
      const exact = () => {
        authority.check(); inactive(projectId, previous);
        if (receipt.consumed || fallbackTombstones.get(authority.tombstone) !== receipt
          || binding.projectId !== projectId || binding.generation !== request.desired.generation || binding.releaseId !== request.desired.releaseId
          || binding.path !== runtime.manifest.ingress.route || binding.path !== previous.path || !equalBytes(binding.tokenDigest, previous.tokenDigest)) throw new Error("Fallback reactivation changed its original generation or route.");
        const route = routes.get(binding.path);
        if (route && [...route.values()].some(value => value.projectId !== projectId)) throw new Error("Deployment runtime ingress path is already assigned.");
        if (published.size + draining.size + 1 > maxBindings) throw new Error("Deployment runtime ingress binding limit reached.");
      };
      exact(); await authority.verifyRunning(); exact();
      // All awaited native/lease checks precede this synchronous replacement.
      // Retain the high-water mark throughout so delayed generic activation can
      // neither publish the old upstream nor acquire an empty tombstone window.
      const key = bindingKey(projectId, binding.generation), group = routes.get(binding.path) ?? new Map<string, RuntimeBinding>();
      published.set(key, binding); group.set(key, binding); routes.set(binding.path, group); latestByProject.set(projectId, binding); receipt.consumed = true;
      return publicState(binding, latestByProject);
    },
  });
  return Object.freeze(runtimeIngress);
}

class RuntimeIngressRequestError extends Error {
  declare readonly status: number;
  declare readonly code: string;
  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.status = status; this.code = code;
  }
}

async function normalizeBinding(input: unknown): Promise<RuntimeBinding> {
  const value = exactObject(input, [
    "protocol",
    "projectId",
    "releaseId",
    "generation",
    "path",
    "token",
    "upstream",
  ]);
  if (value.protocol !== "clank-runtime/1") {
    throw new TypeError("Deployment runtime ingress protocol is unsupported.");
  }
  const token = ingressToken(value.token);
  return {
    protocol: "clank-runtime/1",
    projectId: identifier(value.projectId, "projectId"),
    releaseId: identifier(value.releaseId, "releaseId"),
    generation: positiveInteger(value.generation, "generation"),
    path: ingressPath(value.path),
    tokenDigest: await digest(new TextEncoder().encode(token)),
    upstream: loopbackOrigin(value.upstream),
    activatedAt: Date.now(),
    leases: new Set(),
    waiters: new Set(),
  };
}

function publicState(
  binding: RuntimeBinding,
  latest: Map<string, RuntimeBinding>,
): DeploymentRuntimeIngressState {
  return Object.freeze({
    protocol: DEPLOYMENT_RUNTIME_INGRESS_PROTOCOL,
    projectId: binding.projectId,
    releaseId: binding.releaseId,
    generation: binding.generation,
    path: binding.path,
    activatedAt: binding.activatedAt,
    inFlight: binding.leases.size,
    latest: latest.get(binding.projectId)?.generation === binding.generation,
  });
}

function sameBinding(left: RuntimeBinding, right: RuntimeBinding): boolean {
  return left.releaseId === right.releaseId
    && left.path === right.path
    && left.upstream === right.upstream
    && equalBytes(left.tokenDigest, right.tokenDigest);
}

function findBinding(
  routes: Map<string, Map<string, RuntimeBinding>>,
  pathname: string,
  headers: Headers,
): RuntimeBinding | undefined {
  const projectId = headers.get("x-clank-project-id");
  const generation = headers.get("x-clank-runtime-generation");
  if (
    !projectId
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(projectId)
    || !generation
    || !/^[1-9][0-9]{0,15}$/u.test(generation)
  ) return undefined;
  const number = Number(generation);
  if (!Number.isSafeInteger(number)) return undefined;
  const key = bindingKey(projectId, number);
  let end = pathname.length;
  while (end > 0) {
    const candidate = pathname.slice(0, end);
    const binding = routes.get(candidate)?.get(key);
    if (binding) return binding;
    end = pathname.lastIndexOf("/", end - 1);
  }
  return undefined;
}

async function authorized(headers: Headers, binding: RuntimeBinding): Promise<boolean> {
  if (
    headers.get("x-clank-project-id") !== binding.projectId
    || headers.get("x-clank-runtime-protocol") !== binding.protocol
    || headers.get("x-clank-runtime-generation") !== String(binding.generation)
  ) return false;
  const supplied = headers.get("x-clank-runtime-ingress");
  if (!validIngressToken(supplied)) return false;
  return equalBytes(
    await digest(new TextEncoder().encode(supplied)),
    binding.tokenDigest,
  );
}

function runtimeRequestHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  stripHopHeaders(headers);
  headers.delete("host");
  headers.delete("content-length");
  for (const name of BINDING_HEADERS) headers.delete(name);
  return headers;
}

function runtimeResponseHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  stripHopHeaders(headers);
  headers.delete("server");
  for (const name of BINDING_HEADERS) headers.delete(name);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function stripHopHeaders(headers: Headers): void {
  const nominated = headers.get("connection")
    ?.split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => /^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name))
    ?? [];
  for (const name of [...HOP_HEADERS, ...nominated]) headers.delete(name);
}

const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

async function readBoundedBody(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const aborted = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Runtime request aborted.");
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel("runtime request body limit exceeded").catch(() => undefined);
        throw new RuntimeIngressRequestError(
          413,
          "REQUEST_TOO_LARGE",
          `Request exceeds ${maximum} bytes.`,
        );
      }
      chunks.push(part.value);
    }
    if (signal.aborted) throw signal.reason ?? new Error("Runtime request aborted.");
  } finally {
    signal.removeEventListener("abort", aborted);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function contentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new RuntimeIngressRequestError(400, "INVALID_REQUEST", "content-length is invalid.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RuntimeIngressRequestError(400, "INVALID_REQUEST", "content-length is invalid.");
  }
  return number;
}

function ingressPath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > 512
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("?")
    || value.includes("#")
    || value.includes("\0")
    || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/u.test(value)
    || value.split("/").some((segment, index) =>
      index > 0 && (!segment || segment === "." || segment === ".."))
  ) throw new TypeError("Deployment runtime ingress path is invalid.");
  return value;
}

function ingressToken(value: unknown): string {
  if (!validIngressToken(value)) {
    throw new TypeError("Deployment runtime ingress token is invalid.");
  }
  return value;
}

function validIngressToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 512
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Deployment runtime upstream must be a loopback HTTP origin.");
  }
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
  ) throw new TypeError("Deployment runtime upstream must be a loopback HTTP origin.");
  return url.origin;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new TypeError(`Deployment runtime ${name} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`Deployment runtime ${name} is invalid.`);
  }
  return Number(value);
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Deployment runtime ingress binding must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Deployment runtime ingress binding must be a plain object.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) {
    throw new TypeError("Deployment runtime ingress binding contains an unknown field.");
  }
  if (fields.some((key) => !(key in input))) {
    throw new TypeError("Deployment runtime ingress binding is missing a required field.");
  }
  return input;
}

function bindingKey(projectId: string, generation: number): string {
  return `${projectId}\n${generation}`;
}

function pruneRetired(bindings: Map<string, RuntimeBinding>): void {
  for (const [key, binding] of bindings) {
    if (binding.leases.size === 0) bindings.delete(key);
  }
}

async function digest(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function runtimeUnavailable(): Response {
  return problem(503, "RUNTIME_UNAVAILABLE", "Application runtime is temporarily unavailable.");
}
