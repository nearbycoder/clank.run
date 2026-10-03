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
const DAY = 86_400_000;
function calendar(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError("Use an ISO calendar date.");
  const valueAt = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(valueAt) || valueAt < 0 || valueAt > Date.UTC(2100, 0, 1) || new Date(valueAt).toISOString().slice(0, 10) !== value) throw new TypeError("Schedule dates must be real dates between 1970 and 2100.");
  return valueAt;
}
function formatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 100) throw new TypeError("A named time zone is required.");
  return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}
function wall(at: number, format: Intl.DateTimeFormat): number {
  const values = Object.fromEntries(format.formatToParts(at).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!);
}
export function validateRecurrenceRule(value: RecurrenceRule): Readonly<RecurrenceRule> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["frequency", "interval", "startDate", "time", "timeZone", "weekdays", "dayOfMonth", "endDate", "exceptionDates", "overlap"].includes(key))) throw new TypeError("Invalid recurrence rule.");
  const start = calendar(value.startDate), interval = value.interval ?? 1;
  if (!["daily", "weekly", "monthly"].includes(value.frequency) || !Number.isInteger(interval) || interval < 1 || interval > 366) throw new TypeError("Recurrence interval must be 1–366.");
  if (typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.time)) throw new TypeError("Use a local time in HH:mm format.");
  formatter(value.timeZone);
  if (value.endDate !== undefined && calendar(value.endDate) < start) throw new TypeError("Schedule end precedes its start.");
  if (value.overlap !== undefined && !["earlier", "later"].includes(value.overlap)) throw new TypeError("Choose earlier or later for repeated minutes.");
  if (value.weekdays !== undefined && (value.frequency !== "weekly" || !Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7 || value.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(value.weekdays).size !== value.weekdays.length)) throw new TypeError("Weekly weekdays must be unique Sunday=0 through Saturday=6 values.");
  if (value.dayOfMonth !== undefined && (value.frequency !== "monthly" || !Number.isInteger(value.dayOfMonth) || value.dayOfMonth < 1 || value.dayOfMonth > 31)) throw new TypeError("Monthly day must be 1–31.");
  if (value.exceptionDates !== undefined && (!Array.isArray(value.exceptionDates) || value.exceptionDates.length > 366 || new Set(value.exceptionDates).size !== value.exceptionDates.length)) throw new TypeError("At most 366 distinct exception dates are allowed.");
  value.exceptionDates?.forEach(calendar);
  return Object.freeze({ ...value, interval, overlap: value.overlap ?? "earlier", ...(value.weekdays ? { weekdays: Object.freeze([...value.weekdays].sort()) } : {}), ...(value.exceptionDates ? { exceptionDates: Object.freeze([...value.exceptionDates].sort()) } : {}) });
}
/** Preview bounded recurrence including DST gaps and exception dates. */
export function previewSchedule(input: RecurrenceRule, options: { after: number; limit?: number; horizonDays?: number }): SchedulePreview {
  const rule = validateRecurrenceRule(input), limit = options.limit ?? 10, horizon = options.horizonDays ?? 3660;
  if (!Number.isSafeInteger(options.after) || options.after < -1 || options.after > Date.UTC(2100, 0, 1) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(horizon) || horizon < 1 || horizon > 47500) throw new TypeError("Preview needs a valid clock, 1–100 results, and a 1–47,500 day horizon.");
  const format = formatter(rule.timeZone), start = calendar(rule.startDate), startDate = new Date(start), end = rule.endDate ? calendar(rule.endDate) : Date.UTC(2100, 0, 1);
  const localAfter = wall(Math.max(0, options.after), format);
  const first = Math.max(start, Math.floor(localAfter / DAY) * DAY);
  const [hour, minute] = rule.time.split(":").map(Number);
  const occurrences: ScheduledOccurrence[] = [], skipped: Array<{ date: string; reason: "exception" | "daylight-saving-gap" }> = [];
  const exceptions = new Set(rule.exceptionDates ?? []), weekdays = rule.weekdays ?? [startDate.getUTCDay()];
  const startWeek = start - ((startDate.getUTCDay() + 6) % 7) * DAY;
  let cursor = first;
  for (; cursor <= end && cursor < first + horizon * DAY && occurrences.length < limit; cursor += DAY) {
    const date = new Date(cursor), days = (cursor - start) / DAY;
    const eligible = rule.frequency === "daily" ? days % rule.interval! === 0
      : rule.frequency === "weekly" ? Math.floor((cursor - startWeek) / (7 * DAY)) % rule.interval! === 0 && weekdays.includes(date.getUTCDay())
      : ((date.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + date.getUTCMonth() - startDate.getUTCMonth()) % rule.interval! === 0 && date.getUTCDate() === (rule.dayOfMonth ?? startDate.getUTCDate());
    if (!eligible) continue;
    const iso = date.toISOString().slice(0, 10);
    if (exceptions.has(iso)) { skipped.push({ date: iso, reason: "exception" }); continue; }
    const wanted = cursor + hour! * 3_600_000 + minute! * 60_000;
    // Probe both sides of transitions, then verify candidate local minutes.
    const offsets = new Set<number>();
    for (let shift = -36; shift <= 36; shift += 6) {
      const probe = wanted + shift * 3_600_000;
      offsets.add(wall(probe, format) - probe);
    }
    const candidates = [...offsets].map(offset => wanted - offset).filter(at => wall(at, format) === wanted).sort((a, b) => a - b);
    if (!candidates.length) { skipped.push({ date: iso, reason: "daylight-saving-gap" }); continue; }
    const at = rule.overlap === "later" ? candidates[candidates.length - 1]! : candidates[0]!;
    if (at > options.after) occurrences.push(Object.freeze({ at, local: `${iso}T${rule.time}`, offsetMinutes: (wanted - at) / 60_000, ambiguous: candidates.length > 1 }));
  }
  return Object.freeze({ occurrences: Object.freeze(occurrences), skipped: Object.freeze(skipped.map(value => Object.freeze(value))), exhausted: occurrences.length < limit });
}

/** Render an accessible, text-only preview before saving a recurring operation. */
export function mountSchedulePreview(container: HTMLElement, rule: RecurrenceRule, options: { after: number; limit?: number; horizonDays?: number }): () => void {
  const preview = previewSchedule(rule, options), document = container.ownerDocument;
  const section = document.createElement("section"), heading = document.createElement("h3"), list = document.createElement("ol"), status = document.createElement("p");
  section.setAttribute("aria-label", "Schedule preview");
  heading.textContent = `Upcoming occurrences (${rule.timeZone})`;
  for (const occurrence of preview.occurrences) {
    const row = document.createElement("li"), time = document.createElement("time");
    time.setAttribute("datetime", new Date(occurrence.at).toISOString());
    time.textContent = `${occurrence.local.replace("T", " ")}${occurrence.ambiguous ? ` (${rule.overlap ?? "earlier"} repeated minute)` : ""}`;
    row.append(time); list.append(row);
  }
  status.setAttribute("role", "status");
  status.textContent = `${preview.skipped.length} skipped date(s).${preview.exhausted ? " End date or preview horizon reached." : ""}`;
  section.append(heading, list, status);
  if (preview.skipped.length) {
    const details = document.createElement("details"), summary = document.createElement("summary");
    summary.textContent = "Skipped dates"; details.append(summary);
    for (const item of preview.skipped) { const row = document.createElement("p"); row.textContent = `${item.date}: ${item.reason === "exception" ? "exception date" : "local time does not exist"}`; details.append(row); }
    section.append(details);
  }
  container.append(section);
  return () => section.remove();
}
