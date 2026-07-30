import { readRequestBytes, readResponseBytes } from "./security.ts";

export type BillingSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface BillingCheckoutInput {
  attemptId: string;
  accountId: string;
  accountEmail: string;
  planId: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: number;
  customerId?: string;
}

export interface BillingCheckoutSession {
  id: string;
  url: string;
}

export interface BillingPortalInput {
  customerId: string;
  returnUrl: string;
}

export interface BillingPortalSession {
  id: string;
  url: string;
}

export interface BillingCheckoutCompletedEvent {
  kind: "checkout.completed";
  id: string;
  createdAt: number;
  sessionId: string;
  attemptId: string;
  accountId: string;
  planId: string;
  customerId: string;
  subscriptionId: string;
}

export interface BillingSubscriptionUpdatedEvent {
  kind: "subscription.updated";
  id: string;
  createdAt: number;
  attemptId: string;
  accountId: string;
  planId: string;
  customerId: string;
  subscriptionId: string;
  status: BillingSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
}

export type BillingProviderEvent =
  | BillingCheckoutCompletedEvent
  | BillingSubscriptionUpdatedEvent;

export interface BillingProvider {
  readonly name: string;
  readonly planIds: readonly string[];
  createCheckout(input: BillingCheckoutInput): Promise<BillingCheckoutSession>;
  createPortal(input: BillingPortalInput): Promise<BillingPortalSession>;
  verifyWebhook(request: Request): Promise<BillingProviderEvent | null>;
}

export interface StripeBillingProviderOptions {
  apiKey: string;
  webhookSecret: string;
  prices: Readonly<Record<string, string>>;
  /**
   * Optional public catalog prices keyed by plan ID. When present, the Stripe
   * Price is verified before the first checkout for each plan in this process.
   */
  planPrices?: Readonly<Record<string, {
    currency: string;
    amount: number;
  }>>;
  /** Optional version already tested and pinned in Stripe Workbench. Uses the account default when omitted. */
  apiVersion?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  webhookToleranceMs?: number;
  allowPromotionCodes?: boolean;
}

const STRIPE_API_ORIGIN = "https://api.stripe.com";
const MAX_API_RESPONSE_BYTES = 256 * 1024;
const MAX_WEBHOOK_BYTES = 512 * 1024;
const MAX_SIGNATURE_BYTES = 8 * 1024;

export class BillingProviderError extends Error {
  readonly code = "BILLING_PROVIDER_UNAVAILABLE";

  constructor(message = "The billing provider is temporarily unavailable.", cause?: unknown) {
    super(message, { cause });
    this.name = "BillingProviderError";
  }
}

export class BillingWebhookError extends Error {
  readonly code = "INVALID_BILLING_WEBHOOK";

  constructor(cause?: unknown) {
    super("The billing webhook could not be verified.", { cause });
    this.name = "BillingWebhookError";
  }
}

export function createStripeBillingProvider(
  options: StripeBillingProviderOptions,
): BillingProvider {
  if (!plain(options)) throw new TypeError("Stripe billing options are required.");
  const apiKey = secret(options.apiKey, "Stripe API key", /^sk_(?:test|live)_[\x21-\x7e]{8,500}$/u);
  const webhookSecret = secret(
    options.webhookSecret,
    "Stripe webhook secret",
    /^whsec_[A-Za-z0-9_-]{8,500}$/u,
  );
  const prices = normalizePrices(options.prices);
  const planPrices = options.planPrices === undefined
    ? null
    : normalizePlanPrices(options.planPrices, prices);
  const apiVersion = options.apiVersion === undefined
    ? undefined
    : secret(
      options.apiVersion,
      "Stripe API version",
      /^(?:20[0-9]{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])\.[a-z][a-z0-9_-]{1,31}$/u,
    );
  const planIds = Object.freeze([...prices.keys()].sort());
  const fetcher = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  const timeoutMs = integer(
    options.timeoutMs ?? 10_000,
    "Stripe timeout",
    100,
    60_000,
  );
  const webhookToleranceMs = integer(
    options.webhookToleranceMs ?? 5 * 60_000,
    "Stripe webhook tolerance",
    1_000,
    60 * 60_000,
  );
  if (
    options.allowPromotionCodes !== undefined
    && typeof options.allowPromotionCodes !== "boolean"
  ) throw new TypeError("Stripe promotion-code setting must be a boolean.");
  const liveMode = apiKey.startsWith("sk_live_");
  const verifiedPrices = new Map<string, Promise<void>>();

  const stripeRequest = async (
    method: "GET" | "POST",
    pathname: string,
    body?: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> => {
    const endpoint = `${STRIPE_API_ORIGIN}${pathname}`;
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          authorization: `Bearer ${apiKey}`,
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(apiVersion ? { "stripe-version": apiVersion } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body,
      });
    } catch (error) {
      throw new BillingProviderError(undefined, error);
    }
    if (
      response.status !== 200
      || response.redirected
      || response.url !== endpoint
      || response.headers.has("content-encoding")
      || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new BillingProviderError();
    }
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await readResponseBytes(response, MAX_API_RESPONSE_BYTES),
      ));
      if (!plain(value)) throw new TypeError("Stripe response is not an object.");
      return value;
    } catch (error) {
      throw new BillingProviderError(undefined, error);
    }
  };

  const verifyPlanPrice = async (planId: string): Promise<void> => {
    if (!planPrices) return;
    const current = verifiedPrices.get(planId);
    if (current) return await current;
    const pending = (async () => {
      try {
        const priceId = prices.get(planId)!;
        const expected = planPrices.get(planId)!;
        const value = await stripeRequest("GET", `/v1/prices/${priceId}`);
        if (
          stripeId(value.id, "price") !== priceId
          || value.object !== "price"
          || value.active !== true
          || value.livemode !== liveMode
          || value.currency !== expected.currency
          || value.unit_amount !== expected.amount
          || value.type !== "recurring"
          || value.billing_scheme !== "per_unit"
          || value.custom_unit_amount !== null
          || value.tiers_mode !== null
          || value.transform_quantity !== null
          || !plain(value.recurring)
          || value.recurring.interval !== "month"
          || value.recurring.interval_count !== 1
          || value.recurring.usage_type !== "licensed"
        ) throw new TypeError("Stripe Price does not match the Clank plan catalog.");
      } catch (error) {
        verifiedPrices.delete(planId);
        if (error instanceof BillingProviderError) throw error;
        throw new BillingProviderError(undefined, error);
      }
    })();
    verifiedPrices.set(planId, pending);
    return await pending;
  };

  return Object.freeze({
    name: "stripe",
    planIds,
    async createCheckout(input) {
      const normalized = normalizeCheckout(input, prices, clock());
      await verifyPlanPrice(normalized.planId);
      const body = new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": prices.get(normalized.planId)!,
        "line_items[0][quantity]": "1",
        client_reference_id: normalized.accountId,
        success_url: normalized.successUrl,
        cancel_url: normalized.cancelUrl,
        expires_at: String(Math.floor(normalized.expiresAt / 1_000)),
        "metadata[clank_attempt_id]": normalized.attemptId,
        "metadata[clank_account_id]": normalized.accountId,
        "metadata[clank_plan_id]": normalized.planId,
        "subscription_data[metadata][clank_attempt_id]": normalized.attemptId,
        "subscription_data[metadata][clank_account_id]": normalized.accountId,
        "subscription_data[metadata][clank_plan_id]": normalized.planId,
        ...(options.allowPromotionCodes === false ? {} : { allow_promotion_codes: "true" }),
        ...(normalized.customerId
          ? { customer: normalized.customerId }
          : { customer_email: normalized.accountEmail }),
      });
      const value = await stripeRequest(
        "POST",
        "/v1/checkout/sessions",
        body,
        `clank-checkout-${normalized.attemptId}`,
      );
      try {
        return Object.freeze({
          id: stripeId(value.id, "cs"),
          url: stripeHostedUrl(value.url, "checkout.stripe.com"),
        });
      } catch (error) {
        throw new BillingProviderError(undefined, error);
      }
    },
    async createPortal(input) {
      if (!plain(input)) throw new TypeError("Billing portal input is invalid.");
      const customerId = stripeId(input.customerId, "cus");
      const returnUrl = billingReturnUrl(input.returnUrl, "returnUrl");
      const value = await stripeRequest(
        "POST",
        "/v1/billing_portal/sessions",
        new URLSearchParams({ customer: customerId, return_url: returnUrl }),
      );
      try {
        return Object.freeze({
          id: stripeId(value.id, "bps"),
          url: stripeHostedUrl(value.url, "billing.stripe.com"),
        });
      } catch (error) {
        throw new BillingProviderError(undefined, error);
      }
    },
    async verifyWebhook(request) {
      try {
        if (
          request.method !== "POST"
          || new URL(request.url).search
          || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
            !== "application/json"
        ) {
          throw new TypeError("Stripe webhook request metadata is invalid.");
        }
        const signature = request.headers.get("stripe-signature");
        if (
          !signature
          || new TextEncoder().encode(signature).byteLength > MAX_SIGNATURE_BYTES
          || /[\u0000-\u001f\u007f]/u.test(signature)
        ) throw new TypeError("Stripe signature is invalid.");
        const bytes = await readRequestBytes(request, MAX_WEBHOOK_BYTES);
        const signedAt = await verifyStripeSignature(
          bytes,
          signature,
          webhookSecret,
          clock(),
          webhookToleranceMs,
        );
        const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return normalizeStripeEvent(event, prices, liveMode, signedAt, webhookToleranceMs);
      } catch (error) {
        if (error instanceof BillingWebhookError) throw error;
        throw new BillingWebhookError(error);
      }
    },
  });
}

async function verifyStripeSignature(
  bytes: Uint8Array,
  header: string,
  secretValue: string,
  now: number,
  tolerance: number,
): Promise<number> {
  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index < 1) throw new TypeError("Stripe signature part is invalid.");
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (key === "t") timestamps.push(value);
    if (key === "v1") signatures.push(value);
  }
  if (
    timestamps.length !== 1
    || signatures.length < 1
    || signatures.length > 20
    || !/^[1-9][0-9]{0,15}$/u.test(timestamps[0]!)
  ) throw new TypeError("Stripe signature fields are invalid.");
  const timestampSeconds = Number(timestamps[0]);
  const timestamp = timestampSeconds * 1_000;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    throw new TypeError("Stripe signature timestamp is outside the accepted window.");
  }
  const prefix = new TextEncoder().encode(`${timestampSeconds}.`);
  const payload = new Uint8Array(prefix.byteLength + bytes.byteLength);
  payload.set(prefix);
  payload.set(bytes, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const signature of signatures) {
    if (!/^[a-f0-9]{64}$/u.test(signature)) continue;
    if (await crypto.subtle.verify("HMAC", key, hex(signature), payload)) return timestamp;
  }
  throw new TypeError("Stripe signature does not match.");
}

function normalizeStripeEvent(
  value: unknown,
  prices: ReadonlyMap<string, string>,
  liveMode: boolean,
  signedAt: number,
  tolerance: number,
): BillingProviderEvent | null {
  if (!plain(value) || !plain(value.data) || !plain(value.data.object)) {
    throw new TypeError("Stripe event is invalid.");
  }
  const id = stripeId(value.id, "evt");
  const createdAt = seconds(value.created, "event.created");
  if (createdAt > signedAt + tolerance) {
    throw new TypeError("Stripe event creation time is after its signed delivery.");
  }
  if (
    value.object !== "event"
    || value.livemode !== liveMode
  ) throw new TypeError("Stripe event metadata is invalid.");
  const object = value.data.object;
  if (value.type === "checkout.session.completed") {
    const metadata = clankMetadata(object.metadata, prices);
    if (
      object.object !== "checkout.session"
      || object.mode !== "subscription"
      || object.status !== "complete"
      || object.client_reference_id !== metadata.accountId
    ) throw new TypeError("Stripe checkout event is invalid.");
    return Object.freeze({
      kind: "checkout.completed",
      id,
      createdAt,
      sessionId: stripeId(object.id, "cs"),
      attemptId: metadata.attemptId,
      accountId: metadata.accountId,
      planId: metadata.planId,
      customerId: stripeId(object.customer, "cus"),
      subscriptionId: stripeId(object.subscription, "sub"),
    });
  }
  if (
    value.type === "customer.subscription.created"
    || value.type === "customer.subscription.updated"
    || value.type === "customer.subscription.deleted"
  ) {
    const metadata = clankMetadata(object.metadata, prices);
    if (object.object !== "subscription") {
      throw new TypeError("Stripe subscription event is invalid.");
    }
    const status = subscriptionStatus(
      value.type === "customer.subscription.deleted" ? "canceled" : object.status,
    );
    if (typeof object.cancel_at_period_end !== "boolean") {
      throw new TypeError("Stripe subscription cancellation state is invalid.");
    }
    return Object.freeze({
      kind: "subscription.updated",
      id,
      createdAt,
      attemptId: metadata.attemptId,
      accountId: metadata.accountId,
      planId: subscriptionPlanId(object, prices),
      customerId: stripeId(object.customer, "cus"),
      subscriptionId: stripeId(object.id, "sub"),
      status,
      cancelAtPeriodEnd: object.cancel_at_period_end,
      currentPeriodEnd: subscriptionPeriodEnd(object),
    });
  }
  return null;
}

function normalizeCheckout(
  value: BillingCheckoutInput,
  prices: ReadonlyMap<string, string>,
  now: number,
): Required<Omit<BillingCheckoutInput, "customerId">> & { customerId?: string } {
  if (!plain(value)) throw new TypeError("Billing checkout input is invalid.");
  const planId = identifier(value.planId, "planId", 2, 64);
  if (!prices.has(planId)) throw new TypeError("Billing plan is not configured.");
  const accountEmail = text(value.accountEmail, "accountEmail", 3, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(accountEmail)) {
    throw new TypeError("Billing account email is invalid.");
  }
  return {
    attemptId: identifier(value.attemptId, "attemptId", 8, 128),
    accountId: identifier(value.accountId, "accountId", 8, 128),
    accountEmail,
    planId,
    successUrl: billingReturnUrl(value.successUrl, "successUrl"),
    cancelUrl: billingReturnUrl(value.cancelUrl, "cancelUrl"),
    expiresAt: checkoutExpiration(value.expiresAt, now),
    ...(value.customerId === undefined
      ? {}
      : { customerId: stripeId(value.customerId, "cus") }),
  };
}

function checkoutExpiration(value: unknown, now: number): number {
  const current = integer(now, "current time", 1, Number.MAX_SAFE_INTEGER);
  const expiresAt = integer(
    value,
    "expiresAt",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (expiresAt < current + 30 * 60_000 || expiresAt > current + 24 * 60 * 60_000) {
    throw new TypeError("expiresAt must be 30 minutes through 24 hours in the future.");
  }
  return expiresAt;
}

function clankMetadata(
  value: unknown,
  prices: ReadonlyMap<string, string>,
): { attemptId: string; accountId: string; planId: string } {
  if (!plain(value)) throw new TypeError("Stripe metadata is invalid.");
  const planId = identifier(value.clank_plan_id, "planId", 2, 64);
  if (!prices.has(planId)) throw new TypeError("Stripe plan is not configured.");
  return {
    attemptId: identifier(value.clank_attempt_id, "attemptId", 8, 128),
    accountId: identifier(value.clank_account_id, "accountId", 8, 128),
    planId,
  };
}

function normalizePrices(value: unknown): ReadonlyMap<string, string> {
  if (!plain(value)) throw new TypeError("Stripe prices must be an object.");
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 50) {
    throw new TypeError("Stripe prices must contain 1 through 50 plans.");
  }
  const output = new Map<string, string>();
  const seenPrices = new Set<string>();
  for (const [rawPlanId, rawPriceId] of entries) {
    const planId = identifier(rawPlanId, "planId", 2, 64);
    const priceId = stripeId(rawPriceId, "price");
    if (output.has(planId) || seenPrices.has(priceId)) {
      throw new TypeError("Stripe plan and price mappings must be unique.");
    }
    output.set(planId, priceId);
    seenPrices.add(priceId);
  }
  return output;
}

function normalizePlanPrices(
  value: unknown,
  prices: ReadonlyMap<string, string>,
): ReadonlyMap<string, { currency: string; amount: number }> {
  if (!plain(value)) throw new TypeError("Stripe catalog prices must be an object.");
  const entries = Object.entries(value);
  if (
    entries.length !== prices.size
    || entries.some(([planId]) => !prices.has(planId))
  ) throw new TypeError("Stripe catalog prices must exactly match Stripe plan mappings.");
  const output = new Map<string, { currency: string; amount: number }>();
  for (const [planId, raw] of entries) {
    if (!plain(raw) || Object.keys(raw).some((key) => !["currency", "amount"].includes(key))) {
      throw new TypeError(`Stripe catalog price for ${planId} is invalid.`);
    }
    const currency = text(raw.currency, "Stripe catalog currency", 3, 3).toLowerCase();
    if (!/^[a-z]{3}$/u.test(currency)) throw new TypeError("Stripe catalog currency is invalid.");
    const amount = integer(raw.amount, "Stripe catalog amount", 0, 1_000_000_000_000);
    output.set(planId, Object.freeze({ currency, amount }));
  }
  return output;
}

function subscriptionStatus(value: unknown): BillingSubscriptionStatus {
  if (![
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ].includes(String(value))) throw new TypeError("Stripe subscription status is invalid.");
  return value as BillingSubscriptionStatus;
}

function subscriptionPlanId(
  value: Record<string, any>,
  prices: ReadonlyMap<string, string>,
): string {
  if (!plain(value.items) || !Array.isArray(value.items.data) || value.items.data.length !== 1) {
    throw new TypeError("Stripe subscription must contain exactly one plan item.");
  }
  const item = value.items.data[0];
  if (
    !plain(item)
    || item.object !== "subscription_item"
    || item.quantity !== 1
    || !plain(item.price)
  ) throw new TypeError("Stripe subscription plan item is invalid.");
  const priceId = stripeId(item.price.id, "price");
  for (const [planId, configuredPriceId] of prices) {
    if (configuredPriceId === priceId) return planId;
  }
  throw new TypeError("Stripe subscription price is not configured.");
}

function subscriptionPeriodEnd(value: Record<string, any>): number | null {
  if (value.current_period_end !== undefined) {
    return seconds(value.current_period_end, "subscription.current_period_end");
  }
  const rows = plain(value.items) && Array.isArray(value.items.data) ? value.items.data : [];
  const periods = rows.slice(0, 100).map((row) => {
    if (!plain(row)) throw new TypeError("Stripe subscription item is invalid.");
    return seconds(row.current_period_end, "subscription item current_period_end");
  });
  return periods.length ? Math.max(...periods) : null;
}

function stripeHostedUrl(value: unknown, hostname: string): string {
  const normalized = httpsUrl(value, "Stripe hosted URL");
  const url = new URL(normalized);
  if (url.origin !== `https://${hostname}`) throw new TypeError("Stripe hosted URL is invalid.");
  return normalized;
}

function httpsUrl(value: unknown, name: string): string {
  const raw = text(value, name, 10, 2_048);
  const url = new URL(raw);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
  ) throw new TypeError(`${name} must be an HTTPS URL.`);
  return url.href;
}

function billingReturnUrl(value: unknown, name: string): string {
  const raw = text(value, name, 10, 2_048);
  const url = new URL(raw);
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username
    || url.password
    || url.hash
  ) throw new TypeError(`${name} must be an HTTPS URL, except for loopback development.`);
  return url.href;
}

function stripeId(value: unknown, prefix: string): string {
  const raw = text(value, `${prefix} ID`, prefix.length + 3, 255);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]{3,240}$`, "u").test(raw)) {
    throw new TypeError(`Stripe ${prefix} ID is invalid.`);
  }
  return raw;
}

function identifier(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  const raw = text(value, name, minimum, maximum);
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) throw new TypeError(`${name} is invalid.`);
  return raw;
}

function text(value: unknown, name: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new TypeError(`${name} is invalid.`);
  return value;
}

function secret(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new TypeError(`${name} is invalid.`);
  return value;
}

function seconds(value: unknown, name: string): number {
  const secondsValue = integer(value, name, 1, Math.floor(Number.MAX_SAFE_INTEGER / 1_000));
  return secondsValue * 1_000;
}

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function plain(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
