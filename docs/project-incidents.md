# Project incident workspace

Use **Incidents** at `/projects/<project-slug>/incidents` to connect an immutable release, recurring error, trace, job, workflow and operational alert to an operator-owned recovery record. The console uses the same REST contract and `createProjectIncidentClient` as an application integration. Notes, assignment, resolution and reopening survive platform restart. Selecting an incident adds its ID to the URL; the status filter also survives a refresh.

The incident stores references rather than application logs, stack frames, trace attributes, job arguments/results, credentials or provider response bodies. A reference keeps its kind and identity. Release-backed references retain only the release ID, digest and creation time, so deleting an inactive artifact leaves useful historical context. References do not pin artifacts or prevent normal release cleanup. Diagnostic projections are current, bounded metadata; a missing trace or unavailable adapter is explicitly unavailable and does not establish recovery.

## Current access

Workspace owners and administrators have the project `incidents` permission. Other roles require an explicit project grant, and scoped CLI credentials require that permission too. Reading release references also needs `read`, error/trace/alert references need `logs`, and job/workflow references need `jobs`. An operator lacking that additional permission sees the reference category and a permission notice, with its identifier, release context and projection redacted. Adding or removing a reference requires its current additional permission. Assignment accepts only a currently enabled project incident operator.

Every read and mutation checks the current session or token, membership, permission and persisted protocol. CLI requests remain bound to the exact presented credential hash through body intake and diagnostic waits; replacing a token while a request is held invalidates that request. The controller repeats those checks after reading a request body or awaiting an adapter, and inside the write transaction. A role change cannot authorize a previously held request. Changing incidents and writing its receipt and audit record commit atomically. Support impersonation remains read-only. Switching projects, signing out or losing access clears the console's incident details and drafts.

## Scoped diagnostic adapters

Native release context and project operational alerts come from the control store. Enable the existing `operations` monitor for alert references; organization-wide usage alerts cannot be attached to a different project. Error, trace, job and workflow references use an explicit trusted readonly adapter into the application's diagnostic stores. The platform never executes uploaded application code in its shared process to resolve a reference.

Pass `incidents` to `openPlatform`. The following contract accepts a map of already authorized, release-scoped diagnostic readers; register these readers from your trusted application bootstrap. A reader can project `openErrorInbox(...).snapshot(...)`, `createTraceTimeline().snapshot(...)`, or `openJobs(...).get/events/getWorkflow/workflowEvents(...)`. Return only identity, availability, observation time and an optional operational state or count. Never return their raw payloads.

```ts
import {openPlatform} from "@clank.run/framework/platform";
import type {
  ProjectIncidentDiagnostic,
  ProjectIncidentReference,
} from "@clank.run/framework/project-incidents";

type Reference = Extract<ProjectIncidentReference, {releaseId: string}>;
type Reader = (reference: Reference, signal: AbortSignal) =>
  Promise<ProjectIncidentDiagnostic>;

const readers = new Map<string, Reader>();
const platform = await openPlatform({
  dataDirectory: "/srv/clank/control",
  publicUrl: "https://platform.example.com",
  incidents: {
    maxIncidents: 1000,
    maxReceipts: 10000,
    diagnostics: {
      async resolve(projectId, reference, signal) {
        const reader = readers.get(projectId + ":" + reference.releaseId);
        if (!reader) return {
          projectId, reference, available: false, observedAt: Date.now(),
        };
        return reader(reference, signal);
      },
    },
  },
});
```

The reader must validate the exact reference against that project's release-bound source. The platform rejects a mismatched project/reference, unknown fields, invalid state, negative count or invalid timestamp. Each callback has a two-second deadline and an abort signal. Four callbacks can be outstanding globally; an adapter that ignores abort keeps its capacity credit until it actually settles. Detail reads process at most eight references, two at a time, with a four-second overall diagnostic deadline. Slow reads produce an unavailable projection; no background retry or application write occurs. Current permission, release availability and incident version are checked again before returning a detail.

An error projection can report `open`, `resolved` or `regressed` and its retained occurrence count. Trace counts describe retained spans; job/workflow counts describe retained events. These are observations of the linked sources, not a copy of their timeline or proof that an error is fixed. The referenced source remains responsible for its authorization and retention.

## Exact changes and lost responses

```ts
import {createProjectIncidentClient} from "@clank.run/framework/project-incidents";

const client = createProjectIncidentClient({auth});
const incident = await client.create(projectId, {
  title: "Checkout latency after release",
  severity: "critical",
  ownerId: currentOperatorId,
  operationId: crypto.randomUUID(),
});
const request = {
  expectedVersion: incident.version,
  operationId: crypto.randomUUID(),
  change: {kind: "note" as const, text: "Verified the recovery job timeline."},
};
await client.change(projectId, incident.id, request);
```

Keep that exact request if delivery is uncertain. The same actor/project/operation ID and identical request returns its original retained result. Reusing it for different fields rejects with `409`. A new change needs the current expected version; a stale version cannot overwrite another operator's note, assignment or resolution. A historical receipt does not replay the old mutation or revive its earlier incident state. After retry, read the current detail before rendering it.

The console retains a lost-response request and offers an explicit **Retry same change** action. Refresh can inspect current state while retaining that request. It never silently creates another operation ID or automatically retries a write. Unsaved notes, resolution, title and references warn before navigation; definitive refusal preserves a draft where access still permits it. The client refreshes supplied headers and CSRF data for each request, rejects redirects, bounds the request to 16 KiB and response to 1 MiB, and times out fetch and body reads even if a custom transport ignores abort. The default timeout is ten seconds, configurable from 500 to 30,000 milliseconds.

## Limits and recovery

The control store allows up to 100 incidents per project, 100 notes and 50 references per incident. Lists return 25 incidents by default, at most 50, with a forward sequence cursor. Detail pages return 25 notes and eight references, with separate forward cursors. Global incident and receipt ceilings default to 1,000 and 10,000 and can be configured up to 100,000. Reaching a ceiling refuses new changes while exact retained retries remain readable; receipts are not silently pruned. Titles are at most 160 UTF-8 bytes; notes and resolutions at most 2,000. IDs and reference shapes are bounded and reject URLs or copied payloads.

Incident protocol 1 is checked at startup and throughout operations. An unsupported protocol refuses access before altering the incident tables. Back up the control SQLite store with your normal platform recovery process and retain a compatible binary. Closing the platform stops new incident work and aborts outstanding diagnostic reads. No notification delivery, public status publication or production monitoring certification is implied by an incident record.

Local acceptance uses real authenticated control-plane requests, actual releases/error/trace/job/workflow/alert stores, role revocation during held bodies and diagnostics, two SQLite controllers, atomic audit rollback and an actual SIGKILL after commit but before HTTP delivery. Three existing environmental skips remain visible in full release checks; disposable fixtures do not certify an external production provider.

Publish approved, dedicated customer copy through [customer status pages](customer-status-pages.md). Selecting a private incident supplies version-fenced provenance, without copying its private content.
