import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePlatformBilling } from "../scripts/platform-billing.mjs";

function catalog(overrides = {}) {
  return JSON.stringify({
    defaultPlanId: "free",
    plans: [{
      id: "free",
      name: "Free",
      description: "One project.",
      monthlyPrice: { currency: "usd", amount: 0 },
      quotas: { projectsPerAccount: 1 },
    }, {
      id: "pro",
      name: "Pro",
      description: "More projects.",
      monthlyPrice: { currency: "usd", amount: 1_500 },
      quotas: { projectsPerAccount: 10 },
      stripePriceId: "price_1234567890",
    }],
    ...overrides,
  });
}

test("platform billing catalog supports manual plans and strips provider mappings", async () => {
  const billing = await resolvePlatformBilling({
    CLANK_BILLING_PLANS_JSON: catalog(),
  });
  assert.equal(billing.defaultPlanId, "free");
  assert.equal(billing.provider, undefined);
  assert.equal(billing.plans.length, 2);
  assert.equal("stripePriceId" in billing.plans[1], false);
});

test("platform billing catalog composes Stripe only with both isolated secrets", async () => {
  const billing = await resolvePlatformBilling({
    CLANK_BILLING_PLANS_JSON: catalog(),
    CLANK_STRIPE_SECRET_KEY: "sk_test_1234567890",
    CLANK_STRIPE_WEBHOOK_SECRET: "whsec_1234567890",
    CLANK_STRIPE_API_VERSION: "2026-02-25.clover",
  });
  assert.equal(billing.provider.name, "stripe");
  assert.deepEqual(billing.provider.planIds, ["pro"]);

  await assert.rejects(resolvePlatformBilling({
    CLANK_BILLING_PLANS_JSON: catalog(),
    CLANK_STRIPE_SECRET_KEY: "sk_test_1234567890",
  }), /must be configured together/u);
  await assert.rejects(resolvePlatformBilling({
    CLANK_STRIPE_SECRET_KEY: "sk_test_1234567890",
    CLANK_STRIPE_WEBHOOK_SECRET: "whsec_1234567890",
  }), /require a Clank billing plan catalog/u);
});

test("platform billing catalog is bounded, exact, and refuses symbolic-link files", async () => {
  await assert.rejects(resolvePlatformBilling({
    CLANK_BILLING_PLANS_JSON: catalog({ unexpected: true }),
  }), /Unknown Clank billing field unexpected/u);
  await assert.rejects(resolvePlatformBilling({
    CLANK_BILLING_PLANS_JSON: "{",
  }), /not valid JSON/u);
  await assert.rejects(resolvePlatformBilling({
    CLANK_BILLING_PLANS_JSON: catalog(),
    CLANK_BILLING_PLANS_FILE: "/tmp/catalog.json",
  }), /not both/u);

  const directory = await mkdtemp(join(tmpdir(), "clank-billing-config-"));
  try {
    const target = join(directory, "plans.json");
    const link = join(directory, "plans-link.json");
    await writeFile(target, catalog());
    await symlink(target, link);
    await assert.rejects(resolvePlatformBilling({
      CLANK_BILLING_PLANS_FILE: link,
    }), /regular, non-symbolic-link/u);
    const fromFile = await resolvePlatformBilling({
      CLANK_BILLING_PLANS_FILE: target,
    });
    assert.equal(fromFile.plans[1].id, "pro");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
