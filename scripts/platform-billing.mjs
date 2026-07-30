import { lstat, readFile } from "node:fs/promises";
import { createStripeBillingProvider } from "../dist/billing.js";

const MAX_BILLING_CONFIG_BYTES = 256 * 1024;

/**
 * Resolves a public plan catalog plus an optional Stripe adapter. Provider
 * secrets stay in environment variables and are never accepted in catalog JSON.
 */
export async function resolvePlatformBilling(environment) {
  const inline = environment.CLANK_BILLING_PLANS_JSON;
  const path = environment.CLANK_BILLING_PLANS_FILE;
  const stripeKey = environment.CLANK_STRIPE_SECRET_KEY;
  const stripeWebhookSecret = environment.CLANK_STRIPE_WEBHOOK_SECRET;
  if (inline && path) {
    throw new Error("Configure CLANK_BILLING_PLANS_JSON or CLANK_BILLING_PLANS_FILE, not both.");
  }
  if (!inline && !path) {
    if (stripeKey || stripeWebhookSecret || environment.CLANK_STRIPE_API_VERSION) {
      throw new Error("Stripe billing credentials require a Clank billing plan catalog.");
    }
    return undefined;
  }
  let source;
  if (inline) {
    if (new TextEncoder().encode(inline).byteLength > MAX_BILLING_CONFIG_BYTES) {
      throw new Error("CLANK_BILLING_PLANS_JSON exceeds 256 KiB.");
    }
    source = inline;
  } else {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CLANK_BILLING_PLANS_FILE must be a regular, non-symbolic-link file.");
    }
    if (metadata.size < 2 || metadata.size > MAX_BILLING_CONFIG_BYTES) {
      throw new Error("CLANK_BILLING_PLANS_FILE must contain 2 bytes through 256 KiB.");
    }
    source = await readFile(path, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Clank billing plan catalog is not valid JSON.");
  }
  plain(parsed, "Clank billing plan catalog");
  exact(parsed, ["defaultPlanId", "pastDueGraceMs", "plans"]);
  if (!Array.isArray(parsed.plans)) throw new Error("Clank billing plans must be an array.");
  const prices = Object.create(null);
  const planPrices = Object.create(null);
  const plans = parsed.plans.map((raw, index) => {
    plain(raw, `Clank billing plan ${index}`);
    exact(raw, [
      "id",
      "name",
      "description",
      "monthlyPrice",
      "quotas",
      "featured",
      "stripePriceId",
    ]);
    const { stripePriceId, ...plan } = raw;
    if (stripePriceId !== undefined) {
      if (typeof plan.id !== "string" || typeof stripePriceId !== "string") {
        throw new Error(`Clank billing plan ${index} Stripe price mapping is invalid.`);
      }
      prices[plan.id] = stripePriceId;
      planPrices[plan.id] = plan.monthlyPrice;
    }
    return plan;
  });
  if (Boolean(stripeKey) !== Boolean(stripeWebhookSecret)) {
    throw new Error(
      "CLANK_STRIPE_SECRET_KEY and CLANK_STRIPE_WEBHOOK_SECRET must be configured together.",
    );
  }
  const provider = stripeKey
    ? createStripeBillingProvider({
        apiKey: stripeKey,
        webhookSecret: stripeWebhookSecret,
        prices,
        planPrices,
        ...(environment.CLANK_STRIPE_API_VERSION
          ? { apiVersion: environment.CLANK_STRIPE_API_VERSION }
          : {}),
      })
    : undefined;
  if (!provider && environment.CLANK_STRIPE_API_VERSION) {
    throw new Error("CLANK_STRIPE_API_VERSION requires Stripe billing credentials.");
  }
  return {
    defaultPlanId: parsed.defaultPlanId,
    ...(parsed.pastDueGraceMs === undefined ? {} : { pastDueGraceMs: parsed.pastDueGraceMs }),
    plans,
    ...(provider ? { provider } : {}),
  };
}

function plain(value, name) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${name} must be a JSON object.`);
}

function exact(value, allowedFields) {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  if (unexpected) throw new Error(`Unknown Clank billing field ${unexpected}.`);
}
