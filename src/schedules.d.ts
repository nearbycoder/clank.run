/** Calendar recurrence uses named zones and never assumes a day is 24 hours. */
export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly";
  interval?: number;
  startDate: string;
  time: string;
  timeZone: string;
  weekdays?: readonly number[];
  dayOfMonth?: number;
  endDate?: string;
  exceptionDates?: readonly string[];
  /** Nonexistent local minutes are skipped; repeated minutes run once. */
  overlap?: "earlier" | "later";
}
export interface ScheduledOccurrence { readonly at: number; readonly local: string; readonly offsetMinutes: number; readonly ambiguous: boolean; }
export interface SchedulePreview {
  readonly occurrences: readonly ScheduledOccurrence[];
  readonly skipped: readonly { readonly date: string; readonly reason: "exception" | "daylight-saving-gap" }[];
  /** True when the end date or search horizon was reached before the requested count. */
  readonly exhausted: boolean;
}
export declare function validateRecurrenceRule(value: RecurrenceRule): Readonly<RecurrenceRule>;
export declare function previewSchedule(input: RecurrenceRule, options: { after: number; limit?: number; horizonDays?: number }): SchedulePreview;
export declare function mountSchedulePreview(container: HTMLElement, rule: RecurrenceRule, options: { after: number; limit?: number; horizonDays?: number }): () => void;
