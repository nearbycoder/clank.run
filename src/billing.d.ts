export type BillingSubscriptionStatus = "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";
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
export type BillingProviderEvent = BillingCheckoutCompletedEvent | BillingSubscriptionUpdatedEvent;
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
export declare class BillingProviderError extends Error {
    readonly code = "BILLING_PROVIDER_UNAVAILABLE";
    constructor(message?: string, cause?: unknown);
}
export declare class BillingWebhookError extends Error {
    readonly code = "INVALID_BILLING_WEBHOOK";
    constructor(cause?: unknown);
}
export declare function createStripeBillingProvider(options: StripeBillingProviderOptions): BillingProvider;
