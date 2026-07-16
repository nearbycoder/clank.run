import type { DatabaseSchema, SQLiteDatabase } from "./backend.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";

export type ServiceKind =
  | "files"
  | "images"
  | "email"
  | "jobs"
  | "cron"
  | "search"
  | "webhooks"
  | "custom";

export interface ServiceDriver<Service = unknown> {
  readonly name: string;
  readonly kind: ServiceKind;
  readonly capabilities: readonly string[];
  readonly service: Service;
  health?(): Promise<{ ok: boolean; detail?: string }>;
  close?(): void | Promise<void>;
}

export interface ServiceRequirement {
  name: string;
  kind: ServiceKind;
  capabilities?: readonly string[];
  required?: boolean;
}

export interface ServiceRegistry {
  get<Service = unknown>(name: string): Service;
  has(name: string): boolean;
  describe(): readonly {
    name: string;
    kind: ServiceKind;
    capabilities: readonly string[];
  }[];
  assert(requirements: readonly ServiceRequirement[]): void;
  health(): Promise<Record<string, { ok: boolean; detail?: string }>>;
  close(): Promise<void>;
}

export function defineServiceDriver<Service>(
  driver: ServiceDriver<Service>,
): ServiceDriver<Service> {
  const name = serviceName(driver.name);
  const capabilities = Object.freeze([...new Set(driver.capabilities.map(serviceCapability))].sort());
  return Object.freeze({ ...driver, name, capabilities });
}

export function createServiceRegistry(
  input: readonly ServiceDriver[] | Record<string, ServiceDriver>,
): ServiceRegistry {
  const drivers = new Map<string, ServiceDriver>();
  const values = Array.isArray(input)
    ? input
    : Object.entries(input).map(([name, driver]) => ({ ...driver, name }));
  for (const raw of values) {
    const driver = defineServiceDriver(raw);
    if (drivers.has(driver.name)) throw new TypeError(`Duplicate service driver: ${driver.name}`);
    drivers.set(driver.name, driver);
  }
  return {
    get(name) {
      const driver = drivers.get(name);
      if (!driver) throw new Error(`Service driver is not configured: ${name}`);
      return driver.service;
    },
    has: (name) => drivers.has(name),
    describe: () => [...drivers.values()]
      .map(({ name, kind, capabilities }) => ({ name, kind, capabilities }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    assert(requirements) {
      const missing: string[] = [];
      for (const requirement of requirements) {
        const driver = drivers.get(requirement.name);
        if (!driver) {
          if (requirement.required !== false) missing.push(`${requirement.name} (${requirement.kind})`);
          continue;
        }
        if (driver.kind !== requirement.kind) {
          missing.push(`${requirement.name} requires ${requirement.kind}, got ${driver.kind}`);
          continue;
        }
        for (const capability of requirement.capabilities ?? []) {
          if (!driver.capabilities.includes(capability)) {
            missing.push(`${requirement.name} lacks ${capability}`);
          }
        }
      }
      if (missing.length) throw new Error(`Service requirements are not satisfied: ${missing.join("; ")}`);
    },
    async health() {
      const output: Record<string, { ok: boolean; detail?: string }> = {};
      await Promise.all([...drivers.values()].map(async (driver) => {
        try {
          output[driver.name] = driver.health ? await driver.health() : { ok: true };
        } catch (error) {
          output[driver.name] = { ok: false, detail: safeError(error) };
        }
      }));
      return output;
    },
    async close() {
      const failures: unknown[] = [];
      for (const driver of [...drivers.values()].reverse()) {
        try { await driver.close?.(); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "One or more service drivers failed to close.");
    },
  };
}

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailMessage {
  from: EmailAddress;
  to: readonly EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: EmailAddress;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  tags?: Record<string, string>;
}

export interface EmailReceipt {
  id: string;
  acceptedAt: number;
  provider?: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<EmailReceipt>;
}

export async function openFileEmailService(options: {
  directory: string;
}): Promise<EmailService> {
  const fs = await nodeFs();
  const path = await nodePath();
  const root = path.resolve(options.directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  return {
    async send(message) {
      const normalized = normalizeEmailMessage(message);
      const id = crypto.randomUUID();
      const acceptedAt = Date.now();
      const target = path.join(root, `${acceptedAt}-${id}.json`);
      const temporary = `${target}.${processId()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify({ id, acceptedAt, ...normalized }, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, target);
      return { id, acceptedAt, provider: "file" };
    },
  };
}

export function createHttpEmailService(options: {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}): EmailService {
  const url = secureHttpUrl(options.url, "email service URL");
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "timeoutMs");
  const retries = integerRange(options.retries ?? 2, "retries", 0, 10);
  const headers = cleanHeaders(options.headers ?? {});
  return {
    async send(message) {
      const normalized = normalizeEmailMessage(message);
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error("Email delivery timed out.")), timeoutMs);
        try {
          const response = await fetcher(url, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              ...headers,
              ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
              ...(normalized.idempotencyKey ? { "idempotency-key": normalized.idempotencyKey } : {}),
            },
            body: JSON.stringify(normalized),
          });
          if (response.ok) {
            const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
            return {
              id: typeof payload.id === "string" ? payload.id : crypto.randomUUID(),
              acceptedAt: Date.now(),
              provider: new URL(url).hostname,
            };
          }
          const retryable = response.status === 429 || response.status >= 500;
          lastError = new Error(`Email service returned ${response.status}.`);
          if (!retryable) throw new PermanentDeliveryError(lastError.message);
          if (attempt === retries) throw lastError;
        } catch (error) {
          if (error instanceof PermanentDeliveryError) throw error;
          lastError = error;
          if (attempt === retries) throw error;
        } finally {
          clearTimeout(timeout);
        }
        await retryDelay(attempt);
      }
      throw lastError;
    },
  };
}

export interface FileMetadata {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileObject {
  metadata: FileMetadata;
  bytes: Uint8Array;
}

export interface FileStore {
  put(key: string, value: Uint8Array | ArrayBuffer, options?: { contentType?: string }): Promise<FileMetadata>;
  get(key: string): Promise<FileObject | null>;
  stat(key: string): Promise<FileMetadata | null>;
  delete(key: string): Promise<boolean>;
  sign(input: { key: string; operation: "read" | "write"; expiresAt: number }): Promise<string>;
  verify(token: string, operation: "read" | "write"): Promise<{ key: string; expiresAt: number }>;
  handle(request: Request, prefix?: string): Promise<Response>;
}

export async function openLocalFileStore(options: {
  directory: string;
  signingKey: string | Uint8Array;
  maxFileBytes?: number;
}): Promise<FileStore> {
  const fs = await nodeFs();
  const path = await nodePath();
  const root = path.resolve(options.directory);
  const objects = path.join(root, "objects");
  const metadata = path.join(root, "metadata");
  await fs.mkdir(objects, { recursive: true, mode: 0o700 });
  await fs.mkdir(metadata, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const signingKey = secretBytes(options.signingKey, "file signing key");
  const maxFileBytes = positiveInteger(options.maxFileBytes ?? 25 * 1024 * 1024, "maxFileBytes");

  const locations = async (key: string) => {
    const normalized = fileKey(key);
    const id = await sha256(normalized);
    return {
      key: normalized,
      data: path.join(objects, id.slice(0, 2), id),
      meta: path.join(metadata, id.slice(0, 2), `${id}.json`),
    };
  };

  const readMetadata = async (key: string): Promise<FileMetadata | null> => {
    const location = await locations(key);
    try {
      const parsed = JSON.parse(await fs.readFile(location.meta, "utf8")) as FileMetadata;
      if (
        parsed.key !== location.key
        || !Number.isSafeInteger(parsed.size)
        || parsed.size < 0
        || !/^[a-f0-9]{64}$/u.test(parsed.sha256)
      ) throw new Error("Stored file metadata is invalid.");
      return parsed;
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return null;
      throw error;
    }
  };

  const store: FileStore = {
    async put(key, value, putOptions = {}) {
      const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
      if (bytes.byteLength > maxFileBytes) throw new RangeError(`File exceeds ${maxFileBytes} bytes.`);
      const location = await locations(key);
      const current = await readMetadata(location.key);
      const now = Date.now();
      const record: FileMetadata = {
        key: location.key,
        size: bytes.byteLength,
        sha256: await sha256Bytes(bytes),
        contentType: contentType(putOptions.contentType),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await fs.mkdir(path.dirname(location.data), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(location.meta), { recursive: true, mode: 0o700 });
      const suffix = `${processId()}-${crypto.randomUUID()}.tmp`;
      const dataTemporary = `${location.data}.${suffix}`;
      const metaTemporary = `${location.meta}.${suffix}`;
      try {
        await fs.writeFile(dataTemporary, bytes, { mode: 0o600, flag: "wx" });
        await fs.writeFile(metaTemporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
        await fs.rename(dataTemporary, location.data);
        await fs.rename(metaTemporary, location.meta);
      } finally {
        await fs.rm(dataTemporary, { force: true });
        await fs.rm(metaTemporary, { force: true });
      }
      return record;
    },
    async get(key) {
      const location = await locations(key);
      const record = await readMetadata(location.key);
      if (!record) return null;
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await fs.readFile(location.data)); }
      catch (error) {
        if (nodeCode(error) === "ENOENT") throw new Error(`File data is missing for ${location.key}.`);
        throw error;
      }
      if (bytes.byteLength !== record.size || await sha256Bytes(bytes) !== record.sha256) {
        throw new Error(`Stored file integrity check failed for ${location.key}.`);
      }
      return { metadata: record, bytes };
    },
    stat: readMetadata,
    async delete(key) {
      const location = await locations(key);
      const existed = Boolean(await readMetadata(location.key));
      await Promise.all([
        fs.rm(location.data, { force: true }),
        fs.rm(location.meta, { force: true }),
      ]);
      return existed;
    },
    async sign(input) {
      const payload = {
        v: 1,
        k: fileKey(input.key),
        o: input.operation,
        e: integerRange(input.expiresAt, "expiresAt", Date.now() + 1, Number.MAX_SAFE_INTEGER),
      };
      const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
      return `${encoded}.${await hmac(encoded, signingKey)}`;
    },
    async verify(token, operation) {
      if (typeof token !== "string" || token.length > 4_096) throw new Error("Invalid file capability.");
      const [encoded, signature, extra] = token.split(".");
      if (!encoded || !signature || extra || !await safeEqual(await hmac(encoded, signingKey), signature)) {
        throw new Error("Invalid file capability.");
      }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))); }
      catch { throw new Error("Invalid file capability."); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid file capability.");
      const value = payload as Record<string, unknown>;
      if (value.v !== 1 || value.o !== operation || !Number.isSafeInteger(value.e) || Number(value.e) <= Date.now()) {
        throw new Error("File capability is expired or has the wrong operation.");
      }
      return { key: fileKey(String(value.k)), expiresAt: Number(value.e) };
    },
    async handle(request, prefix = "/__clank/files") {
      const url = new URL(request.url);
      const normalizedPrefix = normalizeEndpointPrefix(prefix);
      if (!url.pathname.startsWith(`${normalizedPrefix}/`)) return fileProblem(404, "NOT_FOUND", "File endpoint not found.");
      let token: string;
      try { token = decodeURIComponent(url.pathname.slice(normalizedPrefix.length + 1)); }
      catch { return fileProblem(400, "INVALID_CAPABILITY", "Invalid file capability."); }
      try {
        if (request.method === "GET" || request.method === "HEAD") {
          const capability = await store.verify(token, "read");
          const object = await store.get(capability.key);
          if (!object) return fileProblem(404, "FILE_NOT_FOUND", "File not found.");
          const headers = new Headers({
            "content-type": object.metadata.contentType,
            "content-length": String(object.metadata.size),
            etag: `"sha256-${object.metadata.sha256}"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          });
          return new Response(request.method === "HEAD" ? null : object.bytes, { headers });
        }
        if (request.method === "PUT") {
          const capability = await store.verify(token, "write");
          const declared = Number(request.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > maxFileBytes) {
            return fileProblem(413, "FILE_TOO_LARGE", `File exceeds ${maxFileBytes} bytes.`);
          }
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength > maxFileBytes) return fileProblem(413, "FILE_TOO_LARGE", `File exceeds ${maxFileBytes} bytes.`);
          const record = await store.put(capability.key, bytes, {
            contentType: request.headers.get("content-type") ?? undefined,
          });
          return Response.json({ ok: true, file: record }, {
            status: 201,
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          });
        }
        return fileProblem(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { allow: "GET, HEAD, PUT" });
      } catch {
        return fileProblem(403, "INVALID_CAPABILITY", "File capability is invalid or expired.");
      }
    },
  };
  return store;
}

export interface JobContext {
  id: string;
  attempt: number;
  signal: AbortSignal;
}

export type JobHandler<Payload = unknown> = (
  payload: Payload,
  context: JobContext,
) => void | Promise<void>;

export interface JobRecord {
  id: string;
  type: string;
  status: "queued" | "running" | "retry" | "completed" | "dead";
  attempts: number;
  maxAttempts: number;
  runAt: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface JobQueue {
  enqueue<Payload>(type: string, payload: Payload, options?: {
    runAt?: number;
    maxAttempts?: number;
    uniqueKey?: string;
  }): Promise<{ id: string; existing: boolean }>;
  runOnce(limit?: number): Promise<number>;
  inspect(id: string): JobRecord | null;
  retry(id: string, runAt?: number): boolean;
  start(intervalMs?: number): () => void;
  close(): void;
}

export function openJobQueue<DB extends DatabaseSchema<any>>(
  database: SQLiteDatabase<DB>,
  handlers: Record<string, JobHandler>,
  options: {
    workerId?: string;
    leaseMs?: number;
    handlerTimeoutMs?: number;
    retryBaseMs?: number;
    maxBatch?: number;
    onError?: (error: unknown, job: JobRecord) => void;
  } = {},
): JobQueue {
  const internal = (database as SQLiteDatabase<DB> & { [SQLITE_INTERNAL]: SQLiteInternal })[SQLITE_INTERNAL];
  if (!internal) throw new Error("Durable jobs require a Clank SQLite database.");
  createJobTables(internal);
  const workerId = options.workerId ?? crypto.randomUUID();
  const leaseMs = positiveInteger(options.leaseMs ?? 30_000, "leaseMs");
  const handlerTimeoutMs = positiveInteger(options.handlerTimeoutMs ?? 60_000, "handlerTimeoutMs");
  const retryBaseMs = positiveInteger(options.retryBaseMs ?? 1_000, "retryBaseMs");
  const maxBatch = integerRange(options.maxBatch ?? 25, "maxBatch", 1, 1_000);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let closed = false;

  const queue: JobQueue = {
    async enqueue(type, payload, enqueueOptions = {}) {
      ensureJobType(type, handlers);
      assertJson(payload, "job payload");
      const uniqueKey = enqueueOptions.uniqueKey === undefined
        ? null
        : boundedText(enqueueOptions.uniqueKey, "uniqueKey", 1, 200);
      if (uniqueKey) {
        const existing = internal.prepare("SELECT id FROM clank_jobs WHERE type = ? AND unique_key = ?")
          .get(type, uniqueKey);
        if (existing) return { id: String(existing.id), existing: true };
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      const runAt = integerRange(enqueueOptions.runAt ?? now, "runAt", 0, Number.MAX_SAFE_INTEGER);
      const maxAttempts = integerRange(enqueueOptions.maxAttempts ?? 5, "maxAttempts", 1, 100);
      try {
        internal.transaction((changes) => {
          internal.prepare(`INSERT INTO clank_jobs
            (id, type, payload, status, attempts, max_attempts, run_at, lease_owner, lease_expires_at,
             unique_key, last_error, created_at, updated_at, completed_at)
            VALUES (?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL)`)
            .run(id, type, JSON.stringify(payload), maxAttempts, runAt, uniqueKey, now, now);
          changes.record("__jobs", id);
        });
      } catch (error) {
        if (uniqueKey && safeError(error).toLowerCase().includes("unique")) {
          const existing = internal.prepare("SELECT id FROM clank_jobs WHERE type = ? AND unique_key = ?")
            .get(type, uniqueKey);
          if (existing) return { id: String(existing.id), existing: true };
        }
        throw error;
      }
      return { id, existing: false };
    },
    async runOnce(limit = maxBatch) {
      if (closed) throw new Error("Job queue is closed.");
      const count = integerRange(limit, "limit", 1, maxBatch);
      let claimed: Array<Record<string, unknown>> = [];
      const now = Date.now();
      internal.transaction((changes) => {
        const candidates = internal.prepare(`SELECT * FROM clank_jobs
          WHERE (
            status IN ('queued', 'retry') AND run_at <= ?
          ) OR (
            status = 'running' AND lease_expires_at <= ?
          )
          ORDER BY run_at, created_at LIMIT ?`).all(now, now, count);
        for (const candidate of candidates) {
          const updated = internal.prepare(`UPDATE clank_jobs
            SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
                updated_at = ?
            WHERE id = ? AND (
              (status IN ('queued', 'retry') AND run_at <= ?)
              OR (status = 'running' AND lease_expires_at <= ?)
            )`).run(workerId, now + leaseMs, now, candidate.id, now, now);
          if (Number(updated.changes) === 1) {
            const row = internal.prepare("SELECT * FROM clank_jobs WHERE id = ?").get(candidate.id);
            if (row) claimed.push(row);
            changes.record("__jobs", String(candidate.id));
          }
        }
      });
      for (const row of claimed) {
        const record = jobRecord(row);
        const handler = handlers[record.type];
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const payload = JSON.parse(String(row.payload));
          await Promise.race([
            Promise.resolve(handler(payload, {
              id: record.id,
              attempt: record.attempts,
              signal: controller.signal,
            })),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                reject(new Error(`Job handler timed out after ${handlerTimeoutMs}ms.`));
              }, handlerTimeoutMs);
            }),
          ]);
          internal.transaction((changes) => {
            internal.prepare(`UPDATE clank_jobs
              SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
                  last_error = NULL, completed_at = ?, updated_at = ?
              WHERE id = ? AND lease_owner = ?`)
              .run(Date.now(), Date.now(), record.id, workerId);
            changes.record("__jobs", record.id);
          });
        } catch (error) {
          const failure = safeError(error).slice(0, 4_096);
          const dead = record.attempts >= record.maxAttempts;
          const runAt = Date.now() + Math.min(60 * 60 * 1_000, retryBaseMs * 2 ** Math.max(0, record.attempts - 1));
          internal.transaction((changes) => {
            internal.prepare(`UPDATE clank_jobs
              SET status = ?, run_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                  last_error = ?, updated_at = ?
              WHERE id = ? AND lease_owner = ?`)
              .run(dead ? "dead" : "retry", runAt, failure, Date.now(), record.id, workerId);
            changes.record("__jobs", record.id);
          });
          try { options.onError?.(error, { ...record, status: dead ? "dead" : "retry", lastError: failure }); }
          catch { /* Error observers cannot alter job state. */ }
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      return claimed.length;
    },
    inspect(id) {
      const row = internal.prepare("SELECT * FROM clank_jobs WHERE id = ?").get(id);
      return row ? jobRecord(row) : null;
    },
    retry(id, runAt = Date.now()) {
      const result = internal.prepare(`UPDATE clank_jobs
        SET status = 'retry', run_at = ?, attempts = 0, lease_owner = NULL,
            lease_expires_at = NULL, last_error = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead'`).run(runAt, Date.now(), id);
      return Number(result.changes) === 1;
    },
    start(intervalMs = 1_000) {
      if (closed) throw new Error("Job queue is closed.");
      if (timer) return () => queue.close();
      const interval = integerRange(intervalMs, "intervalMs", 50, 60_000);
      timer = setInterval(() => {
        if (running || closed) return;
        running = true;
        void queue.runOnce().catch(() => undefined).finally(() => { running = false; });
      }, interval);
      timer.unref?.();
      return () => {
        if (timer) clearInterval(timer);
        timer = undefined;
      };
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return queue;
}

export interface WebhookSender {
  send(input: {
    url: string;
    event: string;
    payload: unknown;
    secret: string | Uint8Array;
    idempotencyKey?: string;
  }): Promise<{ status: number; attempts: number }>;
}

export async function signWebhook(
  body: string | Uint8Array,
  secret: string | Uint8Array,
  timestamp = Math.floor(Date.now() / 1_000),
): Promise<{ timestamp: number; signature: string }> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + bytes.byteLength);
  signed.set(prefix);
  signed.set(bytes, prefix.byteLength);
  return {
    timestamp,
    signature: `v1=${await hmacBytes(signed, secretBytes(secret, "webhook secret"), "hex")}`,
  };
}

export async function verifyWebhook(input: {
  body: string | Uint8Array;
  secret: string | Uint8Array;
  timestamp: number | string;
  signature: string;
  now?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const timestamp = Number(input.timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const tolerance = positiveInteger(input.toleranceSeconds ?? 300, "toleranceSeconds");
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) return false;
  const expected = await signWebhook(input.body, input.secret, timestamp);
  return safeEqual(expected.signature, input.signature);
}

export function createWebhookSender(options: {
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
} = {}): WebhookSender {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available.");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "timeoutMs");
  const retries = integerRange(options.retries ?? 3, "retries", 0, 10);
  return {
    async send(input) {
      const url = secureHttpUrl(input.url, "webhook URL");
      const event = boundedText(input.event, "event", 1, 120);
      assertJson(input.payload, "webhook payload");
      const body = JSON.stringify(input.payload);
      const signed = await signWebhook(body, input.secret);
      const deliveryId = input.idempotencyKey ?? crypto.randomUUID();
      let lastStatus = 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(url, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "x-clank-webhook-event": event,
              "x-clank-webhook-timestamp": String(signed.timestamp),
              "x-clank-webhook-signature": signed.signature,
              "x-clank-delivery": deliveryId,
              "user-agent": "clank-webhooks/1",
            },
            body,
            redirect: "error",
          });
          lastStatus = response.status;
          if (response.ok) return { status: response.status, attempts: attempt + 1 };
          if (response.status !== 429 && response.status < 500) {
            throw new Error(`Webhook endpoint returned ${response.status}.`);
          }
        } finally {
          clearTimeout(timeout);
        }
        if (attempt < retries) await retryDelay(attempt);
      }
      throw new Error(`Webhook delivery failed after ${retries + 1} attempts (last status ${lastStatus}).`);
    },
  };
}

function createJobTables(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry', 'completed', 'dead')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    run_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    unique_key TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )`);
  internal.exec("CREATE UNIQUE INDEX IF NOT EXISTS clank_jobs_unique ON clank_jobs (type, unique_key) WHERE unique_key IS NOT NULL");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_jobs_ready ON clank_jobs (status, run_at)");
}

function jobRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    status: String(row.status) as JobRecord["status"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAt: Number(row.run_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_error === null || row.last_error === undefined ? {} : { lastError: String(row.last_error) }),
  };
}

function ensureJobType(type: string, handlers: Record<string, JobHandler>): void {
  boundedText(type, "job type", 1, 120);
  if (!Object.prototype.hasOwnProperty.call(handlers, type) || typeof handlers[type] !== "function") {
    throw new TypeError(`No job handler is registered for ${type}.`);
  }
}

function normalizeEmailMessage(message: EmailMessage): EmailMessage {
  if (!message || typeof message !== "object") throw new TypeError("Email message is required.");
  const normalized = {
    from: emailAddress(message.from, "from"),
    to: message.to.map((address, index) => emailAddress(address, `to.${index}`)),
    subject: boundedText(message.subject, "subject", 1, 998),
    ...(message.text === undefined ? {} : { text: boundedText(message.text, "text", 0, 10 * 1024 * 1024) }),
    ...(message.html === undefined ? {} : { html: boundedText(message.html, "html", 0, 10 * 1024 * 1024) }),
    ...(message.replyTo ? { replyTo: emailAddress(message.replyTo, "replyTo") } : {}),
    ...(message.headers ? { headers: cleanHeaders(message.headers) } : {}),
    ...(message.idempotencyKey ? {
      idempotencyKey: boundedText(message.idempotencyKey, "idempotencyKey", 8, 200),
    } : {}),
    ...(message.tags ? { tags: cleanTags(message.tags) } : {}),
  };
  if (normalized.to.length === 0 || normalized.to.length > 100) throw new TypeError("Email must have 1 to 100 recipients.");
  if (normalized.text === undefined && normalized.html === undefined) throw new TypeError("Email requires text or html content.");
  return normalized;
}

function emailAddress(value: EmailAddress, name: string): EmailAddress {
  if (!value || typeof value !== "object") throw new TypeError(`${name} email address is required.`);
  const email = boundedText(value.email, `${name}.email`, 3, 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new TypeError(`${name}.email is invalid.`);
  return {
    email,
    ...(value.name ? { name: boundedText(value.name, `${name}.name`, 1, 200) } : {}),
  };
}

function cleanHeaders(value: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,126}$/u.test(name) || ["authorization", "cookie", "set-cookie", "host"].includes(name)) {
      throw new TypeError(`Invalid or reserved header: ${rawName}`);
    }
    if (typeof rawValue !== "string" || /[\r\n\0]/u.test(rawValue) || rawValue.length > 8_192) {
      throw new TypeError(`Invalid header value: ${rawName}`);
    }
    output[name] = rawValue;
  }
  return output;
}

function cleanTags(value: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, tag] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(name)) throw new TypeError(`Invalid tag name: ${name}`);
    output[name] = boundedText(tag, `tags.${name}`, 0, 200);
  }
  return output;
}

function fileKey(input: string): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 512 || input.includes("\\") || input.includes("\0")) {
    throw new TypeError("Invalid file key.");
  }
  const segments = input.split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment) || segment === "." || segment === "..")) {
    throw new TypeError("Invalid file key.");
  }
  return segments.join("/");
}

function contentType(value?: string): string {
  if (!value) return "application/octet-stream";
  const normalized = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(normalized)) {
    throw new TypeError("Invalid content type.");
  }
  return normalized;
}

function fileProblem(status: number, code: string, message: string, extra?: HeadersInit): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(extra)),
    },
  });
}

function serviceName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(value)) throw new TypeError(`Invalid service name: ${value}`);
  return value;
}

function serviceCapability(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u.test(value)) throw new TypeError(`Invalid service capability: ${value}`);
  return value;
}

function secureHttpUrl(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.username
    || url.password
    || url.hash
    || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))
  ) throw new TypeError(`${name} must use HTTPS, except for loopback development.`);
  return url.href;
}

function secretBytes(value: string | Uint8Array, name: string): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  if (bytes.byteLength < 32) throw new TypeError(`${name} must contain at least 32 bytes.`);
  return bytes;
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

function boundedText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} must be a string from ${minimum} to ${maximum} characters.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  return integerRange(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function integerRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value: string, key: Uint8Array): Promise<string> {
  return hmacBytes(new TextEncoder().encode(value), key, "base64url");
}

async function hmacBytes(
  value: Uint8Array,
  key: Uint8Array,
  encoding: "base64url" | "hex",
): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", imported, value));
  if (encoding === "hex") return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return base64Url(signature);
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url.");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function retryDelay(attempt: number): Promise<void> {
  const delay = Math.min(5_000, 100 * 2 ** attempt) + Math.floor(Math.random() * 50);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function normalizeEndpointPrefix(input: string): string {
  if (typeof input !== "string") throw new TypeError("File endpoint prefix must be a string.");
  let start = 0;
  let end = input.length;
  while (start < end && input.charCodeAt(start) === 47) start++;
  while (end > start && input.charCodeAt(end - 1) === 47) end--;
  return `/${input.slice(start, end)}`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PermanentDeliveryError extends Error {}

function nodeCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

function processId(): number {
  return (globalThis as any).process?.pid ?? 0;
}

async function nodeFs(): Promise<{
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, value: string | Uint8Array, options: { mode: number; flag: string }): Promise<void>;
  readFile(path: string, encoding?: "utf8"): Promise<any>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}> {
  return await import("node:fs/promises") as any;
}

async function nodePath(): Promise<{
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
  dirname(path: string): string;
}> {
  return await import("node:path") as any;
}
