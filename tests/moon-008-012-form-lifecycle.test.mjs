import test from "node:test";
import assert from "node:assert/strict";
import { createForm } from "../dist/forms.js";
import { effect } from "../dist/core.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("008 setValues rejects unknown later fields before changing values or errors", () => {
  const form = createForm({ initial: { first: "original", second: "original" } });
  form.setErrors({ first: "Keep this error", _form: "Keep this summary" });
  const seen = [];
  const stop = effect(() => {
    seen.push([form.values.value.first, form.values.value.second, form.formErrors.value, form.status.value]);
  });
  try {
    assert.throws(() => form.setValues({ first: "changed", unknown: "invalid" }), /Unknown form field/);
    assert.deepEqual({ ...form.values.value }, { first: "original", second: "original" });
    assert.deepEqual(form.field("first").errors.value, ["Keep this error"]);
    assert.deepEqual(form.formErrors.value, ["Keep this summary"]);
    assert.equal(form.status.value, "invalid");
    assert.equal(form.dirty.value, false);
    assert.equal(seen.length, 1);
    form.setValues({ first: "changed", second: "changed" });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], ["changed", "changed", [], "idle"]);
  } finally {
    stop();
  }
});

test("008 setValues reads every entry before applying any of them", () => {
  const form = createForm({ initial: { first: "original", second: "original" } });
  const failure = new Error("Unable to read second");
  assert.throws(() => form.setValues({ first: "changed", get second() { throw failure; } }), (error) => error === failure);
  assert.deepEqual({ ...form.values.value }, { first: "original", second: "original" });
});

test("009 failed reset validation or cloning preserves the pending submission", async () => {
  const work = deferred();
  let context;
  const form = createForm({ initial: { name: "original" }, onSubmit: (_values, next) => {
    context = next;
    return work.promise;
  } });
  form.setValue("name", "submitted");
  const submitted = form.submit();
  for (const next of [{}, { name: "new", extra: true }, { name: () => {} }, null, false, 0, []]) {
    assert.throws(() => form.reset(next), undefined, `reset(${String(next)}) rejects`);
    assert.equal(context.signal.aborted, false);
    assert.equal(form.pending.value, true);
    assert.equal(form.status.value, "submitting");
    assert.equal(form.field("name").value.value, "submitted");
    assert.equal(form.submitCount.value, 1);
  }
  work.resolve("accepted");
  assert.equal(await submitted, "accepted");
  assert.equal(form.status.value, "success");
  form.reset();
  assert.equal(form.field("name").value.value, "original");
});

test("010 superseded setErrors cannot reject or corrupt a newer submission", async () => {
  const submissions = [];
  const form = createForm({ initial: { name: "first" }, onSubmit: (_values, context) => {
    const work = deferred();
    submissions.push({ context, ...work });
    return work.promise;
  } });
  const first = form.submit();
  form.setValue("name", "second");
  const second = form.submit();
  const [old, current] = submissions;
  assert.equal(old.context.signal.aborted, true);
  old.context.setErrors({ name: "stale field", _form: "stale summary" });
  assert.deepEqual(form.field("name").errors.value, []);
  assert.deepEqual(form.formErrors.value, []);
  assert.equal(form.status.value, "submitting");
  assert.equal(form.pending.value, true);
  old.reject(new Error("old submission failed"));
  await first;
  assert.equal(form.status.value, "submitting");
  assert.equal(form.error.value, undefined);
  old.context.setErrors({ name: "still stale" });
  current.resolve("new result");
  assert.equal(await second, "new result");
  assert.equal(form.status.value, "success");
  current.context.setErrors({ name: "too late" });
  assert.deepEqual(form.field("name").errors.value, []);
  assert.equal(form.status.value, "success");
});

test("010 current setErrors remains usable when concurrent submissions are ignored", async () => {
  const work = deferred();
  let context;
  const form = createForm({ initial: { name: "value" }, concurrency: "ignore", onSubmit: (_values, next) => {
    context = next;
    return work.promise;
  } });
  const first = form.submit();
  assert.equal(await form.submit(), undefined);
  assert.equal(form.submitCount.value, 1);
  assert.equal(context.signal.aborted, false);
  assert.throws(() => context.setErrors({ missing: "programming error" }), /Unknown form error field/);
  context.setErrors({ name: "Server rejected this value" });
  work.resolve("rejected result");
  assert.equal(await first, undefined);
  assert.equal(form.pending.value, false);
  assert.equal(form.status.value, "invalid");
  context.setErrors({ name: "late overwrite" });
  assert.deepEqual(form.field("name").errors.value, ["Server rejected this value"]);
});

test("010 reset invalidates retained setErrors callbacks", async () => {
  const work = deferred();
  let context;
  const form = createForm({ initial: { name: "initial" }, onSubmit: (_values, next) => {
    context = next;
    return work.promise;
  } });
  const pending = form.submit();
  form.reset({ name: "reset" });
  context.setErrors({ name: "old error", _form: "old summary" });
  assert.equal(form.status.value, "idle");
  assert.deepEqual(form.field("name").errors.value, []);
  assert.deepEqual(form.formErrors.value, []);
  work.resolve("stale");
  assert.equal(await pending, undefined);
});

test("011 stale reset cannot cancel a replacement while a current reset establishes its baseline", async () => {
  const submissions = [];
  const form = createForm({ initial: { name: "initial" }, onSubmit: (_values, context) => {
    const work = deferred();
    submissions.push({ context, ...work });
    return work.promise;
  } });
  const first = form.submit();
  form.setValue("name", "newer");
  const second = form.submit();
  const [old, current] = submissions;
  old.context.reset({ name: "stale" });
  assert.equal(current.context.signal.aborted, false);
  assert.equal(form.pending.value, true);
  assert.equal(form.field("name").value.value, "newer");
  assert.throws(() => current.context.reset({}), /exactly the original fields/);
  assert.equal(current.context.signal.aborted, false);
  current.context.reset({ name: "accepted baseline" });
  assert.equal(current.context.signal.aborted, true);
  assert.equal(form.pending.value, false);
  assert.equal(form.status.value, "idle");
  assert.equal(form.dirty.value, false);
  current.context.reset({ name: "second reset is stale" });
  assert.equal(form.field("name").value.value, "accepted baseline");
  old.resolve("old");
  current.resolve("newer");
  await Promise.all([first, second]);
  assert.equal(form.result.value, undefined);
  form.setValue("name", "edit");
  form.reset();
  assert.equal(form.field("name").value.value, "accepted baseline");
});

test("010–011 settled success and failure contexts cannot mutate later edits", async () => {
  for (const fails of [false, true]) {
    let context;
    const failure = new Error("submission failed");
    const form = createForm({ initial: { name: "initial" }, onSubmit: (_values, next) => {
      context = next;
      if (fails) throw failure;
      return "saved";
    } });
    await form.submit();
    assert.equal(form.status.value, fails ? "error" : "success");
    form.setValue("name", "later edit");
    const status = form.status.value;
    context.reset({ name: "stale" });
    context.setErrors({ name: "stale" });
    assert.equal(form.field("name").value.value, "later edit");
    assert.deepEqual(form.field("name").errors.value, []);
    assert.equal(form.status.value, status);
    assert.equal(form.error.value, fails ? failure : undefined);
  }
});

for (const validation of ["custom", "schema"]) {
  test(`012 thrown ${validation} validation settles submission and remains throwable directly`, async () => {
    const failure = new Error(`${validation} validator failed`);
    let shouldThrow = true;
    let calls = 0;
    const validate = (values) => {
      if (shouldThrow) throw failure;
      return values;
    };
    const form = createForm({
      initial: { name: "value" },
      ...(validation === "custom"
        ? { validate: (values) => { validate(values); } }
        : { schema: { toJSONSchema: () => ({}), safeParse: (values) => ({ success: true, data: validate(values) }) } }),
      onSubmit: () => { calls++; return "saved"; },
    });
    assert.throws(() => form.validate(), (error) => error === failure);
    assert.equal(form.status.value, "idle");
    assert.equal(form.pending.value, false);
    assert.equal(await form.submit(), undefined);
    assert.equal(form.pending.value, false);
    assert.equal(form.status.value, "error");
    assert.equal(form.error.value, failure);
    assert.equal(form.submitted.value, true);
    assert.equal(form.field("name").touched.value, true);
    assert.equal(calls, 0);
    shouldThrow = false;
    assert.equal(await form.submit(), "saved");
    assert.equal(form.error.value, undefined);
    assert.equal(form.status.value, "success");
    assert.equal(form.submitCount.value, 2);
    assert.equal(calls, 1);
  });
}

test("012 a validator error from a replaced submission does not settle the current submission", async () => {
  const work = deferred();
  let validationCount = 0;
  let newer;
  const form = createForm({
    initial: { name: "value" },
    validate() {
      if (++validationCount === 1) {
        newer = form.submit();
        throw new Error("old validation failed");
      }
    },
    onSubmit: () => work.promise,
  });
  assert.equal(await form.submit(), undefined);
  assert.equal(form.pending.value, true);
  assert.equal(form.status.value, "submitting");
  assert.equal(form.error.value, undefined);
  work.resolve("current result");
  assert.equal(await newer, "current result");
  assert.equal(form.status.value, "success");
});

test("012 reset during throwing validation preserves the reset state", async () => {
  const form = createForm({ initial: { name: "original" }, validate() {
    form.reset({ name: "reset" });
    throw new Error("old validation failed");
  } });
  assert.equal(await form.submit(), undefined);
  assert.equal(form.pending.value, false);
  assert.equal(form.status.value, "idle");
  assert.equal(form.error.value, undefined);
  assert.equal(form.field("name").value.value, "reset");
});

test("012 normal invalid and no-handler submissions preserve their terminal states", async () => {
  const invalid = createForm({ initial: { name: "" }, validate: () => ({ name: "Required" }) });
  assert.equal(await invalid.submit(), undefined);
  assert.equal(invalid.status.value, "invalid");
  assert.equal(invalid.pending.value, false);
  assert.equal(invalid.error.value, undefined);
  const valid = createForm({ initial: { name: "ready" } });
  assert.equal(await valid.submit(), undefined);
  assert.equal(valid.status.value, "success");
  assert.equal(valid.pending.value, false);
});

test("010–012 resetOnSuccess restores the baseline and invalidates retained callbacks", async () => {
  let context;
  const form = createForm({ initial: { name: "initial" }, resetOnSuccess: true, onSubmit: (_values, next) => {
    context = next;
    return "saved";
  } });
  form.setValue("name", "submitted");
  assert.equal(await form.submit(), "saved");
  assert.equal(form.status.value, "idle");
  assert.equal(form.pending.value, false);
  assert.equal(form.field("name").value.value, "initial");
  assert.equal(form.dirty.value, false);
  context.setErrors({ name: "late error" });
  context.reset({ name: "late reset" });
  assert.equal(form.status.value, "idle");
  assert.equal(form.field("name").value.value, "initial");
  assert.deepEqual(form.field("name").errors.value, []);
});

test("010–011 terminal state observers cannot reuse the completed submit context", async () => {
  let context;
  const form = createForm({ initial: { name: "initial" }, onSubmit: (_values, next) => {
    context = next;
    return "saved";
  } });
  const stop = effect(() => {
    if (form.status.value === "success") {
      context.setErrors({ name: "late error" });
      context.reset({ name: "late reset" });
    }
  });
  try {
    assert.equal(await form.submit(), "saved");
    assert.equal(form.status.value, "success");
    assert.equal(form.field("name").value.value, "initial");
    assert.deepEqual(form.field("name").errors.value, []);
  } finally {
    stop();
  }
});

test("012 resetOnSuccess cannot cancel a newer submission started by a success observer", async () => {
  const submissions = [];
  const form = createForm({ initial: { name: "initial" }, resetOnSuccess: true, onSubmit: (_values, context) => {
    const work = deferred();
    submissions.push({ context, ...work });
    return work.promise;
  } });
  let newer;
  let started = false;
  const stop = effect(() => {
    if (form.status.value === "success" && !started) {
      started = true;
      form.setValue("name", "newer");
      newer = form.submit();
    }
  });
  try {
    const first = form.submit();
    submissions[0].resolve("first result");
    assert.equal(await first, "first result");
    assert.equal(submissions[1].context.signal.aborted, false);
    assert.equal(form.pending.value, true);
    assert.equal(form.field("name").value.value, "newer");
    submissions[1].resolve("newer result");
    assert.equal(await newer, "newer result");
    assert.equal(form.status.value, "idle");
    assert.equal(form.field("name").value.value, "initial");
  } finally {
    stop();
  }
});

for (const validation of ["custom", "schema"]) {
  test(`012 returned ${validation} errors cannot overwrite a reset made during validation`, async () => {
    let form;
    const invalidate = () => {
      form.reset({ name: "reset" });
      return { name: "obsolete validation error" };
    };
    form = createForm({ initial: { name: "original" },
      ...(validation === "custom" ? { validate: invalidate } : { schema: {
        toJSONSchema: () => ({}),
        safeParse() { invalidate(); return { success: false, error: { issues: [{ path: ["name"], message: "obsolete schema error" }] } }; },
      } }),
      onSubmit: () => assert.fail("the replaced submission must not run"),
    });
    assert.equal(await form.submit(), undefined);
    assert.equal(form.field("name").value.value, "reset");
    assert.deepEqual(form.field("name").errors.value, []);
    assert.deepEqual(form.formErrors.value, []);
    assert.equal(form.status.value, "idle");
    assert.equal(form.pending.value, false);
    assert.equal(form.error.value, undefined);
  });

  test(`012 returned ${validation} errors cannot corrupt a newer pending or successful submission`, async () => {
    const work = deferred();
    let form, newer, calls = 0;
    const validate = (values) => {
      if (++calls === 1) {
        form.setValue("name", "newer");
        newer = form.submit();
        return { name: "obsolete validation error" };
      }
    };
    form = createForm({ initial: { name: "original" },
      ...(validation === "custom" ? { validate } : { schema: {
        toJSONSchema: () => ({}),
        safeParse(values) {
          return validate(values)
            ? { success: false, error: { issues: [{ path: ["name"], message: "obsolete schema error" }] } }
            : { success: true, data: { name: `${values.name} parsed` } };
        },
      } }),
      onSubmit: (values) => {
        assert.equal(values.name, validation === "schema" ? "newer parsed" : "newer");
        return work.promise;
      },
    });
    assert.equal(await form.submit(), undefined);
    assert.equal(form.pending.value, true);
    assert.equal(form.status.value, "submitting");
    assert.deepEqual(form.field("name").errors.value, []);
    work.resolve("current");
    assert.equal(await newer, "current");
    assert.equal(form.status.value, "success");
    assert.deepEqual(form.field("name").errors.value, []);
  });
}

test("012 validation outcomes commit together before an error observer starts a replacement", async () => {
  const work = deferred();
  let calls = 0, newer;
  const form = createForm({ initial: { name: "original" }, validate: () => ++calls === 1 ? { name: "first error" } : undefined, onSubmit: () => work.promise });
  const stop = effect(() => {
    if (form.field("name").errors.value.length) newer = form.submit();
  });
  try {
    await form.submit();
    assert.equal(form.pending.value, true);
    assert.equal(form.status.value, "submitting");
    assert.deepEqual(form.field("name").errors.value, []);
    work.resolve("current"); await newer;
    assert.equal(form.status.value, "success");
  } finally { stop(); }
});

test("012 manual validation still commits its returned errors after validator-driven reset", () => {
  const form = createForm({ initial: { name: "original" }, validate() {
    form.reset({ name: "reset" });
    return { name: "manual validation error" };
  } });
  assert.equal(form.validate(), false);
  assert.equal(form.field("name").value.value, "reset");
  assert.equal(form.status.value, "invalid");
  assert.deepEqual(form.field("name").errors.value, ["manual validation error"]);
});

test("010 server errors cannot reject a replacement started by an error observer", async () => {
  const submissions = [];
  const form = createForm({ initial: { name: "value" }, onSubmit: (_values, context) => {
    const work = deferred();
    submissions.push({ context, ...work });
    return work.promise;
  } });
  let newer;
  const stop = effect(() => {
    if (form.field("name").errors.value.length) newer = form.submit();
  });
  try {
    const older = form.submit();
    submissions[0].context.setErrors({ name: "first error" });
    assert.equal(form.pending.value, true);
    assert.equal(form.status.value, "submitting");
    assert.deepEqual(form.field("name").errors.value, []);
    submissions[1].resolve("current");
    assert.equal(await newer, "current");
    assert.equal(form.status.value, "success");
    submissions[0].resolve("old"); await older;
    assert.equal(form.result.value, "current");
  } finally { stop(); }
});
