import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAuth } from "../dist/auth.js";
import { openReminders, createReminderClient } from "../dist/reminders.js";
import { previewSchedule, validateRecurrenceRule, mountSchedulePreview } from "../dist/schedules.js";

const daily = { frequency: "daily", startDate: "2026-03-07", time: "02:30", timeZone: "America/New_York" };
test("daily schedules skip nonexistent local minutes and preserve wall time after DST", () => {
  const preview = previewSchedule(daily, { after: Date.parse("2026-03-07T00:00:00Z"), limit: 3 });
  assert.deepEqual(preview.occurrences.map(item => new Date(item.at).toISOString()), ["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  assert.deepEqual(preview.skipped, [{ date: "2026-03-08", reason: "daylight-saving-gap" }]);
  assert.equal(preview.exhausted, false);
});
test("repeated minutes run once using the selected offset and half-hour transitions work", () => {
  const input = { ...daily, startDate: "2026-11-01", time: "01:30" };
  const options = { after: Date.parse("2026-11-01T00:00:00Z"), limit: 1 };
  const early = previewSchedule(input, options).occurrences[0], late = previewSchedule({ ...input, overlap: "later" }, options).occurrences[0];
  assert.equal(late.at - early.at, 3600000);
  assert.equal(early.ambiguous, true);
  assert.equal(early.offsetMinutes, -240);
  assert.equal(late.offsetMinutes, -300);
  const lordHowe = previewSchedule({ ...daily, startDate: "2026-10-04", time: "02:15", timeZone: "Australia/Lord_Howe" }, { after: Date.parse("2026-10-03T00:00:00Z"), limit: 1 });
  assert.equal(lordHowe.skipped[0].reason, "daylight-saving-gap");
  assert.equal(lordHowe.occurrences[0].local, "2026-10-05T02:15");
});
test("calendar intervals, exception dates and short months remain anchored", () => {
  const monthly = previewSchedule({ frequency: "monthly", startDate: "2026-01-31", time: "09:00", timeZone: "UTC", exceptionDates: ["2026-03-31"], endDate: "2026-05-31" }, { after: 0, limit: 5 });
  assert.deepEqual(monthly.occurrences.map(item => item.local), ["2026-01-31T09:00", "2026-05-31T09:00"]);
  assert.equal(monthly.exhausted, true);
  const weekly = previewSchedule({ frequency: "weekly", interval: 2, startDate: "2026-01-07", time: "09:00", timeZone: "UTC", weekdays: [1, 3] }, { after: Date.parse("2026-01-06T00:00:00Z"), limit: 4 });
  assert.deepEqual(weekly.occurrences.map(item => item.local), ["2026-01-07T09:00", "2026-01-19T09:00", "2026-01-21T09:00", "2026-02-02T09:00"]);
});
test("untrusted recurrence settings and unbounded previews fail before scheduling", () => {
  for (const change of [{ startDate: "2026-02-30" }, { time: "24:00" }, { interval: 0 }, { timeZone: "Invalid/Zone" }, { endDate: "2020-01-01" }, { weekdays: [0] }, { dayOfMonth: 1 }, { overlap: "both" }, { extra: true }]) assert.throws(() => validateRecurrenceRule({ ...daily, ...change }));
  assert.throws(() => previewSchedule(daily, { after: NaN }));
  assert.throws(() => previewSchedule(daily, { after: 0, limit: 101 }));
  assert.throws(() => previewSchedule(daily, { after: 0, horizonDays: 47501 }));
  const values = ["2026-03-10"], rule = validateRecurrenceRule({ ...daily, exceptionDates: values });
  values.push("2026-03-11");
  assert.equal(rule.exceptionDates.length, 1);
});
test("recurring reminders persist, isolate owners and advance exactly once on completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-recurring-"));
  const options = { path: join(root, "app.sqlite"), auth: defineAuth({ password: { cost: 1024, maxMemory: 4194304 } }) };
  let service = await openReminders(options);
  const register = async email => {
    const response = await service.handle(new Request("https://schedule.test/__clank/reminders/auth/register", { method: "POST", headers: { origin: "https://schedule.test", "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery staple" }) }));
    assert.equal(response.status, 201);
    const data = await response.json(), cookie = response.headers.get("set-cookie").split(";", 1)[0];
    return createReminderClient({ url: "https://schedule.test/__clank/reminders", auth: { csrfHeader: () => ({ "x-clank-csrf": data.csrfToken }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie, origin: "https://schedule.test" } })) });
  };
  try {
    const alice = await register("alice@example.test"), bob = await register("bob@example.test");
    const recurrence = { ...daily, endDate: "2026-03-09" }, dueAt = Date.parse("2026-03-07T07:30:00Z");
    const first = await alice.save({ title: "Review", dueAt, recurrence, key: "review" });
    assert.deepEqual(await bob.list(), []);
    await assert.rejects(bob.complete(first.id, true, first.version));
    service.close(); service = await openReminders(options);
    assert.equal((await alice.list())[0].recurrence.timeZone, "America/New_York");
    await alice.complete(first.id, true, first.version);
    const next = (await alice.list())[0];
    assert.equal(next.dueAt, Date.parse("2026-03-09T06:30:00Z"));
    assert.equal(next.completed, false);
    await assert.rejects(alice.complete(first.id, true, first.version));
    await alice.complete(next.id, true, next.version);
    assert.equal((await alice.list())[0].completed, true);
    await assert.rejects(alice.save({ title: "Wrong offset", dueAt: dueAt + 60000, recurrence }));
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});
