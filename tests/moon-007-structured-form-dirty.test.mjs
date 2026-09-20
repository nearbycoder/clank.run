import test from "node:test";
import assert from "node:assert/strict";
import { createForm } from "../dist/forms.js";

test("structured fields start clean, track content changes, and become clean after restoration", () => {
  const initial = { tags: ["news"], profile: { name: "Ada", options: { notify: true } } };
  const form = createForm({ initial });
  assert.equal(form.field("tags").dirty.value, false);
  assert.equal(form.field("profile").dirty.value, false);
  assert.equal(form.dirty.value, false);

  form.setValue("tags", ["news", "updates"]);
  assert.equal(form.field("tags").dirty.value, true);
  assert.equal(form.dirty.value, true);
  form.setValue("tags", ["news"]);
  assert.equal(form.dirty.value, false);

  form.field("profile").value.value = { options: { notify: false }, name: "Ada" };
  assert.equal(form.field("profile").dirty.value, true);
  form.field("profile").set({ options: { notify: true }, name: "Ada" });
  assert.equal(form.dirty.value, false);
});

test("field and form resets restore isolated structured baselines", () => {
  const initial = { value: { items: ["original"] } };
  const form = createForm({ initial });
  const field = form.field("value");
  initial.value.items.push("outside");
  field.value.value.items.push("inside");
  field.set({ items: ["changed"] });
  assert.equal(form.dirty.value, true);
  field.reset();
  assert.deepEqual(field.value.value, { items: ["original"] });
  assert.equal(field.dirty.value, false);
  assert.equal(form.dirty.value, false);

  const replacement = { value: { items: ["replacement"] } };
  form.reset(replacement);
  assert.equal(form.dirty.value, false);
  replacement.value.items.push("outside");
  field.set({ items: ["temporary"] });
  form.reset();
  assert.deepEqual(field.value.value, { items: ["replacement"] });
  assert.equal(form.dirty.value, false);
});

test("structured dirty comparisons preserve primitive Object.is distinctions and array shape", () => {
  const form = createForm({ initial: { number: NaN, signed: -0, value: { a: undefined, b: NaN }, list: [, "x"] } });
  assert.equal(form.dirty.value, false);
  form.setValue("number", NaN);
  assert.equal(form.field("number").dirty.value, false);
  form.setValue("signed", 0);
  assert.equal(form.field("signed").dirty.value, true);
  form.setValue("signed", -0);
  assert.equal(form.field("signed").dirty.value, false);

  form.setValue("value", { b: NaN });
  assert.equal(form.field("value").dirty.value, true);
  form.setValue("value", { a: undefined, b: null });
  assert.equal(form.field("value").dirty.value, true);
  form.setValue("value", { b: NaN, a: undefined });
  assert.equal(form.field("value").dirty.value, false);
  form.setValue("list", [undefined, "x"]);
  assert.equal(form.field("list").dirty.value, true);
  form.setValue("list", [, "x", ,]);
  assert.equal(form.field("list").dirty.value, true);
  form.setValue("list", [, "x"]);
  assert.equal(form.dirty.value, false);
});

test("cyclic field values compare and reset without recursion failures", () => {
  const value = { label: "original" };
  value.self = value;
  value.items = [value];
  const form = createForm({ initial: { value } });
  assert.equal(form.dirty.value, false);
  const changed = structuredClone(value);
  changed.label = "changed";
  form.setValue("value", changed);
  assert.equal(form.dirty.value, true);
  form.setValue("value", structuredClone(value));
  assert.equal(form.dirty.value, false);
  form.reset();
  assert.equal(form.field("value").value.value.self, form.field("value").value.value);
  assert.equal(form.dirty.value, false);
});

test("cloneable built-ins compare their values instead of enumerable property counts", () => {
  const cases = [
    [new Date("2026-01-01"), new Date("2026-01-02")],
    [new Date(NaN), new Date(0)],
    [/original/gi, /changed/gi],
    [new Map([[{ id: 1 }, { active: true }]]), new Map([[{ id: 1 }, { active: false }]])],
    [new Set([{ id: 1 }]), new Set([{ id: 2 }])],
    [new Uint8Array([1, 2]), new Uint8Array([1, 3])],
    [new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer],
    [new DataView(new Uint8Array([1, 2]).buffer), new DataView(new Uint8Array([1, 3]).buffer)],
  ];
  for (const [value, changed] of cases) {
    const form = createForm({ initial: { value } });
    const kind = Object.prototype.toString.call(value);
    assert.equal(form.dirty.value, false, `${kind} starts clean`);
    form.setValue("value", changed);
    assert.equal(form.dirty.value, true, `${kind} content change is dirty`);
    form.setValue("value", structuredClone(value));
    assert.equal(form.dirty.value, false, `${kind} equivalent restoration is clean`);
    form.setValue("value", changed);
    form.reset();
    assert.equal(form.dirty.value, false, `${kind} reset is clean`);
  }
});

test("cyclic collections compare entries and typed array kinds remain distinct", () => {
  const value = new Map();
  value.set("self", value);
  value.set("set", new Set([value]));
  const form = createForm({ initial: { value, bytes: new Uint8Array([1]) } });
  assert.equal(form.dirty.value, false);
  const changed = structuredClone(value);
  changed.set("extra", true);
  form.setValue("value", changed);
  assert.equal(form.field("value").dirty.value, true);
  form.setValue("value", structuredClone(value));
  assert.equal(form.dirty.value, false);
  form.setValue("bytes", new Int8Array([1]));
  assert.equal(form.field("bytes").dirty.value, true);
});

test("adopting the current primitive value as the baseline invalidates cached dirty state", () => {
  const form = createForm({ initial: { count: 1, signed: -0, number: NaN } });
  form.setValues({ count: 2, signed: 0, number: 3 });
  for (const name of ["count", "signed", "number"]) assert.equal(form.field(name).dirty.value, true);
  assert.equal(form.dirty.value, true);
  form.reset({ count: 2, signed: 0, number: 3 });
  for (const name of ["count", "signed", "number"]) assert.equal(form.field(name).dirty.value, false);
  assert.equal(form.dirty.value, false);
  form.setValue("signed", -0);
  assert.equal(form.field("signed").dirty.value, true);
});

test("opaque values start and reset clean while newly supplied Blob and Error values are dirty", async () => {
  const form = createForm({ initial: { file: new Blob(["original"]), error: new Error("original") } });
  assert.equal(form.dirty.value, false);
  form.setValue("file", new Blob(["modified"]));
  assert.equal(form.field("file").dirty.value, true);
  form.field("file").reset();
  assert.equal(form.field("file").dirty.value, false);
  assert.equal(await form.field("file").value.value.text(), "original");
  form.setValue("error", new Error("modified"));
  assert.equal(form.field("error").dirty.value, true);
  form.reset();
  assert.equal(form.dirty.value, false);
  assert.equal(form.field("error").value.value.message, "original");
  form.reset({ file: new Blob(["replacement"]), error: new Error("replacement") });
  assert.equal(form.dirty.value, false);
  assert.equal(await form.field("file").value.value.text(), "replacement");
});

test("nested opaque clone identities are recognized without hiding new values in containers", () => {
  const containers = [
    (leaf) => ({ nested: { leaf } }),
    (leaf) => [leaf],
    (leaf) => new Map([["leaf", leaf]]),
    (leaf) => new Set([leaf]),
  ];
  for (const wrap of containers) {
    const form = createForm({ initial: { value: wrap(new Blob(["original"])) } });
    const clean = form.field("value").value.value;
    assert.equal(form.dirty.value, false);
    form.setValue("value", wrap(new Blob(["modified"])));
    assert.equal(form.dirty.value, true);
    form.setValue("value", clean);
    assert.equal(form.dirty.value, false);
    form.field("value").reset();
    assert.equal(form.dirty.value, false);
  }
});

test("opaque provenance does not hide in-place replacement of a nested clean leaf", () => {
  const form = createForm({ initial: { value: { file: new Blob(["original"]) } } });
  const current = form.field("value").value.value;
  current.file = new Blob(["modified"]);
  assert.equal(form.dirty.value, true);
  form.reset();
  assert.equal(form.dirty.value, false);
});
