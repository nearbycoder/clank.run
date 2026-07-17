import test from "node:test";
import assert from "node:assert/strict";
import { createForm, s } from "../dist/index.js";

test("forms validate schemas, expose accessible control props, and reset cleanly", async () => {
  const form = createForm({
    id: "profile",
    initial: { name: "", age: undefined, role: "member", accepted: false },
    schema: s.object({
      name: s.string({ min: 2 }),
      age: s.optional(s.number({ integer: true, min: 18 })),
      role: s.enum(["member", "admin"]),
      accepted: s.literal(true),
    }),
  });

  assert.deepEqual(
    form.manifest.fields.map(({ name, required, control }) => ({ name, required, control })),
    [
      { name: "name", required: true, control: "text" },
      { name: "age", required: false, control: "number" },
      { name: "role", required: true, control: "select" },
      { name: "accepted", required: true, control: "checkbox" },
    ],
  );

  assert.equal(form.validate(), false);
  assert.equal(form.field("name").message.value, "Must contain at least 2 characters.");
  assert.equal(form.field("name").input()["aria-invalid"](), true);
  assert.equal(form.field("name").input()["aria-describedby"](), "profile-name-error");

  form.field("name").input().onInput({ currentTarget: { value: "Ada" } });
  form.field("age").input({ type: "number" }).onInput({
    currentTarget: { value: "36", valueAsNumber: 36 },
  });
  form.field("role").select().onChange({ currentTarget: { value: "admin" } });
  form.field("accepted").checkbox().onChange({ currentTarget: { checked: true } });

  assert.deepEqual({ ...form.values.value }, {
    name: "Ada",
    age: 36,
    role: "admin",
    accepted: true,
  });
  assert.equal(form.dirty.value, true);
  assert.equal(form.validate(), true);
  assert.equal(form.valid.value, true);

  form.reset();
  assert.equal(form.dirty.value, false);
  assert.deepEqual({ ...form.values.value }, {
    name: "",
    age: undefined,
    role: "member",
    accepted: false,
  });
});

test("form submit supports server field errors, success state, and replacement cancellation", async () => {
  const releases = [];
  const signals = [];
  const form = createForm({
    id: "invite",
    initial: { email: "taken@example.com" },
    schema: s.object({ email: s.string({ min: 3 }) }),
    onSubmit: (values, context) => {
      signals.push(context.signal);
      if (values.email === "taken@example.com") {
        context.setErrors({ email: "That address is already invited." });
        return "rejected";
      }
      return new Promise((resolve) => releases.push(() => resolve(values.email)));
    },
  });

  assert.equal(await form.submit(), undefined);
  assert.equal(form.status.value, "invalid");
  assert.equal(form.field("email").message.value, "That address is already invited.");

  form.setValue("email", "first@example.com");
  const first = form.submit();
  form.setValue("email", "second@example.com");
  const second = form.submit();
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[2].aborted, false);

  releases[0]();
  releases[1]();
  assert.equal(await first, undefined);
  assert.equal(await second, "second@example.com");
  assert.equal(form.result.value, "second@example.com");
  assert.equal(form.status.value, "success");
  assert.equal(form.submitCount.value, 3);
});

test("forms reject dangerous field names and focus the first invalid named control", () => {
  const unsafe = Object.create(null);
  unsafe.__proto__ = "";
  assert.throws(() => createForm({ initial: unsafe }), /Unsafe form field name/);

  const form = createForm({
    id: "contact",
    initial: { subject: "", message: "" },
    schema: s.object({
      subject: s.string({ min: 1 }),
      message: s.string({ min: 1 }),
    }),
  });
  form.validate();
  let focused = "";
  const root = {
    querySelectorAll() {
      return [
        { getAttribute: () => "subject", focus: () => { focused = "subject"; } },
        { getAttribute: () => "message", focus: () => { focused = "message"; } },
      ];
    },
  };
  assert.equal(form.focusFirstError(root), true);
  assert.equal(focused, "subject");
  assert.throws(() => form.setErrors({ missing: "No such field." }), /Unknown form error field/);
  assert.throws(() => form.reset({ subject: "Incomplete" }), /exactly the original fields/);
});

test("form IDs normalize adversarial boundary input in linear time", () => {
  const form = createForm({
    id: `${"-".repeat(100_000)}profile${"-".repeat(100_000)}`,
    initial: { name: "" },
  });
  assert.equal(form.field("name").input().id, "profile-name");
});
