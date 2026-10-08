# Reminders, recurrence and notification delivery

`openReminders({ path, auth })` and `createReminderClient(...)` provide account-owned reminder storage. Mount `mountReminders(container, client)` for creation, due/active/completed filters, editing, completion, snooze, deletion and refresh. Saves, completion and snooze require the displayed record version; stale edits preserve the draft and ask the user to refresh. Duplicate creation keys return the original reminder. Snooze uses server time and accepts 1–10,080 minutes. There are at most 200 reminders per account.

## Calendar recurrence

```ts
import { previewSchedule } from "@clank.run/framework/schedules";

const recurrence = {
  frequency: "weekly" as const,
  interval: 2,
  startDate: "2027-01-04",
  weekdays: [1, 3],
  time: "09:30",
  timeZone: "America/New_York",
  exceptionDates: ["2027-01-18"],
  endDate: "2027-12-31",
};
const preview = previewSchedule(recurrence, { after: Date.now(), limit: 5 });
await reminders.save({
  title: "Review upcoming work",
  dueAt: preview.occurrences[0].at,
  recurrence,
});
```

Rules support daily, weekly and monthly frequencies, intervals of 1–366, Sunday=0 through Saturday=6 weekdays, a monthly day, an inclusive end date and up to 366 exception dates. Calendar dates range from 1970 through January 1, 2100. A monthly day that does not exist is skipped. Local times that disappear during daylight-saving transitions are skipped; repeated minutes run once using `overlap: "earlier"` (default) or `"later"`. The preview reports skipped dates and when its bounded horizon is exhausted. `mountSchedulePreview` renders the same results as accessible text before saving.

The editor offers frequency, named time zone and exception dates. Advanced API rules keep their interval, weekday/month-day, end date and overlap policy when editing within the same frequency. Editing only the title preserves a snoozed due time. Changing only exceptions or the zone preserves the calendar anchor and picks the next eligible occurrence at or after the current due time. Changing the local date/time explicitly sets a new anchor. Completing a recurring reminder advances once to the next occurrence after its current due time; completion after the final occurrence marks it complete. Concurrent or replayed completion cannot advance twice. These reminders are durable personal records: mounting the panel does not create an operating-system or browser push notification.

## Delivery preferences and digests

`openNotificationCenter({ path, auth, categories, sendEmail })` stores in-app notifications and queues optional email. `sendEmail` receives an abort signal and stable `idempotencyKey`; pass that key to a provider that supports idempotency. Publication keys deduplicate per account while the notification remains retained. Identical retries return the original ID without resetting read state; changing the category, title, body or local URL under that key throws without changing the record. Workers call `workEmailOnce()` or `startEmailWorker()`; only accounts with verified email, an active account and current opt-in may receive email.

```ts
await notifications.setPreference({
  category: "updates",
  inApp: true,
  email: true,
  delivery: "daily",
  timeZone: "America/Chicago",
  digestTime: "09:00",
  quietHours: { start: "22:00", end: "08:00" },
});
```

Delivery defaults to immediate, UTC, no quiet hours. Hourly digests wait for the next UTC hour boundary; daily digests use the named zone's local calendar and skip nonexistent local digest times. Quiet intervals may cross midnight and must have distinct start/end times. Clear them with `quietHours: null`. `nextNotificationDelivery` previews the earliest delivery instant. Newly enabled quiet hours are checked again when the worker runs, including retries. Disabling email or disabling the account prevents pending delivery. Changing frequency affects newly published notifications; existing jobs retain their scheduled instant, subject to current quiet hours and opt-in.

A digest contains up to 50 currently due notifications from the same recipient/category. The first attempt persists its recipient, content, member IDs and delivery key, so a retry sends the same payload even after new notifications arrive or the service restarts. Recipient-email changes cancel that sealed batch. A failed delivery uses the durable job retry policy; after automatic attempts are exhausted the account can call `retryEmail(id)` or use **Retry failed email**. Quiet-hours deferrals keep the batch linked to its current job so manual retry remains available. Pending or failed delivery records are retained rather than silently discarded when enforcing the configured retention limit; publication fails when pending capacity is full.

`mountNotificationCenter` displays read/unread state, scheduled delivery, delivery attempts and per-category channel/digest/zone/quiet-hour controls. If only one quiet-hour endpoint is entered, it preserves the unfinished form until both endpoints are provided. Rendering escapes notification contents and accepts only local navigation URLs.

`tests/recurrence-ui.test.mjs` drives editor controls through real authenticated SQLite transport, including snoozed title edits, advanced-rule preservation, exception changes and stale conflicts. The schedule tests cover DST gaps/overlaps, half-hour transitions, monthly boundaries and owner isolation. Notification tests cover digest sealing, restart/retry identities, opt-out, deferred manual retries and calendar delivery policy.
