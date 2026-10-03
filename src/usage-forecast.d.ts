export interface UsageForecastInput {
  used: number;
  limit: number;
  periodStartedAt: number;
  periodEndsAt: number;
  asOf: number;
  trackingStartedAt?: number;
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
export declare function forecastUsage(input: UsageForecastInput): UsageForecast;
