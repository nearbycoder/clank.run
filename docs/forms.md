# Forms

Clank forms are headless: the framework owns state, validation, accessible control wiring, submission, and cancellation while the application owns its HTML and Tailwind classes.

This keeps generated code readable. There is no component DSL to learn and no required visual style.

## Create a form

```tsx
import { createForm, s } from "@clank.run/framework";

const signup = createForm({
  id: "signup",
  initial: {
    name: "",
    email: "",
    plan: "starter" as "starter" | "team",
    accepted: false,
  },
  schema: s.object({
    name: s.string({ min: 2, max: 80 }),
    email: s.email({ max: 160 }),
    plan: s.enum(["starter", "team"]),
    accepted: s.literal(true),
  }),
  validateOn: "blur",
  onSubmit: async (values, { signal }) => {
    await saveAccount(values, { signal });
  },
});
```

The initial object is the inference root. Field names, values, `setValue`, validation output, and `onSubmit` values retain those types.

The `id` is deterministic so SSR and hydration produce the same control, error, and description IDs.

## Render native controls

```tsx
function SignupForm() {
  const name = signup.field("name");
  const email = signup.field("email");
  const plan = signup.field("plan");
  const accepted = signup.field("accepted");

  return (
    <form {...signup.props()} class="space-y-5">
      <div>
        <label for={name.id}>Name</label>
        <input {...name.input()} autocomplete="name" />
        <p {...name.error()}>{name.message.value}</p>
      </div>

      <div>
        <label for={email.id}>Email</label>
        <input {...email.input({ type: "email" })} autocomplete="email" />
        <p {...email.error()}>{email.message.value}</p>
      </div>

      <select {...plan.select()}>
        <option value="starter">Starter</option>
        <option value="team">Team</option>
      </select>

      <label>
        <input {...accepted.checkbox()} />
        I agree to the terms.
      </label>

      <button type="submit" disabled={signup.pending.value}>
        {signup.pending.value ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
```

Field helpers return ordinary Clank/HTML props:

- `input()` handles text, date, email, password, number, range, and other native inputs.
- `textarea()` handles multiline text.
- `select()` handles single or multiple selection.
- `checkbox()` is available only on boolean fields in TypeScript.
- `radio({ value })` creates one option for a field.
- `error()` provides a stable ID, polite live region, and reactive `hidden` state.

`aria-invalid` remains explicitly `"true"` or `"false"`. When errors exist, the control automatically references its error element with `aria-describedby`.

## State

The form controller exposes:

```ts
signup.values.value;
signup.dirty.value;
signup.valid.value;
signup.pending.value;
signup.submitted.value;
signup.submitCount.value;
signup.status.value; // idle | invalid | submitting | success | error
signup.result.value;
signup.error.value;
signup.formErrors.value;
```

Each field exposes `value`, `errors`, `message`, `touched`, `dirty`, and `invalid`.

Imperative updates remain explicit:

```ts
signup.setValue("plan", "team");
signup.setValues({ name: "Ada", email: "ada@example.com" });
signup.reset();
signup.reset({
  name: "Grace",
  email: "grace@example.com",
  plan: "team",
  accepted: true,
});
```

Reset values must contain exactly the original fields. Unknown field errors throw instead of disappearing silently.

## Validation

Schema validation is synchronous and deterministic:

```ts
signup.validate("manual");
```

Validation issues are mapped by their first path segment. Nested issues remain attached to their top-level form field, which works well when nested editors are composed as separate form controllers.

Cross-field validation is a plain function:

```ts
const stay = createForm({
  id: "stay",
  initial: { checkIn: "", checkOut: "" },
  schema: s.object({
    checkIn: s.date(),
    checkOut: s.date(),
  }),
  validate(values) {
    return values.checkOut <= values.checkIn
      ? { checkOut: "Check-out must be after check-in." }
      : undefined;
  },
});
```

`validateOn` may be `submit`, `blur`, or `input`. Expensive remote checks belong in `onSubmit`; the server can return field errors through `setErrors`.

## Submission and server errors

```ts
const invite = createForm({
  id: "invite",
  initial: { email: "" },
  schema: s.object({ email: s.email() }),
  onSubmit: async (values, { signal, setErrors }) => {
    const response = await fetch("/api/invitations", {
      method: "POST",
      signal,
      body: JSON.stringify(values),
    });
    if (response.status === 409) {
      setErrors({ email: "That person is already invited." });
      return;
    }
    if (!response.ok) throw new Error("Invitation failed.");
  },
});
```

New submissions abort older submissions by default and ignore their stale results. Set `concurrency: "ignore"` when a second submit should do nothing while the first is pending.

An invalid submit marks every field touched and focuses the first invalid named control unless `focusFirstError: false` is configured.

`resetOnSuccess: true` restores initial values after a successful submit. A manual `reset(values)` establishes a new baseline.

## Form manifests for agents

Every controller exposes a stable manifest:

```ts
signup.manifest;
```

The protocol is `clank-form/1`. It includes the form ID, JSON Schema, field names, required state, and a suggested native control type.

The manifest does not contain live field values. Rendered controls remain discoverable through
native IDs, associated labels, semantic roles, and optional `agentId`/`agentAction` metadata.
For a server-backed submit control, prefer `agentAction={api.resource.mutation}` over a copied
string and verify it with `assertAgentActionParity()` in the application contract test.

Password and file-input values are deliberately omitted from semantic inspection.

## Multi-step and nested forms

Compose one controller per independently validated step:

```ts
const dates = createForm({ /* … */ });
const room = signal("standard");
const guest = createForm({ /* … */ });
```

This produces smaller contracts, clearer error ownership, and simpler generated code than a single controller with conditional nested paths. The booking example under `examples/booking` demonstrates the pattern.

## Security notes

- Client validation improves UX; server actions must validate again.
- Never render `form.error.value` directly when it may contain a sensitive server exception. Map it to a user-safe message.
- Do not place secrets in initial values, labels, agent metadata, or form manifests.
- File uploads require an explicit upload transport. `createAgentSurface().input()` refuses file inputs.
- Form cancellation is cooperative. Pass the provided `AbortSignal` into Fetch or other cancellable work.

## CSV import with validation and preview

`@clank.run/framework/csv-import` provides a strict parser, typed mapping planner, and browser
import controls without an upload service. All parsing and previewing can happen locally.

```ts
import { mountCsvImporter } from "@clank.run/framework/csv-import";
const dispose = mountCsvImporter(panel, {
  fields: [{ name: "name", type: "text", required: true },
    { name: "quantity", type: "integer", required: true }],
  uniqueBy: ["name"],
  commit: async (records, { idempotencyKey, signal }) => {
    await api.importRows({ records, idempotencyKey }, { signal });
  },
});
```

The panel accepts pasted CSV or a local file, lets users map source headers to target fields,
previews the first 20 typed records or validation issues, and enables import only for a valid,
nonempty plan. A failed write can retry with the same operation key. Dispose aborts the signal;
it cannot undo a server transaction that already committed.

For headless use, call `parseCsv(text)`, then `planCsvImport(text, { columns, uniqueBy, existing,
duplicates })`. A column declares `source`, `target`, `type`, and optional `required`. Supported
types are text, finite numbers, safe integers, booleans (`true`, `false`, `1`, `0`), and real ISO
calendar dates. Surrounding whitespace is trimmed and optional empty cells become null.
Duplicates within the file or against the supplied existing records can fail or be skipped.
Existing-key evidence is only a preview: enforce uniqueness again inside the server transaction.

`commitCsvImport(plan, commit, signal)` accepts only a validated plan created in the same runtime,
blocks concurrent/repeated successful commits, and invokes one host callback. The host must
revalidate authorization and schema, write atomically, and persist the supplied idempotency key
with its writes so a lost response cannot duplicate an import. This module never guesses a
business table or silently makes multiple partial writes.

Limits: 5 MiB input, 100 columns, 65,536 characters per cell, 10,000 data rows by default (maximum
50,000), and 1,000 reported validation issues. Quoted delimiters, escaped quotes, multiline fields,
UTF-8 BOMs, CRLF/LF, and explicit comma/semicolon/tab delimiters are supported. Duplicate/empty
headers, malformed quotes, and mismatched row widths are rejected. Errors identify record and
target column without echoing cell values; a record number counts quoted multiline data as one row.

## CSV export and downloads

`@clank.run/framework/csv-export` exports authorized application records with explicit columns,
UTF-8 encoding, CRLF records, and spreadsheet formula protection. It needs no export service.

```ts
import { mountCsvExporter, csvExportResponse } from "@clank.run/framework/csv-export";
const columns = [{ field: "name", label: "Name" }, { field: "quantity", label: "Quantity" }];
const dispose = mountCsvExporter(panel, {
  columns, records: () => visibleAuthorizedRows, filename: "inventory.csv",
});
// A server route can stream a separately authorized async record iterator:
return csvExportResponse(authorizedRecords(), columns, { filename: "inventory.csv" });
```

The browser control lets users choose columns and explicitly download a complete file. It validates
all cells and limits before producing a download, reports success/failure, and revokes temporary
object URLs on cleanup. `exportCsv(records, columns, options)` provides the same buffered operation.

Fields use literal own-property names. Missing/null cells are empty; strings, finite numbers,
booleans, and valid Date objects are supported. Every cell is quoted and embedded quotes are doubled.
Strings that could start spreadsheet formulas receive a leading apostrophe, including whitespace
before `=`, `+`, `-`, or `@`, and leading tabs/newlines. This also protects column labels. Numeric
negative values retain their numeric spelling. Formula protection intentionally changes dangerous
text values; callers should retain originals in their database.

Defaults are a UTF-8 BOM, comma delimiter, 10,000 rows, and 5 MiB. Options support semicolon/tab,
`bom: false`, and explicit bounded row/byte limits. Cells cannot exceed 65,536 characters.
`streamCsvExport` consumes an async iterator only when the reader requests another row and calls
its return method on cancellation or failure. A late invalid row errors the stream, so use buffered
export when partial output must never be visible. Attachment responses are private/non-cacheable
and reject path-like or header-injecting filenames. Always apply ownership and field authorization
before passing records; column selection is not an access-control boundary.


## Recoverable editor drafts

`@clank.run/framework/drafts` provides device-local recovery without an additional service:

```ts
const store = await openDraftStore("my-app-drafts");
const session = await mountDraftRecovery(panel, {
  store, key: `${account.id}:article:${article.id}`,
  read: () => ({ title: titleInput.value, body: bodyInput.value }),
  write: draft => { titleInput.value = draft.title; bodyInput.value = draft.body; },
});
editor.addEventListener("input", () => session.changed());
// After the host successfully saves the actual record:
await session.discard();
// Before navigation, explicitly await session.flush(); then dispose and close.
```

Existing drafts require explicit recovery or discard before autosaving. The host chooses the fields through `read`/`write`; do not include passwords, payment data, or other fields that should not persist on a shared device. Keys should include the account and resource, but this is browser storage, not server authorization or encryption. Clear appropriate drafts at sign-out if the device policy requires it.

IndexedDB read/write transactions prevent concurrent tabs from silently overwriting the same revision. Conflicts stop autosaving until explicit recovery; generic storage failures retain dirty editor state for `flush()` retry. Saves debounce by 500 ms, serialized operations preserve edit order, and disposing cancels future timers. Async work already committed cannot be undone by disposal. Do not rely on unload handlers to finish asynchronous writes; flush at a controlled navigation boundary.

Snapshots accept finite plain JSON values, reject getters, cycles and sparse arrays, and are bounded to 64 KiB, 10,000 nodes, and depth 20. Each database holds at most 200 drafts. Default expiry is seven days, configurable from one second to 30 days; `store.prune()` removes expired entries. Loading an expired draft also removes it. Browser quota failures are surfaced rather than claiming a successful save. Close stores on shutdown; call the mount/session disposer when removing the editor.

## Local undo and redo

Use `createUndoHistory(initialValue)` from `@clank.run/framework/undo-history` for a structured editor. On accepted edits call `history.commit(nextValue, "Change title")`. `mountUndoControls(panel, history, applyValue)` renders named undo/redo actions; dispose the controls when removing the editor. `state()` returns a detached current value, available actions, labels, and retained bytes. Subscribe to changes with `subscribe(listener)` and call its returned unsubscribe function when finished.

`transaction(value => nextValue, label)` combines several synchronous edits into one step and commits nothing if the callback fails. Reentrant mutations and promises are rejected. Passing the same explicit group to consecutive `commit` calls coalesces typing into one step; undo, redo, reset, and snapshot restoration end the group. Committing after undo discards the redo branch. Equal serialized values do not add a step.

The default capacity is 100 undo steps within a one-MiB snapshot budget, configurable up to 1,000 steps and 16 MiB. Oldest states are evicted first and cannot be undone after eviction. Individual oversized values fail before history changes. Values must be finite plain JSON, bounded to depth 20 and 10,000 nodes; snapshots are detached from caller mutations. `serialize()` and `restore(text)` preserve both branches, validate the complete snapshot before replacing state, and can be paired with the draft store. Listener failures do not interrupt other listeners or corrupt history.

This history applies to local editor state. It does not reverse network requests, payments, or server-side changes. Host `applyValue` callbacks should synchronously update the editor; errors are displayed but do not automatically compensate external effects. Use the record-history service for version-fenced persisted document restoration.
