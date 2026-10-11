import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// Private first-base transport. Formatting/authentication is not source,
// filesystem, process, readiness or provider ownership authority. The producer
// and dispatcher must retain their genuine owners around every asynchronous step.
export interface SourceSQLiteTaskRequest {
  readonly protocol: "clank-source-sqlite-task/1";
  readonly operation: "backup" | "inspect" | "verify";
  readonly backupId: string;
  readonly temporaryId: string | null;
}
export interface SourceWorkerIdentity {
  readonly bindingSha256: string;
  readonly containerId: string;
  readonly sourceIncarnation: string;
}
export interface SourceWorkerChannelBinding extends SourceWorkerIdentity {
  readonly channelId: string;
}
export interface SourceWorkerInspection {
  readonly revision: number | null;
  readonly migrationCount: number;
  readonly latestMigration: string | null;
}
export interface AcceptedSourceWorkerRequest { readonly task: SourceSQLiteTaskRequest }

export const SOURCE_WORKER_REQUEST_MAX_BYTES = 2048;
export const SOURCE_WORKER_RESPONSE_MAX_BYTES = 8192;
const PROTOCOL = "clank-provider-source-worker/1";
const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const TEMPORARY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NONCE = /^[A-Za-z0-9_-]{24}$/u;
const OPERATIONS = ["backup", "inspect", "verify"] as const;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
function invalid(): never { throw new Error("Invalid private source worker protocol."); }

function own(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const fields = Reflect.ownKeys(value);
  if (fields.length !== names.length || fields.some(name => typeof name !== "string" || !names.includes(name))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(value, name);
    if (!field || !("value" in field)) invalid();
    result[name] = field.value;
  }
  return result;
}
function match(value: unknown, expression: RegExp): value is string {
  return typeof value === "string" && expression.test(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0);
}
function binding(value: unknown): SourceWorkerChannelBinding {
  const data = own(value, ["bindingSha256", "containerId", "sourceIncarnation", "channelId"]);
  if (!match(data.bindingSha256, DIGEST) || !match(data.containerId, DIGEST)
    || !match(data.sourceIncarnation, UUID) || !match(data.channelId, TEMPORARY)) invalid();
  return Object.freeze({ bindingSha256: data.bindingSha256, containerId: data.containerId,
    sourceIncarnation: data.sourceIncarnation, channelId: data.channelId });
}
function task(value: unknown): SourceSQLiteTaskRequest {
  const data = own(value, ["protocol", "operation", "backupId", "temporaryId"]);
  if (data.protocol !== "clank-source-sqlite-task/1" || !OPERATIONS.includes(data.operation as any)
    || typeof data.backupId !== "string" || data.backupId.length > 45) invalid();
  const id = /^bk_([1-9][0-9]{0,15})_[A-Za-z0-9_-]{24}$/u.exec(data.backupId);
  if (!id || !Number.isSafeInteger(Number(id[1]))) invalid();
  if (data.operation === "backup" ? !match(data.temporaryId, TEMPORARY) : data.temporaryId !== null) invalid();
  return Object.freeze({ protocol: "clank-source-sqlite-task/1", operation: data.operation as SourceSQLiteTaskRequest["operation"],
    backupId: data.backupId, temporaryId: data.temporaryId as string | null });
}
function inspection(value: unknown): SourceWorkerInspection {
  const data = own(value, ["revision", "migrationCount", "latestMigration"]);
  if (data.revision !== null && !integer(data.revision) || !integer(data.migrationCount)
    || data.latestMigration !== null && (typeof data.latestMigration !== "string"
      || !data.latestMigration || data.latestMigration.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(data.latestMigration))) invalid();
  return Object.freeze({ revision: data.revision as number | null, migrationCount: data.migrationCount,
    latestMigration: data.latestMigration as string | null });
}
function parse(encoded: unknown, maximum: number): unknown {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > maximum) invalid();
  try { return JSON.parse(encoded); } catch { invalid(); }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function keys(controlSecret: Uint8Array, value: SourceWorkerChannelBinding) {
  // Native typed-array slots avoid key getters/iterators and reject shared or
  // oversized backing input before copying. Never mutate the caller's key.
  if (!(controlSecret instanceof Uint8Array) || !ArrayBuffer.isView(controlSecret)) invalid();
  try {
    if (byteLength.call(controlSecret) !== 32) invalid();
    arrayBufferLength.call(backingBuffer.call(controlSecret));
  } catch { invalid(); }
  const copy = new Uint8Array(controlSecret);
  try {
    const derive = (direction: string) => createHmac("sha256", copy)
      .update(JSON.stringify({ protocol: "clank-provider-source-worker-key/1", direction, binding: value })).digest();
    return { request: derive("request"), response: derive("response") };
  } finally { copy.fill(0); }
}
function authenticator(key: Uint8Array, body: object): string {
  return createHmac("sha256", key).update(JSON.stringify(body)).digest("hex");
}
function authenticated(encoded: string, body: object, mac: unknown, key: Uint8Array): void {
  if (!match(mac, DIGEST) || JSON.stringify({ ...body, mac }) !== encoded
    || !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(authenticator(key, body), "hex"))) invalid();
}
function assertTaskOrder(value: SourceSQLiteTaskRequest, sequence: number, backupId: string | undefined): void {
  if (value.operation !== OPERATIONS[sequence - 1] || backupId !== undefined && value.backupId !== backupId) invalid();
}
interface Request {
  readonly protocol: typeof PROTOCOL;
  readonly kind: "request";
  readonly binding: SourceWorkerChannelBinding;
  readonly sequence: number;
  readonly nonce: string;
  readonly task: SourceSQLiteTaskRequest;
}
function request(encoded: string, expected: SourceWorkerChannelBinding, key: Uint8Array): Request {
  const data = own(parse(encoded, SOURCE_WORKER_REQUEST_MAX_BYTES),
    ["protocol", "kind", "binding", "sequence", "nonce", "task", "mac"]);
  if (data.protocol !== PROTOCOL || data.kind !== "request" || !integer(data.sequence, 1)
    || data.sequence > 3 || !match(data.nonce, NONCE)) invalid();
  const declared = binding(data.binding);
  if (JSON.stringify(declared) !== JSON.stringify(expected)) invalid();
  const body: Request = { protocol: PROTOCOL, kind: "request", binding: declared,
    sequence: data.sequence, nonce: data.nonce, task: task(data.task) };
  authenticated(encoded, body, data.mac, key);
  return Object.freeze(body);
}
interface Response {
  readonly protocol: typeof PROTOCOL;
  readonly kind: "response";
  readonly binding: SourceWorkerChannelBinding;
  readonly sequence: number;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly status: "ok" | "refused";
  readonly result: SourceWorkerInspection | null;
}
interface Pending { readonly request: Request; readonly sha256: string }

/** Wire state only; no native authority, work, filesystem or network is minted. */
export function createSourceWorkerClientProtocol(controlSecret: Uint8Array, channel: SourceWorkerChannelBinding) {
  const scope = binding(channel), secret = keys(controlSecret, scope);
  let closed = false, sequence = 0, backupId: string | undefined, pending: Pending | undefined;
  const close = () => { closed = true; pending = undefined; secret.request.fill(0); secret.response.fill(0); };
  const current = () => { if (closed) invalid(); };
  return Object.freeze({
    begin(value: SourceSQLiteTaskRequest): string {
      current(); if (pending || sequence >= 3) invalid();
      const approved = task(value); assertTaskOrder(approved, sequence + 1, backupId);
      const body: Request = { protocol: PROTOCOL, kind: "request", binding: scope,
        sequence: sequence + 1, nonce: randomBytes(18).toString("base64url"), task: approved };
      const encoded = JSON.stringify({ ...body, mac: authenticator(secret.request, body) });
      if (Buffer.byteLength(encoded, "utf8") > SOURCE_WORKER_REQUEST_MAX_BYTES) invalid();
      pending = { request: Object.freeze(body), sha256: digest(encoded) };
      sequence++; backupId ??= approved.backupId;
      return encoded;
    },
    finish(encoded: string): SourceWorkerInspection | undefined {
      current(); if (!pending) invalid();
      try {
        const data = own(parse(encoded, SOURCE_WORKER_RESPONSE_MAX_BYTES),
          ["protocol", "kind", "binding", "sequence", "nonce", "requestSha256", "status", "result", "mac"]);
        const original = pending.request;
        if (data.protocol !== PROTOCOL || data.kind !== "response"
          || JSON.stringify(binding(data.binding)) !== JSON.stringify(scope)
          || data.sequence !== original.sequence || data.nonce !== original.nonce
          || data.requestSha256 !== pending.sha256 || !["ok", "refused"].includes(data.status as any)) invalid();
        const result = data.status === "ok" && original.task.operation === "inspect" ? inspection(data.result) : null;
        if (result === null && data.result !== null) invalid();
        const body: Response = { protocol: PROTOCOL, kind: "response", binding: scope, sequence: original.sequence,
          nonce: original.nonce, requestSha256: pending.sha256, status: data.status as Response["status"], result };
        authenticated(encoded, body, data.mac, secret.response);
        pending = undefined;
        if (data.status === "refused") { close(); throw new Error("Private source worker refused initialization."); }
        if (sequence === 3) close();
        return result ?? undefined;
      } catch (error) { close(); throw error; }
    },
    close,
  });
}

/** Authenticated task receipts are wire correlation, never worker authority. */
export function createSourceWorkerServerProtocol(controlSecret: Uint8Array, identity: SourceWorkerIdentity) {
  // A new server never adopts an old channel epoch or its replay history.
  const fields = own(identity, ["bindingSha256", "containerId", "sourceIncarnation"]);
  const scope = binding({ ...fields, channelId: randomUUID() }), secret = keys(controlSecret, scope);
  const receipts = new WeakMap<AcceptedSourceWorkerRequest, Pending>(), nonces = new Set<string>();
  let closed = false, sequence = 0, backupId: string | undefined, active: AcceptedSourceWorkerRequest | undefined;
  const close = () => { closed = true; if (active) receipts.delete(active); active = undefined;
    nonces.clear(); secret.request.fill(0); secret.response.fill(0); };
  const current = () => { if (closed) invalid(); };
  const complete = (accepted: AcceptedSourceWorkerRequest, status: Response["status"], value?: unknown): string => {
    current(); const held = receipts.get(accepted);
    if (!held || active !== accepted) invalid();
    const result = status === "ok" && held.request.task.operation === "inspect" ? inspection(value) : null;
    if (result === null && value !== undefined && value !== null) invalid();
    const body: Response = { protocol: PROTOCOL, kind: "response", binding: scope,
      sequence: held.request.sequence, nonce: held.request.nonce, requestSha256: held.sha256, status, result };
    const encoded = JSON.stringify({ ...body, mac: authenticator(secret.response, body) });
    if (Buffer.byteLength(encoded, "utf8") > SOURCE_WORKER_RESPONSE_MAX_BYTES) invalid();
    receipts.delete(accepted); active = undefined;
    if (status === "refused" || sequence === 3) close();
    return encoded;
  };
  return Object.freeze({
    binding: scope,
    accept(encoded: string): AcceptedSourceWorkerRequest {
      current(); if (active || sequence >= 3) invalid();
      const approved = request(encoded, scope, secret.request);
      if (approved.sequence !== sequence + 1 || nonces.has(approved.nonce)) invalid();
      assertTaskOrder(approved.task, approved.sequence, backupId);
      const accepted = Object.freeze({ task: approved.task });
      receipts.set(accepted, { request: approved, sha256: digest(encoded) });
      active = accepted; sequence++; backupId ??= approved.task.backupId; nonces.add(approved.nonce);
      return accepted;
    },
    reply(accepted: AcceptedSourceWorkerRequest, result?: unknown): string { return complete(accepted, "ok", result); },
    refuse(accepted: AcceptedSourceWorkerRequest): string { return complete(accepted, "refused"); },
    close,
  });
}
