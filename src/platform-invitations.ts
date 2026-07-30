import type { EmailAddress, EmailService } from "./services.ts";
import type { SQLiteInternal } from "./sqlite-internal.ts";

export type PlatformInvitationScope = "workspace" | "personal";
export type PlatformInvitationDeliveryStatus =
  | "manual"
  | "queued"
  | "retrying"
  | "sent"
  | "failed";

export interface PlatformInvitationDeliveryOptions {
  email: EmailService;
  from: EmailAddress;
  replyTo?: EmailAddress;
  /** Longest idle poll interval. Defaults to 30 seconds. */
  intervalMs?: number;
  /** Invitations claimed by one pass. Defaults to 20. */
  batchSize?: number;
  /** Concurrent provider requests. Defaults to 2. */
  concurrency?: number;
  /** Initial retry delay. Defaults to 30 seconds. */
  retryBaseMs?: number;
  /** Maximum provider attempts. Defaults to 6. */
  maxAttempts?: number;
  /** Delivery-claim lifetime. Defaults to 60 seconds. */
  leaseMs?: number;
}

export interface PlatformInvitationDeliveryView {
  status: PlatformInvitationDeliveryStatus;
  attempts: number;
  sentAt: number | null;
}

export interface PlatformInvitationDeliveryScheduler {
  readonly configured: boolean;
  enqueue(input: {
    invitationId: string;
    scope: PlatformInvitationScope;
    token: string;
  }): PlatformInvitationDeliveryView;
  cancel(invitationId: string): void;
  view(invitationId: string): PlatformInvitationDeliveryView;
  start(): void;
  wake(): void;
  close(): Promise<void>;
}

interface InvitationClaim {
  invitationId: string;
  scope: PlatformInvitationScope;
  leaseToken: string;
  attempt: number;
  encryptedToken: string;
}

interface InvitationMessage {
  invitationId: string;
  scope: PlatformInvitationScope;
  email: string;
  inviterEmail: string;
  organizationName: string | null;
  role: string | null;
  expiresAt: number;
  token: string;
}

const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function createPlatformInvitationDeliveryScheduler(options: {
  internal: SQLiteInternal;
  publicUrl: string;
  delivery?: PlatformInvitationDeliveryOptions;
  encrypt(token: string): string;
  decrypt(encrypted: string): string;
  onError?: (error: unknown) => void;
}): PlatformInvitationDeliveryScheduler {
  const { internal } = options;
  ensurePlatformInvitationDeliverySchema(internal);
  const delivery = options.delivery ? normalizeDelivery(options.delivery) : undefined;
  pruneInvitationDeliveries(internal);
  if (!delivery) {
    internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
      state = 'cancelled', encrypted_token = NULL, next_attempt_at = NULL,
      lease_token = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE state IN ('queued', 'delivering', 'retry', 'failed')`)
      .run(Date.now());
  }
  const intervalMs = integerRange(
    delivery?.intervalMs ?? 30_000,
    "invitations.intervalMs",
    10,
    24 * 60 * 60_000,
  );
  const batchSize = integerRange(delivery?.batchSize ?? 20, "invitations.batchSize", 1, 100);
  const concurrency = integerRange(delivery?.concurrency ?? 2, "invitations.concurrency", 1, 10);
  const retryBaseMs = integerRange(
    delivery?.retryBaseMs ?? 30_000,
    "invitations.retryBaseMs",
    10,
    24 * 60 * 60_000,
  );
  const maxAttempts = integerRange(delivery?.maxAttempts ?? 6, "invitations.maxAttempts", 1, 20);
  const leaseMs = integerRange(delivery?.leaseMs ?? 60_000, "invitations.leaseMs", 100, 60 * 60_000);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let wakeRequested = false;
  let closed = false;

  const report = (error: unknown): void => {
    try { options.onError?.(error); }
    catch { /* Operator reporting cannot change queue state. */ }
  };

  const view = (invitationId: string): PlatformInvitationDeliveryView => {
    const row = internal.prepare(`SELECT state, attempt_count, sent_at
      FROM clank_platform_invitation_deliveries WHERE invitation_id = ?`).get(invitationId);
    if (!row) return { status: "manual", attempts: 0, sentAt: null };
    return deliveryView(row);
  };

  const enqueue = (input: {
    invitationId: string;
    scope: PlatformInvitationScope;
    token: string;
  }): PlatformInvitationDeliveryView => {
    if (!delivery) return { status: "manual", attempts: 0, sentAt: null };
    if (input.scope !== "workspace" && input.scope !== "personal") {
      throw new TypeError("Invitation delivery scope is invalid.");
    }
    const now = Date.now();
    internal.prepare(`INSERT INTO clank_platform_invitation_deliveries
      (invitation_id, scope, encrypted_token, state, attempt_count, next_attempt_at,
       lease_token, lease_until, provider_id, sent_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(invitation_id) DO UPDATE SET
        scope = excluded.scope,
        encrypted_token = excluded.encrypted_token,
        state = 'queued',
        attempt_count = 0,
        next_attempt_at = excluded.next_attempt_at,
        lease_token = NULL,
        lease_until = NULL,
        provider_id = NULL,
        sent_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at`)
      .run(input.invitationId, input.scope, options.encrypt(input.token), now, now, now);
    return { status: "queued", attempts: 0, sentAt: null };
  };

  const cancel = (invitationId: string): void => {
    internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
      state = 'cancelled', encrypted_token = NULL, next_attempt_at = NULL,
      lease_token = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE invitation_id = ? AND state NOT IN ('sent', 'cancelled')`)
      .run(Date.now(), invitationId);
  };

  const invitation = (claim: InvitationClaim): InvitationMessage | null => {
    const now = Date.now();
    const row = claim.scope === "workspace"
      ? internal.prepare(`SELECT i.id, i.email, i.role, i.expires_at,
            u.email AS inviter_email, o.name AS organization_name
          FROM clank_platform_invitations i
          JOIN clank_auth_users u ON u.id = i.invited_by
          JOIN clank_platform_organizations o ON o.id = i.organization_id
          WHERE i.id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > ?`).get(claim.invitationId, now)
      : internal.prepare(`SELECT i.id, i.email, NULL AS role, i.expires_at,
            u.email AS inviter_email, NULL AS organization_name
          FROM clank_platform_personal_invitations i
          JOIN clank_auth_users u ON u.id = i.invited_by
          WHERE i.id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > ?`).get(claim.invitationId, now);
    if (!row) return null;
    return {
      invitationId: String(row.id),
      scope: claim.scope,
      email: String(row.email),
      inviterEmail: String(row.inviter_email),
      organizationName: row.organization_name === null ? null : String(row.organization_name),
      role: row.role === null ? null : String(row.role),
      expiresAt: Number(row.expires_at),
      token: options.decrypt(claim.encryptedToken),
    };
  };

  const claim = (now: number): InvitationClaim[] => internal.transaction(() => {
    const rows = internal.prepare(`SELECT invitation_id, scope, encrypted_token, attempt_count
      FROM clank_platform_invitation_deliveries
      WHERE state IN ('queued', 'retry', 'delivering')
        AND encrypted_token IS NOT NULL
        AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        AND attempt_count < ?
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_attempt_at, invitation_id
      LIMIT ?`).all(now, maxAttempts, now, batchSize);
    const claims: InvitationClaim[] = [];
    for (const row of rows) {
      const invitationId = String(row.invitation_id);
      const leaseToken = `invitation_delivery_${crypto.randomUUID()}`;
      const attempt = Number(row.attempt_count) + 1;
      const updated = internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
        state = 'delivering', attempt_count = ?, lease_token = ?, lease_until = ?,
        last_error = NULL, updated_at = ?
        WHERE invitation_id = ? AND state IN ('queued', 'retry', 'delivering')
          AND attempt_count = ? AND next_attempt_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?)`)
        .run(
          attempt,
          leaseToken,
          now + leaseMs,
          now,
          invitationId,
          Number(row.attempt_count),
          now,
          now,
        );
      if (Number(updated.changes) !== 1) continue;
      claims.push({
        invitationId,
        scope: String(row.scope) as PlatformInvitationScope,
        leaseToken,
        attempt,
        encryptedToken: String(row.encrypted_token),
      });
    }
    return claims;
  });

  const work = async (entry: InvitationClaim): Promise<void> => {
    let leaseLost = false;
    const renewer = setInterval(() => {
      try {
        const now = Date.now();
        const result = internal.prepare(`UPDATE clank_platform_invitation_deliveries
          SET lease_until = ?, updated_at = ?
          WHERE invitation_id = ? AND lease_token = ? AND lease_until > ?`)
          .run(now + leaseMs, now, entry.invitationId, entry.leaseToken, now);
        if (Number(result.changes) !== 1) leaseLost = true;
      } catch (error) {
        leaseLost = true;
        report(error);
      }
    }, Math.max(50, Math.floor(leaseMs / 3)));
    renewer.unref?.();
    try {
      const message = invitation(entry);
      if (!message) {
        internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
          state = 'cancelled', encrypted_token = NULL, next_attempt_at = NULL,
          lease_token = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
          WHERE invitation_id = ? AND lease_token = ?`)
          .run(Date.now(), entry.invitationId, entry.leaseToken);
        return;
      }
      const email = invitationEmail(options.publicUrl, delivery!, message);
      const receipt = await delivery!.email.send(email);
      if (leaseLost) return;
      internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
        state = 'sent', encrypted_token = NULL, next_attempt_at = NULL,
        lease_token = NULL, lease_until = NULL, provider_id = ?, sent_at = ?,
        last_error = NULL, updated_at = ?
        WHERE invitation_id = ? AND lease_token = ?`)
        .run(receipt.id, receipt.acceptedAt, Date.now(), entry.invitationId, entry.leaseToken);
    } catch (error) {
      const now = Date.now();
      const terminal = entry.attempt >= maxAttempts;
      const retryAt = terminal
        ? null
        : now + Math.min(24 * 60 * 60_000, retryBaseMs * (2 ** Math.max(0, entry.attempt - 1)));
      internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
        state = ?, next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
        last_error = ?, updated_at = ?
        WHERE invitation_id = ? AND lease_token = ?`)
        .run(
          terminal ? "failed" : "retry",
          retryAt,
          "Invitation email delivery failed. See private operator logs.",
          now,
          entry.invitationId,
          entry.leaseToken,
        );
      report(error);
    } finally {
      clearInterval(renewer);
    }
  };

  const run = async (): Promise<void> => {
    if (!delivery || closed) return;
    pruneInvitationDeliveries(internal);
    const claims = claim(Date.now());
    try {
      await runBounded(claims, concurrency, work, () => closed);
    } finally {
      const now = Date.now();
      internal.transaction(() => {
        for (const entry of claims) {
          internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
            state = 'retry', next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
            last_error = ?, updated_at = ?
            WHERE invitation_id = ? AND lease_token = ?`)
            .run(
              now + retryBaseMs,
              "Invitation email delivery was interrupted and will retry.",
              now,
              entry.invitationId,
              entry.leaseToken,
            );
        }
      });
    }
  };

  const nextDelay = (): number => {
    const now = Date.now();
    const row = internal.prepare(`SELECT min(
        CASE WHEN lease_until IS NOT NULL AND lease_until > ? THEN lease_until ELSE next_attempt_at END
      ) AS runnable_at
      FROM clank_platform_invitation_deliveries
      WHERE state IN ('queued', 'retry', 'delivering') AND next_attempt_at IS NOT NULL`).get(now);
    if (row?.runnable_at === null || row?.runnable_at === undefined) return intervalMs;
    return Math.max(0, Math.min(intervalMs, Number(row.runnable_at) - now));
  };

  const schedule = (requestedDelayMs?: number): void => {
    if (!delivery || closed || timer || flight) return;
    let delayMs = requestedDelayMs;
    if (delayMs === undefined) {
      try { delayMs = nextDelay(); }
      catch (error) {
        report(error);
        delayMs = intervalMs;
      }
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (flight) {
        wakeRequested = true;
        return;
      }
      const current = run().catch(report);
      flight = current;
      void current.then(() => {
        if (flight === current) flight = undefined;
        if (!closed) {
          const requested = wakeRequested;
          wakeRequested = false;
          schedule(requested ? 0 : undefined);
        }
      });
    }, delayMs);
    timer.unref?.();
  };

  const wake = (): void => {
    if (!delivery || closed) return;
    if (flight) {
      wakeRequested = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    schedule(0);
  };

  return {
    configured: Boolean(delivery),
    enqueue,
    cancel,
    view,
    start() {
      if (!delivery || closed) return;
      schedule(0);
    },
    wake,
    async close() {
      if (closed) return;
      closed = true;
      wakeRequested = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await flight?.catch(() => undefined);
    },
  };
}

export function ensurePlatformInvitationDeliverySchema(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_invitation_deliveries (
    invitation_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('workspace', 'personal')),
    encrypted_token TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'delivering', 'retry', 'sent', 'failed', 'cancelled')),
    attempt_count INTEGER NOT NULL,
    next_attempt_at INTEGER,
    lease_token TEXT,
    lease_until INTEGER,
    provider_id TEXT,
    sent_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_platform_invitation_deliveries_due
    ON clank_platform_invitation_deliveries (state, next_attempt_at, lease_until)`);
}

function pruneInvitationDeliveries(internal: SQLiteInternal): void {
  const now = Date.now();
  internal.prepare(`UPDATE clank_platform_invitation_deliveries SET
    state = 'cancelled', encrypted_token = NULL, next_attempt_at = NULL,
    lease_token = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
    WHERE state IN ('queued', 'delivering', 'retry', 'failed') AND (
      (scope = 'workspace' AND NOT EXISTS (
        SELECT 1 FROM clank_platform_invitations i
        WHERE i.id = invitation_id AND i.accepted_at IS NULL
          AND i.revoked_at IS NULL AND i.expires_at > ?
      ))
      OR
      (scope = 'personal' AND NOT EXISTS (
        SELECT 1 FROM clank_platform_personal_invitations i
        WHERE i.id = invitation_id AND i.accepted_at IS NULL
          AND i.revoked_at IS NULL AND i.expires_at > ?
      ))
    )`).run(now, now, now);
  internal.prepare(`DELETE FROM clank_platform_invitation_deliveries
    WHERE state IN ('sent', 'cancelled') AND updated_at < ?`)
    .run(now - TERMINAL_RETENTION_MS);
}

function invitationEmail(
  publicUrl: string,
  delivery: PlatformInvitationDeliveryOptions,
  invitation: InvitationMessage,
) {
  const invitationUrl = new URL("/invite", publicUrl);
  invitationUrl.hash = new URLSearchParams({ token: invitation.token }).toString();
  const workspace = invitation.organizationName
    ? invitation.organizationName.replace(/[\r\n\0]+/gu, " ").trim()
    : null;
  const subject = invitation.scope === "workspace"
    ? `You are invited to ${workspace} on Clank`
    : "Create your Clank workspace";
  const access = invitation.scope === "workspace"
    ? `${invitation.role} access to ${workspace}`
    : "a private Clank account and personal workspace";
  const expiry = new Date(invitation.expiresAt).toUTCString();
  const text = [
    invitation.scope === "workspace"
      ? `${invitation.inviterEmail} invited you to join ${workspace} on Clank.`
      : `${invitation.inviterEmail} invited you to create your own workspace on Clank.`,
    "",
    `This invitation grants ${access}.`,
    `Accept by ${expiry}:`,
    invitationUrl.href,
    "",
    "The link is single-use and bound to this email address. If you did not expect it, ignore this message.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#090909;color:#f4f4f5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><div style="max-width:560px;margin:0 auto;padding:48px 24px"><div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#7ee787">Clank</div><h1 style="font-size:28px;line-height:1.2;margin:24px 0 12px">${escapeHtml(subject)}</h1><p style="color:#a1a1aa;line-height:1.7;margin:0 0 24px">${escapeHtml(invitation.inviterEmail)} invited you to receive ${escapeHtml(access)}.</p><a href="${escapeHtml(invitationUrl.href)}" style="display:inline-block;background:#f4f4f5;color:#090909;text-decoration:none;font-weight:750;padding:12px 18px;border-radius:9px">Accept invitation</a><p style="color:#71717a;font-size:12px;line-height:1.6;margin:24px 0 0">Single-use · bound to ${escapeHtml(invitation.email)} · expires ${escapeHtml(expiry)}.</p></div></body></html>`;
  return {
    from: delivery.from,
    to: [{ email: invitation.email }],
    subject,
    text,
    html,
    ...(delivery.replyTo ? { replyTo: delivery.replyTo } : {}),
    idempotencyKey: `clank-invitation-${invitation.invitationId}`,
    tags: {
      category: "invitation",
      scope: invitation.scope,
    },
  };
}

function deliveryView(row: Record<string, unknown>): PlatformInvitationDeliveryView {
  const state = String(row.state);
  const attempts = Number(row.attempt_count ?? 0);
  const status: PlatformInvitationDeliveryStatus = state === "sent"
    ? "sent"
    : state === "failed"
    ? "failed"
    : state === "retry" || (state === "delivering" && attempts > 1)
    ? "retrying"
    : state === "queued" || state === "delivering"
    ? "queued"
    : "manual";
  return {
    status,
    attempts,
    sentAt: row.sent_at === null || row.sent_at === undefined ? null : Number(row.sent_at),
  };
}

function normalizeDelivery(
  delivery: PlatformInvitationDeliveryOptions,
): PlatformInvitationDeliveryOptions {
  if (!delivery.email || typeof delivery.email.send !== "function") {
    throw new TypeError("invitations.email must implement send(message).");
  }
  return Object.freeze({
    ...delivery,
    from: emailAddress(delivery.from, "invitations.from"),
    ...(delivery.replyTo
      ? { replyTo: emailAddress(delivery.replyTo, "invitations.replyTo") }
      : {}),
  });
}

function emailAddress(value: EmailAddress, name: string): EmailAddress {
  if (!value || typeof value !== "object") throw new TypeError(`${name} is required.`);
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new TypeError(`${name}.email is invalid.`);
  }
  const displayName = value.name?.trim();
  if (
    displayName !== undefined
    && (
      displayName.length < 1
      || displayName.length > 200
      || /[\r\n\0]/u.test(displayName)
    )
  ) {
    throw new TypeError(`${name}.name is invalid.`);
  }
  return Object.freeze({
    email,
    ...(displayName ? { name: displayName } : {}),
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

async function runBounded<Input>(
  inputs: readonly Input[],
  concurrency: number,
  worker: (input: Input) => Promise<void>,
  stopped: () => boolean,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (!stopped()) {
      const index = cursor++;
      if (index >= inputs.length) return;
      await worker(inputs[index]!);
    }
  });
  await Promise.all(runners);
}

function integerRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
