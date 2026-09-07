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
  const act = async (status: RecipeDecision, response?: string) => { if (busy.value) return; busy.value = true; try { await props.update(props.row, status, response); } finally { busy.value = false; } };
  return <article><div class="record-heading"><h2>{props.row.title}</h2><span class="status">{props.row.status}</span></div><p class="detail">{props.row.detail}</p>
    {props.row.note ? <p class="response">Response: {props.row.note}</p> : null}
    {props.row.status === "booked" ? <button disabled={busy.value} onClick={() => act("cancelled")} agentId={`cancel-${props.row._id}`} agentAction={api.records.update}>Cancel booking</button> : null}
  </article>;
}
