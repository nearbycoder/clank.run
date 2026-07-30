import {
  decodeDeploymentBundle,
  deploymentDigest,
  type DeploymentBundle,
} from "./deploy.ts";
import type {
  ClaimedDeploymentOperation,
  DeploymentNodeInput,
} from "./orchestration.ts";
import {
  openDeploymentAgent,
  type DeploymentAgentOptions,
  type DeploymentAgentRuntime,
  type DeploymentArtifact,
  type DeploymentExecutionContext,
  type DeploymentRuntimeArtifact,
} from "./runner.ts";
import {
  decodeDeploymentRuntimeCapsule,
  DEPLOYMENT_RUNTIME_MEDIA_TYPE,
  DEPLOYMENT_RUNTIME_PROTOCOL,
  deploymentRuntimeDigest,
  type DeploymentRuntimeCapsule,
} from "./runtime-placement.ts";

export const DEPLOYMENT_PROVIDER_RECONCILE_PATH = "/v1/clank/reconcile";
export const DEPLOYMENT_PROVIDER_ROLLBACK_PATH = "/v1/clank/rollback";
export const DEPLOYMENT_PROVIDER_DELETE_PATH = "/v1/clank/delete";

export interface DeploymentProviderOperation {
  readonly id: string;
  readonly projectId: string;
  readonly fence: number;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface DeploymentProviderDesiredState {
  readonly generation: number;
  readonly releaseId: string | null;
  readonly state: "running" | "stopped";
  /** Selects the sensitive runtime capsule wire contract for a running release. */
  readonly runtimeProtocol?: typeof DEPLOYMENT_RUNTIME_PROTOCOL | null;
}

export interface DeploymentProviderArtifact {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly bundle: DeploymentBundle;
}

export interface DeploymentProviderRequest {
  /** Lease credentials and node credentials are deliberately excluded. */
  readonly operation: DeploymentProviderOperation;
  readonly desired: DeploymentProviderDesiredState;
  /** Present only while reconciling a running release. */
  readonly artifact: DeploymentProviderArtifact | null;
  /** Present when the desired state selects the runtime capsule protocol. */
  readonly runtime?: DeploymentRuntimeCapsule | null;
  readonly signal: AbortSignal;
}

export interface DeploymentProviderLifecycleRequest {
  readonly operation: DeploymentProviderOperation;
  /** Exact current provider-data generation being changed. */
  readonly generation: number;
  /** Derived confirmation; never accepted from an operation payload. */
  readonly confirmation: string;
  readonly signal: AbortSignal;
}

/**
 * The portable infrastructure boundary. A provider must converge the project
 * to the requested generation and make repeated operation/fence pairs safe.
 */
export interface DeploymentProvider {
  /** Stable, non-secret adapter name used in bounded operation results. */
  readonly kind: string;
  reconcile(request: DeploymentProviderRequest): Promise<void>;
  /** Optional fenced destructive lifecycle capability. */
  rollback?(request: DeploymentProviderLifecycleRequest): Promise<unknown>;
  /** Optional fenced destructive lifecycle capability. */
  delete?(request: DeploymentProviderLifecycleRequest): Promise<unknown>;
}

export interface ProviderDeploymentAgentOptions
  extends Omit<DeploymentAgentOptions, "execute" | "node"> {
  node: DeploymentNodeInput;
  provider: DeploymentProvider;
}

export interface HttpDeploymentProviderOptions {
  /** Provider service origin. HTTPS is required outside loopback. */
  baseUrl: string;
  /** Separate high-entropy bearer token for the provider service. */
  token: string;
  fetch?: typeof fetch;
  /** Per-attempt deadline. Defaults to 60 seconds. */
  timeoutMs?: number;
  /** Retries exact idempotent reconciliation after network/429/5xx failures. Defaults to 2. */
  retries?: number;
  /** Maximum response bytes discarded on failure. Defaults to 16 KiB. */
  maxResponseBytes?: number;
}

export interface DeploymentProviderHandlerOptions {
  /** Separate high-entropy bearer token accepted only by this provider bridge. */
  token: string;
  /** Maximum compressed deployment artifact. Defaults to 100 MiB. */
  maxArtifactBytes?: number;
  /** Maximum sensitive runtime capsule. Defaults to 768 MiB. */
  maxRuntimeBytes?: number;
  /** Receives private adapter failures. */
  onError?: (error: unknown) => void;
}

export interface DeploymentProviderHandler {
  readonly path: typeof DEPLOYMENT_PROVIDER_RECONCILE_PATH;
  readonly paths: readonly [
    typeof DEPLOYMENT_PROVIDER_RECONCILE_PATH,
    typeof DEPLOYMENT_PROVIDER_ROLLBACK_PATH,
    typeof DEPLOYMENT_PROVIDER_DELETE_PATH,
  ];
  handle(request: Request): Promise<Response>;
}

export class DeploymentProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeploymentProviderError";
  }
}

/**
 * Runs the standard node lifecycle and gives the selected provider only a
 * verified, credential-free desired-state request.
 */
export async function openProviderDeploymentAgent(
  options: ProviderDeploymentAgentOptions,
): Promise<DeploymentAgentRuntime> {
  const kind = providerKind(options.provider.kind);
  return openDeploymentAgent({
    ...options,
    node: Object.freeze({
      ...options.node,
      labels: Object.freeze({
        ...options.node.labels,
        provider: kind,
      }),
    }),
    async execute(operation, context) {
      return executeDeploymentProvider(options.provider, operation, context);
    },
  });
}

/**
 * Dispatches canonical reconcile and destructive lifecycle operations without
 * passing node credentials, operation lease tokens, or caller confirmations.
 */
export async function executeDeploymentProvider(
  provider: DeploymentProvider,
  operation: ClaimedDeploymentOperation,
  context: DeploymentExecutionContext,
): Promise<
  | {
      provider: string;
      generation: number;
      releaseId: string | null;
      state: "running" | "stopped";
    }
  | {
      provider: string;
      action: "rollback" | "delete";
      generation: number;
    }
> {
  if (operation.action === "reconcile") {
    return reconcileDeploymentProvider(provider, operation, context);
  }
  if (operation.action !== "rollback" && operation.action !== "delete") {
    throw new TypeError("Portable deployment providers accept only reconcile, rollback, or delete operations.");
  }
  const action = operation.action;
  const execute = provider[action];
  if (typeof execute !== "function") {
    throw new TypeError(`Deployment provider does not support ${action}.`);
  }
  const payload = lifecycleState(operation.payload, action);
  const requestOperation = providerOperation(operation, context);
  const confirmation = action === "rollback"
    ? `rollback ${requestOperation.projectId} ${payload.generation}`
    : `delete ${requestOperation.projectId}`;
  throwIfAborted(context.signal);
  await execute.call(provider, Object.freeze({
    operation: requestOperation,
    generation: payload.generation,
    confirmation,
    signal: context.signal,
  }));
  throwIfAborted(context.signal);
  return Object.freeze({
    provider: providerKind(provider.kind),
    action,
    generation: payload.generation,
  });
}

/**
 * Validates one canonical reconcile operation. This is exported so custom
 * agent loops can use the same contract without reimplementing its checks.
 */
export async function reconcileDeploymentProvider(
  provider: DeploymentProvider,
  operation: ClaimedDeploymentOperation,
  context: DeploymentExecutionContext,
): Promise<{
  provider: string;
  generation: number;
  releaseId: string | null;
  state: "running" | "stopped";
}> {
  const kind = providerKind(provider.kind);
  if (operation.action !== "reconcile") {
    throw new TypeError("Portable deployment providers accept only reconcile operations.");
  }
  const desired = desiredState(operation.payload);
  const requestOperation = providerOperation(operation, context);
  let artifact: DeploymentProviderArtifact | null = null;
  let runtime: DeploymentRuntimeCapsule | null = null;
  if (desired.state === "running") {
    if (desired.runtimeProtocol === DEPLOYMENT_RUNTIME_PROTOCOL) {
      runtime = await verifiedRuntime(await context.runtime());
      assertRuntimeBindings(runtime, requestOperation, desired);
      artifact = runtime.artifact;
    } else {
      const downloaded = await context.artifact();
      artifact = await verifiedArtifact(downloaded);
    }
  }
  throwIfAborted(context.signal);
  await provider.reconcile(Object.freeze({
    operation: requestOperation,
    desired,
    artifact,
    runtime,
    signal: context.signal,
  }));
  throwIfAborted(context.signal);
  const accepted = await context.observe({
    generation: desired.generation,
    releaseId: desired.releaseId,
    state: desired.state,
  });
  if (!accepted) {
    throw new Error("Deployment provider observation was rejected as stale.");
  }
  return Object.freeze({
    provider: kind,
    generation: desired.generation,
    releaseId: desired.releaseId,
    state: desired.state,
  });
}

/**
 * Adapts the portable provider contract to a bounded, redirect-safe HTTP
 * service. Legacy requests retain their original deployment artifact body;
 * runtime requests carry the exact integrity-checked capsule without re-encoding.
 */
export function createHttpDeploymentProvider(
  options: HttpDeploymentProviderOptions,
): DeploymentProvider {
  const endpoints = Object.freeze({
    reconcile: providerEndpoint(options.baseUrl, DEPLOYMENT_PROVIDER_RECONCILE_PATH),
    rollback: providerEndpoint(options.baseUrl, DEPLOYMENT_PROVIDER_ROLLBACK_PATH),
    delete: providerEndpoint(options.baseUrl, DEPLOYMENT_PROVIDER_DELETE_PATH),
  });
  const token = highEntropyToken(options.token, "token");
  const request = options.fetch ?? fetch;
  const timeoutMs = integer(options.timeoutMs ?? 60_000, "timeoutMs", 100, 10 * 60_000);
  const retries = integer(options.retries ?? 2, "retries", 0, 10);
  const maxResponseBytes = integer(
    options.maxResponseBytes ?? 16 * 1024,
    "maxResponseBytes",
    0,
    1024 * 1024,
  );

  const send = async (
    action: "reconcile" | "rollback" | "delete",
    headers: Headers,
    body: BodyInit | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      throwIfAborted(signal);
      const controller = new AbortController();
      const aborted = () => controller.abort(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error("Deployment provider request timed out.")),
        timeoutMs,
      );
      try {
        const response = await request(endpoints[action], {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 204) {
          await discardResponse(response, maxResponseBytes);
          return;
        }
        await discardResponse(response, maxResponseBytes);
        if (attempt < retries && retryableStatus(response.status)) {
          await retryDelay(attempt, signal);
          continue;
        }
        throw new DeploymentProviderError(
          response.status >= 400 && response.status <= 599 ? response.status : 502,
          "PROVIDER_REJECTED",
          `Deployment provider rejected ${action}.`,
        );
      } catch (error) {
        if (error instanceof DeploymentProviderError) throw error;
        if (signal.aborted) throw signal.reason ?? error;
        if (attempt < retries) {
          await retryDelay(attempt, signal);
          continue;
        }
        if (controller.signal.aborted) {
          throw new DeploymentProviderError(
            504,
            "PROVIDER_TIMEOUT",
            `Deployment provider ${action} timed out.`,
          );
        }
        throw new DeploymentProviderError(
          502,
          "PROVIDER_UNAVAILABLE",
          "Deployment provider is unavailable.",
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
      }
    }
    throw new DeploymentProviderError(
      502,
      "PROVIDER_UNAVAILABLE",
      "Deployment provider is unavailable.",
    );
  };

  const provider: DeploymentProvider = {
    kind: "http",
    async reconcile(input: DeploymentProviderRequest) {
      const normalized = await providerRequest(input);
      const headers = providerHeaders(normalized, token);
      const body = normalized.runtime
        ? requestBody(normalized.runtime.bytes)
        : normalized.artifact
          ? requestBody(normalized.artifact.bytes)
          : undefined;
      await send("reconcile", headers, body, normalized.signal);
    },
    async rollback(input) {
      const normalized = providerLifecycleRequest(input, "rollback");
      await send(
        "rollback",
        providerLifecycleHeaders(normalized, token),
        undefined,
        normalized.signal,
      );
    },
    async delete(input) {
      const normalized = providerLifecycleRequest(input, "delete");
      await send(
        "delete",
        providerLifecycleHeaders(normalized, token),
        undefined,
        normalized.signal,
      );
    },
  };
  return Object.freeze(provider);
}

/**
 * Exposes a local provider implementation through the same exact wire
 * contract used by createHttpDeploymentProvider().
 */
export function createDeploymentProviderHandler(
  provider: DeploymentProvider,
  options: DeploymentProviderHandlerOptions,
): DeploymentProviderHandler {
  providerKind(provider.kind);
  const token = highEntropyToken(options.token, "token");
  const maxArtifactBytes = integer(
    options.maxArtifactBytes ?? 100 * 1024 * 1024,
    "maxArtifactBytes",
    1_024,
    1024 * 1024 * 1024,
  );
  const maxRuntimeBytes = integer(
    options.maxRuntimeBytes ?? 768 * 1024 * 1024,
    "maxRuntimeBytes",
    1_024,
    2 * 1024 * 1024 * 1024,
  );
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics are isolated from the provider protocol.
    }
  };

  const paths = Object.freeze([
    DEPLOYMENT_PROVIDER_RECONCILE_PATH,
    DEPLOYMENT_PROVIDER_ROLLBACK_PATH,
    DEPLOYMENT_PROVIDER_DELETE_PATH,
  ] as const);
  const handler: DeploymentProviderHandler = {
    path: DEPLOYMENT_PROVIDER_RECONCILE_PATH,
    paths,
    async handle(request: Request) {
      const url = new URL(request.url);
      if (!paths.some((path) => url.pathname === path)) {
        return providerProblem(404, "NOT_FOUND", "Deployment provider endpoint not found.");
      }
      if (request.method !== "POST") {
        return providerProblem(
          405,
          "METHOD_NOT_ALLOWED",
          "Deployment provider requests must use POST.",
          { allow: "POST" },
        );
      }
      try {
        const supplied = bearerToken(request);
        if (!await tokensEqual(supplied, token)) {
          throw new ProviderRequestError(401, "AUTH_DENIED", "Deployment provider authentication failed.");
        }
        if (url.pathname !== DEPLOYMENT_PROVIDER_RECONCILE_PATH) {
          const action = url.pathname === DEPLOYMENT_PROVIDER_ROLLBACK_PATH
            ? "rollback"
            : "delete";
          const execute = provider[action];
          if (typeof execute !== "function") {
            throw new ProviderRequestError(
              501,
              "ACTION_UNSUPPORTED",
              `Deployment provider does not support ${action}.`,
            );
          }
          const lifecycle = providerLifecycleRequestHeaders(
            request.headers,
            request.signal,
            action,
          );
          if (
            request.headers.has("content-type")
            || request.headers.has("x-clank-content-sha256")
            || request.headers.has("x-clank-desired-state")
            || request.headers.has("x-clank-release-id")
            || request.headers.has("x-clank-runtime-protocol")
          ) {
            throw new ProviderRequestError(
              400,
              "UNEXPECTED_BODY",
              `Deployment provider ${action} cannot include release content.`,
            );
          }
          const length = contentLength(request.headers);
          if (length !== null && length !== 0) {
            throw new ProviderRequestError(
              400,
              "UNEXPECTED_BODY",
              `Deployment provider ${action} cannot include a request body.`,
            );
          }
          await requireEmptyBody(request.body, action);
          throwIfAborted(request.signal);
          try {
            await execute.call(provider, lifecycle);
          } catch (error) {
            if (request.signal.aborted) throw error;
            report(error);
            throw new ProviderRequestError(
              500,
              "PROVIDER_FAILED",
              `Deployment provider ${action} failed.`,
            );
          }
          throwIfAborted(request.signal);
          return new Response(null, {
            status: 204,
            headers: providerHeadersBase(),
          });
        }
        const parsed = providerRequestHeaders(request.headers);
        const desired = parsed.desired;
        const operation = parsed.operation;
        const length = contentLength(request.headers);
        const bodyLimit = desired.runtimeProtocol === DEPLOYMENT_RUNTIME_PROTOCOL
          ? maxRuntimeBytes
          : maxArtifactBytes;
        if (length !== null && length > bodyLimit) {
          throw new ProviderRequestError(
            413,
            desired.runtimeProtocol ? "RUNTIME_TOO_LARGE" : "ARTIFACT_TOO_LARGE",
            desired.runtimeProtocol
              ? "Deployment runtime capsule is too large."
              : "Deployment artifact is too large.",
          );
        }
        let artifact: DeploymentProviderArtifact | null = null;
        let runtime: DeploymentRuntimeCapsule | null = null;
        if (desired.state === "running") {
          const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
          const expectedContentType = desired.runtimeProtocol
            ? DEPLOYMENT_RUNTIME_MEDIA_TYPE
            : "application/vnd.clank.deploy+gzip";
          if (contentType !== expectedContentType) {
            throw new ProviderRequestError(
              415,
              "UNSUPPORTED_MEDIA_TYPE",
              desired.runtimeProtocol
                ? "Running reconciliation requires a Clank runtime capsule."
                : "Running reconciliation requires a Clank deployment artifact.",
            );
          }
          const bytes = await readBytes(
            request.body,
            bodyLimit,
            desired.runtimeProtocol ? "runtime" : "artifact",
          );
          if (bytes.byteLength === 0) {
            throw new ProviderRequestError(
              400,
              desired.runtimeProtocol ? "RUNTIME_REQUIRED" : "ARTIFACT_REQUIRED",
              desired.runtimeProtocol
                ? "Deployment runtime capsule is required."
                : "Deployment artifact is required.",
            );
          }
          const expected = contentDigestHeader(
            request.headers,
            desired.runtimeProtocol ? "RUNTIME_INVALID" : "ARTIFACT_INVALID",
          );
          const digest = desired.runtimeProtocol
            ? await deploymentRuntimeDigest(bytes)
            : await deploymentDigest(bytes);
          if (digest !== expected) {
            throw new ProviderRequestError(
              400,
              desired.runtimeProtocol ? "RUNTIME_INVALID" : "ARTIFACT_INVALID",
              desired.runtimeProtocol
                ? "Deployment runtime capsule failed verification."
                : "Deployment artifact failed verification.",
            );
          }
          if (desired.runtimeProtocol) {
            try {
              runtime = await decodeDeploymentRuntimeCapsule(bytes, {
                maxArtifactBytes,
                maxCapsuleBytes: maxRuntimeBytes,
              });
              assertRuntimeBindings(runtime, operation, desired);
            } catch {
              throw new ProviderRequestError(
                400,
                "RUNTIME_INVALID",
                "Deployment runtime capsule failed verification.",
              );
            }
            artifact = runtime.artifact;
          } else {
            let bundle: DeploymentBundle;
            try {
              bundle = await decodeDeploymentBundle(bytes, { maxTotalBytes: maxArtifactBytes });
            } catch {
              throw new ProviderRequestError(400, "ARTIFACT_INVALID", "Deployment artifact failed verification.");
            }
            artifact = Object.freeze({ bytes, sha256: digest, bundle });
          }
        } else {
          if (length !== null && length !== 0) {
            throw new ProviderRequestError(400, "UNEXPECTED_ARTIFACT", "Stopped reconciliation cannot include an artifact.");
          }
          const bytes = await readBytes(request.body, 1);
          if (bytes.byteLength !== 0) {
            throw new ProviderRequestError(400, "UNEXPECTED_ARTIFACT", "Stopped reconciliation cannot include an artifact.");
          }
          if (request.headers.has("x-clank-content-sha256")) {
            throw new ProviderRequestError(400, "UNEXPECTED_ARTIFACT", "Stopped reconciliation cannot include an artifact.");
          }
          if (request.headers.has("x-clank-runtime-protocol")) {
            throw new ProviderRequestError(400, "UNEXPECTED_ARTIFACT", "Stopped reconciliation cannot include a runtime capsule.");
          }
        }
        throwIfAborted(request.signal);
        try {
          await provider.reconcile(Object.freeze({
            operation,
            desired,
            artifact,
            runtime,
            signal: request.signal,
          }));
        } catch (error) {
          if (request.signal.aborted) throw error;
          report(error);
          throw new ProviderRequestError(500, "PROVIDER_FAILED", "Deployment provider reconciliation failed.");
        }
        throwIfAborted(request.signal);
        return new Response(null, {
          status: 204,
          headers: providerHeadersBase(),
        });
      } catch (error) {
        if (error instanceof ProviderRequestError) {
          return providerProblem(error.status, error.code, error.message);
        }
        report(error);
        return providerProblem(500, "INTERNAL_ERROR", "Deployment provider reconciliation failed.");
      }
    },
  };
  return Object.freeze(handler);
}

async function verifiedArtifact(input: DeploymentArtifact): Promise<DeploymentProviderArtifact> {
  if (!(input.bytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new TypeError("Deployment artifact is invalid.");
  }
  const bytes = new Uint8Array(input.bytes);
  const digest = await deploymentDigest(bytes);
  if (digest !== input.sha256) throw new Error("Deployment artifact failed digest verification.");
  return Object.freeze({
    bytes,
    sha256: digest,
    bundle: await decodeDeploymentBundle(bytes),
  });
}

async function verifiedRuntime(
  input: DeploymentRuntimeArtifact | DeploymentRuntimeCapsule,
): Promise<DeploymentRuntimeCapsule> {
  if (!(input.bytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new TypeError("Deployment runtime capsule is invalid.");
  }
  const bytes = new Uint8Array(input.bytes);
  if (await deploymentRuntimeDigest(bytes) !== input.sha256) {
    throw new Error("Deployment runtime capsule failed digest verification.");
  }
  return decodeDeploymentRuntimeCapsule(bytes);
}

function assertRuntimeBindings(
  runtime: DeploymentRuntimeCapsule,
  operation: DeploymentProviderOperation,
  desired: DeploymentProviderDesiredState,
): void {
  if (
    runtime.manifest.protocol !== desired.runtimeProtocol
    || runtime.manifest.projectId !== operation.projectId
    || runtime.manifest.releaseId !== desired.releaseId
    || runtime.manifest.generation !== desired.generation
  ) {
    throw new TypeError("Deployment runtime capsule does not match the desired placement.");
  }
}

function providerOperation(
  operation: ClaimedDeploymentOperation,
  context: DeploymentExecutionContext,
): DeploymentProviderOperation {
  if (
    context.operation.id !== operation.id
    || context.operation.projectId !== operation.projectId
    || context.operation.action !== operation.action
  ) {
    throw new TypeError("Deployment execution context does not match its operation.");
  }
  return Object.freeze({
    id: safeIdentifier(operation.id, "operation ID"),
    projectId: safeIdentifier(operation.projectId, "project ID"),
    fence: positiveInteger(context.operation.fence, "operation fence"),
    attempt: positiveInteger(context.operation.attempts, "operation attempt"),
    maxAttempts: positiveInteger(context.operation.maxAttempts, "operation maxAttempts"),
  });
}

function lifecycleState(
  value: unknown,
  action: "rollback" | "delete",
): Readonly<{ generation: number }> {
  const input = plainObject(value, `${action} payload`);
  exact(input, ["generation"]);
  return Object.freeze({
    generation: positiveInteger(input.generation, `${action} generation`),
  });
}

function desiredState(value: unknown): DeploymentProviderDesiredState {
  const input = plainObject(value, "reconcile payload");
  exact(
    input,
    "runtimeProtocol" in input
      ? ["releaseId", "state", "generation", "runtimeProtocol"]
      : ["releaseId", "state", "generation"],
  );
  const state = enumeration(input.state, "desired state", ["running", "stopped"] as const);
  const generation = positiveInteger(input.generation, "desired generation");
  const releaseId = input.releaseId === null
    ? null
    : safeIdentifier(input.releaseId, "release ID");
  const runtimeProtocol = input.runtimeProtocol === undefined || input.runtimeProtocol === null
    ? null
    : enumeration(
      input.runtimeProtocol,
      "runtime protocol",
      [DEPLOYMENT_RUNTIME_PROTOCOL] as const,
    );
  if (state === "running" && releaseId === null) {
    throw new TypeError("A running deployment requires a release ID.");
  }
  if (state === "stopped" && releaseId !== null) {
    throw new TypeError("A stopped deployment cannot select a release ID.");
  }
  if (state === "stopped" && runtimeProtocol !== null) {
    throw new TypeError("A stopped deployment cannot select a runtime protocol.");
  }
  return Object.freeze({ generation, releaseId, state, runtimeProtocol });
}

async function providerRequest(input: DeploymentProviderRequest): Promise<DeploymentProviderRequest> {
  const desired = desiredState(input.desired);
  const operation = Object.freeze({
    id: safeIdentifier(input.operation.id, "operation ID"),
    projectId: safeIdentifier(input.operation.projectId, "project ID"),
    fence: positiveInteger(input.operation.fence, "operation fence"),
    attempt: positiveInteger(input.operation.attempt, "operation attempt"),
    maxAttempts: positiveInteger(input.operation.maxAttempts, "operation maxAttempts"),
  });
  if (!(input.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
  let runtime: DeploymentRuntimeCapsule | null = null;
  let artifact: DeploymentProviderArtifact | null = null;
  if (desired.state === "running") {
    if (desired.runtimeProtocol === DEPLOYMENT_RUNTIME_PROTOCOL) {
      if (!input.runtime) {
        throw new TypeError("A runtime provider request requires a verified runtime capsule.");
      }
      runtime = await verifiedRuntime(input.runtime);
      assertRuntimeBindings(runtime, operation, desired);
      artifact = runtime.artifact;
      if (input.artifact && input.artifact.sha256 !== artifact.sha256) {
        throw new TypeError("Provider artifact does not match its runtime capsule.");
      }
    } else {
      if (input.runtime !== undefined && input.runtime !== null) {
        throw new TypeError("A legacy provider request cannot include a runtime capsule.");
      }
      if (!input.artifact) {
        throw new TypeError("A running provider request requires a verified artifact.");
      }
      artifact = await verifiedArtifact(input.artifact);
    }
  } else if (
    input.artifact !== null
    || (input.runtime !== undefined && input.runtime !== null)
  ) {
    throw new TypeError("A stopped provider request cannot include deployment content.");
  }
  return Object.freeze({
    operation,
    desired,
    artifact,
    runtime,
    signal: input.signal,
  });
}

function providerLifecycleRequest(
  input: DeploymentProviderLifecycleRequest,
  action: "rollback" | "delete",
): DeploymentProviderLifecycleRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`Provider ${action} request is required.`);
  }
  exact(input as unknown as Record<string, unknown>, [
    "operation",
    "generation",
    "confirmation",
    "signal",
  ]);
  const operationInput = plainObject(input.operation, `${action} operation`);
  exact(operationInput, ["id", "projectId", "fence", "attempt", "maxAttempts"]);
  const operation = Object.freeze({
    id: safeIdentifier(operationInput.id, "operation ID"),
    projectId: safeIdentifier(operationInput.projectId, "project ID"),
    fence: positiveInteger(operationInput.fence, "operation fence"),
    attempt: positiveInteger(operationInput.attempt, "operation attempt"),
    maxAttempts: positiveInteger(operationInput.maxAttempts, "operation maxAttempts"),
  });
  if (operation.attempt > operation.maxAttempts) {
    throw new TypeError(`Provider ${action} operation attempt exceeds maxAttempts.`);
  }
  const generation = positiveInteger(input.generation, `${action} generation`);
  const confirmation = typeof input.confirmation === "string"
    ? input.confirmation
    : "";
  const expected = action === "rollback"
    ? `rollback ${operation.projectId} ${generation}`
    : `delete ${operation.projectId}`;
  if (confirmation !== expected) {
    throw new TypeError(`confirmation must equal "${expected}".`);
  }
  if (!(input.signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal.");
  }
  return Object.freeze({
    operation,
    generation,
    confirmation,
    signal: input.signal,
  });
}

function providerHeaders(input: DeploymentProviderRequest, token: string): Headers {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "x-clank-operation-id": input.operation.id,
    "x-clank-operation-fence": String(input.operation.fence),
    "x-clank-operation-attempt": String(input.operation.attempt),
    "x-clank-operation-max-attempts": String(input.operation.maxAttempts),
    "x-clank-project-id": input.operation.projectId,
    "x-clank-generation": String(input.desired.generation),
    "x-clank-desired-state": input.desired.state,
  });
  if (input.artifact && input.desired.releaseId) {
    headers.set(
      "content-type",
      input.runtime ? DEPLOYMENT_RUNTIME_MEDIA_TYPE : "application/vnd.clank.deploy+gzip",
    );
    headers.set(
      "x-clank-content-sha256",
      input.runtime ? input.runtime.sha256 : input.artifact.sha256,
    );
    headers.set("x-clank-release-id", input.desired.releaseId);
    if (input.runtime) {
      headers.set("x-clank-runtime-protocol", DEPLOYMENT_RUNTIME_PROTOCOL);
    }
  }
  return headers;
}

function providerLifecycleHeaders(
  input: DeploymentProviderLifecycleRequest,
  token: string,
): Headers {
  return new Headers({
    authorization: `Bearer ${token}`,
    "x-clank-operation-id": input.operation.id,
    "x-clank-operation-fence": String(input.operation.fence),
    "x-clank-operation-attempt": String(input.operation.attempt),
    "x-clank-operation-max-attempts": String(input.operation.maxAttempts),
    "x-clank-project-id": input.operation.projectId,
    "x-clank-generation": String(input.generation),
  });
}

function desiredStateFromHeaders(headers: Headers): DeploymentProviderDesiredState {
  const state = enumeration(
    requiredHeader(headers, "x-clank-desired-state"),
    "desired state",
    ["running", "stopped"] as const,
  );
  const release = headers.get("x-clank-release-id");
  return desiredState({
    state,
    generation: headerInteger(headers, "x-clank-generation"),
    releaseId: release === null ? null : release,
    runtimeProtocol: headers.get("x-clank-runtime-protocol"),
  });
}

function operationFromHeaders(headers: Headers): DeploymentProviderOperation {
  return Object.freeze({
    id: safeIdentifier(requiredHeader(headers, "x-clank-operation-id"), "operation ID"),
    projectId: safeIdentifier(requiredHeader(headers, "x-clank-project-id"), "project ID"),
    fence: headerInteger(headers, "x-clank-operation-fence"),
    attempt: headerInteger(headers, "x-clank-operation-attempt"),
    maxAttempts: headerInteger(headers, "x-clank-operation-max-attempts"),
  });
}

function providerRequestHeaders(headers: Headers): {
  desired: DeploymentProviderDesiredState;
  operation: DeploymentProviderOperation;
} {
  try {
    return {
      desired: desiredStateFromHeaders(headers),
      operation: operationFromHeaders(headers),
    };
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(400, "INVALID_REQUEST", "Deployment provider request is invalid.");
  }
}

function providerLifecycleRequestHeaders(
  headers: Headers,
  signal: AbortSignal,
  action: "rollback" | "delete",
): DeploymentProviderLifecycleRequest {
  try {
    const operation = operationFromHeaders(headers);
    const generation = headerInteger(headers, "x-clank-generation");
    return providerLifecycleRequest({
      operation,
      generation,
      confirmation: action === "rollback"
        ? `rollback ${operation.projectId} ${generation}`
        : `delete ${operation.projectId}`,
      signal,
    }, action);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(
      400,
      "INVALID_REQUEST",
      `Deployment provider ${action} request is invalid.`,
    );
  }
}

function contentDigestHeader(headers: Headers, code: "ARTIFACT_INVALID" | "RUNTIME_INVALID"): string {
  const digest = requiredHeader(headers, "x-clank-content-sha256");
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new ProviderRequestError(
      400,
      code,
      code === "RUNTIME_INVALID"
        ? "Deployment runtime capsule failed verification."
        : "Deployment artifact failed verification.",
    );
  }
  return digest;
}

function providerEndpoint(
  input: string,
  path: typeof DEPLOYMENT_PROVIDER_RECONCILE_PATH
    | typeof DEPLOYMENT_PROVIDER_ROLLBACK_PATH
    | typeof DEPLOYMENT_PROVIDER_DELETE_PATH,
): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Deployment provider baseUrl cannot contain credentials, query, or fragment.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Deployment provider baseUrl must use HTTPS or loopback HTTP.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${path}`;
  return url.toString();
}

function providerKind(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new TypeError("Deployment provider kind is invalid.");
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function headerInteger(headers: Headers, name: string): number {
  const value = requiredHeader(headers, name);
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new ProviderRequestError(400, "INVALID_REQUEST", `${name} is invalid.`);
  }
  try {
    return positiveInteger(Number(value), name);
  } catch {
    throw new ProviderRequestError(400, "INVALID_REQUEST", `${name} is invalid.`);
  }
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProviderRequestError(400, "INVALID_REQUEST", `${name} is invalid.`);
  }
  return value;
}

function contentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new ProviderRequestError(400, "INVALID_REQUEST", "content-length is invalid.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new ProviderRequestError(400, "INVALID_REQUEST", "content-length is invalid.");
  }
  return length;
}

function highEntropyToken(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length < 32
    || value.length > 512
    || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a high-entropy token between 32 and 512 characters.`);
  }
  return value;
}

function bearerToken(request: Request): string {
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new ProviderRequestError(401, "AUTH_REQUIRED", "Bearer authentication is required.");
  try {
    return highEntropyToken(match[1], "bearer token");
  } catch {
    throw new ProviderRequestError(401, "AUTH_REQUIRED", "Bearer authentication is required.");
  }
}

async function tokensEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index % leftBytes.length] ?? 0)
      ^ (rightBytes[index % rightBytes.length] ?? 0);
  }
  return difference === 0;
}

async function readBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  kind: "artifact" | "runtime" = "artifact",
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProviderRequestError(
          413,
          kind === "runtime" ? "RUNTIME_TOO_LARGE" : "ARTIFACT_TOO_LARGE",
          kind === "runtime"
            ? "Deployment runtime capsule is too large."
            : "Deployment artifact is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function requireEmptyBody(
  stream: ReadableStream<Uint8Array> | null,
  action: "rollback" | "delete",
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    const first = await reader.read();
    if (!first.done) {
      await reader.cancel();
      throw new ProviderRequestError(
        400,
        "UNEXPECTED_BODY",
        `Deployment provider ${action} cannot include a request body.`,
      );
    }
  } finally {
    reader.releaseLock();
  }
}

async function discardResponse(response: Response, limit: number): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new DeploymentProviderError(
          502,
          "PROVIDER_RESPONSE_TOO_LARGE",
          "Deployment provider response is too large.",
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function requestBody(value: Uint8Array): BodyInit {
  // Fetch accepts Uint8Array bodies in the supported Node runtime. TypeScript's
  // DOM declaration can narrow this to ArrayBuffer-backed views even though
  // the runtime accepts every Uint8Array.
  return value as unknown as BodyInit;
}

async function retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("Deployment provider request was aborted.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, Math.min(2_000, 100 * 2 ** attempt));
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Deployment provider request was aborted."));
    };
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    function done() {
      cleanup();
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Deployment provider request was aborted.");
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`Unknown field ${key}.`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new TypeError(`Missing field ${key}.`);
  }
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value as Values[number];
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function providerHeadersBase(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function providerProblem(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: code, error_description: message }), {
    status,
    headers: {
      ...providerHeadersBase(),
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

class ProviderRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
