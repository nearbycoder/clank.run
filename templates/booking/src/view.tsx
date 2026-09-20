/* @clankImportSource @clank.run/framework */
import { For, createApi, signal, type AuthUser, type DefaultAuthProfile } from "@clank.run/framework";
import type { backend, RecipeRecord, RecipeDecision } from "./backend.ts";
const projectTitle = __PROJECT_TITLE_JSON__;
const api = createApi<typeof backend>();
export interface RecipeViewProps {
  user: AuthUser<DefaultAuthProfile>; records: RecipeRecord[]; error?: string;
  create(title: string, detail: string): Promise<boolean>;
  update(row: RecipeRecord, status: RecipeDecision, note?: string): Promise<boolean>;
  logout(): void | Promise<void>;
}
export function RecipeView(props: RecipeViewProps) {
  const title = signal(""), detail = signal(""), busy = signal(false);
  const submit = async (event: Event) => {
    event.preventDefault(); if (busy.value) return; busy.value = true;
    try { if (await props.create(title.value, detail.value)) { title.value = ""; detail.value = ""; } }
    finally { busy.value = false; }
  };
  return <main><header><div><p class="eyebrow">Booking</p><h1>{projectTitle}</h1><p>Reserve one 30-minute consultation. Start times use UTC.</p></div><button onClick={props.logout}>Sign out</button></header>
    <p role="alert">{props.error ?? ""}</p>
    <form onSubmit={submit} class="compose"><label>Title<input bind:value={title} maxlength={160} required agentId="record-title" agentLabel="Title" /></label>
      <label>Start time (UTC)<input type="datetime-local" step={1800} bind:value={detail} required agentId="record-detail" agentLabel="Start time (UTC)" /></label>
      <button type="submit" disabled={busy.value} agentId="record-create" agentAction={api.records.create}>Book consultation</button>
    </form>
    <section aria-label="Records"><For each={props.records} by="_id" fallback={<p class="empty">No records yet.</p>}>
      {(row) => <RecordCard row={row} user={props.user} update={props.update} />}
    </For></section>
  </main>;
}
function RecordCard(props: { row: RecipeRecord; user: AuthUser<DefaultAuthProfile>; update: RecipeViewProps["update"] }) {
  const note = signal(props.row.note), busy = signal(false);
  const calendarError = signal("");
  const act = async (status: RecipeDecision, response?: string) => { if (busy.value) return; busy.value = true; try { await props.update(props.row, status, response); } finally { busy.value = false; } };
  const download = () => {
    calendarError.value = "";
    if (props.row.status !== "booked") return;
    try {
      const url = URL.createObjectURL(new Blob([bookingCalendar(props.row, window.location.host)], { type: "text/calendar;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `booking-${String(props.row._id).replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 80)}.ics`;
      try { document.body.append(anchor); anchor.click(); }
      finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1_000); }
    } catch { calendarError.value = "Could not export this booking. Refresh and try again."; }
  };
  return <article><div class="record-heading"><h2>{props.row.title}</h2><span class="status">{props.row.status}</span></div><p class="detail">{props.row.detail}</p>
    {props.row.note ? <p class="response">Response: {props.row.note}</p> : null}
    {props.row.status === "booked" ? <div class="actions"><button type="button" onClick={download} agentId={`calendar-${props.row._id}`} agentLabel={`Add ${props.row.title} to calendar`}>Add to calendar</button><button disabled={busy.value} onClick={() => act("cancelled")} agentId={`cancel-${props.row._id}`} agentAction={api.records.update}>Cancel booking</button></div> : null}
    <p role="alert" hidden={!calendarError.value}>{calendarError.value}</p>
  </article>;
}

function bookingCalendar(row: RecipeRecord, host: string): string {
  const utc = (value: number) => {
    if (!Number.isFinite(value)) throw new Error("Invalid booking date.");
    const date = new Date(value).toISOString();
    if (!/^\d{4}-/u.test(date)) throw new Error("Invalid booking date.");
    return date.slice(0, 19).replace(/[-:]/gu, "") + "Z";
  };
  if (row.status !== "booked" || row.endsAt - row.startsAt !== 30 * 60_000) throw new Error("Invalid booking duration.");
  const text = (value: string) => value.replaceAll("\\", "\\\\").replace(/\r\n|\r|\n/gu, "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
  // RFC 5545 §§3.1/3.3.11: CRLF content lines, escaped TEXT, 75-octet folds.
  const encoder = new TextEncoder();
  const fold = (line: string) => {
    let output = "", bytes = 0;
    for (const character of line) {
      const size = encoder.encode(character).length;
      if (bytes + size > 75) { output += "\r\n "; bytes = 1; }
      output += character;
      bytes += size;
    }
    return output;
  };
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Clank//Booking//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${encodeURIComponent(String(row._id))}@${encodeURIComponent(host)}`,
    `DTSTAMP:${utc(row._creationTime)}`, `DTSTART:${utc(row.startsAt)}`, `DTEND:${utc(row.endsAt)}`,
    `SUMMARY:${text(row.title)}`, `DESCRIPTION:${text(`30-minute consultation. Start time: ${row.detail} UTC.${row.note ? `\n${row.note}` : ""}`)}`,
    "STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR", ""].map(fold).join("\r\n");
}
