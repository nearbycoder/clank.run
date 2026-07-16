import type { Migration, MigrationPlan, MigrationRecord } from "./migrations.ts";

export interface IngressRoute {
  id: string;
  projectId: string;
  hosts: readonly string[];
  upstream: string;
  active: boolean;
}

export interface IngressRouteStore {
  routes(): readonly IngressRoute[] | Promise<readonly IngressRoute[]>;
}

export interface ManagedIngress {
  handle(request: Request): Promise<Response>;
  health(): Promise<Record<string, { ok: boolean; status?: number; error?: string }>>;
}

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
}): ManagedIngress {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = integerRange(options.timeoutMs ?? 30_000, "timeoutMs", 100, 5 * 60_000);
  const maxBodyBytes = integerRange(options.maxBodyBytes ?? 25 * 1024 * 1024, "maxBodyBytes", 1, Number.MAX_SAFE_INTEGER);
  const retries = integerRange(options.retries ?? 1, "retries", 0, 3);
  const circuitFailures = integerRange(options.circuitFailures ?? 5, "circuitFailures", 1, 100);
  const circuitResetMs = integerRange(options.circuitResetMs ?? 30_000, "circuitResetMs", 100, 60 * 60_000);
  const circuits = new Map<string, { failures: number; openedAt: number }>();
  const routeSource = typeof options.routes === "function"
    ? options.routes
    : () => options.routes.routes();

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
      const circuit = circuits.get(route.id);
      if (circuit && circuit.failures >= circuitFailures && Date.now() - circuit.openedAt < circuitResetMs) {
        return ingressProblem(503, "UPSTREAM_UNAVAILABLE", "Application is temporarily unavailable.", {
          "retry-after": String(Math.max(1, Math.ceil((circuitResetMs - (Date.now() - circuit.openedAt)) / 1_000))),
        });
      }
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return ingressProblem(413, "REQUEST_TOO_LARGE", `Request exceeds ${maxBodyBytes} bytes.`);
      }
      let body: Uint8Array | undefined;
      if (request.body && !["GET", "HEAD"].includes(request.method)) {
        body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > maxBodyBytes) {
          return ingressProblem(413, "REQUEST_TOO_LARGE", `Request exceeds ${maxBodyBytes} bytes.`);
        }
      }
      const target = new URL(`${url.pathname}${url.search}`, `${route.upstream}/`);
      const headers = proxyRequestHeaders(request, host, options.trustProxy === true);
      headers.set("x-clank-project-id", route.projectId);
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
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status >= 500) {
            const current = circuits.get(route.id) ?? { failures: 0, openedAt: 0 };
            current.failures++;
            if (current.failures >= circuitFailures) current.openedAt = Date.now();
            circuits.set(route.id, current);
            if (attempt + 1 < attempts) {
              await response.body?.cancel().catch(() => undefined);
              await backoff(attempt);
              continue;
            }
          } else {
            circuits.delete(route.id);
          }
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: proxyResponseHeaders(response.headers, route.id),
          });
        } catch (error) {
          lastError = error;
          const current = circuits.get(route.id) ?? { failures: 0, openedAt: 0 };
          current.failures++;
          if (current.failures >= circuitFailures) current.openedAt = Date.now();
          circuits.set(route.id, current);
          if (attempt + 1 < attempts) await backoff(attempt);
        } finally {
          clearTimeout(timeout);
        }
      }
      void lastError;
      return ingressProblem(502, "UPSTREAM_FAILED", "Application upstream could not be reached.");
    },
    async health() {
      const output: Record<string, { ok: boolean; status?: number; error?: string }> = {};
      await Promise.all((await loadRoutes()).filter((route) => route.active).map(async (route) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5_000));
        try {
          const response = await fetcher(new URL("/healthz", `${route.upstream}/`), {
            method: "GET",
            signal: controller.signal,
            redirect: "manual",
          });
          output[route.id] = { ok: response.ok, status: response.status };
        } catch (error) {
          output[route.id] = { ok: false, error: safeError(error) };
        } finally {
          clearTimeout(timeout);
        }
      }));
      return output;
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

export function createMemoryDomainStore(): DomainChallengeStore & { values(): DomainChallenge[] } {
  const values = new Map<string, DomainChallenge>();
  return {
    save(challenge) { values.set(challenge.id, structuredClone(challenge)); },
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
      if (existing?.status === "verified" && existing.projectId !== projectId) {
        throw new Error("Domain is already assigned to another project.");
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
      if (!challenge || challenge.expiresAt <= Date.now()) throw new Error("Domain challenge is invalid or expired.");
      if (challenge.status === "verified") return challenge;
      const records = await resolver(challenge.recordName);
      const values = records.map((record) => record.join(""));
      if (!values.includes(challenge.recordValue)) {
        throw new Error(`DNS TXT verification failed for ${challenge.recordName}.`);
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
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxResponseBytes) throw new Error("Postgres response is too large.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxResponseBytes) throw new Error("Postgres response is too large.");
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
  const remote = trustProxy
    ? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    : undefined;
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-proto", new URL(request.url).protocol.slice(0, -1));
  if (remote && validIpHint(remote)) headers.set("x-forwarded-for", remote);
  else headers.delete("x-forwarded-for");
  return headers;
}

function proxyResponseHeaders(input: Headers, routeId: string): Headers {
  const headers = new Headers(input);
  stripHopHeaders(headers);
  headers.delete("server");
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
