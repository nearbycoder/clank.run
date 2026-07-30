import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPlatform } from "../dist/platform.js";

function jsonRequest(path, {
  method = "GET",
  body,
  token,
  cookie,
  csrf,
} = {}) {
  return new Request(`http://127.0.0.1:4200${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4200",
      }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-clank-csrf": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function payload(platform, request, expected = 200) {
  const response = await platform.handle(request);
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

async function authorize(platform, email) {
  const registered = await platform.handle(jsonRequest("/__clank/auth/register", {
    method: "POST",
    body: {
      email,
      password: "correct horse battery staple",
      profile: { name: "Billing owner" },
    },
  }));
  assert.equal(registered.status, 201);
  const session = await registered.json();
  const cookie = registered.headers.get("set-cookie").split(";", 1)[0];
  const started = await payload(platform, jsonRequest("/api/device/start", {
    method: "POST",
    body: { clientName: "billing test" },
  }), 201);
  await payload(platform, jsonRequest("/api/device/approve", {
    method: "POST",
    body: { code: started.userCode },
    cookie,
    csrf: session.csrfToken,
  }));
  const token = await payload(platform, jsonRequest("/api/device/token", {
    method: "POST",
    body: { deviceCode: started.deviceCode },
  }));
  return {
    user: session.user,
    cookie,
    csrf: session.csrfToken,
    token: token.accessToken,
  };
}

function fakeBillingProvider(calls) {
  return Object.freeze({
    name: "testbilling",
    planIds: Object.freeze(["pro", "team"]),
    async createCheckout(input) {
      calls.checkout.push(input);
      return Object.freeze({
        id: calls.checkoutId ?? "cs_billing123",
        url: calls.checkoutUrl ?? "https://checkout.example.test/session",
      });
    },
    async createPortal(input) {
      calls.portal.push(input);
      return Object.freeze({
        id: "bps_billing123",
        url: "https://billing.example.test/session",
      });
    },
    async verifyWebhook(request) {
      calls.webhook++;
      return JSON.parse(await request.text());
    },
  });
}

function billingOptions(provider) {
  return {
    defaultPlanId: "free",
    pastDueGraceMs: 60 * 60_000,
    provider,
    plans: [{
      id: "free",
      name: "Free",
      description: "For one small project.",
      monthlyPrice: { currency: "usd", amount: 0 },
      quotas: {
        projectsPerAccount: 1,
        projectsPerOrganization: 1,
      },
    }, {
      id: "pro",
      name: "Pro",
      description: "More room for side projects.",
      monthlyPrice: { currency: "usd", amount: 1_500 },
      featured: true,
      quotas: {
        projectsPerAccount: 3,
        projectsPerOrganization: 3,
        backupsPerProject: 60,
      },
    }, {
      id: "team",
      name: "Team",
      description: "Shared production capacity.",
      monthlyPrice: { currency: "usd", amount: 4_900 },
      quotas: {
        projectsPerAccount: 5,
        projectsPerOrganization: 5,
      },
    }],
  };
}

function subscriptionEvent(input, overrides = {}) {
  return {
    kind: "subscription.updated",
    id: overrides.id ?? "evt_subscription_active",
    createdAt: overrides.createdAt ?? Date.now(),
    attemptId: input.attemptId,
    accountId: input.accountId,
    planId: overrides.planId ?? input.planId,
    customerId: overrides.customerId ?? "cus_billing123",
    subscriptionId: overrides.subscriptionId ?? "sub_billing123",
    status: overrides.status ?? "active",
    cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: overrides.currentPeriodEnd ?? Date.now() + 30 * 24 * 60 * 60_000,
  };
}

test("hosted plans are durable, webhook-bound, ordering-safe, and subordinate to operator overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-platform-billing-"));
  const calls = { checkout: [], portal: [], webhook: 0 };
  const provider = fakeBillingProvider(calls);
  const options = {
    dataDirectory: directory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    platformAdminEmails: ["billing@example.com"],
    backups: { intervalMs: false },
    billing: billingOptions(provider),
  };
  let platform = await openPlatform(options);
  try {
    const owner = await authorize(platform, "billing@example.com");
    const billingPage = await platform.handle(jsonRequest("/billing", { cookie: owner.cookie }));
    assert.equal(billingPage.status, 200);
    const billingHtml = await billingPage.text();
    assert.match(billingHtml, /<section id="billing-page">/u);
    assert.match(billingHtml, /id="nav-billing"[^>]*active|nav-button active[^>]*id="nav-billing"/u);
    assert.match(billingHtml, /"billingEnabled":true/u);
    const initial = await payload(platform, jsonRequest("/api/billing", { token: owner.token }));
    assert.equal(initial.protocol, "clank-billing/1");
    assert.equal(initial.defaultPlanId, "free");
    assert.equal(initial.current.planId, "free");
    assert.equal(initial.current.status, "free");
    assert.equal(initial.entitlements.projectsPerAccount, 1);
    assert.equal(initial.plans.find((plan) => plan.id === "pro").monthlyPrice.amount, 1_500);
    assert.equal("customerId" in initial.current, false);

    const adminBillingPath = `/api/admin/billing/accounts/${owner.user.id}`;
    const granted = await payload(platform, jsonRequest(adminBillingPath, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { planId: "team" },
    }));
    assert.equal(granted.current.status, "manual");
    assert.equal(granted.current.planId, "team");
    assert.equal(granted.entitlements.projectsPerAccount, 5);
    const manualCheckout = await payload(platform, jsonRequest("/api/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { planId: "pro" },
    }), 409);
    assert.equal(manualCheckout.error.code, "OPERATOR_MANAGED_PLAN");
    const revoked = await payload(platform, jsonRequest(adminBillingPath, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { planId: null },
    }));
    assert.equal(revoked.current.status, "free");
    assert.equal(revoked.entitlements.projectsPerAccount, 1);

    const first = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.token,
      body: { name: "First", slug: "billing-first" },
    }), 201);
    const denied = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.token,
      body: { name: "Denied", slug: "billing-denied" },
    }), 409);
    assert.equal(denied.error.code, "ACCOUNT_PROJECT_LIMIT_REACHED");

    await payload(platform, jsonRequest("/api/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      body: { planId: "pro" },
    }), 403);
    await payload(platform, jsonRequest("/api/billing/checkout", {
      method: "POST",
      token: owner.token,
      body: { planId: "pro" },
    }), 403);
    calls.checkoutUrl = "javascript:alert(1)";
    const malformedProvider = await payload(platform, jsonRequest("/api/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { planId: "pro" },
    }), 503);
    assert.equal(malformedProvider.error.code, "BILLING_PROVIDER_UNAVAILABLE");
    delete calls.checkoutUrl;
    const checkout = await payload(platform, jsonRequest("/api/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { planId: "pro" },
    }), 201);
    assert.equal(checkout.checkout.url, "https://checkout.example.test/session");
    assert.equal(calls.checkout.length, 2);
    assert.equal(calls.checkout[0].accountId, owner.user.id);
    assert.equal(calls.checkout[0].successUrl, "http://127.0.0.1:4200/billing?checkout=success");

    const activeAt = Date.now() - 3 * 60 * 60_000;
    const active = subscriptionEvent(calls.checkout[0], {
      createdAt: activeAt,
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60_000,
    });
    const invalidProviderEvent = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: { ...active, unexpected: "must not cross the provider boundary" },
    }), 400);
    assert.equal(invalidProviderEvent.error.code, "INVALID_BILLING_WEBHOOK");
    const applied = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: active,
    }));
    assert.deepEqual(
      { duplicate: applied.duplicate, changed: applied.changed },
      { duplicate: false, changed: true },
    );
    const duplicate = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: active,
    }));
    assert.equal(duplicate.duplicate, true);

    const checkoutAfterSubscription = {
      kind: "checkout.completed",
      id: "evt_checkout_completed",
      createdAt: activeAt - 1_000,
      sessionId: "cs_billing123",
      attemptId: calls.checkout[0].attemptId,
      accountId: owner.user.id,
      planId: "pro",
      customerId: "cus_billing123",
      subscriptionId: "sub_billing123",
    };
    await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: checkoutAfterSubscription,
    }));
    const paid = await payload(platform, jsonRequest("/api/billing", { cookie: owner.cookie }));
    assert.equal(paid.current.planId, "pro");
    assert.equal(paid.current.status, "active");
    assert.equal(paid.entitlements.projectsPerAccount, 3);
    assert.equal(paid.entitlements.backupsPerProject, 60);
    const paidAdminScope = await payload(platform, jsonRequest(
      `/api/admin/quotas/account/${owner.user.id}`,
      { cookie: owner.cookie },
    ));
    assert.equal(paidAdminScope.inherited.projectsPerAccount, 3);
    assert.equal(paidAdminScope.effective.projectsPerAccount, 3);
    assert.equal(paidAdminScope.billing.current.planId, "pro");

    await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.token,
      body: {
        name: "Second",
        slug: "billing-second",
        organizationId: first.project.organizationId,
      },
    }), 201);

    const overridePath = `/api/admin/quotas/account/${owner.user.id}`;
    await payload(platform, jsonRequest(overridePath, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { overrides: { projectsPerAccount: 5 } },
    }));
    const overridden = await payload(platform, jsonRequest("/api/billing", { cookie: owner.cookie }));
    assert.equal(overridden.entitlements.projectsPerAccount, 5);
    assert.equal(overridden.operatorOverrides.projectsPerAccount, 5);
    await payload(platform, jsonRequest(overridePath, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { overrides: { projectsPerAccount: null } },
    }));

    const stale = subscriptionEvent(calls.checkout[0], {
      id: "evt_subscription_stale",
      createdAt: activeAt - 60_000,
      status: "canceled",
      currentPeriodEnd: null,
    });
    const staleResult = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: stale,
    }));
    assert.equal(staleResult.changed, false);

    const team = subscriptionEvent(calls.checkout[0], {
      id: "evt_subscription_team",
      createdAt: activeAt + 60_000,
      planId: "team",
    });
    await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: team,
    }));
    assert.equal(
      (await payload(platform, jsonRequest("/api/billing", { cookie: owner.cookie })))
        .entitlements.projectsPerAccount,
      5,
    );
    const delayedCheckout = {
      ...checkoutAfterSubscription,
      id: "evt_checkout_delayed",
      createdAt: activeAt + 2 * 60_000,
    };
    const delayedCheckoutResult = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: delayedCheckout,
    }));
    assert.equal(delayedCheckoutResult.changed, false);
    const afterDelayedCheckout = await payload(
      platform,
      jsonRequest("/api/billing", { cookie: owner.cookie }),
    );
    assert.equal(afterDelayedCheckout.current.planId, "team");
    assert.equal(afterDelayedCheckout.entitlements.projectsPerAccount, 5);

    const portal = await payload(platform, jsonRequest("/api/billing/portal", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: {},
    }), 201);
    assert.equal(portal.portal.url, "https://billing.example.test/session");
    assert.deepEqual(calls.portal, [{
      customerId: "cus_billing123",
      returnUrl: "http://127.0.0.1:4200/billing",
    }]);

    const expiredPastDue = subscriptionEvent(calls.checkout[0], {
      id: "evt_subscription_past_due",
      createdAt: Date.now() - 2 * 60 * 60_000,
      planId: "team",
      status: "past_due",
    });
    await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: expiredPastDue,
    }));
    const defaulted = await payload(platform, jsonRequest("/api/billing", { cookie: owner.cookie }));
    assert.equal(defaulted.current.status, "past_due");
    assert.equal(defaulted.current.planId, "free");
    assert.equal(defaulted.current.entitlementsActive, false);
    assert.equal(defaulted.entitlements.projectsPerAccount, 1);

    const noDeletion = await payload(platform, jsonRequest("/api/dashboard", { cookie: owner.cookie }));
    assert.equal(noDeletion.projects.length, 2);
    const stillDenied = await payload(platform, jsonRequest("/api/projects", {
      method: "POST",
      token: owner.token,
      body: {
        name: "Still denied",
        slug: "billing-still-denied",
        organizationId: first.project.organizationId,
      },
    }), 409);
    assert.equal(stillDenied.error.code, "ACCOUNT_PROJECT_LIMIT_REACHED");

    const conflict = { ...active, status: "paused" };
    const conflictResult = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: conflict,
    }), 409);
    assert.equal(conflictResult.error.code, "BILLING_EVENT_CONFLICT");

    await platform.close();
    platform = await openPlatform(options);
    const afterRestart = await payload(platform, jsonRequest("/api/billing", { token: owner.token }));
    assert.equal(afterRestart.current.status, "past_due");
    assert.equal(afterRestart.entitlements.projectsPerAccount, 1);
    assert.ok(calls.webhook >= 6);
  } finally {
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retired subscription events are recorded without replacing the current binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-platform-billing-retired-"));
  const calls = { checkout: [], portal: [], webhook: 0 };
  const provider = fakeBillingProvider(calls);
  const platform = await openPlatform({
    dataDirectory: directory,
    publicUrl: "http://127.0.0.1:4200",
    signup: true,
    backups: { intervalMs: false },
    billing: billingOptions(provider),
  });
  try {
    const owner = await authorize(platform, "retired-billing@example.com");
    await payload(platform, jsonRequest("/api/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { planId: "pro" },
    }), 201);
    const firstCheckout = calls.checkout.at(-1);
    const firstActiveAt = Date.now() - 10_000;
    await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: subscriptionEvent(firstCheckout, {
        id: "evt_first_active",
        createdAt: firstActiveAt,
      }),
    }));
    await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: subscriptionEvent(firstCheckout, {
        id: "evt_first_canceled",
        createdAt: firstActiveAt + 1_000,
        status: "canceled",
        currentPeriodEnd: null,
      }),
    }));

    calls.checkoutId = "cs_billing456";
    await payload(platform, jsonRequest("/api/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { planId: "team" },
    }), 201);
    const secondCheckout = calls.checkout.at(-1);
    const secondActiveAt = firstActiveAt + 2_000;
    await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: subscriptionEvent(secondCheckout, {
        id: "evt_second_active",
        createdAt: secondActiveAt,
        subscriptionId: "sub_billing456",
      }),
    }));

    const retiredEvent = subscriptionEvent(firstCheckout, {
      id: "evt_first_late_delete",
      createdAt: secondActiveAt + 1_000,
      status: "canceled",
      currentPeriodEnd: null,
    });
    const retired = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: retiredEvent,
    }));
    assert.deepEqual(
      { duplicate: retired.duplicate, changed: retired.changed },
      { duplicate: false, changed: false },
    );
    const duplicate = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: retiredEvent,
    }));
    assert.equal(duplicate.duplicate, true);

    const unrelated = await payload(platform, jsonRequest("/api/billing/webhook", {
      method: "POST",
      body: subscriptionEvent(firstCheckout, {
        id: "evt_unrelated_identity",
        createdAt: secondActiveAt + 2_000,
        customerId: "cus_unrelated123",
        status: "canceled",
        currentPeriodEnd: null,
      }),
    }), 409);
    assert.equal(unrelated.error.code, "BILLING_ACCOUNT_CONFLICT");
    const current = await payload(platform, jsonRequest("/api/billing", { cookie: owner.cookie }));
    assert.equal(current.current.planId, "team");
    assert.equal(current.current.status, "active");
    assert.equal(current.entitlements.projectsPerAccount, 5);
  } finally {
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("billing configuration fails closed before the platform starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-platform-billing-invalid-"));
  const calls = { checkout: [], portal: [], webhook: 0 };
  try {
    await assert.rejects(openPlatform({
      dataDirectory: directory,
      publicUrl: "http://127.0.0.1:4200",
      backups: { intervalMs: false },
      billing: {
        ...billingOptions(fakeBillingProvider(calls)),
        defaultPlanId: "pro",
      },
    }), /default billing plan must have a zero monthly amount/u);
    await assert.rejects(openPlatform({
      dataDirectory: directory,
      publicUrl: "http://127.0.0.1:4200",
      backups: { intervalMs: false },
      billing: {
        ...billingOptions({
          ...fakeBillingProvider(calls),
          planIds: ["pro"],
        }),
      },
    }), /must exactly match the paid plan catalog/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
