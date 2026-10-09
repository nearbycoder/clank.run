import { isRetentionHeld, type SQLiteInternal } from "./sqlite-internal.ts";
export interface SignedAuditEntry {
  readonly protocol: "clank-signed-audit/1";
  readonly sequence: number;
  readonly previousSequence: number;
  readonly previousDigest: string;
  readonly keyId: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly signature: string;
}
export interface AuditExportCheckpoint { readonly sequence: number; readonly digest: string; }
export interface AuditExportOptions {
  keyId: string;
  /** Ed25519 private key in PEM format, kept outside the control-plane database. */
  privateKey: string;
  /** Independently controlled append-only storage. Deduplicate retries by sequence and digest. */
  destination(entries: readonly SignedAuditEntry[], signal: AbortSignal): Promise<void>;
  intervalMs?: number;
  batchSize?: number;
  timeoutMs?: number;
  /** Backpressure bounds include acknowledged envelopes protected by a hold. */
  maxOutboxEntries?: number;
  maxOutboxBytes?: number;
  onError?: (error: unknown) => void;
}
export interface AuditExporter {
  flush(): Promise<number>;
  start(): void;
  status(): { exportedThrough: AuditExportCheckpoint; pending: number; retainedAcknowledged: number };
  close(): Promise<void>;
}
const ZERO = "0".repeat(64);
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
};
const unsigned = (entry: SignedAuditEntry) => ({ protocol: entry.protocol, sequence: entry.sequence, previousSequence: entry.previousSequence,
  previousDigest: entry.previousDigest, keyId: entry.keyId, event: entry.event });

/** A durable signed outbox over the platform's existing audit log. */
export async function openAuditExporter(internal: SQLiteInternal, options: AuditExportOptions): Promise<AuditExporter> {
  options = { ...options };
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(options.keyId) || typeof options.destination !== "function") throw new TypeError("Audit signing key ID and destination are required.");
  const interval = options.intervalMs ?? 60_000, batchSize = options.batchSize ?? 100, timeoutMs = options.timeoutMs ?? 15_000;
  const maxEntries = options.maxOutboxEntries ?? 10000, maxBytes = options.maxOutboxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 128 * 1024 * 1024) throw new TypeError("Invalid audit outbox retention capacity.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new TypeError("Invalid audit delivery timeout.");
  if (!Number.isInteger(interval) || interval < 1000 || interval > 3_600_000 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError("Invalid audit export cadence or batch size.");
  const cryptoName = "node:crypto";
  const crypto = await import(cryptoName);
  const key = crypto.createPrivateKey(options.privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Audit export signing requires an Ed25519 key.");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_audit_export_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), captured_sequence INTEGER NOT NULL,
    captured_digest TEXT NOT NULL, exported_sequence INTEGER NOT NULL, exported_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clank_audit_export_outbox (sequence INTEGER PRIMARY KEY, envelope TEXT NOT NULL CHECK(json_valid(envelope)));
    INSERT OR IGNORE INTO clank_audit_export_state VALUES(1,0,'${ZERO}',0,'${ZERO}');`);
  let closed = false, flight: Promise<number> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const report = (error: unknown) => { try { void Promise.resolve(options.onError?.(error)).catch(() => undefined); } catch {} };
  const flush = async (): Promise<number> => {
    if (closed) throw new Error("Audit exporter is closed.");
    if (flight) return flight;
    flight = (async () => {
      let capacityBlocked = false, captureError: unknown;
      try { internal.transaction(() => {
        let state = internal.prepare("SELECT * FROM clank_audit_export_state WHERE singleton=1").get()!;
        const usage = internal.prepare("SELECT count(*) AS entries,coalesce(sum(length(CAST(envelope AS BLOB))),0) AS bytes FROM clank_audit_export_outbox").get()!;
        let entries = Number(usage.entries), bytes = Number(usage.bytes);
        const rows = internal.prepare("SELECT id,length(CAST(metadata AS BLOB)) AS bytes FROM clank_platform_audit WHERE id > ? ORDER BY id LIMIT ?").all(state.captured_sequence, batchSize);
        for (const source of rows) {
          if (!Number.isSafeInteger(source.bytes) || Number(source.bytes) > 256 * 1024) throw new Error("Audit event exceeds export size bound.");
          const row = internal.prepare("SELECT * FROM clank_platform_audit WHERE id=?").get(source.id)!;
          const sequence = Number(row.id), previousSequence = Number(state.captured_sequence), previousDigest = String(state.captured_digest);
          if (sequence !== previousSequence + 1) throw new Error(`Audit export detected missing events after sequence ${previousSequence}.`);
          const event = { actorUserId: row.actor_user_id, actorTokenId: row.actor_token_id, projectId: row.project_id,
            organizationId: row.organization_id, action: row.action, metadata: JSON.parse(String(row.metadata)), createdAt: Number(row.created_at) };
          const material = { protocol: "clank-signed-audit/1" as const, sequence, previousSequence, previousDigest, keyId: options.keyId, event };
          const encoded = canonical(material);
          if (new TextEncoder().encode(encoded).byteLength > 256 * 1024) throw new Error("Audit event exceeds export size bound.");
          const digest = crypto.createHash("sha256").update(encoded).digest("hex");
          const signature = crypto.sign(null, new TextEncoder().encode(digest), key).toString("base64url");
          const envelope = JSON.stringify({ ...material, digest, signature });
          const envelopeBytes = new TextEncoder().encode(envelope).byteLength;
          // Deliver already captured entries even when capture is full; throwing
          // here would prevent their acknowledgement from freeing capacity.
          if (entries >= maxEntries || bytes + envelopeBytes > maxBytes) { capacityBlocked = true; break; }
          internal.prepare("INSERT INTO clank_audit_export_outbox(sequence,envelope) VALUES(?,?)").run(sequence, envelope);
          entries++; bytes += envelopeBytes;
          internal.prepare("UPDATE clank_audit_export_state SET captured_sequence=?,captured_digest=? WHERE singleton=1").run(sequence, digest);
          state = { ...state, captured_sequence: sequence, captured_digest: digest };
        }
      }); } catch (error) { captureError = error; }
      // A malformed next event must remain an explicit failure, while already
      // signed pending events still reach their independent destination.
      const pending = internal.prepare("SELECT envelope FROM clank_audit_export_outbox WHERE sequence>(SELECT exported_sequence FROM clank_audit_export_state WHERE singleton=1) ORDER BY sequence LIMIT ?").all(batchSize)
        .map((row) => JSON.parse(String(row.envelope)) as SignedAuditEntry);
      if (!pending.length) { if (captureError) throw captureError; if (capacityBlocked) throw new Error("Audit export retention capacity reached; release and retire acknowledged held data before capturing more events."); return 0; }
      const timeout = new AbortController();
      const signal = AbortSignal.any([controller.signal, timeout.signal]);
      let rejectAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("Audit destination was cancelled or exceeded its delivery deadline.")); signal.addEventListener("abort", rejectAbort, { once: true }); });
      const deliveryTimer = setTimeout(() => timeout.abort(), timeoutMs);
      try { await Promise.race([options.destination(Object.freeze(pending.map((entry) => Object.freeze(entry))), signal), aborted]); }
      finally { clearTimeout(deliveryTimer); signal.removeEventListener("abort", rejectAbort); }
      if (controller.signal.aborted) throw new Error("Audit export closed before delivery acknowledgement.");
      const last = pending.at(-1)!;
      internal.transaction(() => {
        internal.prepare("UPDATE clank_audit_export_state SET exported_sequence=?,exported_digest=? WHERE singleton=1 AND exported_sequence<?")
          .run(last.sequence, last.digest, last.sequence);
        for (const entry of pending) {
          if (!isRetentionHeld(internal, "audit", String(entry.sequence))) internal.prepare("DELETE FROM clank_audit_export_outbox WHERE sequence=?").run(entry.sequence);
        }
      });
      if (captureError) throw captureError;
      return pending.length;
    })();
    try { return await flight; } finally { flight = undefined; }
  };
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; void flush().catch(report).finally(schedule); }, interval);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };
  return {
    flush, start: schedule,
    status() { const state = internal.prepare("SELECT * FROM clank_audit_export_state WHERE singleton=1").get()!;
      return { exportedThrough: { sequence: Number(state.exported_sequence), digest: String(state.exported_digest) },
        pending: Number(internal.prepare("SELECT count(*) AS n FROM clank_audit_export_outbox WHERE sequence>?").get(state.exported_sequence)!.n),
        retainedAcknowledged: Number(internal.prepare("SELECT count(*) AS n FROM clank_audit_export_outbox WHERE sequence<=?").get(state.exported_sequence)!.n) }; },
    async close() { if (closed) return; closed = true; if (timer) clearTimeout(timer); controller.abort(); await flight?.catch(report); },
  };
}

/** Verify append order, missing events, content, signatures, and the independently retained checkpoint. */
export async function verifyAuditExport(entries: readonly SignedAuditEntry[], publicKeys: Readonly<Record<string, string>>, checkpoint: AuditExportCheckpoint = { sequence: 0, digest: ZERO }): Promise<AuditExportCheckpoint> {
  if (!Array.isArray(entries) || entries.length > 1000 || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 || !/^[a-f0-9]{64}$/.test(checkpoint.digest)) throw new TypeError("Invalid audit verification inputs.");
  const name = "node:crypto", crypto = await import(name);
  let prior = checkpoint;
  for (const entry of entries) {
    if (!entry || Object.keys(entry).sort().join(",") !== "digest,event,keyId,previousDigest,previousSequence,protocol,sequence,signature"
      || entry?.protocol !== "clank-signed-audit/1" || entry.sequence !== prior.sequence + 1 || entry.previousSequence !== prior.sequence
      || entry.previousDigest !== prior.digest || !/^[a-f0-9]{64}$/.test(entry.digest) || !/^[A-Za-z0-9_-]{86}$/.test(entry.signature)
      || !Object.hasOwn(publicKeys, entry.keyId)) throw new Error("Audit export has missing, reordered, or untrusted entries.");
    const encoded = canonical(unsigned(entry));
    if (new TextEncoder().encode(encoded).byteLength > 256 * 1024 || crypto.createHash("sha256").update(encoded).digest("hex") !== entry.digest
      || !crypto.verify(null, new TextEncoder().encode(entry.digest), publicKeys[entry.keyId]!, (globalThis as any).Buffer.from(entry.signature, "base64url"))) throw new Error("Audit export signature or content verification failed.");
    prior = { sequence: entry.sequence, digest: entry.digest };
  }
  return Object.freeze(prior);
}
