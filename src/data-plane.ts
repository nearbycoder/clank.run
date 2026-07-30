import type { Migration, MigrationPlan, MigrationRecord } from "./migrations.ts";
import { readResponseBytes, ResponseBodyLimitError } from "./security.ts";

export interface IngressRuntimeRoute {
  readonly protocol: "clank-runtime/1";
  readonly generation: number;
  /** Provider-local path dedicated to this application runtime. */
  readonly path: string;
  /** Secret delivered only in a managed-ingress request header. */
  readonly token: string;
}

export interface IngressRoute {
  id: string;
  projectId: string;
  hosts: readonly string[];
  upstream: string;
  active: boolean;
  /** Binds a remote provider origin to one exact application generation. */
  runtime?: IngressRuntimeRoute;
}

export interface IngressRouteStore {
  routes(): readonly IngressRoute[] | Promise<readonly IngressRoute[]>;
}

export interface ManagedIngress {
  handle(request: Request): Promise<Response>;
  health(): Promise<Record<string, { ok: boolean; status?: number; error?: string }>>;
  /** Waits for requests already assigned to an upstream to finish before its process is stopped. */
  drain(upstream: string, timeoutMs?: number): Promise<boolean>;
}

export interface IngressRequestMetric {
  projectId: string;
  routeId: string;
  method: string;
  statusCode: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  recordedAt: number;
  /** True only when the request passed the configured admission policy. */
  admitted: boolean;
}

export interface IngressAdmissionRequest {
  projectId: string;
  routeId: string;
  method: string;
  requestBytes: number;
  recordedAt: number;
}

export type IngressAdmissionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: string;
      message: string;
      retryAfterSeconds: number;
    };

export type IngressAdmissionPolicy = (
  request: Readonly<IngressAdmissionRequest>,
) => IngressAdmissionDecision | void | Promise<IngressAdmissionDecision | void>;

export function createManagedIngress(options: {
  routes: IngressRouteStore | (() => readonly IngressRoute[] | Promise<readonly IngressRoute[]>);
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  retries?: number;
  trustProxy?: boolean;
  allowedUpstreamHosts?: readonly string[];
  circuitFailures?: number;
  circuitResetMs?: number;
  /**
   * Optional durable capacity/rate policy. It receives no path, headers,
   * cookies, IP address, query string, or body content.
   */
  admitRequest?: IngressAdmissionPolicy;
  onRequest?: (metric: IngressRequestMetric) => void | Promise<void>;
}): ManagedIngress {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = integerRange(options.timeoutMs ?? 30_000, "timeoutMs", 100, 5 * 60_000);
  const maxBodyBytes = integerRange(options.maxBodyBytes ?? 25 * 1024 * 1024, "maxBodyBytes", 1, Number.MAX_SAFE_INTEGER);
  const retries = integerRange(options.retries ?? 1, "retries", 0, 3);
  const circuitFailures = integerRange(options.circuitFailures ?? 5, "circuitFailures", 1, 100);
  const circuitResetMs = integerRange(options.circuitResetMs ?? 30_000, "circuitResetMs", 100, 60 * 60_000);
  const circuits = new Map<string, { failures: number; openedAt: number; target: string }>();
  const inFlight = new Map<string, {
    leases: Set<symbol>;
    waiters: Set<() => void>;
  }>();
  const routeSource = typeof options.routes === "function"
    ? options.routes
    : () => options.routes.routes();

  const recordCircuitFailure = (routeId: string, target: string): void => {
    const existing = circuits.get(routeId);
    // A response from a drained generation must not mutate the circuit that
    // already belongs to its replacement.
    if (existing && existing.target !== target) return;
    const current = existing ?? { failures: 0, openedAt: 0, target };
    current.failures++;
    if (current.failures >= circuitFailures) current.openedAt = Date.now();
    circuits.set(routeId, current);
  };

  const clearCircuit = (routeId: string, target: string): void => {
    if (circuits.get(routeId)?.target === target) circuits.delete(routeId);
  };

  const retain = (upstream: string): (() => void) => {
    const state = inFlight.get(upstream) ?? {
      leases: new Set<symbol>(),
      waiters: new Set<() => void>(),
    };
    inFlight.set(upstream, state);
    const lease = Symbol(upstream);
    state.leases.add(lease);
    return () => {
      if (!state.leases.delete(lease) || state.leases.size) return;
      if (inFlight.get(upstream) === state) inFlight.delete(upstream);
      for (const resolve of state.waiters) resolve();
      state.waiters.clear();
    };
  };

  const loadRoutes = async (): Promise<IngressRoute[]> => {
    const routes = [...await routeSource()];
    const seen = new Set<string>();
    return routes.map((route) => {
      const normalized: IngressRoute = {
        id: opaque(route.id, "route ID"),
        projectId: opaque(route.projectId, "project ID"),
        hosts: Object.freeze(route.hosts.map(domainName)),
        upstream: upstreamUrl(route.upstream, options.allowedUpstreamHosts),
        active: route.active === true,
        ...(route.runtime === undefined
          ? {}
          : { runtime: normalizeIngressRuntimeRoute(route.runtime) }),
      };
      for (const host of normalized.hosts) {
        if (seen.has(host)) throw new Error(`Ingress host is assigned more than once: ${host}`);
        seen.add(host);
      }
      return normalized;
    });
  };

  const ingress: ManagedIngress = {
    async handle(request) {
      const url = new URL(request.url);
      const host = domainName(url.hostname);
      const route = (await loadRoutes()).find((entry) => entry.active && entry.hosts.includes(host));
      if (!route) return ingressProblem(404, "ROUTE_NOT_FOUND", "No application is assigned to this host.");
      const targetIdentity = ingressRouteIdentity(route);
      const release = retain(route.upstream);
      const finish = (response: Response, trackBody = false): Response => {
        if (!trackBody || !response.body) {
          release();
          return response;
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
              } else {
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      try {
      const startedAt = performance.now();
      const recordedAt = Date.now();
      let requestBytes = 0;
      let admitted = options.admitRequest === undefined;
      const observed = (response: Response): Response => {
        const declaredResponseBytes = request.method === "HEAD"
          || response.status === 204
          || response.status === 304
          ? 0
          : Number(response.headers.get("content-length"));
        const metric: IngressRequestMetric = {
          projectId: route.projectId,
          routeId: route.id,
          method: knownHttpMethod(request.method),
          statusCode: response.status,
          durationMs: Math.max(0, performance.now() - startedAt),
          requestBytes,
          responseBytes: Number.isSafeInteger(declaredResponseBytes) && declaredResponseBytes >= 0
            ? declaredResponseBytes
            : 0,
          recordedAt,
          admitted,
        };
        try {
          const pending = options.onRequest?.(Object.freeze(metric));
          if (pending && typeof (pending as Promise<void>).catch === "function") {
            void (pending as Promise<void>).catch(() => undefined);
          }
        } catch {
          // Observability must never affect application traffic.
        }
        return response;
      };
      let circuit = circuits.get(route.id);
      if (circuit && circuit.target !== targetIdentity) {
        circuits.delete(route.id);
        circuit = undefined;
      }
      if (circuit && circuit.failures >= circuitFailures && Date.now() - circuit.openedAt < circuitResetMs) {
        return finish(observed(ingressProblem(503, "UPSTREAM_UNAVAILABLE", "Application is temporarily unavailable.", {
          "retry-after": String(Math.max(1, Math.ceil((circuitResetMs - (Date.now() - circuit.openedAt)) / 1_000))),
        })));
      }
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        requestBytes = Math.max(0, declared);
        return finish(observed(ingressProblem(413, "REQUEST_TOO_LARGE", `Request exceeds ${maxBodyBytes} bytes.`)));
      }
      let body: Uint8Array | undefined;
      if (request.body && !["GET", "HEAD"].includes(request.method)) {
        const read = await readBoundedBody(request.body, maxBodyBytes);
        requestBytes = read.size;
        if (read.tooLarge) {
          return finish(observed(ingressProblem(413, "REQUEST_TOO_LARGE", `Request exceeds ${maxBodyBytes} bytes.`)));
        }
        body = read.body;
      }
      if (options.admitRequest) {
        let decision: IngressAdmissionDecision | void;
        let denial: Exclude<IngressAdmissionDecision, { allowed: true }> | undefined;
        try {
          decision = await options.admitRequest(Object.freeze({
            projectId: route.projectId,
            routeId: route.id,
            method: knownHttpMethod(request.method),
            requestBytes,
            recordedAt,
          }));
          if (decision !== undefined) {
            if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
              throw new TypeError("Ingress admission decision is invalid.");
            }
            if (decision.allowed === false) denial = normalizeAdmissionDenial(decision);
            else if (decision.allowed !== true) {
              throw new TypeError("Ingress admission decision is invalid.");
            }
          }
        } catch {
          return finish(observed(ingressProblem(
            503,
            "ADMISSION_UNAVAILABLE",
            "Application admission policy is temporarily unavailable.",
            { "retry-after": "1" },
          )));
        }
        if (denial) {
          return finish(observed(ingressProblem(429, denial.code, denial.message, {
            "retry-after": String(denial.retryAfterSeconds),
          })));
        }
        admitted = true;
      }
      // Assign the path after parsing the trusted origin. Passing a path such
      // as //attacker.example directly to new URL(path, base) would otherwise
      // turn it into a scheme-relative URL and let request input select a host.
      const target = ingressTarget(route, url.pathname, url.search);
      const headers = proxyRequestHeaders(request, host, options.trustProxy === true);
      headers.set("x-clank-project-id", route.projectId);
      setRuntimeIngressHeaders(headers, route.runtime);
      const attempts = ["GET", "HEAD"].includes(request.method) ? retries + 1 : 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(target, {
            method: request.method,
            headers,
            body,
            signal: AbortSignal.any([controller.signal, request.signal]),
            redirect: "manual",
          });
          if (response.status >= 500) {
            recordCircuitFailure(route.id, targetIdentity);
            if (attempt + 1 < attempts) {
              await response.body?.cancel().catch(() => undefined);
              await backoff(attempt);
              continue;
            }
          } else {
            clearCircuit(route.id, targetIdentity);
          }
          return finish(observed(new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: proxyResponseHeaders(response.headers, route.id),
          })), true);
        } catch (error) {
          lastError = error;
          if (request.signal.aborted) break;
          recordCircuitFailure(route.id, targetIdentity);
          if (attempt + 1 < attempts) await backoff(attempt);
        } finally {
          clearTimeout(timeout);
        }
      }
      void lastError;
      return finish(observed(ingressProblem(502, "UPSTREAM_FAILED", "Application upstream could not be reached.")));
      } catch (error) {
        release();
        throw error;
      }
    },
    async health() {
      const output: Record<string, { ok: boolean; status?: number; error?: string }> = {};
      await Promise.all((await loadRoutes()).filter((route) => route.active).map(async (route) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5_000));
        try {
          const headers = new Headers({
            "x-clank-project-id": route.projectId,
          });
          setRuntimeIngressHeaders(headers, route.runtime);
          const response = await fetcher(ingressTarget(route, "/healthz", ""), {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          output[route.id] = { ok: response.ok, status: response.status };
        } catch (error) {
          output[route.id] = {
            ok: false,
            error: route.runtime ? "Runtime health check failed." : safeError(error),
          };
        } finally {
          clearTimeout(timeout);
        }
      }));
      return output;
    },
    async drain(input, timeout = 2_000) {
      const upstream = upstreamUrl(input, options.allowedUpstreamHosts);
      const timeoutMs = integerRange(timeout, "drain timeout", 100, 30_000);
      // Let requests that already loaded the prior route resume and retain
      // their upstream before deciding that there is nothing to drain.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const state = inFlight.get(upstream);
      if (!state?.leases.size) return true;
      let resolveDrained!: () => void;
      const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
      state.waiters.add(resolveDrained);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        drained.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!result) {
        state.waiters.delete(resolveDrained);
        // Detach timed-out leases so a later release reusing this loopback
        // port starts with an independent generation.
        if (inFlight.get(upstream) === state) inFlight.delete(upstream);
      }
      return result;
    },
  };
  return ingress;
}

export interface DomainChallenge {
  id: string;
  projectId: string;
  hostname: string;
  recordName: string;
  recordType: "TXT";
  recordValue: string;
  status: "pending" | "verified";
  expiresAt: number;
  verifiedAt?: number;
}

export interface DomainChallengeStore {
  save(challenge: DomainChallenge): void | Promise<void>;
  get(id: string): DomainChallenge | undefined | Promise<DomainChallenge | undefined>;
  byHostname(hostname: string): DomainChallenge | undefined | Promise<DomainChallenge | undefined>;
}

export interface DomainManager {
  begin(projectId: string, hostname: string): Promise<DomainChallenge>;
  verify(id: string): Promise<DomainChallenge>;
}

export class DomainVerificationError extends Error {
  constructor(readonly code: "INVALID_CHALLENGE" | "DNS_TXT_MISSING", message: string) {
    super(message);
    this.name = "DomainVerificationError";
  }
}

export interface DomainDnsResolver {
  resolveCname(hostname: string): Promise<readonly string[]>;
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
}

export interface DomainRoutingTarget {
  cname?: string;
  addresses?: readonly string[];
}

export interface DomainRoutingReport {
  hostname: string;
  status: "pending" | "ready" | "misconfigured" | "error";
  target: {
    cname: string | null;
    addresses: readonly string[];
  };
  observed: {
    cnames: readonly string[];
    addresses: readonly string[];
  };
  checkedAt: number;
  error?: string;
}

/** Resolves a customer hostname and proves that it points at the configured Clank edge. */
export async function inspectDomainRouting(
  hostnameInput: string,
  targetInput: DomainRoutingTarget,
  resolver: DomainDnsResolver = defaultDomainDnsResolver(),
): Promise<DomainRoutingReport> {
  const hostname = domainName(hostnameInput);
  const cname = targetInput.cname === undefined ? null : domainName(targetInput.cname);
  if (cname === hostname) throw new TypeError("Custom-domain CNAME target must differ from the customer hostname.");
  const configuredAddresses = Object.freeze(uniqueDnsValues(targetInput.addresses ?? []));
  if (!cname && configuredAddresses.length === 0) {
    throw new TypeError("Domain routing requires a CNAME target or at least one edge address.");
  }
  const [cnameLookup, ipv4Lookup, ipv6Lookup, target4Lookup, target6Lookup] = await Promise.all([
    dnsLookup(() => resolver.resolveCname(hostname), true),
    dnsLookup(() => resolver.resolve4(hostname)),
    dnsLookup(() => resolver.resolve6(hostname)),
    cname ? dnsLookup(() => resolver.resolve4(cname)) : Promise.resolve({ values: [] as string[] }),
    cname ? dnsLookup(() => resolver.resolve6(cname)) : Promise.resolve({ values: [] as string[] }),
  ]);
  const cnames = uniqueDnsValues(cnameLookup.values.map(normalizeDnsName));
  const addresses = uniqueDnsValues([...ipv4Lookup.values, ...ipv6Lookup.values]);
  const targetAddresses = new Set(uniqueDnsValues([
    ...configuredAddresses,
    ...target4Lookup.values,
    ...target6Lookup.values,
  ]));
  const cnameMatches = cname !== null && cnames.includes(cname);
  const addressMatches = addresses.some((address) => targetAddresses.has(address));
  const errors = [
    cnameLookup.error,
    ipv4Lookup.error,
    ipv6Lookup.error,
    target4Lookup.error,
    target6Lookup.error,
  ].filter((value): value is string => Boolean(value));
  const hasRecords = cnames.length > 0 || addresses.length > 0;
  const status: DomainRoutingReport["status"] = cnameMatches || addressMatches
    ? "ready"
    : errors.length > 0 && !hasRecords
      ? "error"
      : hasRecords
        ? "misconfigured"
        : "pending";
  return Object.freeze({
    hostname,
    status,
    target: Object.freeze({ cname, addresses: configuredAddresses }),
    observed: Object.freeze({ cnames: Object.freeze(cnames), addresses: Object.freeze(addresses) }),
    checkedAt: Date.now(),
    ...(errors.length > 0 ? { error: errors[0] } : {}),
  });
}

export function createMemoryDomainStore(): DomainChallengeStore & { values(): DomainChallenge[] } {
  const values = new Map<string, DomainChallenge>();
  return {
    save(challenge) {
      for (const [id, existing] of values) {
        if (id !== challenge.id && existing.hostname === challenge.hostname) values.delete(id);
      }
      values.set(challenge.id, structuredClone(challenge));
    },
    get(id) {
      const value = values.get(id);
      return value ? structuredClone(value) : undefined;
    },
    byHostname(hostname) {
      const value = [...values.values()].find((entry) => entry.hostname === hostname);
      return value ? structuredClone(value) : undefined;
    },
    values: () => [...values.values()].map((value) => structuredClone(value)),
  };
}

export function createDomainManager(options: {
  store: DomainChallengeStore;
  resolveTxt?: (hostname: string) => Promise<readonly (readonly string[])[]>;
  challengeLifetimeMs?: number;
}): DomainManager {
  const lifetime = integerRange(
    options.challengeLifetimeMs ?? 24 * 60 * 60 * 1_000,
    "challengeLifetimeMs",
    60_000,
    7 * 24 * 60 * 60 * 1_000,
  );
  const resolver = options.resolveTxt ?? defaultResolveTxt;
  return {
    async begin(projectIdInput, hostnameInput) {
      const projectId = opaque(projectIdInput, "project ID");
      const hostname = domainName(hostnameInput);
      const existing = await options.store.byHostname(hostname);
      if (existing && existing.projectId !== projectId) {
        throw new Error("Domain is already assigned to another project.");
      }
      if (existing?.status === "verified" || (existing && existing.expiresAt > Date.now())) {
        return structuredClone(existing);
      }
      const challenge: DomainChallenge = {
        id: `dom_${randomToken(18)}`,
        projectId,
        hostname,
        recordName: `_clank.${hostname}`,
        recordType: "TXT",
        recordValue: `clank-domain=${randomToken(32)}`,
        status: "pending",
        expiresAt: Date.now() + lifetime,
      };
      await options.store.save(challenge);
      return structuredClone(challenge);
    },
    async verify(idInput) {
      const id = opaque(idInput, "domain challenge ID");
      const challenge = await options.store.get(id);
      if (!challenge || challenge.expiresAt <= Date.now()) {
        throw new DomainVerificationError("INVALID_CHALLENGE", "Domain challenge is invalid or expired.");
      }
      if (challenge.status === "verified") return challenge;
      const records = await resolver(challenge.recordName);
      const values = records.map((record) => record.join(""));
      if (!values.includes(challenge.recordValue)) {
        throw new DomainVerificationError("DNS_TXT_MISSING", `DNS TXT verification failed for ${challenge.recordName}.`);
      }
      const verified: DomainChallenge = {
        ...challenge,
        status: "verified",
        verifiedAt: Date.now(),
      };
      await options.store.save(verified);
      return structuredClone(verified);
    },
  };
}

export interface SqlStatement {
  text: string;
  parameters?: readonly unknown[];
}

export interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: readonly Row[];
  rowCount: number;
}

export interface ExternalSqlDriver {
  readonly dialect: "postgres";
  query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: SqlStatement): Promise<SqlResult<Row>>;
  transaction(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
  health(): Promise<boolean>;
  close?(): void | Promise<void>;
}

export function createHttpPostgresDriver(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  headers?: Record<string, string>;
}): ExternalSqlDriver {
  const url = secureHttpUrl(options.url, "Postgres HTTP URL");
  const token = bounded(options.token, "Postgres token", 8, 16_384);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = integerRange(options.timeoutMs ?? 15_000, "timeoutMs", 100, 2 * 60_000);
  const maxResponseBytes = integerRange(
    options.maxResponseBytes ?? 8 * 1024 * 1024,
    "maxResponseBytes",
    1_024,
    100 * 1024 * 1024,
  );
  const extraHeaders = transportHeaders(options.headers ?? {});
  const execute = async (statements: readonly SqlStatement[], transaction: boolean): Promise<readonly SqlResult[]> => {
    if (statements.length === 0 || statements.length > 1_000) throw new TypeError("SQL request requires 1 to 1000 statements.");
    const normalized = statements.map(normalizeStatement);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...extraHeaders,
        },
        body: JSON.stringify({ dialect: "postgres", transaction, statements: normalized }),
      });
      if (!response.ok) throw new Error(`Postgres service returned ${response.status}.`);
      let bytes: Uint8Array;
      try { bytes = await readResponseBytes(response, maxResponseBytes); }
      catch (error) {
        if (error instanceof ResponseBodyLimitError) throw new Error("Postgres response is too large.");
        throw error;
      }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error("Postgres service returned invalid JSON."); }
      return parseSqlResults(payload, normalized.length);
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    dialect: "postgres",
    async query(statement) {
      return await execute([statement], false).then((results) => results[0] as SqlResult);
    },
    transaction: (statements) => execute(statements, true),
    async health() {
      try {
        const result = await execute([{ text: "SELECT 1 AS ok", parameters: [] }], false);
        return result[0]?.rowCount === 1;
      } catch {
        return false;
      }
    },
  };
}

export async function planExternalMigrations(
  driver: ExternalSqlDriver,
  migrations: readonly Migration[],
): Promise<MigrationPlan> {
  await driver.query({
    text: `CREATE TABLE IF NOT EXISTS clank_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )`,
  });
  const result = await driver.query<{
    id: string;
    name: string;
    checksum: string;
    applied_at: number | string;
  }>({ text: "SELECT id, name, checksum, applied_at FROM clank_migrations ORDER BY id" });
  const applied: MigrationRecord[] = result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: Number(row.applied_at),
  }));
  for (const record of applied) {
    const migration = migrations.find((entry) => entry.id === record.id);
    if (!migration || migration.name !== record.name || migration.checksum !== record.checksum) {
      throw new Error(`Applied migration ${record.id} does not match immutable migration history.`);
    }
  }
  const appliedIds = new Set(applied.map((entry) => entry.id));
  return { applied, pending: migrations.filter((entry) => !appliedIds.has(entry.id)) };
}

export async function applyExternalMigrations(
  driver: ExternalSqlDriver,
  migrations: readonly Migration[],
): Promise<MigrationPlan> {
  const plan = await planExternalMigrations(driver, migrations);
  if (!plan.pending.length) return plan;
  const statements: SqlStatement[] = [];
  for (const migration of plan.pending) {
    statements.push({ text: migration.sql });
    statements.push({
      text: "INSERT INTO clank_migrations (id, name, checksum, applied_at) VALUES ($1, $2, $3, $4)",
      parameters: [migration.id, migration.name, migration.checksum, Date.now()],
    });
  }
  await driver.transaction(statements);
  return { applied: plan.applied, pending: plan.pending };
}

export interface ExternalDatabaseBinding {
  id: string;
  engine: "postgres";
  region: string;
  connectionUrl: string;
  createdAt: number;
}

export interface ExternalDatabaseProvisioner {
  provision(input: {
    projectId: string;
    region: string;
    idempotencyKey: string;
  }): Promise<ExternalDatabaseBinding>;
  destroy(id: string, confirmation: string): Promise<void>;
}

export function createHttpDatabaseProvisioner(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): ExternalDatabaseProvisioner {
  const url = secureHttpUrl(options.url, "database provisioner URL");
  const token = bounded(options.token, "database provisioner token", 8, 16_384);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = integerRange(options.timeoutMs ?? 30_000, "timeoutMs", 1_000, 5 * 60_000);
  const request = async (path: string, body: unknown) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(new URL(path, url), {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.error ?? `Provisioner returned ${response.status}.`));
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    async provision(input) {
      const payload = await request("databases", {
        projectId: opaque(input.projectId, "project ID"),
        region: safeName(input.region, "region"),
        idempotencyKey: bounded(input.idempotencyKey, "idempotencyKey", 8, 300),
        engine: "postgres",
      });
      return {
        id: opaque(String(payload.id), "database ID"),
        engine: "postgres",
        region: safeName(String(payload.region), "region"),
        connectionUrl: connectionUrl(String(payload.connectionUrl)),
        createdAt: Number(payload.createdAt),
      };
    },
    async destroy(id, confirmation) {
      const checked = opaque(id, "database ID");
      if (confirmation !== `destroy ${checked}`) throw new Error(`Confirmation must equal "destroy ${checked}".`);
      await request(`databases/${encodeURIComponent(checked)}/destroy`, { confirmation });
    },
  };
}

function proxyRequestHeaders(request: Request, host: string, trustProxy: boolean): Headers {
  const headers = new Headers(request.headers);
  stripHopHeaders(headers);
  headers.delete("host");
  headers.delete("content-length");
  for (const name of MANAGED_INGRESS_HEADERS) headers.delete(name);
  const remote = trustProxy
    ? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    : undefined;
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-proto", new URL(request.url).protocol.slice(0, -1));
  if (remote && validIpHint(remote)) headers.set("x-forwarded-for", remote);
  else headers.delete("x-forwarded-for");
  return headers;
}

const MANAGED_INGRESS_HEADERS = [
  "x-clank-project-id",
  "x-clank-runtime-protocol",
  "x-clank-runtime-generation",
  "x-clank-runtime-ingress",
] as const;

function setRuntimeIngressHeaders(headers: Headers, runtime?: IngressRuntimeRoute): void {
  for (const name of MANAGED_INGRESS_HEADERS.slice(1)) headers.delete(name);
  if (!runtime) return;
  headers.set("x-clank-runtime-protocol", runtime.protocol);
  headers.set("x-clank-runtime-generation", String(runtime.generation));
  headers.set("x-clank-runtime-ingress", runtime.token);
}

function ingressTarget(route: IngressRoute, pathname: string, search: string): URL {
  const target = new URL(route.upstream);
  // Both parts are assigned as a pathname on the already-trusted origin.
  // Even a request path beginning with // cannot select a different host.
  target.pathname = route.runtime ? `${route.runtime.path}${pathname}` : pathname;
  target.search = search;
  return target;
}

function ingressRouteIdentity(route: IngressRoute): string {
  if (!route.runtime) return route.upstream;
  return [
    route.upstream,
    route.runtime.protocol,
    String(route.runtime.generation),
    route.runtime.path,
  ].join("\n");
}

function normalizeIngressRuntimeRoute(input: unknown): IngressRuntimeRoute {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Ingress runtime route must be an object.");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Ingress runtime route must be a plain object.");
  }
  const value = input as Record<string, unknown>;
  const fields = ["protocol", "generation", "path", "token"];
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new TypeError("Ingress runtime route contains an unknown field.");
  }
  if (fields.some((key) => !(key in value))) {
    throw new TypeError("Ingress runtime route is missing a required field.");
  }
  if (value.protocol !== "clank-runtime/1") {
    throw new TypeError("Ingress runtime protocol is unsupported.");
  }
  if (
    typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
  ) throw new TypeError("Ingress runtime generation is invalid.");
  if (
    typeof value.path !== "string"
    || value.path.length < 2
    || value.path.length > 512
    || !value.path.startsWith("/")
    || value.path.startsWith("//")
    || value.path.includes("?")
    || value.path.includes("#")
    || value.path.includes("\0")
    || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/u.test(value.path)
    || value.path.split("/").some((segment, index) =>
      index > 0 && (!segment || segment === "." || segment === ".."))
  ) throw new TypeError("Ingress runtime path is invalid.");
  if (
    typeof value.token !== "string"
    || value.token.length < 32
    || value.token.length > 512
    || /[\u0000-\u0020\u007f]/u.test(value.token)
  ) throw new TypeError("Ingress runtime token is invalid.");
  return Object.freeze({
    protocol: "clank-runtime/1",
    generation: value.generation,
    path: value.path,
    token: value.token,
  });
}

function proxyResponseHeaders(input: Headers, routeId: string): Headers {
  const headers = new Headers(input);
  stripHopHeaders(headers);
  headers.delete("server");
  for (const name of MANAGED_INGRESS_HEADERS) headers.delete(name);
  headers.set("x-clank-route-id", routeId);
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

function ingressProblem(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

async function readBoundedBody(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<{ body?: Uint8Array; size: number; tooLarge: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(result.value as ArrayBuffer);
      size += chunk.byteLength;
      if (size > maximum) {
        await reader.cancel("request body limit exceeded").catch(() => undefined);
        return { size, tooLarge: true };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return { body: new Uint8Array(), size, tooLarge: false };
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, size, tooLarge: false };
}

function normalizeStatement(statement: SqlStatement): SqlStatement {
  if (!statement || typeof statement !== "object") throw new TypeError("SQL statement is required.");
  const text = bounded(statement.text, "SQL text", 1, 10 * 1024 * 1024);
  if (text.includes("\0")) throw new TypeError("SQL text contains a null byte.");
  const parameters = statement.parameters ?? [];
  if (!Array.isArray(parameters) || parameters.length > 10_000) throw new TypeError("SQL parameters must be an array.");
  assertJson(parameters, "SQL parameters");
  return { text, parameters };
}

function parseSqlResults(value: unknown, expected: number): SqlResult[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Postgres response is invalid.");
  const results = (value as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length !== expected) throw new Error("Postgres response result count is invalid.");
  return results.map((result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Postgres result is invalid.");
    const source = result as Record<string, unknown>;
    if (!Array.isArray(source.rows) || !Number.isSafeInteger(source.rowCount) || Number(source.rowCount) < 0) {
      throw new Error("Postgres result is invalid.");
    }
    for (const row of source.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Postgres row is invalid.");
    }
    return { rows: source.rows as Record<string, unknown>[], rowCount: Number(source.rowCount) };
  });
}

const KNOWN_HTTP_METHODS = new Set(["CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "QUERY", "TRACE"]);

function knownHttpMethod(method: string): string {
  return KNOWN_HTTP_METHODS.has(method) ? method : "_OTHER";
}

let nativeDnsResolver: DomainDnsResolver | undefined;

function defaultDomainDnsResolver(): DomainDnsResolver {
  if (nativeDnsResolver) return nativeDnsResolver;
  const moduleName = "node:dns/promises";
  const load = async () => await import(moduleName) as unknown as {
    resolveCname(hostname: string): Promise<string[]>;
    resolve4(hostname: string): Promise<string[]>;
    resolve6(hostname: string): Promise<string[]>;
  };
  nativeDnsResolver = {
    async resolveCname(hostname) { return (await load()).resolveCname(hostname); },
    async resolve4(hostname) { return (await load()).resolve4(hostname); },
    async resolve6(hostname) { return (await load()).resolve6(hostname); },
  };
  return nativeDnsResolver;
}

async function dnsLookup(
  lookup: () => Promise<readonly string[]>,
  names = false,
): Promise<{ values: string[]; error?: string }> {
  try {
    const values = await lookup();
    return { values: uniqueDnsValues(values.map((value) => names ? normalizeDnsName(value) : String(value))) };
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? "");
    if (["ENODATA", "ENOTFOUND", "ENOENT", "NXDOMAIN", "NODATA"].includes(code)) return { values: [] };
    return { values: [], error: "DNS lookup is temporarily unavailable." };
  }
}

function uniqueDnsValues(values: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const input of values) {
    const value = String(input).trim().toLowerCase();
    if (!value || value.length > 253 || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length >= 32) break;
  }
  return output;
}

function normalizeDnsName(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 46) end--;
  return value.slice(0, end).toLowerCase();
}

function domainName(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/u, "");
  if (
    value.length < 1
    || value.length > 253
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)
  ) throw new TypeError(`Invalid hostname: ${input}`);
  return value;
}

function upstreamUrl(input: string, allowedHosts?: readonly string[]): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("Ingress upstream must be an HTTP(S) origin.");
  }
  if (url.pathname !== "/") throw new TypeError("Ingress upstream cannot include a path.");
  const allowed = allowedHosts?.map((host) => host.toLowerCase());
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!loopback && !(allowed?.includes(url.hostname.toLowerCase()))) {
    throw new TypeError(`Ingress upstream host is not allowed: ${url.hostname}`);
  }
  return url.origin;
}

function secureHttpUrl(input: string, name: string): string {
  const url = new URL(input);
  if (
    url.username
    || url.password
    || url.hash
    || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))
  ) throw new TypeError(`${name} must use HTTPS, except for loopback development.`);
  return url.href;
}

function connectionUrl(input: string): string {
  const url = new URL(input);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username) {
    throw new Error("Provisioner returned an invalid Postgres connection URL.");
  }
  return url.href;
}

function transportHeaders(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    if (!/^[a-z0-9-]{1,128}$/u.test(normalized)
      || ["authorization", "host", "content-length", "cookie"].includes(normalized)
      || /[\r\n\0]/u.test(value)) {
      throw new TypeError(`Invalid transport header: ${name}`);
    }
    output[normalized] = value;
  }
  return output;
}

function safeName(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u.test(value)) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function opaque(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]{8,200}$/u.test(value)) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function bounded(value: string, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} must contain ${minimum} to ${maximum} characters.`);
  }
  return value;
}

function normalizeAdmissionDenial(
  value: Exclude<IngressAdmissionDecision, { allowed: true }>,
): Exclude<IngressAdmissionDecision, { allowed: true }> {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.code)) {
    throw new TypeError("Ingress admission denial code is invalid.");
  }
  if (
    typeof value.message !== "string"
    || value.message.length < 1
    || value.message.length > 200
    || /[\u0000-\u001f\u007f]/u.test(value.message)
  ) {
    throw new TypeError("Ingress admission denial message is invalid.");
  }
  return {
    allowed: false,
    code: value.code,
    message: value.message,
    retryAfterSeconds: integerRange(
      value.retryAfterSeconds,
      "admission retryAfterSeconds",
      1,
      31 * 24 * 60 * 60,
    ),
  };
}

function integerRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function assertJson(value: unknown, name: string): void {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined");
    JSON.parse(encoded);
  } catch {
    throw new TypeError(`${name} must be JSON serializable.`);
  }
}

function randomToken(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function defaultResolveTxt(hostname: string): Promise<readonly (readonly string[])[]> {
  const dns = await import("node:dns/promises") as any;
  return await dns.resolveTxt(hostname);
}

function validIpHint(value: string): boolean {
  return /^[A-Fa-f0-9:.]{2,64}$/u.test(value);
}

async function backoff(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
