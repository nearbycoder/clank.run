import test from "node:test";
import assert from "node:assert/strict";
import {
  createField,
  createFieldset,
  createFormFacade,
  createInput,
  createNumberField,
  createOtpField,
  createSlider,
} from "../dist/ui-fields.js";
import { signal } from "../dist/core.js";

test("fields connect labels, controls, state hooks, native validation, and matched errors", async () => {
  const changes = [];
  const field = createField({
    id: "profile-name",
    name: "name",
    defaultValue: "",
    required: true,
    validate(value) { return value.length >= 3 ? undefined : "Use at least three characters."; },
    onValueChange(value, details) { changes.push([value, details.reason]); },
  });
  const control = field.control({ describedBy: "hint" });
  field.description();
  assert.equal(field.label().htmlFor, "profile-name-control");
  assert.equal(control["aria-describedby"](), "hint profile-name-description");
  assert.equal(field.root()["data-filled"](), undefined);

  control.onInput(inputEvent("Al"));
  assert.equal(field.value.value, "Al");
  assert.equal(field.dirty.value, true);
  assert.equal(field.filled.value, true);
  assert.equal(await field.validate("manual"), false);
  assert.deepEqual(field.errors.value, ["Use at least three characters."]);
  assert.equal(field.error({ match: "custom" }).hidden(), false);
  assert.equal(control["aria-errormessage"](), "profile-name-error");

  control.onInput(inputEvent("Ada"));
  assert.deepEqual(field.errors.value, [], "editing clears previous validator and server output");
  assert.equal(await field.validate(), true);
  assert.equal(field.valid.value, true);
  field.setServerErrors("That name is already taken.");
  assert.equal(field.valid.value, false);
  field.setValue("Grace", "programmatic");
  assert.deepEqual(field.errors.value, []);
  assert.deepEqual(changes, [["Al", "input"], ["Ada", "input"], ["Grace", "programmatic"]]);
  assert.equal(field.manifest().protocol, "clank-ui/1");
  assert.deepEqual(field.manifest().parts.map((part) => part.name), ["root", "label", "control", "description", "item", "error", "validity"]);
});

test("field async validation aborts stale work and never publishes an older result", async () => {
  const jobs = [];
  const field = createField({
    id: "username",
    defaultValue: "first",
    validate(value, context) {
      return new Promise((resolve) => jobs.push({ value, context, resolve }));
    },
  });
  const first = field.validate();
  assert.equal(field.pending.value, true);
  field.setValue("second");
  assert.equal(jobs[0].context.signal.aborted, true);
  const second = field.validate();
  jobs[0].resolve("Stale error");
  jobs[1].resolve(undefined);
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(field.errors.value, []);
  assert.equal(field.pending.value, false);
  field.dispose();
});

test("field on-change validation debounces bursts and only validates the latest value", async () => {
  const seen = [];
  const field = createField({
    id: "search-query",
    defaultValue: "",
    validationMode: "onChange",
    validationDebounce: 10,
    validate(value) { seen.push(value); },
  });
  field.setValue("a", "input");
  field.setValue("ab", "input");
  field.setValue("abc", "input");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(seen, ["abc"]);
  assert.equal(field.valid.value, true);
  field.dispose();
});

test("canceled native events cannot mutate field-family state", () => {
  const field = createField({ id: "cancel-field", defaultValue: "before" });
  field.control().onInput(inputEvent("after", { defaultPrevented: true }));
  assert.equal(field.value.value, "before");
  const otp = createOtpField({ id: "cancel-otp", length: 4, defaultValue: "12" });
  otp.input(2).onPaste(clipboardEvent("34", { defaultPrevented: true }));
  assert.equal(otp.value.value, "12");
  const slider = createSlider({ id: "cancel-slider", defaultValue: 20 });
  slider.thumb(0).onKeyDown(keyEvent("ArrowRight", { defaultPrevented: true }));
  assert.equal(slider.value.value, 20);
});

test("application-canceled edits restore native text and suppress dependent commits", () => {
  const directField = createField({
    id: "rejected-direct-field",
    defaultValue: "before",
    onValueChange(_value, details) { details.cancel(); },
  });
  const directTarget = nativeInput({ value: "after" });
  directField.control().onInput(event({ currentTarget: directTarget }));
  assert.equal(directField.value.value, "before");
  assert.equal(directTarget.value, "before", "generic Field.Control rolls the browser value back synchronously");

  const booleanField = createField({
    id: "rejected-boolean-field",
    defaultValue: false,
    onValueChange(_value, details) { details.cancel(); },
  });
  const booleanTarget = nativeInput({ type: "checkbox", checked: true });
  booleanField.control({ type: "checkbox" }).onChange(event({ currentTarget: booleanTarget }));
  assert.equal(booleanField.value.value, false);
  assert.equal(booleanTarget.checked, false, "generic boolean controls restore checked state too");

  const text = createInput({
    id: "rejected-text-input",
    defaultValue: "stable",
    onValueChange(_value, details) { details.cancel(); },
  });
  const textTarget = { value: "draft" };
  text.root().onInput(event({ currentTarget: textTarget }));
  assert.equal(text.value.value, "stable");
  assert.equal(textTarget.value, "stable");

  const numberField = createField({
    id: "rejected-number-field",
    defaultValue: 1,
    onValueChange(_value, details) { details.cancel(); },
  });
  const number = createNumberField({ id: "rejected-number", field: numberField });
  const numberTarget = { value: "2" };
  number.input().onInput(event({ currentTarget: numberTarget }));
  assert.equal(number.value.value, 1);
  assert.equal(numberTarget.value, "1");
  assert.equal(number.input().value(), "1", "NumberField does not retain rejected editing text");

  const completions = [];
  const otp = createOtpField({
    id: "rejected-otp",
    length: 2,
    onValueChange(_value, details) { details.cancel(); },
    onValueComplete(value) { completions.push(value); },
  });
  const otpTarget = { ...slotTarget("rejected-otp", 0), value: "12" };
  otp.input(0).onPaste(clipboardEvent("12", { currentTarget: otpTarget }));
  assert.equal(otp.value.value, "");
  assert.equal(otpTarget.value, "");
  assert.deepEqual(completions, [], "a rejected complete paste cannot complete or submit the OTP");

  const sliderCommits = [];
  const slider = createSlider({
    id: "rejected-slider",
    defaultValue: 10,
    onValueChange(_value, details) { details.cancel(); },
    onValueCommitted(value) { sliderCommits.push(value); },
  });
  const sliderTarget = {
    ownerDocument: { getElementById() { return null; } },
    getAttribute() { return null; },
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  slider.control().onPointerDown(pointerEvent({ pointerId: 19, button: 0, clientX: 50, currentTarget: sliderTarget }));
  slider.control().onPointerUp(pointerEvent({ pointerId: 19, clientX: 50, currentTarget: sliderTarget }));
  assert.equal(slider.value.value, 10);
  assert.equal(slider.touched.value, false);
  assert.deepEqual(sliderCommits, [], "a rejected drag has no commit side effect");
  const rangeTarget = { value: "50", valueAsNumber: 50 };
  slider.input(0).onInput(event({ currentTarget: rangeTarget }));
  assert.equal(rangeTarget.value, "10", "a rejected native range edit restores its projected value");

  directField.dispose();
  booleanField.dispose();
  numberField.dispose();
});

test("field controls synchronize native elements, custom validity, focus, blur, and form reset", async () => {
  const form = eventTarget();
  const field = createField({ id: "email", defaultValue: "a@example.test", validationMode: "onBlur" });
  const props = field.control();
  const native = Object.assign(eventTarget(), {
    value: "",
    disabled: false,
    readOnly: false,
    required: false,
    form,
    validity: validity(),
    validationMessage: "",
    setCustomValidity(message) { this.customValidity = message; },
  });
  const cleanup = props.use(native);
  assert.equal(native.value, "a@example.test");
  props.onFocus(event({ currentTarget: native }));
  assert.equal(field.focused.value, true);
  props.onBlur(event({ currentTarget: native }));
  assert.equal(field.touched.value, true);
  field.setValue("changed@example.test");
  assert.equal(native.value, "changed@example.test");
  form.dispatch("reset", event());
  await Promise.resolve();
  assert.equal(field.value.value, "a@example.test");
  assert.equal(native.value, "a@example.test");
  cleanup();
});

test("native validity connects rendered errors even without a custom validator message", () => {
  const changes = [];
  const field = createField({
    id: "native-email",
    defaultValue: "invalid",
    onValidityChange(valid, errors) { changes.push([valid, errors]); },
  });
  const control = field.control();
  field.error();
  const native = {
    value: "invalid",
    validity: validity({ typeMismatch: true }),
  };
  control.onInvalid(event({ currentTarget: native }));
  assert.equal(field.valid.value, false);
  assert.equal(control["aria-errormessage"](), field.errorId);
  assert.equal(control["aria-describedby"](), field.errorId);
  assert.deepEqual(changes, [[false, []]]);
});

test("form facade registers fields, clears server errors on change, validates, focuses, submits, and resets", async () => {
  const submitted = [];
  const form = createFormFacade({
    id: "account-form",
    onFormSubmit(values, details) {
      submitted.push([values, details.formData]);
      return "saved";
    },
  });
  const name = createField({ id: "account-name", defaultValue: "Ada", validate: (value) => value ? undefined : "Required" });
  const email = createField({ id: "account-email", defaultValue: "ada@example.test", validate: (value) => value.includes("@") ? undefined : "Invalid" });
  const unregisterName = form.register("name", name);
  const unregisterEmail = form.register("email", email);
  form.setErrors({ email: "Already registered" });
  assert.deepEqual(email.errors.value, ["Already registered"]);
  email.setValue("grace@example.test");
  assert.deepEqual(email.errors.value, []);

  const result = await form.submit(cancelableEvent());
  assert.equal(result, "saved");
  assert.deepEqual(submitted[0][0], { name: "Ada", email: "grace@example.test" });
  assert.equal(form.pending.value, false);
  assert.equal(form.submitted.value, true);

  email.setValue("invalid");
  assert.equal(await form.validate(), false);
  let focused = "";
  const root = {
    querySelector(selector) {
      return selector.includes("account-email-control") ? { focus() { focused = "email"; } } : null;
    },
  };
  assert.equal(form.focusFirstInvalid(root), true);
  assert.equal(focused, "email");
  form.reset();
  assert.equal(email.value.value, "ada@example.test");
  unregisterEmail();
  unregisterName();
  form.dispose();
});

test("field and form manifests redact password and OTP values across aggregate boundaries", () => {
  const form = createFormFacade({ id: "secrets-form" });
  const password = createField({ id: "password-field", defaultValue: "correct horse battery staple" });
  const code = createField({ id: "otp-field", defaultValue: "867530" });
  createInput({ id: "password", type: "password", field: password });
  createOtpField({ id: "otp", length: 6, field: code });
  form.register("password", password);
  form.register("code", code);

  assert.equal(password.sensitive.value, true);
  assert.equal(code.sensitive.value, true);
  assert.equal(password.manifest().state.value, "[redacted]");
  assert.equal(code.manifest().state.value, "[redacted]");
  assert.deepEqual(form.manifest().state.values, {
    password: "[redacted]",
    code: "[redacted]",
  });
  assert.deepEqual(form.manifest().state.sensitiveFields, ["password", "code"]);
  const serialized = JSON.stringify(form.manifest());
  assert.equal(serialized.includes("correct horse"), false);
  assert.equal(serialized.includes("867530"), false);
  assert.deepEqual(form.values(), {
    password: "correct horse battery staple",
    code: "867530",
  }, "submission values remain available to the application");

  const standalone = createInput({ id: "standalone-password", type: "PASSWORD", defaultValue: "top secret" });
  assert.equal(standalone.root().type, "password");
  assert.equal(standalone.manifest().state.value, "[redacted]");
  assert.equal(JSON.stringify(standalone.manifest()).includes("top secret"), false);
});

test("fieldset uses native disabled propagation and Input composes with Field state", () => {
  let disabled = true;
  const fieldset = createFieldset({ id: "billing", disabled: () => disabled, form: "checkout", name: "billing" });
  assert.equal(fieldset.root().disabled(), true);
  assert.equal(fieldset.root()["data-disabled"](), "");
  assert.equal(fieldset.legend().id, "billing-legend");
  assert.deepEqual(fieldset.manifest().parts.map((part) => part.name), ["root", "legend"]);
  disabled = false;
  assert.equal(fieldset.root().disabled(), false);

  const field = createField({ id: "city-field", defaultValue: "Paris" });
  const input = createInput({ id: "city", name: "city", field });
  const props = input.root();
  props.onInput(inputEvent("Lyon"));
  assert.equal(input.value.value, "Lyon");
  assert.equal(field.value.value, "Lyon");
  assert.equal(props["data-filled"](), "");
  input.reset();
  assert.equal(input.value.value, "Paris");
  assert.equal(field.value.value, "Paris");
  assert.equal(input.manifest().component, "Input");
});

test("Input, NumberField, OTPField, and Slider compose exact Field relationships", () => {
  const textField = createField({ id: "display-name-field", name: "displayName", defaultValue: "Ada" });
  const text = createInput({ id: "display-name", field: textField });
  const textProps = text.root();
  textField.description({ id: "display-name-help" });
  textField.description({ id: "display-name-format" });
  textField.error({ id: "display-name-error" });
  assert.equal(textField.label().htmlFor, "display-name-field-control");
  assert.equal(textProps.id, "display-name-field-control");
  assert.equal(textProps.name, "displayName");
  assert.equal(textProps["aria-labelledby"](), "display-name-field-label");
  assert.equal(textProps["aria-describedby"](), "display-name-help display-name-format");
  textProps.onFocus(event());
  assert.equal(textField.focused.value, true);
  textProps.onBlur(event());
  assert.equal(textField.focused.value, false);
  assert.equal(textField.touched.value, true);

  const amountField = createField({ id: "amount-field", name: "amount", defaultValue: 2 });
  amountField.description();
  const number = createNumberField({ id: "amount", field: amountField });
  assert.equal(number.input().id, amountField.controlId);
  assert.equal(number.input().name, "amount");
  assert.equal(number.input()["aria-labelledby"](), undefined, "a missing Field.Label is never referenced");
  amountField.label();
  assert.equal(number.input()["aria-labelledby"](), "amount-field-label");
  assert.equal(number.input()["aria-describedby"](), "amount-field-description");

  const codeField = createField({ id: "code-field", name: "code", defaultValue: "" });
  codeField.description();
  const otp = createOtpField({ id: "code", length: 4, field: codeField });
  assert.equal(otp.input(0).id, codeField.controlId);
  assert.equal(otp.root()["aria-labelledby"](), undefined);
  codeField.label();
  assert.equal(otp.root()["aria-labelledby"](), "code-field-label");
  assert.equal(otp.input(0)["aria-label"], undefined, "the native Field label names the first slot");
  assert.equal(otp.input(3)["aria-label"], "Character 4 of 4");
  assert.equal(otp.input(1, { ariaLabel: "Second verification character" })["aria-label"], "Second verification character");
  assert.equal(otp.hiddenInput().name, "code");

  const rangeField = createField({ id: "budget-field", name: "budget", defaultValue: [20, 80] });
  rangeField.description();
  const slider = createSlider({ id: "budget", field: rangeField });
  assert.equal(rangeField.label().htmlFor, "budget-field-control");
  assert.equal(slider.thumb(0).id, rangeField.controlId);
  assert.equal(slider.thumb(0)["aria-labelledby"](), "budget-field-label");
  assert.equal(slider.control()["aria-describedby"](), "budget-field-description");
  assert.equal(slider.input(0).name, "budget");
});

test("conditional Field relationships unregister on unmount and Item propagates disabled state", () => {
  const rootDisabled = signal(false);
  const itemDisabled = signal(false);
  const field = createField({ id: "preferences-field", defaultValue: "", disabled: () => rootDisabled.value });
  const control = field.control();
  const label = field.label();
  const description = field.description({ id: "preferences-help" });
  const error = field.error({ id: "preferences-error" });

  assert.equal(control["aria-describedby"](), "preferences-help", "SSR relationships exist before mount");
  const unmountDescription = description.use({});
  const unmountError = error.use({});
  const unmountLabel = label.use({});
  assert.equal(control["aria-labelledby"](), "preferences-field-label");
  field.setServerErrors("Choose an option.");
  assert.equal(control["aria-describedby"](), "preferences-help preferences-error");
  assert.equal(control["aria-errormessage"](), "preferences-error");

  unmountDescription();
  assert.equal(control["aria-describedby"](), "preferences-error");
  unmountError();
  assert.equal(control["aria-describedby"](), undefined);
  assert.equal(control["aria-errormessage"](), undefined);
  unmountLabel();
  assert.equal(control["aria-labelledby"](), undefined);

  const remountedDescription = description.use({});
  assert.equal(control["aria-describedby"](), "preferences-help", "a retained part can mount again");
  remountedDescription();

  const native = nativeInput();
  const item = field.item({ disabled: () => itemDisabled.value });
  const wrapper = {
    ownerDocument: null,
    querySelectorAll() { return [native]; },
  };
  const stopItem = item.use(wrapper);
  assert.equal(native.disabled, false);
  itemDisabled.value = true;
  assert.equal(item["aria-disabled"](), true);
  assert.equal(item["data-disabled"](), "");
  assert.equal(native.disabled, true, "item-local disabled state reaches nested native controls");
  const blockedClick = event();
  item.onClickCapture(blockedClick);
  assert.equal(blockedClick.defaultPrevented, true);

  itemDisabled.value = false;
  assert.equal(native.disabled, false);
  rootDisabled.value = true;
  assert.equal(native.disabled, true, "Field.Root disabled state takes precedence");
  rootDisabled.value = false;
  assert.equal(native.disabled, false);
  stopItem();
});

test("composed fields honor validationMode instead of validating every blur", async () => {
  let submitOnlyRuns = 0;
  const submitOnly = createField({
    id: "submit-only-field",
    defaultValue: "value",
    validationMode: "onSubmit",
    validate() { submitOnlyRuns++; },
  });
  createInput({ id: "submit-only", field: submitOnly }).root().onBlur(event());
  await Promise.resolve();
  assert.equal(submitOnlyRuns, 0);

  let blurRuns = 0;
  const onBlur = createField({
    id: "blur-field",
    defaultValue: "value",
    validationMode: "onBlur",
    validate() { blurRuns++; },
  });
  createInput({ id: "blur-input", field: onBlur }).root().onBlur(event());
  await Promise.resolve();
  assert.equal(blurRuns, 1);
});

test("specialized Field composition reads native validity from its mounted form control", async () => {
  const amountField = createField({ id: "native-amount", defaultValue: 2 });
  const amount = createNumberField({ id: "native-amount-control", field: amountField });
  const amountNative = nativeInput({ value: "2", validity: validity({ rangeOverflow: true }) });
  const stopAmount = amount.input().use(amountNative);
  assert.equal(await amountField.validate(), false);
  assert.equal(amountField.nativeValidity.value.rangeOverflow, true);
  stopAmount();

  const codeField = createField({ id: "native-code", defaultValue: "12" });
  const code = createOtpField({ id: "native-code-control", length: 4, field: codeField });
  const codeNative = nativeInput({ value: "12", validity: validity({ patternMismatch: true }) });
  const stopCode = code.hiddenInput().use(codeNative);
  assert.equal(await codeField.validate(), false);
  assert.equal(codeField.nativeValidity.value.patternMismatch, true);
  stopCode();

  const sliderField = createField({ id: "native-slider", defaultValue: 20 });
  const slider = createSlider({ id: "native-slider-control", field: sliderField });
  const sliderNative = nativeInput({ value: "20", validity: validity({ rangeUnderflow: true }) });
  const stopSlider = slider.input(0).use(sliderNative);
  assert.equal(await sliderField.validate(), false);
  assert.equal(sliderField.nativeValidity.value.rangeUnderflow, true);
  stopSlider();
});

test("native reset is cancellable, carries one event, and is deduplicated across composed paths", async () => {
  const changes = [];
  const field = createField({
    id: "reset-field",
    defaultValue: "initial",
    onValueChange(value, details) { changes.push([value, details.reason, details.event]); },
  });
  const input = createInput({ id: "reset-input", field });
  const form = eventTarget();
  const native = Object.assign(eventTarget(), {
    value: "",
    disabled: false,
    readOnly: false,
    required: false,
    form,
    validity: validity(),
    validationMessage: "",
    setCustomValidity() {},
  });
  const cleanup = input.root().use(native);
  input.setValue("edited", "input-change");
  const canceled = event({ defaultPrevented: true });
  form.dispatch("reset", canceled);
  assert.equal(field.value.value, "edited");

  const resetEvent = event();
  form.dispatch("reset", resetEvent);
  await Promise.resolve();
  assert.equal(field.value.value, "initial");
  const resets = changes.filter(([, reason]) => reason === "reset");
  assert.equal(resets.length, 1);
  assert.equal(resets[0][2], resetEvent);
  cleanup();
});

test("form pending state always clears when application submission rejects", async () => {
  const form = createFormFacade({
    id: "rejecting-form",
    async onFormSubmit() { throw new Error("save failed"); },
  });
  form.register("name", createField({ id: "rejecting-name", defaultValue: "Ada" }));
  await assert.rejects(form.submit(event()), /save failed/);
  assert.equal(form.pending.value, false);
  assert.equal(form.submitted.value, true);
  form.dispose();
});

test("number fields parse localized text and support nullable values, modifier steps, bounds, and commits", () => {
  const commits = [];
  const number = createNumberField({
    id: "amount",
    name: "amount",
    defaultValue: null,
    min: 0,
    max: 2_000,
    step: 1,
    smallStep: 0.1,
    largeStep: 10,
    locale: "de-DE",
    onValueCommitted(value, details) { commits.push([value, details.reason]); },
  });
  const input = number.input();
  input.onInput(inputEvent("1.234,5"));
  assert.equal(number.value.value, 1234.5);
  input.onKeyDown(keyEvent("ArrowUp", { shiftKey: true }));
  assert.equal(number.value.value, 1244.5);
  input.onKeyDown(keyEvent("ArrowDown", { altKey: true }));
  assert.equal(number.value.value, 1244.4);
  input.onKeyDown(keyEvent("Home"));
  assert.equal(number.value.value, 0);
  input.onKeyDown(keyEvent("End"));
  assert.equal(number.value.value, 2000);
  input.onInput(inputEvent(""));
  assert.equal(number.value.value, null);
  input.onBlur(event({ currentTarget: { value: "" } }));
  assert.equal(number.touched.value, true);
  assert.equal(commits.at(-1)[1], "input-blur");
  assert.equal(number.manifest().state.value, null);
});

test("empty number fields seed the nearest in-range zero before applying any step", () => {
  const unboundedUp = createNumberField({ id: "empty-up", defaultValue: null, step: 5, snapOnStep: true });
  assert.equal(unboundedUp.incrementButton().disabled(), false);
  assert.equal(unboundedUp.decrementButton().disabled(), false);
  assert.equal(unboundedUp.increment(), true);
  assert.equal(unboundedUp.value.value, 0, "the first increment seeds zero rather than adding one step");

  const unboundedDown = createNumberField({ id: "empty-down", defaultValue: null, step: 5, snapOnStep: true });
  assert.equal(unboundedDown.decrement(), true);
  assert.equal(unboundedDown.value.value, 0, "the first decrement uses the same direction-free seed");

  const positive = createNumberField({ id: "positive-empty", defaultValue: null, min: 5, max: 10, step: 2, snapOnStep: true });
  assert.equal(positive.incrementButton().disabled(), false, "an empty bounded field can always be seeded");
  assert.equal(positive.decrementButton().disabled(), false, "both empty step buttons remain operable");
  positive.increment();
  assert.equal(positive.value.value, 5, "zero clamps to the nearest positive boundary without an extra step");

  const negative = createNumberField({ id: "negative-empty", defaultValue: null, min: -10, max: -5, step: 2, snapOnStep: true });
  negative.decrement();
  assert.equal(negative.value.value, -5, "zero clamps to the nearest negative boundary without an extra step");
});

test("number field press, wheel, and scrub interactions clamp and expose state hooks", () => {
  const number = createNumberField({
    id: "quantity",
    defaultValue: 5,
    min: 0,
    max: 10,
    step: 1,
    allowWheelScrub: true,
    pixelSensitivity: 2,
  });
  number.incrementButton().onClick(event());
  number.decrementButton().onClick(event());
  assert.equal(number.value.value, 5);
  const input = number.input();
  input.onFocus(event());
  input.onWheel(event({ deltaY: -1 }));
  assert.equal(number.value.value, 6);

  const capture = [];
  const target = { setPointerCapture(id) { capture.push(["set", id]); }, releasePointerCapture(id) { capture.push(["release", id]); } };
  const scrub = number.scrubArea();
  scrub.onPointerDown(pointerEvent({ pointerId: 4, button: 0, clientX: 10, currentTarget: target }));
  assert.equal(scrub["data-scrubbing"](), "");
  scrub.onPointerMove(pointerEvent({ pointerId: 4, clientX: 18, currentTarget: target }));
  assert.equal(number.value.value, 10);
  scrub.onPointerUp(pointerEvent({ pointerId: 4, clientX: 18, currentTarget: target }));
  assert.equal(number.scrubbing.value, false);
  assert.deepEqual(capture, [["set", 4], ["release", 4]]);
});

test("number field buttons repeat while held and commit once on release", async () => {
  const commits = [];
  const number = createNumberField({
    id: "held-stepper",
    defaultValue: 0,
    max: 20,
    stepButtonDelay: 2,
    stepButtonInterval: 2,
    onValueCommitted(value, details) { commits.push([value, details.reason]); },
  });
  const target = { setPointerCapture() {}, releasePointerCapture() {} };
  const increment = number.incrementButton();
  const down = pointerEvent({ pointerId: 12, button: 0, currentTarget: target });
  increment.onPointerDown(down);
  await new Promise((resolve) => setTimeout(resolve, 12));
  increment.onPointerUp(pointerEvent({ pointerId: 12, currentTarget: target }));
  assert.ok(number.value.value > 1, "holding repeats beyond the initial step");
  assert.deepEqual(commits, [[number.value.value, "increment-press"]]);
  increment.use()();
});

test("number and slider pointer cancellation releases capture without committing", () => {
  const numberCommits = [];
  const number = createNumberField({
    id: "cancel-scrub",
    defaultValue: 1,
    onValueCommitted(value) { numberCommits.push(value); },
  });
  const scrubTarget = { setPointerCapture() {}, releasePointerCapture() {} };
  const scrub = number.scrubArea();
  assert.equal(scrub.style.touchAction, "none");
  scrub.onPointerDown(pointerEvent({ pointerId: 9, button: 0, clientX: 0, currentTarget: scrubTarget }));
  scrub.onPointerMove(pointerEvent({ pointerId: 9, clientX: 8, currentTarget: scrubTarget }));
  scrub.onPointerCancel(pointerEvent({ pointerId: 9, currentTarget: scrubTarget }));
  assert.equal(number.scrubbing.value, false);
  assert.deepEqual(numberCommits, []);

  const sliderCommits = [];
  const slider = createSlider({
    id: "cancel-drag",
    defaultValue: 10,
    onValueCommitted(value) { sliderCommits.push(value); },
  });
  const control = slider.control();
  const sliderTarget = {
    ownerDocument: null,
    parentElement: null,
    getAttribute() { return null; },
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  assert.equal(control.style.touchAction, "none");
  control.onPointerDown(pointerEvent({ pointerId: 7, button: 0, clientX: 50, currentTarget: sliderTarget }));
  control.onPointerCancel(pointerEvent({ pointerId: 7, currentTarget: sliderTarget }));
  assert.equal(slider.dragging.value, false);
  assert.equal(slider.touched.value, false);
  assert.deepEqual(sliderCommits, []);
});

test("OTP field normalizes, reports rejected input, distributes paste, masks slots, and projects one form value", () => {
  const invalid = [];
  const completed = [];
  const otp = createOtpField({
    id: "verification",
    length: 4,
    name: "code",
    validationType: "numeric",
    mask: true,
    onValueInvalid(value) { invalid.push(value); },
    onValueComplete(value) { completed.push(value); },
  });
  otp.setValue("1a2 b");
  assert.equal(otp.value.value, "12");
  assert.equal(invalid.join(""), "ab");
  const third = otp.input(2);
  third.onPaste(clipboardEvent("34", { currentTarget: slotTarget("verification", 2) }));
  assert.equal(otp.value.value, "1234");
  assert.deepEqual(completed, ["1234"]);
  assert.equal(otp.complete.value, true);
  assert.equal(otp.input(0).value(), "•");
  assert.equal(otp.hiddenInput().value(), "1234");
  assert.equal(otp.hiddenInput().name, "code");
  assert.equal(otp.root()["data-complete"](), "");
  assert.equal(otp.manifest().state.value, "••••", "agent manifests do not expose masked secrets");
});

test("OTP logical labels target the first visible slot and complete paste notifies even when unchanged", () => {
  const completed = [];
  const legacyCompleted = [];
  const otp = createOtpField({
    id: "existing-code",
    length: 4,
    defaultValue: "1234",
    onValueComplete(value, details) { completed.push([value, details.reason]); },
    onComplete(value, details) { legacyCompleted.push([value, details.reason]); },
  });

  assert.equal(otp.input(0).id, "existing-code", "a native label for the logical id targets the visible slot");
  assert.equal(otp.hiddenInput().id, "existing-code-hidden-input");
  assert.equal(otp.input(0)["aria-label"], undefined, "the external native label supplies the first slot name");
  assert.equal(otp.input(1)["aria-label"], "Character 2 of 4");
  assert.equal(otp.input(0, { ariaLabel: "Verification character one" })["aria-label"], "Verification character one");

  const pasted = clipboardEvent("1234", { currentTarget: slotTarget("existing-code", 0) });
  otp.input(0).onPaste(pasted);
  assert.equal(otp.value.value, "1234");
  assert.equal(pasted.defaultPrevented, true);
  assert.deepEqual(completed, [["1234", "input-paste"]]);
  assert.deepEqual(legacyCompleted, [["1234", "input-paste"]], "the deprecated alias remains compatible");
});

test("OTP native constraint validation redirects hidden aggregate focus to the first visible slot", () => {
  const focused = [];
  const otp = createOtpField({ id: "required-code", length: 4, required: true });
  const hidden = otp.hiddenInput();
  const input = {
    ownerDocument: {
      getElementById(id) {
        assert.equal(id, "required-code");
        return { focus() { focused.push(id); } };
      },
    },
  };
  hidden.onFocus(event({ currentTarget: input }));
  assert.deepEqual(focused, ["required-code"]);
  assert.equal(hidden.required(), true);
  assert.equal(hidden.minLength, 4);
});

test("controlled OTP completion reports the accepted value without waiting for a reactive reread", () => {
  const controlled = signal("");
  const completed = [];
  const otp = createOtpField({
    id: "controlled-code",
    length: 4,
    value: () => controlled.value,
    onValueChange(value) { controlled.value = value; },
    onValueComplete(value, details) { completed.push([value, details.reason]); },
  });

  assert.equal(otp.setValue("2468", "input-change"), true);
  assert.equal(otp.value.value, "2468");
  assert.deepEqual(completed, [["2468", "input-change"]]);
});

test("OTP keyboard navigation is direction aware and deletion edits the logical code", () => {
  const otp = createOtpField({ id: "rtl-code", length: 4, defaultValue: "1234", direction: "rtl" });
  const focused = [];
  const source = slotTarget("rtl-code", 1, focused);
  otp.input(1).onKeyDown(keyEvent("ArrowLeft", { currentTarget: source }));
  assert.deepEqual(focused, [2], "ArrowLeft advances in RTL");
  otp.input(1).onKeyDown(keyEvent("Backspace", { currentTarget: source }));
  assert.equal(otp.value.value, "134");
  otp.input(0).onKeyDown(keyEvent("Delete", { currentTarget: slotTarget("rtl-code", 0) }));
  assert.equal(otp.value.value, "34");
});

test("sliders support single keyboard operation, RTL, pointer input, and native form projection", () => {
  const commits = [];
  const slider = createSlider({
    id: "volume",
    name: "volume",
    defaultValue: 25,
    step: 5,
    largeStep: 20,
    direction: "rtl",
    onValueCommitted(value, details) { commits.push([value, details.reason]); },
  });
  const thumb = slider.thumb(0, {
    ariaLabel: "Volume",
    getAriaValueText: (formatted, value, index) => `${formatted} at thumb ${index + 1} (${value})`,
  });
  assert.equal(thumb["aria-label"], "Volume");
  assert.equal(thumb["aria-labelledby"](), undefined);
  assert.match(thumb["aria-valuetext"](), /thumb 1 \(25\)/);
  thumb.onKeyDown(keyEvent("ArrowRight", { currentTarget: attributeElement({ dir: "rtl" }) }));
  assert.equal(slider.value.value, 20);
  thumb.onKeyDown(keyEvent("PageUp"));
  assert.equal(slider.value.value, 40);
  assert.equal(slider.input(0).type, "range");
  assert.equal(slider.input(0).hidden, true);
  assert.equal(slider.input(0).name, "volume");

  const control = slider.control();
  const focusedThumbs = [];
  const target = Object.assign(attributeElement({ dir: "rtl" }), {
    ownerDocument: {
      getElementById(id) { return { focus() { focusedThumbs.push(id); } }; },
    },
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  });
  control.onPointerDown(pointerEvent({ pointerId: 1, button: 0, clientX: 25, clientY: 10, currentTarget: target }));
  assert.equal(slider.value.value, 75, "horizontal pointer position is mirrored in RTL");
  assert.deepEqual(focusedThumbs, ["volume-thumb-0"], "pointer interaction focuses the selected thumb");
  control.onPointerUp(pointerEvent({ pointerId: 1, clientX: 25, currentTarget: target }));
  assert.equal(commits.at(-1)[1], "pointer");
  assert.equal(slider.manifest().protocol, "clank-ui/1");

  const unlabeled = createSlider({ id: "presence-slider", defaultValue: 10 });
  const unlabeledThumb = unlabeled.thumb(0);
  const unlabeledControl = unlabeled.control();
  assert.equal(unlabeledThumb["aria-labelledby"](), undefined, "a missing Slider.Label is never referenced");
  assert.equal(unlabeledControl["aria-labelledby"](), undefined);
  const visibleLabel = unlabeled.label();
  assert.equal(unlabeledThumb["aria-labelledby"](), "presence-slider-label");
  assert.equal(unlabeledControl["aria-labelledby"](), "presence-slider-label");
  const removeLabel = visibleLabel.use({});
  removeLabel();
  assert.equal(unlabeledThumb["aria-labelledby"](), undefined);

  const range = createSlider({ id: "focused-range", defaultValue: [20, 80] });
  assert.equal(range.thumb(0, { getAriaLabel: (index) => index === 0 ? "Minimum price" : "Maximum price" })["aria-label"], "Minimum price");
  assert.equal(range.thumb(1, { ariaLabel: "Maximum price", ariaValueText: "$80" })["aria-valuetext"](), "$80");
  const rangeFocus = [];
  const rangeTarget = {
    ownerDocument: { getElementById(id) { return { focus() { rangeFocus.push(id); } }; } },
    getAttribute() { return null; },
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  range.control().onPointerDown(pointerEvent({ pointerId: 2, button: 0, clientX: 70, currentTarget: rangeTarget }));
  assert.equal(range.activeThumb.value, 1);
  assert.deepEqual(rangeFocus, ["focused-range-thumb-1"]);
});

test("range sliders implement push, none, and swap collision policies with minimum gaps", () => {
  const pushed = createSlider({ id: "push-range", defaultValue: [20, 40], minGap: 10, thumbCollisionBehavior: "push" });
  pushed.setThumb(0, 50);
  assert.deepEqual(pushed.values.value, [50, 60]);
  pushed.setThumb(1, 100);
  assert.deepEqual(pushed.values.value, [50, 100]);

  const stopped = createSlider({ id: "none-range", defaultValue: [20, 40], minGap: 10, thumbCollisionBehavior: "none" });
  stopped.setThumb(0, 80);
  assert.deepEqual(stopped.values.value, [30, 40]);

  const swapped = createSlider({ id: "swap-range", defaultValue: [20, 40], thumbCollisionBehavior: "swap" });
  swapped.setThumb(0, 60);
  assert.deepEqual(swapped.values.value, [40, 60]);
  assert.equal(swapped.activeThumb.value, 1);
  assert.equal(swapped.indicator().style["--clank-slider-start"](), "40%");
  assert.equal(swapped.indicator().style["--clank-slider-end"](), "60%");

  const canceled = createSlider({
    id: "canceled-swap-range",
    defaultValue: [20, 40],
    thumbCollisionBehavior: "swap",
    onValueChange(_value, details) { details.cancel(); },
  });
  assert.equal(canceled.setThumb(0, 60), false);
  assert.deepEqual(canceled.values.value, [20, 40]);
  assert.equal(canceled.activeThumb.value, 0, "a rejected swap cannot transfer active-thumb ownership");

  const equal = createSlider({
    id: "equal-swap-range",
    defaultValue: [50, 50],
    thumbCollisionBehavior: "swap",
  });
  equal.thumb(1).onFocus();
  assert.equal(equal.activeThumb.value, 1);
  assert.equal(equal.setThumb(1, 50), false);
  assert.equal(equal.activeThumb.value, 1, "an equal-value no-op cannot transfer active-thumb ownership");
});

test("field-family factories reject unsafe IDs and impossible component state", () => {
  assert.throws(() => createField({ id: "bad id" }), /id must start/);
  assert.throws(() => createNumberField({ id: "number", step: 0 }), /positive finite/);
  assert.throws(() => createOtpField({ id: "otp", length: 0 }), /integer/);
  assert.throws(() => createOtpField({ id: "otp", length: 4, maskCharacter: "xx" }), /exactly one/);
  assert.throws(() => createSlider({ id: "range", defaultValue: [], minGap: 2 }), /cannot be empty/);
  assert.throws(() => createSlider({ id: "range", defaultValue: [0, 100], minGap: 101 }), /too large|cannot fit/);
  assert.throws(() => createInput({ id: "file", type: "file" }), /not supported/);
  assert.throws(() => createInput({ id: "checkbox", type: "checkbox" }), /not supported/);
  assert.throws(() => createInput({ id: "radio", type: "radio" }), /not supported/);
});

function event(overrides = {}) {
  return {
    defaultPrevented: false,
    prevented: false,
    preventDefault() { this.defaultPrevented = true; this.prevented = true; },
    stopPropagation() {},
    ...overrides,
  };
}

function cancelableEvent(overrides = {}) {
  return event(overrides);
}

function inputEvent(value, overrides = {}) {
  return event({ currentTarget: { value }, ...overrides });
}

function keyEvent(key, overrides = {}) {
  return event({ key, altKey: false, shiftKey: false, currentTarget: {}, ...overrides });
}

function pointerEvent(overrides = {}) {
  return event({ pointerId: 1, button: 0, clientX: 0, clientY: 0, currentTarget: {}, ...overrides });
}

function clipboardEvent(text, overrides = {}) {
  return event({ clipboardData: { getData(type) { return type === "text" ? text : ""; } }, ...overrides });
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      const entries = listeners.get(name) ?? new Set();
      entries.add(listener);
      listeners.set(name, entries);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name, dispatched = event()) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(dispatched);
    },
  };
}

function validity(overrides = {}) {
  return {
    badInput: false,
    customError: false,
    patternMismatch: false,
    rangeOverflow: false,
    rangeUnderflow: false,
    stepMismatch: false,
    tooLong: false,
    tooShort: false,
    typeMismatch: false,
    valueMissing: false,
    ...overrides,
  };
}

function nativeInput(overrides = {}) {
  return Object.assign(eventTarget(), {
    value: "",
    disabled: false,
    readOnly: false,
    required: false,
    form: null,
    validity: validity(),
    validationMessage: "",
    setCustomValidity(message) { this.customValidity = message; },
    ...overrides,
  });
}

function slotTarget(id, index, focused = []) {
  const document = {
    getElementById(targetId) {
      const match = targetId.match(/-(\d+)$/);
      return {
        focus() { focused.push(Number(match?.[1] ?? index)); },
        select() {},
      };
    },
  };
  return { ownerDocument: document, id: `${id}-slot-${index}` };
}

function attributeElement(attributes = {}) {
  return {
    ownerDocument: null,
    parentElement: null,
    getAttribute(name) { return attributes[name] ?? null; },
  };
}
