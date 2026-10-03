export interface UsageForecastInput {
  used: number;
  limit: number;
  periodStartedAt: number;
  periodEndsAt: number;
  asOf: number;
  /** When metering began, if later than the period start. */
  trackingStartedAt?: number;
  /** Avoid extrapolating a few startup requests. Defaults to one hour. */
  minimumObservationMs?: number;
  warningPercent?: number;
}
export interface UsageForecast {
  readonly protocol: "clank-usage-forecast/1";
  readonly status: "insufficient_data" | "within_limit" | "warning" | "projected_exhaustion" | "exhausted";
  readonly used: number;
  readonly limit: number;
  readonly percentUsed: number;
  readonly observedForMs: number;
  readonly ratePerHour: number | null;
  readonly projectedTotal: number | null;
  readonly exhaustionAt: number | null;
}
/** A transparent constant-rate projection using measured usage, never a billing guarantee. */
export function forecastUsage(input: UsageForecastInput): UsageForecast {
  for (const [name, value] of Object.entries({ used: input.used, limit: input.limit, periodStartedAt: input.periodStartedAt,
    periodEndsAt: input.periodEndsAt, asOf: input.asOf, trackingStartedAt: input.trackingStartedAt ?? input.periodStartedAt,
    minimumObservationMs: input.minimumObservationMs ?? 3_600_000 })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid usage forecast ${name}.`);
  }
  if (input.limit < 1 || input.periodEndsAt <= input.periodStartedAt) throw new TypeError("Usage forecast requires a positive limit and period.");
  const warning = input.warningPercent ?? 80;
  if (!Number.isFinite(warning) || warning < 1 || warning > 100) throw new TypeError("Invalid usage warning percentage.");
  const end = Math.max(input.periodStartedAt, Math.min(input.asOf, input.periodEndsAt));
  const start = Math.max(input.periodStartedAt, input.trackingStartedAt ?? input.periodStartedAt);
  const observedForMs = Math.max(0, end - start);
  const enough = observedForMs >= (input.minimumObservationMs ?? 3_600_000) && observedForMs > 0;
  const rate = enough ? input.used / observedForMs : null;
  const projectedTotal = rate === null ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(input.used + rate * (input.periodEndsAt - end)));
  const exhaustionAt = input.used >= input.limit ? end
    : rate && projectedTotal! >= input.limit ? Math.min(input.periodEndsAt, Math.ceil(end + (input.limit - input.used) / rate)) : null;
  const percentUsed = Math.min(100, input.used / input.limit * 100);
  return Object.freeze({ protocol: "clank-usage-forecast/1", used: input.used, limit: input.limit, percentUsed, observedForMs,
    ratePerHour: rate === null ? null : rate * 3_600_000, projectedTotal, exhaustionAt,
    status: input.used >= input.limit ? "exhausted" : !enough ? percentUsed >= warning ? "warning" : "insufficient_data" : exhaustionAt !== null ? "projected_exhaustion"
      : percentUsed >= warning ? "warning" : "within_limit" });
}
