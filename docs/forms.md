# Forms

Clank forms are headless: the framework owns state, validation, accessible control wiring, submission, and cancellation while the application owns its HTML and Tailwind classes.

This keeps generated code readable. There is no component DSL to learn and no required visual style.

## Create a form

```tsx
import { createForm, s } from "clank.run";

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

The manifest does not contain live field values. Rendered controls remain discoverable through native IDs, associated labels, semantic roles, and optional `agentId`/`agentAction` metadata.

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
