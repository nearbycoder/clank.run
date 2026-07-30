import type {
  ClaimedDeploymentOperation,
  DeploymentNode,
  DeploymentNodeInput,
  DeploymentOperation,
  DeploymentOrchestrator,
  NodeSession,
} from "./orchestration.ts";

export const DEPLOYMENT_COORDINATOR_PREFIX = "/api/runner/v1";

export interface DeploymentCoordinatorHandlerOptions {
  /** Separate high-entropy secret used only to enroll or rotate deployment nodes. */
  registrationToken: string;
  /** Maximum JSON request body. Defaults to 128 KiB. */
  maxRequestBytes?: number;
  /** Receives private unexpected failures. */
  onError?: (error: unknown) => void;
}

export interface DeploymentCoordinatorHandler {
  readonly prefix: typeof DEPLOYMENT_COORDINATOR_PREFIX;
  handle(request: Request): Promise<Response>;
}

export interface DeploymentCoordinatorClientOptions {
  /** HTTPS control-plane origin. Loopback HTTP is accepted for development. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per-request deadline. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Maximum JSON response body. Defaults to 1 MiB. */
  maxResponseBytes?: number;
}

export interface DeploymentCoordinatorClient {
  register(registrationToken: string, input: DeploymentNodeInput): Promise<NodeSession>;
  authenticate(nodeId: string, token: string): Promise<DeploymentNode>;
  heartbeat(nodeId: string, token: string, input?: {
    capacity?: number;
    labels?: Record<string, string>;
  }): Promise<DeploymentNode>;
  drain(nodeId: string, token: string, draining?: boolean): Promise<DeploymentNode>;
  claim(nodeId: string, token: string, limit?: number): Promise<ClaimedDeploymentOperation[]>;
  renew(
    nodeId: string,
    token: string,
    operation: ClaimedDeploymentOperation,
  ): Promise<ClaimedDeploymentOperation | null>;
  complete(
    nodeId: string,
    token: string,
    operation: ClaimedDeploymentOperation,
    result?: unknown,
  ): Promise<boolean>;
  fail(
    nodeId: string,
    token: string,
    operation: ClaimedDeploymentOperation,
    error: unknown,
  ): Promise<DeploymentOperation>;
  observe(nodeId: string, token: string, input: {
    projectId: string;
    generation: number;
    releaseId: string | null;
    state: "running" | "stopped" | "failed";
  }): Promise<boolean>;
}

export interface DeploymentNodeCredentialStore {
  load(nodeId: string): Promise<string | null>;
  save(nodeId: string, token: string): Promise<void>;
  clear(nodeId: string): Promise<void>;
}

export interface DeploymentExecutionContext {
  /** The current claim, including its monotonic fence and latest lease expiry. */
  readonly operation: ClaimedDeploymentOperation;
  /** Aborts when shutdown wins or the operation lease is lost. */
  readonly signal: AbortSignal;
  /** Reports generation-fenced desired state for this operation's project. */
  observe(input: {
    generation: number;
    releaseId: string | null;
    state: "running" | "stopped" | "failed";
  }): Promise<boolean>;
}

export interface DeploymentAgentOptions {
  client: DeploymentCoordinatorClient;
  node: DeploymentNodeInput;
  /** Needed only when the credential store does not contain a valid node token. */
  registrationToken?: string;
  credentials?: DeploymentNodeCredentialStore;
  execute(
    operation: ClaimedDeploymentOperation,
    context: DeploymentExecutionContext,
  ): Promise<unknown>;
  concurrency?: number;
  claimLimit?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  shutdownTimeoutMs?: number;
  /**
   * Converts an execution failure into the safe remote message. Defaults to a
   * generic value so local exception details cannot become control-plane logs.
   */
  failureMessage?: (error: unknown) => string;
  /** Receives private local execution and transport failures. */
  onError?: (error: unknown) => void;
}

export interface DeploymentAgentRuntime {
  readonly nodeId: string;
  readonly node: DeploymentNode;
  readonly activeOperations: number;
  readonly draining: boolean;
  /** Resolves after both background loops stop. */
  readonly done: Promise<void>;
  /** Drains claims, waits for work, then aborts work beyond the shutdown deadline. */
  close(): Promise<void>;
}

class CoordinatorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class DeploymentCoordinatorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeploymentCoordinatorError";
  }
}

/**
 * Adapts durable deployment orchestration to a bounded server-to-server HTTP
 * protocol. Application traffic and browser credentials are never accepted.
 */
export function createDeploymentCoordinatorHandler(
  orchestrator: DeploymentOrchestrator,
  options: DeploymentCoordinatorHandlerOptions,
): DeploymentCoordinatorHandler {
  const registrationToken = boundedToken(options.registrationToken, "registrationToken");
  const maxRequestBytes = integer(
    options.maxRequestBytes ?? 128 * 1024,
    "maxRequestBytes",
    1_024,
    1024 * 1024,
  );

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== DEPLOYMENT_COORDINATOR_PREFIX
      && !url.pathname.startsWith(`${DEPLOYMENT_COORDINATOR_PREFIX}/`)) {
      return problem(404, "NOT_FOUND", "Deployment coordinator endpoint not found.");
    }
    if (request.method !== "POST") {
      return problem(405, "METHOD_NOT_ALLOWED", "Deployment coordinator requests must use POST.", {
        allow: "POST",
      });
    }
    try {
      const operation = url.pathname.slice(DEPLOYMENT_COORDINATOR_PREFIX.length + 1);
      if (!operation || operation.includes("/")) {
        throw new CoordinatorRequestError(404, "NOT_FOUND", "Deployment coordinator endpoint not found.");
      }
      const input = object(await readJson(request, maxRequestBytes));

      if (operation === "register") {
        exact(input, ["id", "region"], ["endpoint", "capacity", "labels"]);
        const bearer = bearerToken(request);
        if (!await tokensEqual(bearer, registrationToken)) {
          throw new CoordinatorRequestError(401, "REGISTRATION_DENIED", "Deployment node enrollment was denied.");
        }
        const session = await orchestrator.registerNode({
          id: string(input.id, "id"),
          region: string(input.region, "region"),
          ...(input.endpoint === undefined ? {} : { endpoint: string(input.endpoint, "endpoint") }),
          ...(input.capacity === undefined ? {} : { capacity: number(input.capacity, "capacity") }),
          ...(input.labels === undefined ? {} : { labels: stringRecord(input.labels, "labels") }),
        });
        return json({ ok: true, ...session }, 201);
      }

      if (![
        "authenticate",
        "heartbeat",
        "drain",
        "claim",
        "observe",
        "renew",
        "complete",
        "fail",
      ].includes(operation)) {
        throw new CoordinatorRequestError(404, "NOT_FOUND", "Deployment coordinator endpoint not found.");
      }
      const nodeId = boundedHeader(request.headers.get("x-clank-node-id"), "x-clank-node-id");
      const nodeToken = bearerToken(request);
      if (operation === "authenticate") {
        exact(input, []);
        return json({ ok: true, node: await orchestrator.authenticateNode(nodeId, nodeToken) });
      }
      if (operation === "heartbeat") {
        exact(input, [], ["capacity", "labels"]);
        return json({
          ok: true,
          node: await orchestrator.heartbeat(nodeId, nodeToken, {
            ...(input.capacity === undefined ? {} : { capacity: number(input.capacity, "capacity") }),
            ...(input.labels === undefined ? {} : { labels: stringRecord(input.labels, "labels") }),
          }),
        });
      }
      if (operation === "drain") {
        exact(input, [], ["draining"]);
        return json({
          ok: true,
          node: await orchestrator.drainNode(
            nodeId,
            nodeToken,
            input.draining === undefined ? true : boolean(input.draining, "draining"),
          ),
        });
      }
      if (operation === "claim") {
        exact(input, [], ["limit"]);
        return json({
          ok: true,
          operations: await orchestrator.claim(
            nodeId,
            nodeToken,
            input.limit === undefined ? 10 : number(input.limit, "limit"),
          ),
        });
      }

      exact(
        input,
        operation === "observe" ? ["projectId", "generation", "releaseId", "state"] : ["operation"],
        operation === "complete" ? ["result"] : operation === "fail" ? ["error"] : [],
      );

      if (operation === "observe") {
        return json({
          ok: true,
          accepted: await orchestrator.observe(nodeId, nodeToken, {
            projectId: string(input.projectId, "projectId"),
            generation: number(input.generation, "generation"),
            releaseId: input.releaseId === null ? null : string(input.releaseId, "releaseId"),
            state: enumeration(input.state, "state", ["running", "stopped", "failed"] as const),
          }),
        });
      }

      await orchestrator.authenticateNode(nodeId, nodeToken);
      const claimed = claimedOperation(input.operation);
      if (claimed.nodeId !== nodeId) {
        throw new CoordinatorRequestError(403, "NODE_SCOPE_DENIED", "The operation belongs to another deployment node.");
      }
      if (operation === "renew") {
        return json({ ok: true, operation: await orchestrator.renewOperation(claimed) });
      }
      if (operation === "complete") {
        return json({
          ok: true,
          accepted: await orchestrator.complete(claimed, input.result ?? null),
        });
      }
      return json({
        ok: true,
        operation: await orchestrator.fail(
          claimed,
          typeof input.error === "string" ? input.error : "Deployment operation failed.",
        ),
      });
    } catch (error) {
      if (error instanceof CoordinatorRequestError) {
        return problem(error.status, error.code, error.message);
      }
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
        return problem(422, "INVALID_INPUT", "Deployment coordinator input is invalid.");
      }
      if (safeError(error).includes("authentication failed")) {
        return problem(401, "NODE_AUTH_FAILED", "Deployment node authentication failed.");
      }
      if (safeError(error).includes("node lease is expired")) {
        return problem(409, "NODE_OFFLINE", "The deployment node heartbeat lease is expired.");
      }
      if (safeError(error).includes("lease is stale")) {
        return problem(409, "STALE_OPERATION", "The deployment operation lease is stale.");
      }
      options.onError?.(error);
      return problem(500, "COORDINATOR_FAILED", "The deployment coordinator operation failed.");
    }
  };

  return Object.freeze({ prefix: DEPLOYMENT_COORDINATOR_PREFIX, handle });
}

/** Creates a redirect-safe, bounded client for a remote deployment node. */
export function createDeploymentCoordinatorClient(
  options: DeploymentCoordinatorClientOptions,
): DeploymentCoordinatorClient {
  const baseUrl = coordinatorBaseUrl(options.baseUrl);
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = integer(options.timeoutMs ?? 10_000, "timeoutMs", 100, 60_000);
  const maxResponseBytes = integer(
    options.maxResponseBytes ?? 1024 * 1024,
    "maxResponseBytes",
    1_024,
    8 * 1024 * 1024,
  );

  const call = async (
    operation: string,
    body: Record<string, unknown>,
    token: string,
    nodeId?: string,
  ): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}/${operation}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${boundedToken(token, "token")}`,
          "content-type": "application/json",
          ...(nodeId ? { "x-clank-node-id": boundedNodeId(nodeId) } : {}),
        },
        body: JSON.stringify(body),
      });
      const payload = object(await readResponseJson(response, maxResponseBytes));
      if (!response.ok) {
        const error = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
          ? payload.error as Record<string, unknown>
          : {};
        throw new DeploymentCoordinatorError(
          response.status,
          typeof error.code === "string" ? error.code : "COORDINATOR_FAILED",
          typeof error.message === "string" ? error.message : "The deployment coordinator request failed.",
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof DeploymentCoordinatorError) throw error;
      if (controller.signal.aborted) {
        throw new DeploymentCoordinatorError(504, "COORDINATOR_TIMEOUT", "Deployment coordinator request timed out.");
      }
      throw new DeploymentCoordinatorError(502, "COORDINATOR_UNAVAILABLE", "Deployment coordinator is unavailable.");
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({
    async register(token, input) {
      const payload = await call("register", { ...input }, token);
      return {
        node: deploymentNode(payload.node),
        token: string(payload.token, "token"),
      };
    },
    async authenticate(nodeId, token) {
      return deploymentNode((await call("authenticate", {}, token, nodeId)).node);
    },
    async heartbeat(nodeId, token, input = {}) {
      return deploymentNode((await call("heartbeat", input, token, nodeId)).node);
    },
    async drain(nodeId, token, draining = true) {
      return deploymentNode((await call("drain", { draining }, token, nodeId)).node);
    },
    async claim(nodeId, token, limit = 10) {
      const payload = await call("claim", { limit }, token, nodeId);
      if (!Array.isArray(payload.operations)) throw new TypeError("Coordinator operations response is invalid.");
      return payload.operations.map(claimedOperation);
    },
    async renew(nodeId, token, operation) {
      const payload = await call("renew", { operation }, token, nodeId);
      return payload.operation === null ? null : claimedOperation(payload.operation);
    },
    async complete(nodeId, token, operation, result = null) {
      return boolean((await call("complete", { operation, result }, token, nodeId)).accepted, "accepted");
    },
    async fail(nodeId, token, operation, error) {
      return deploymentOperation((await call("fail", {
        operation,
        error: safeError(error).slice(0, 4_096),
      }, token, nodeId)).operation);
    },
    async observe(nodeId, token, input) {
      return boolean((await call("observe", input, token, nodeId)).accepted, "accepted");
    },
  });
}

/**
 * Runs the provider-neutral deployment-node lifecycle. Runtime adapters only
 * implement `execute`; enrollment, credentials, claims, renewal, fencing,
 * heartbeat, drain, and bounded shutdown stay identical across Docker/VM hosts.
 */
export async function openDeploymentAgent(
  options: DeploymentAgentOptions,
): Promise<DeploymentAgentRuntime> {
  const nodeId = boundedNodeId(options.node.id);
  const concurrency = integer(options.concurrency ?? 2, "concurrency", 1, 64);
  const claimLimit = integer(options.claimLimit ?? concurrency, "claimLimit", 1, 100);
  const pollIntervalMs = integer(options.pollIntervalMs ?? 1_000, "pollIntervalMs", 10, 60_000);
  const heartbeatIntervalMs = integer(
    options.heartbeatIntervalMs ?? 10_000,
    "heartbeatIntervalMs",
    100,
    5 * 60_000,
  );
  const shutdownTimeoutMs = integer(
    options.shutdownTimeoutMs ?? 30_000,
    "shutdownTimeoutMs",
    100,
    10 * 60_000,
  );
  const credentials = options.credentials ?? memoryCredentialStore();
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Operator diagnostics must never break the runner lifecycle.
    }
  };

  let token = await credentials.load(nodeId);
  let currentNode: DeploymentNode | undefined;
  if (token) {
    try {
      currentNode = await options.client.heartbeat(nodeId, token, {
        ...(options.node.capacity === undefined ? {} : { capacity: options.node.capacity }),
        ...(options.node.labels === undefined ? {} : { labels: options.node.labels }),
      });
    } catch (error) {
      if (!(error instanceof DeploymentCoordinatorError) || error.code !== "NODE_AUTH_FAILED"
        || !options.registrationToken) {
        throw error;
      }
      await credentials.clear(nodeId);
      token = null;
    }
  }
  if (!token) {
    if (!options.registrationToken) {
      throw new TypeError("A registrationToken is required when no deployment node credential is stored.");
    }
    const session = await options.client.register(options.registrationToken, options.node);
    token = session.token;
    currentNode = session.node;
    await credentials.save(nodeId, token);
  }
  currentNode = await options.client.drain(nodeId, token, false);

  let closing = false;
  let closePromise: Promise<void> | undefined;
  let draining = false;
  const lifecycle = new AbortController();
  let wakePoll: (() => void) | undefined;
  const active = new Map<string, {
    promise: Promise<void>;
    abandon(error: Error): void;
  }>();
  const stopForInvalidCredential = (error: DeploymentCoordinatorError) => {
    report(error);
    draining = true;
    closing = true;
    wakePoll?.();
    for (const entry of active.values()) entry.abandon(error);
    lifecycle.abort();
  };

  const waitForPoll = () => new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (wakePoll === wake) wakePoll = undefined;
      resolve();
    }, pollIntervalMs);
    const wake = () => {
      clearTimeout(timer);
      if (wakePoll === wake) wakePoll = undefined;
      resolve();
    };
    wakePoll = wake;
  });

  const execute = (claimed: ClaimedDeploymentOperation) => {
    const controller = new AbortController();
    let current = claimed;
    let finished = false;
    let leaseLost = false;
    let abandoned = false;
    const renewalController = new AbortController();
    const abandon = (error: Error) => {
      if (finished || abandoned) return;
      abandoned = true;
      controller.abort(error);
      renewalController.abort();
    };
    const renew = (async () => {
      while (!finished && !abandoned) {
        const remaining = current.leaseExpiresAt - Date.now();
        if (remaining <= 0) {
          leaseLost = true;
          abandon(new Error("Deployment operation lease expired."));
          return;
        }
        await delay(Math.max(25, Math.min(5_000, Math.floor(remaining / 3))), renewalController.signal);
        if (finished || abandoned) return;
        try {
          const renewed = await options.client.renew(nodeId, token!, current);
          if (!renewed) {
            leaseLost = true;
            abandon(new Error("Deployment operation lease was reclaimed."));
            return;
          }
          current = renewed;
        } catch (error) {
          if (error instanceof DeploymentCoordinatorError && error.code === "NODE_AUTH_FAILED") {
            leaseLost = true;
            stopForInvalidCredential(error);
            return;
          }
          report(error);
          if (Date.now() >= current.leaseExpiresAt) {
            leaseLost = true;
            abandon(new Error("Deployment operation renewal failed before expiry."));
            return;
          }
        }
      }
    })();

    const promise = Promise.resolve().then(async () => {
      let result: unknown;
      try {
        result = await options.execute(claimed, {
          get operation() {
            return current;
          },
          signal: controller.signal,
          async observe(input) {
            if (leaseLost || controller.signal.aborted) {
              throw new Error("Cannot observe state after the deployment operation lease is lost.");
            }
            return options.client.observe(nodeId, token!, {
              projectId: current.projectId,
              ...input,
            });
          },
        });
      } catch (error) {
        if (!leaseLost && !abandoned) {
          report(error);
          let message = "Deployment execution failed.";
          if (options.failureMessage) {
            try {
              message = boundedFailure(options.failureMessage(error));
            } catch (formatError) {
              report(formatError);
            }
          }
          try {
            await options.client.fail(nodeId, token!, current, message);
          } catch (settlementError) {
            report(settlementError);
          }
        }
        return;
      }

      if (!leaseLost && !abandoned && !controller.signal.aborted) {
        try {
          const accepted = await options.client.complete(nodeId, token!, current, result ?? null);
          if (!accepted) {
            leaseLost = true;
            abandon(new Error("Deployment operation completion was stale."));
          }
        } catch (settlementError) {
          // A timed-out completion may have committed. Never turn an uncertain
          // success into a second execution by explicitly failing the lease.
          report(settlementError);
        }
      }
    }).finally(async () => {
      finished = true;
      renewalController.abort();
      await renew;
      active.delete(claimed.id);
      wakePoll?.();
    });
    active.set(claimed.id, { promise, abandon });
  };

  const heartbeatLoop = (async () => {
    while (!lifecycle.signal.aborted) {
      await delay(heartbeatIntervalMs, lifecycle.signal);
      if (lifecycle.signal.aborted) return;
      try {
        currentNode = await options.client.heartbeat(nodeId, token!, {
          ...(options.node.capacity === undefined ? {} : { capacity: options.node.capacity }),
          ...(options.node.labels === undefined ? {} : { labels: options.node.labels }),
        });
      } catch (error) {
        if (error instanceof DeploymentCoordinatorError && error.code === "NODE_AUTH_FAILED") {
          stopForInvalidCredential(error);
          return;
        }
        report(error);
      }
    }
  })();

  const claimLoop = (async () => {
    while (!closing) {
      const available = concurrency - active.size;
      if (!draining && available > 0) {
        try {
          const operations = await options.client.claim(
            nodeId,
            token!,
            Math.min(available, claimLimit),
          );
          for (const operation of operations) {
            // A claim request may have crossed a shutdown request. Work already
            // leased to this node is still accepted during the grace period.
            if (lifecycle.signal.aborted || active.size >= concurrency) break;
            if (!active.has(operation.id)) execute(operation);
          }
          if (closing) return;
          if (operations.length > 0) continue;
        } catch (error) {
          if (error instanceof DeploymentCoordinatorError && error.code === "NODE_AUTH_FAILED") {
            stopForInvalidCredential(error);
            return;
          }
          report(error);
          if (closing) return;
        }
      }
      await waitForPoll();
    }
  })();

  const done = Promise.all([heartbeatLoop, claimLoop]).then(() => undefined);
  const runtime: DeploymentAgentRuntime = {
    nodeId,
    get node() {
      return currentNode!;
    },
    get activeOperations() {
      return active.size;
    },
    get draining() {
      return draining;
    },
    done,
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        draining = true;
        closing = true;
        wakePoll?.();
        try {
          currentNode = await options.client.drain(nodeId, token!, true);
        } catch (error) {
          report(error);
        }
        // Let an in-flight claim finish before taking the work snapshot. The
        // coordinator refuses claims once its drain update wins the race.
        await claimLoop;
        const work = [...active.values()];
        const shutdownDeadline = new AbortController();
        const graceful = await Promise.race([
          Promise.allSettled(work.map((entry) => entry.promise)).then(() => true),
          delay(shutdownTimeoutMs, shutdownDeadline.signal).then(() => false),
        ]);
        shutdownDeadline.abort();
        if (!graceful) {
          for (const entry of work) {
            entry.abandon(new Error("Deployment agent shutdown deadline exceeded."));
          }
        }
        lifecycle.abort();
        await done;
      })();
      return closePromise;
    },
  };
  return runtime;
}

/** In-memory credentials are useful for tests and ephemeral enrolled nodes. */
export function memoryDeploymentNodeCredentials(
  initial: Record<string, string> = {},
): DeploymentNodeCredentialStore {
  const values = new Map<string, string>();
  for (const [nodeId, token] of Object.entries(initial)) {
    values.set(boundedNodeId(nodeId), boundedToken(token, "node token"));
  }
  return Object.freeze({
    async load(nodeId) {
      return values.get(boundedNodeId(nodeId)) ?? null;
    },
    async save(nodeId, token) {
      values.set(boundedNodeId(nodeId), boundedToken(token, "node token"));
    },
    async clear(nodeId) {
      values.delete(boundedNodeId(nodeId));
    },
  });
}

/**
 * Persists one or more node credentials in an owner-only JSON file using an
 * atomic replacement. The path is operator configuration, never remote input.
 */
export function fileDeploymentNodeCredentials(pathInput: string): DeploymentNodeCredentialStore {
  if (
    typeof pathInput !== "string"
    || !pathInput
    || pathInput.length > 4_096
    || pathInput.includes("\0")
  ) {
    throw new TypeError("Deployment node credential path is invalid.");
  }
  const path = pathInput;
  let pending: Promise<void> = Promise.resolve();
  const serialized = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const read = async (): Promise<Record<string, string>> => {
    const fsName = "node:fs/promises";
    const nodeFsName = "node:fs";
    const [fs, nodeFs] = await Promise.all([
      import(fsName) as unknown as Promise<{
        lstat(path: string): Promise<{
          dev: number;
          ino: number;
          isSymbolicLink(): boolean;
        }>;
        open(path: string, flags: number): Promise<{
          stat(): Promise<{
            dev: number;
            ino: number;
            mode: number;
            size: number;
            uid: number;
            isFile(): boolean;
          }>;
          readFile(options: { encoding: "utf8" }): Promise<string>;
          close(): Promise<void>;
        }>;
      }>,
      import(nodeFsName) as unknown as Promise<{
        constants: { O_RDONLY: number; O_NOFOLLOW?: number };
      }>,
    ]);
    let handle: {
      stat(): Promise<{
        dev: number;
        ino: number;
        mode: number;
        size: number;
        uid: number;
        isFile(): boolean;
      }>;
      readFile(options: { encoding: "utf8" }): Promise<string>;
      close(): Promise<void>;
    } | undefined;
    try {
      handle = await fs.open(
        path,
        nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return {};
      if ((error as { code?: string }).code === "ELOOP") {
        throw new Error("Deployment node credential file is unsafe or too large.");
      }
      throw error;
    }
    let encoded: string;
    try {
      const [stats, pathStats] = await Promise.all([handle.stat(), fs.lstat(path)]);
      const getUid = (globalThis as any).process?.getuid;
      const currentUid = typeof getUid === "function" ? Number(getUid.call((globalThis as any).process)) : null;
      if (
        pathStats.isSymbolicLink()
        || pathStats.dev !== stats.dev
        || pathStats.ino !== stats.ino
        || !stats.isFile()
        || stats.size > 64 * 1024
        || (stats.mode & 0o077) !== 0
        || (currentUid !== null && stats.uid !== currentUid)
      ) {
        throw new Error("Deployment node credential file is unsafe or too large.");
      }
      encoded = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    const parsed = object(JSON.parse(encoded));
    exact(parsed, ["version", "credentials"]);
    if (parsed.version !== 1) throw new Error("Deployment node credential file version is unsupported.");
    const input = object(parsed.credentials);
    const output = Object.create(null) as Record<string, string>;
    for (const [nodeId, token] of Object.entries(input)) {
      output[boundedNodeId(nodeId)] = boundedToken(token, "node token");
    }
    return output;
  };
  const write = async (values: Record<string, string>): Promise<void> => {
    const fsName = "node:fs/promises";
    const pathName = "node:path";
    const [fs, pathModule] = await Promise.all([
      import(fsName) as unknown as Promise<{
        chmod(path: string, mode: number): Promise<void>;
        mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
        rename(source: string, destination: string): Promise<void>;
        rm(path: string, options: { force: true }): Promise<void>;
        writeFile(path: string, value: string, options: { encoding: "utf8"; flag: "wx"; mode: number }): Promise<void>;
      }>,
      import(pathName) as unknown as Promise<{ dirname(path: string): string }>,
    ]);
    const directory = pathModule.dirname(path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(
        temporary,
        `${JSON.stringify({ version: 1, credentials: values }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await fs.rename(temporary, path);
      await fs.chmod(path, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  };
  return Object.freeze({
    async load(nodeId) {
      return serialized(async () => {
        const values = await read();
        const token = values[boundedNodeId(nodeId)];
        return token === undefined ? null : boundedToken(token, "node token");
      });
    },
    async save(nodeId, token) {
      await serialized(async () => {
        const values = await read();
        values[boundedNodeId(nodeId)] = boundedToken(token, "node token");
        await write(values);
      });
    },
    async clear(nodeId) {
      await serialized(async () => {
        const values = await read();
        delete values[boundedNodeId(nodeId)];
        await write(values);
      });
    },
  });
}

function memoryCredentialStore(): DeploymentNodeCredentialStore {
  return memoryDeploymentNodeCredentials();
}

function boundedFailure(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("failureMessage must return a string.");
  return value.replace(/[\u0000]/gu, "").slice(0, 4_096) || "Deployment execution failed.";
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function coordinatorBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Deployment coordinator baseUrl cannot contain credentials, query, or fragment.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Deployment coordinator baseUrl must use HTTPS or loopback HTTP.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${DEPLOYMENT_COORDINATOR_PREFIX}`;
  return url.toString().replace(/\/$/u, "");
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new CoordinatorRequestError(415, "UNSUPPORTED_MEDIA_TYPE", "Deployment coordinator requests require JSON.");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > limit) {
    throw new CoordinatorRequestError(413, "REQUEST_TOO_LARGE", "Deployment coordinator request is too large.");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(request.body, limit)));
}

async function readResponseJson(response: Response, limit: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > limit) {
    throw new DeploymentCoordinatorError(502, "RESPONSE_TOO_LARGE", "Deployment coordinator response is too large.");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(response.body, limit)));
  } catch (error) {
    if (error instanceof DeploymentCoordinatorError) throw error;
    if (error instanceof CoordinatorRequestError && error.status === 413) {
      throw new DeploymentCoordinatorError(502, "RESPONSE_TOO_LARGE", "Deployment coordinator response is too large.");
    }
    throw new DeploymentCoordinatorError(502, "INVALID_RESPONSE", "Deployment coordinator returned invalid JSON.");
  }
}

async function readBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
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
        throw new CoordinatorRequestError(413, "BODY_TOO_LARGE", "Deployment coordinator message is too large.");
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

function claimedOperation(value: unknown): ClaimedDeploymentOperation {
  const operation = deploymentOperation(value);
  const input = object(value);
  if (operation.state !== "leased" || operation.nodeId === null) {
    throw new TypeError("Claimed deployment operation is not leased.");
  }
  return {
    ...operation,
    state: "leased",
    nodeId: operation.nodeId,
    leaseToken: boundedToken(input.leaseToken, "leaseToken"),
    leaseExpiresAt: number(input.leaseExpiresAt, "leaseExpiresAt"),
  };
}

function deploymentOperation(value: unknown): DeploymentOperation {
  const input = object(value);
  return {
    id: string(input.id, "operation.id"),
    projectId: string(input.projectId, "operation.projectId"),
    action: enumeration(input.action, "operation.action", ["reconcile", "deploy", "rollback", "restart", "stop"] as const),
    state: enumeration(
      input.state,
      "operation.state",
      ["queued", "leased", "retry", "succeeded", "failed", "cancelled"] as const,
    ),
    payload: input.payload,
    nodeId: input.nodeId === null ? null : string(input.nodeId, "operation.nodeId"),
    attempts: number(input.attempts, "operation.attempts"),
    maxAttempts: number(input.maxAttempts, "operation.maxAttempts"),
    fence: number(input.fence, "operation.fence"),
    nextAttemptAt: number(input.nextAttemptAt, "operation.nextAttemptAt"),
    leaseExpiresAt: input.leaseExpiresAt === null ? null : number(input.leaseExpiresAt, "operation.leaseExpiresAt"),
    createdAt: number(input.createdAt, "operation.createdAt"),
    updatedAt: number(input.updatedAt, "operation.updatedAt"),
    ...(typeof input.error === "string" ? { error: input.error } : {}),
    ...(input.result === undefined ? {} : { result: input.result }),
  };
}

function deploymentNode(value: unknown): DeploymentNode {
  const input = object(value);
  return {
    id: string(input.id, "node.id"),
    region: string(input.region, "node.region"),
    ...(input.endpoint === undefined ? {} : { endpoint: string(input.endpoint, "node.endpoint") }),
    capacity: number(input.capacity, "node.capacity"),
    labels: stringRecord(input.labels, "node.labels"),
    status: enumeration(input.status, "node.status", ["active", "draining", "offline"] as const),
    heartbeatAt: number(input.heartbeatAt, "node.heartbeatAt"),
    expiresAt: number(input.expiresAt, "node.expiresAt"),
  };
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object.");
  return value as Record<string, any>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`Unknown field ${key}.`);
  for (const key of required) if (!(key in value)) throw new TypeError(`Missing field ${key}.`);
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function number(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${name} must be a non-negative integer.`);
  return Number(value);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
  return value;
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  name: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value as Values[number];
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const input = object(value);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new TypeError(`${name}.${key} is reserved.`);
    }
    if (typeof entry !== "string") throw new TypeError(`${name}.${key} must be a string.`);
    output[key] = entry;
  }
  return output;
}

function boundedHeader(value: string | null, name: string): string {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new CoordinatorRequestError(401, "NODE_AUTH_FAILED", `${name} is invalid.`);
  }
  return value;
}

function boundedNodeId(value: string): string {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("nodeId is invalid.");
  }
  return value;
}

function boundedToken(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 512 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a high-entropy token between 32 and 512 characters.`);
  }
  return value;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match) throw new CoordinatorRequestError(401, "AUTH_REQUIRED", "Bearer authentication is required.");
  try {
    return boundedToken(match[1], "bearer token");
  } catch {
    throw new CoordinatorRequestError(401, "AUTH_REQUIRED", "Bearer authentication is required.");
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
    difference |= (leftBytes[index % leftBytes.length] ?? 0) ^ (rightBytes[index % rightBytes.length] ?? 0);
  }
  return difference === 0;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function problem(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return json({ ok: false, error: { code, message } }, status, {
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="clank-runner"' } : {}),
    ...extraHeaders,
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
