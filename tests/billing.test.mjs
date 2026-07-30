import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  BillingProviderError,
  BillingWebhookError,
  createStripeBillingProvider,
} from "../dist/billing.js";

const now = 1_800_000_000_000;
const timestamp = Math.floor(now / 1_000);
const apiKey = "sk_test_1234567890";
const webhookSecret = "whsec_clankbillingsecret";
const prices = { pro: "price_1234567890" };

function stripeResponse(endpoint, value, options = {}) {
  const response = new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(options.headers ?? {}),
    },
  });
  Object.defineProperty(response, "url", {
    value: options.url ?? endpoint,
    configurable: true,
  });
  Object.defineProperty(response, "redirected", {
    value: options.redirected ?? false,
    configurable: true,
  });
  return response;
}

function provider(overrides = {}) {
  return createStripeBillingProvider({
    apiKey,
    webhookSecret,
    prices,
    now: () => now,
    fetch: async (endpoint) => stripeResponse(endpoint, {
      id: "cs_1234567890",
      url: "https://checkout.stripe.com/c/pay/cs_1234567890",
    }),
    ...overrides,
  });
}

function checkoutInput(overrides = {}) {
  return {
    attemptId: "attempt_12345678",
    accountId: "account_12345678",
    accountEmail: "owner@example.com",
    planId: "pro",
    successUrl: "https://clank.run/billing?checkout=success",
    cancelUrl: "https://clank.run/billing?checkout=cancel",
    expiresAt: now + 31 * 60_000,
    ...overrides,
  };
}

function event(type, object, overrides = {}) {
  return {
    id: "evt_1234567890",
    object: "event",
    type,
    created: timestamp,
    livemode: false,
    data: { object },
    ...overrides,
  };
}

function metadata(overrides = {}) {
  return {
    clank_attempt_id: "attempt_12345678",
    clank_account_id: "account_12345678",
    clank_plan_id: "pro",
    ...overrides,
  };
}

function signedRequest(value, options = {}) {
  const body = options.body ?? JSON.stringify(value);
  const signedAt = options.timestamp ?? timestamp;
  const digest = createHmac("sha256", options.secret ?? webhookSecret)
    .update(`${signedAt}.${body}`)
    .digest("hex");
  return new Request(options.url ?? "https://clank.run/api/billing/webhook", {
    method: options.method ?? "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "stripe-signature": options.signature ?? `t=${signedAt},v1=${digest}`,
      ...(options.headers ?? {}),
    },
    body: options.method === "GET" ? undefined : body,
  });
}

test("Stripe checkout uses a fixed endpoint, bounded request contract, and idempotency", async () => {
  let captured;
  const billing = provider({
    fetch: async (endpoint, init) => {
      captured = { endpoint, init };
      return stripeResponse(endpoint, {
        id: "cs_1234567890",
        url: "https://checkout.stripe.com/c/pay/cs_1234567890",
      });
    },
  });

  assert.deepEqual(billing.planIds, ["pro"]);
  assert.equal(Object.isFrozen(billing), true);
  assert.deepEqual(await billing.createCheckout(checkoutInput()), {
    id: "cs_1234567890",
    url: "https://checkout.stripe.com/c/pay/cs_1234567890",
  });
  assert.equal(captured.endpoint, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.credentials, "omit");
  assert.equal(captured.init.referrerPolicy, "no-referrer");
  assert.equal(captured.init.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(captured.init.headers["stripe-version"], undefined);
  assert.equal(captured.init.headers["idempotency-key"], "clank-checkout-attempt_12345678");
  const body = captured.init.body;
  assert.equal(body.get("mode"), "subscription");
  assert.equal(body.get("line_items[0][price]"), prices.pro);
  assert.equal(body.get("customer_email"), "owner@example.com");
  assert.equal(body.get("expires_at"), String(Math.floor((now + 31 * 60_000) / 1_000)));
  assert.equal(body.get("metadata[clank_account_id]"), "account_12345678");
  assert.equal(body.get("subscription_data[metadata][clank_plan_id]"), "pro");
  assert.equal(body.get("allow_promotion_codes"), "true");
});

test("Stripe checkout verifies the public catalog against the recurring Price", async () => {
  const requests = [];
  const configuredPrice = {
    id: prices.pro,
    object: "price",
    active: true,
    livemode: false,
    currency: "usd",
    unit_amount: 1_500,
    type: "recurring",
    billing_scheme: "per_unit",
    custom_unit_amount: null,
    tiers_mode: null,
    transform_quantity: null,
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
    },
  };
  const billing = provider({
    planPrices: { pro: { currency: "usd", amount: 1_500 } },
    fetch: async (endpoint, init) => {
      requests.push({ endpoint, init });
      return endpoint.includes("/v1/prices/")
        ? stripeResponse(endpoint, configuredPrice)
        : stripeResponse(endpoint, {
            id: "cs_1234567890",
            url: "https://checkout.stripe.com/c/pay/cs_1234567890",
          });
    },
  });
  await billing.createCheckout(checkoutInput());
  await billing.createCheckout(checkoutInput());
  assert.deepEqual(requests.map((request) => request.init.method), ["GET", "POST", "POST"]);
  assert.equal(requests[0].endpoint, `https://api.stripe.com/v1/prices/${prices.pro}`);
  assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[0].init.headers["content-type"], undefined);

  for (const changed of [
    { ...configuredPrice, active: false },
    { ...configuredPrice, currency: "eur" },
    { ...configuredPrice, unit_amount: 15_001 },
    { ...configuredPrice, livemode: true },
    {
      ...configuredPrice,
      recurring: { ...configuredPrice.recurring, interval: "year" },
    },
  ]) {
    const mismatched = provider({
      planPrices: { pro: { currency: "usd", amount: 1_500 } },
      fetch: async (endpoint) => stripeResponse(endpoint, changed),
    });
    await assert.rejects(
      mismatched.createCheckout(checkoutInput()),
      (error) => error instanceof BillingProviderError
        && error.message === "The billing provider is temporarily unavailable.",
    );
  }
});

test("Stripe API versions are only sent when explicitly pinned", async () => {
  let headers;
  const billing = provider({
    apiVersion: "2026-02-25.clover",
    fetch: async (endpoint, init) => {
      headers = init.headers;
      return stripeResponse(endpoint, {
        id: "cs_1234567890",
        url: "https://checkout.stripe.com/c/pay/cs_1234567890",
      });
    },
  });
  await billing.createCheckout(checkoutInput());
  assert.equal(headers["stripe-version"], "2026-02-25.clover");
  assert.throws(
    () => provider({ apiVersion: "latest" }),
    /Stripe API version is invalid/u,
  );
});

test("Stripe portal reuses the bound customer and accepts only Stripe's hosted origin", async () => {
  let captured;
  const billing = provider({
    fetch: async (endpoint, init) => {
      captured = { endpoint, init };
      return stripeResponse(endpoint, {
        id: "bps_1234567890",
        url: "https://billing.stripe.com/p/session/1234567890",
      });
    },
  });
  assert.deepEqual(await billing.createPortal({
    customerId: "cus_1234567890",
    returnUrl: "https://clank.run/billing",
  }), {
    id: "bps_1234567890",
    url: "https://billing.stripe.com/p/session/1234567890",
  });
  assert.equal(captured.endpoint, "https://api.stripe.com/v1/billing_portal/sessions");
  assert.equal(captured.init.body.get("customer"), "cus_1234567890");
  assert.equal(captured.init.body.get("return_url"), "https://clank.run/billing");

  const hostile = provider({
    fetch: async (endpoint) => stripeResponse(endpoint, {
      id: "cs_1234567890",
      url: "https://checkout.stripe.com.evil.example/session",
    }),
  });
  await assert.rejects(
    hostile.createCheckout(checkoutInput()),
    (error) => error instanceof BillingProviderError
      && error.message === "The billing provider is temporarily unavailable.",
  );
});

test("Stripe checkout and subscription webhooks normalize signed raw events", async () => {
  const billing = provider();
  const checkout = event("checkout.session.completed", {
    id: "cs_1234567890",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    client_reference_id: "account_12345678",
    customer: "cus_1234567890",
    subscription: "sub_1234567890",
    metadata: metadata(),
  });
  assert.deepEqual(await billing.verifyWebhook(signedRequest(checkout)), {
    kind: "checkout.completed",
    id: "evt_1234567890",
    createdAt: now,
    sessionId: "cs_1234567890",
    attemptId: "attempt_12345678",
    accountId: "account_12345678",
    planId: "pro",
    customerId: "cus_1234567890",
    subscriptionId: "sub_1234567890",
  });

  const subscription = event("customer.subscription.updated", {
    id: "sub_1234567890",
    object: "subscription",
    customer: "cus_1234567890",
    status: "past_due",
    cancel_at_period_end: true,
    current_period_end: timestamp + 86_400,
    metadata: metadata(),
    items: {
      data: [{
        object: "subscription_item",
        quantity: 1,
        current_period_end: timestamp + 86_400,
        price: { id: prices.pro },
      }],
    },
  });
  assert.deepEqual(await billing.verifyWebhook(signedRequest(subscription)), {
    kind: "subscription.updated",
    id: "evt_1234567890",
    createdAt: now,
    attemptId: "attempt_12345678",
    accountId: "account_12345678",
    planId: "pro",
    customerId: "cus_1234567890",
    subscriptionId: "sub_1234567890",
    status: "past_due",
    cancelAtPeriodEnd: true,
    currentPeriodEnd: now + 86_400_000,
  });
});

test("Stripe webhook signatures bind method, URL metadata, timestamp, secret, and exact bytes", async () => {
  const billing = provider();
  const value = event("invoice.created", { object: "invoice" });
  assert.equal(await billing.verifyWebhook(signedRequest(value)), null);

  const rejected = [
    signedRequest(value, { secret: "whsec_wrongsecret123" }),
    signedRequest(value, { timestamp: timestamp - 301 }),
    signedRequest(value, { url: "https://clank.run/api/billing/webhook?debug=1" }),
    signedRequest(value, { contentType: "text/plain" }),
    signedRequest(value, { method: "GET" }),
    signedRequest(value, {
      signature: `t=${timestamp},v1=${"0".repeat(64)}`,
    }),
    signedRequest({ ...value, created: timestamp + 301 }),
  ];
  for (const request of rejected) {
    await assert.rejects(
      billing.verifyWebhook(request),
      (error) => error instanceof BillingWebhookError
        && error.message === "The billing webhook could not be verified.",
    );
  }

  const original = JSON.stringify(value);
  const signature = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${original}`)
    .digest("hex");
  await assert.rejects(
    billing.verifyWebhook(signedRequest(value, {
      body: `${original} `,
      signature: `t=${timestamp},v1=${signature}`,
    })),
    BillingWebhookError,
  );
});

test("Stripe webhook rejects cross-mode events and untrusted metadata", async () => {
  const liveBilling = provider({ apiKey: "sk_live_1234567890" });
  const checkout = event("checkout.session.completed", {
    id: "cs_1234567890",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    client_reference_id: "account_12345678",
    customer: "cus_1234567890",
    subscription: "sub_1234567890",
    metadata: metadata(),
  });
  await assert.rejects(liveBilling.verifyWebhook(signedRequest(checkout)), BillingWebhookError);

  for (const changed of [
    { ...checkout, data: { object: { ...checkout.data.object, client_reference_id: "account_other123" } } },
    { ...checkout, data: { object: { ...checkout.data.object, metadata: metadata({ clank_plan_id: "elite" }) } } },
    { ...checkout, data: { object: { ...checkout.data.object, status: "open" } } },
  ]) {
    await assert.rejects(
      provider().verifyWebhook(signedRequest(changed)),
      BillingWebhookError,
    );
  }
});

test("Stripe provider rejects invalid local inputs and malformed provider responses", async () => {
  assert.throws(() => provider({ allowPromotionCodes: "yes" }), TypeError);
  assert.throws(() => createStripeBillingProvider({
    apiKey,
    webhookSecret,
    prices: { pro: prices.pro, team: prices.pro },
  }), /unique/u);
  await assert.rejects(
    provider().createCheckout(checkoutInput({ successUrl: "http://clank.run/billing" })),
    /HTTPS URL/u,
  );
  await assert.doesNotReject(provider().createCheckout(checkoutInput({
    successUrl: "http://127.0.0.1:4200/billing",
    cancelUrl: "http://localhost:4200/billing",
  })));

  for (const responseOptions of [
    { status: 500 },
    { contentType: "text/html" },
    { redirected: true },
    { url: "https://evil.example/v1/checkout/sessions" },
    { headers: { "content-encoding": "gzip" } },
  ]) {
    const billing = provider({
      fetch: async (endpoint) => stripeResponse(endpoint, {
        id: "cs_1234567890",
        url: "https://checkout.stripe.com/c/pay/cs_1234567890",
      }, responseOptions),
    });
    await assert.rejects(billing.createCheckout(checkoutInput()), BillingProviderError);
  }
});

test("Stripe webhook request and response bodies are bounded", async () => {
  const billing = provider();
  const oversized = " ".repeat(512 * 1024 + 1);
  await assert.rejects(
    billing.verifyWebhook(signedRequest({}, { body: oversized })),
    BillingWebhookError,
  );

  const response = " ".repeat(256 * 1024 + 1);
  const api = provider({
    fetch: async (endpoint) => stripeResponse(endpoint, response, {
      headers: { "content-length": String(response.length) },
    }),
  });
  await assert.rejects(api.createCheckout(checkoutInput()), BillingProviderError);
});
