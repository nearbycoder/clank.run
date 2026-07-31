import test from "node:test";
import assert from "node:assert/strict";
import { signal } from "../dist/core.js";
import { createField } from "../dist/ui-fields.js";
import {
  createAvatar,
  createButton,
  createCheckbox,
  createCheckboxGroup,
  createMeter,
  createProgress,
  createRadioGroup,
  createSeparator,
  createSwitch,
  createToggle,
  createToggleGroup,
} from "../dist/ui-controls.js";

test("buttons are native-first, custom-element keyboard operable, cancelable, and agent-readable", () => {
  const disabled = signal(false);
  const presses = [];
  const button = createButton({
    id: "save",
    disabled: () => disabled.value,
    form: "editor",
    name: "intent",
    value: "save",
    onPress(details) {
      presses.push(details.reason);
      if (details.reason === "programmatic") details.cancel();
    },
  });
  const root = button.root({ agentId: "save-document", agentLabel: "Save document" });
  assert.equal(root.type, "button");
  assert.equal(root.form, "editor");
  assert.equal(root.role, "button");
  assert.equal(root.tabIndex(), 0);
  assert.equal(root["aria-disabled"](), false);

  const keyboard = keyEvent("Enter");
  root.onKeyDown(keyboard);
  assert.equal(keyboard.prevented, true);
  assert.deepEqual(presses, ["press"]);

  const space = keyEvent(" ");
  root.onKeyDown(space);
  assert.equal(space.prevented, true, "Space keydown prevents page scrolling");
  assert.deepEqual(presses, ["press"], "Space activates on keyup, matching native buttons");
  root.onKeyUp(keyEvent(" "));
  assert.deepEqual(presses, ["press", "press"]);
  root.onKeyDown({ ...keyEvent("Enter"), repeat: true });
  assert.deepEqual(presses, ["press", "press"], "held Enter does not repeat activation");

  const native = keyEvent(" ", { localName: "button" });
  root.onKeyDown(native);
  assert.equal(native.prevented, false, "native buttons provide their own keyboard click");
  assert.equal(button.press(), false, "press callbacks can cancel a programmatic action");
  disabled.value = true;
  assert.equal(root.disabled(), true);
  assert.equal(root.tabIndex(), -1);
  assert.equal(button.press(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(button.manifest())).actions.map((entry) => entry.name), ["press"]);
  assert.equal(button.manifest().actions[0].sideEffects, "write");
  assert.equal(Object.isFrozen(button.manifest()), true);
  assert.equal(Object.isFrozen(button.manifest().state), true);
  assert.equal(Object.isFrozen(button.manifest().parts[0]), true);
  assert.equal(Object.isFrozen(button.manifest().actions[0]), true);

  const canceledSubmit = createButton({
    id: "canceled-submit",
    type: "submit",
    onPress(details) { details.cancel(); },
  });
  const click = event();
  canceledSubmit.root().onClick(click);
  assert.equal(click.defaultPrevented, true, "canceling a structured press also cancels native submission");
});

test("avatars swap image and fallback state without browser globals during SSR", async () => {
  const changes = [];
  const avatar = createAvatar({
    id: "account-avatar",
    src: "/ada.png",
    onStatusChange(status, details) { changes.push([status, details.reason]); },
  });
  const image = avatar.image({ alt: "Ada Lovelace" });
  const fallback = avatar.fallback();
  assert.equal(fallback["aria-hidden"], undefined, "visible fallback initials remain in the accessibility tree");
  assert.equal(avatar.status.value, "loading");
  assert.equal(image.hidden(), true);
  image.onLoad(event());
  assert.equal(avatar.status.value, "loaded");
  assert.equal(image.hidden(), false);
  assert.equal(fallback.hidden(), true);
  image.onError(event());
  assert.equal(avatar.status.value, "error");
  assert.deepEqual(changes, [["loaded", "load"], ["error", "error"]]);
  assert.equal(avatar.manifest().state.status, "error");

  avatar.reset();
  const delayed = avatar.fallback({ delay: 1 });
  const stop = delayed.use();
  assert.equal(delayed.hidden(), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(delayed.hidden(), false);
  stop();

  const perImage = createAvatar({ id: "per-image-avatar" });
  const perImageChanges = [];
  const tracked = createAvatar({
    id: "tracked-per-image-avatar",
    onStatusChange(status, details) { perImageChanges.push([status, details.reason]); },
  });
  const incomplete = { complete: false, naturalWidth: 0 };
  perImage.image({ alt: "Grace Hopper", src: "/grace.png" }).use(incomplete);
  tracked.image({ alt: "Katherine Johnson", src: "/katherine.png" }).use(incomplete);
  assert.equal(perImage.status.value, "loading", "an image-level source enters loading while its image is incomplete");
  assert.deepEqual(perImageChanges, [["loading", "loading"]]);
});

test("checkboxes support indeterminate state, custom keyboard use, native input changes, and form reset", async () => {
  const form = eventTarget();
  const checkbox = createCheckbox({
    id: "terms",
    defaultChecked: "indeterminate",
    name: "terms",
    required: true,
  });
  const root = checkbox.root();
  const inputProps = checkbox.input();
  const input = nativeInput(form);
  const cleanup = inputProps.use(input);

  assert.equal(root["aria-checked"](), "mixed");
  assert.equal(root["data-indeterminate"](), "");
  assert.equal(input.indeterminate, true);
  assert.equal(input.checked, false);
  assert.equal(inputProps.required(), true);

  const keyboard = keyEvent(" ");
  root.onKeyDown(keyboard);
  assert.equal(keyboard.prevented, true);
  assert.equal(checkbox.checked.value, true);
  assert.equal(input.checked, true);
  assert.equal(input.indeterminate, false);

  const enter = keyEvent("Enter");
  root.onKeyDown(enter);
  assert.equal(enter.prevented, true);
  assert.equal(checkbox.checked.value, true, "Enter never toggles a checkbox");

  input.checked = false;
  input.dispatch("change", event());
  assert.equal(checkbox.checked.value, false);
  form.dispatch("reset", event());
  assert.equal(checkbox.checked.value, "indeterminate");
  await Promise.resolve();
  assert.equal(input.indeterminate, true);
  assert.equal(checkbox.manifest().actions.every((action) => action.sideEffects === "write"), true);
  cleanup();
});

test("controlled checkbox transitions do not mutate external state and cancellation is honored", () => {
  const external = signal(false);
  const requested = [];
  const checkbox = createCheckbox({
    id: "controlled-check",
    checked: () => external.value,
    onCheckedChange(next, details) {
      requested.push([next, details.reason]);
      details.cancel();
    },
  });
  assert.equal(checkbox.toggle(), false);
  assert.equal(checkbox.checked.value, false);
  assert.deepEqual(requested, [[true, "toggle"]]);
  external.value = true;
  assert.equal(checkbox.checked.value, true);
});

test("choice indicators can stay mounted while exposing their inactive state", () => {
  const checkbox = createCheckbox({ id: "persistent-check" });
  const checkboxIndicator = checkbox.indicator({ keepMounted: true });
  assert.equal(checkboxIndicator.hidden(), false);
  assert.equal(checkboxIndicator["data-state"](), "unchecked");
  assert.equal(checkboxIndicator["data-unchecked"](), "");

  const checks = createCheckboxGroup({ id: "persistent-checks", items: ["one", "two"] });
  const checkIndicator = checks.indicator("two", { keepMounted: true });
  assert.equal(checkIndicator.hidden(), false);
  assert.equal(checkIndicator["data-unchecked"](), "");

  const radios = createRadioGroup({ id: "persistent-radios", items: ["one", "two"], defaultValue: "one" });
  const radioIndicator = radios.indicator("two", { keepMounted: true });
  assert.equal(radioIndicator.hidden(), false);
  assert.equal(radioIndicator["data-unchecked"](), "");
});

test("choice controls use wrapping-label-friendly spans by default and opt into native buttons explicitly", () => {
  const checkbox = createCheckbox({ id: "terms-contract" });
  const checkboxRoot = checkbox.root();
  assert.equal(checkboxRoot.type, undefined);
  assert.equal(checkboxRoot.tabIndex(), 0);
  assert.equal(checkboxRoot["aria-disabled"](), undefined);
  assert.equal(checkbox.manifest().parts.find((part) => part.name === "root").defaultElement, "span");
  const checkboxButton = checkbox.root({ nativeButton: true });
  assert.equal(checkboxButton.type, "button");
  assert.equal(checkboxButton.disabled(), false);
  assert.equal(checkboxButton.tabIndex, undefined);

  const group = createCheckboxGroup({ id: "features-contract", items: ["sync"] });
  assert.equal(group.item("sync").type, undefined);
  assert.equal(group.item("sync").tabIndex(), 0);
  assert.equal(group.item("sync", { nativeButton: true }).type, "button");
  assert.equal(group.manifest().parts.find((part) => part.name === "item").defaultElement, "span");

  const radio = createRadioGroup({ id: "plan-contract", items: ["free"] });
  assert.equal(radio.item("free").type, undefined);
  assert.equal(radio.item("free", { nativeButton: true }).type, "button");
  assert.equal(radio.manifest().parts.find((part) => part.name === "item").defaultElement, "span");

  const switchControl = createSwitch({ id: "alerts-contract" });
  assert.equal(switchControl.root().type, undefined);
  assert.equal(switchControl.root({ nativeButton: true }).type, "button");
  assert.equal(switchControl.manifest().parts.find((part) => part.name === "root").defaultElement, "span");

  for (const projection of [checkbox.input(), group.input("sync"), radio.input("free"), switchControl.input()]) {
    assert.equal(projection.tabIndex, -1);
    assert.equal(projection["aria-hidden"], true);
    assert.equal(projection.style.position, "absolute");
    assert.equal(projection.style.pointerEvents, "none");
    assert.equal(projection.style.width, "1px");
  }
});

test("checkbox and switch preserve underlying state while projecting mixed and explicit unchecked values", () => {
  const mixed = signal(true);
  const checkbox = createCheckbox({
    id: "mixed-check",
    name: "agreement",
    defaultChecked: true,
    indeterminate: () => mixed.value,
    value: "yes",
    uncheckedValue: "no",
  });
  assert.equal(checkbox.checked.value, true);
  assert.equal(checkbox.indeterminate.value, true);
  assert.equal(checkbox.root()["aria-checked"](), "mixed");
  assert.equal(checkbox.input().checked(), true, "mixed presentation does not erase the native checked value");
  assert.equal(checkbox.uncheckedInput().disabled(), true);
  mixed.value = false;
  assert.equal(checkbox.root()["aria-checked"](), true);
  checkbox.setChecked(false);
  assert.equal(checkbox.uncheckedInput().type, "hidden");
  assert.equal(checkbox.uncheckedInput().name, "agreement");
  assert.equal(checkbox.uncheckedInput().value, "no");
  assert.equal(checkbox.uncheckedInput().disabled(), false);

  const switchControl = createSwitch({
    id: "mixed-switch",
    name: "notifications",
    defaultChecked: false,
    value: "enabled",
    uncheckedValue: "disabled",
  });
  assert.equal(switchControl.uncheckedInput().disabled(), false);
  assert.equal(switchControl.uncheckedInput().value, "disabled");
  switchControl.toggle();
  assert.equal(switchControl.uncheckedInput().disabled(), true);
  assert.equal(checkbox.manifest().parts.some((part) => part.name === "unchecked-input"), true);
  assert.equal(switchControl.manifest().parts.some((part) => part.name === "unchecked-input"), true);
});

test("checkbox-group parent controls all mutable children, reports mixed state, and preserves locked selections", () => {
  const reasons = [];
  const group = createCheckboxGroup({
    id: "permissions",
    items: ["read", { value: "audit", disabled: true }, "write"],
    defaultValue: ["read"],
    onValueChange(_value, details) { reasons.push(details.reason); },
  });
  const parent = group.parent({ agentLabel: "All permissions" });
  assert.equal(group.parentState.value, "indeterminate");
  assert.equal(parent["aria-checked"](), "mixed");
  assert.equal(parent["aria-controls"], "permissions-item-read permissions-item-audit permissions-item-write");
  assert.equal(parent["data-parent"], "");
  assert.equal(group.parentIndicator()["data-indeterminate"](), "");
  parent.onClick(event());
  assert.deepEqual(group.value.value, ["read", "write"], "an unchecked disabled child is not selected by the parent");
  parent.onClick(event());
  assert.deepEqual(group.value.value, [], "a second mixed-state press clears the mutable children");
  group.setValue(["audit"]);
  group.toggleAll();
  assert.deepEqual(group.value.value, ["read", "audit", "write"]);
  assert.equal(group.parentState.value, true);
  group.toggleAll();
  assert.deepEqual(group.value.value, ["audit"], "a selected disabled child survives parent clearing");
  assert.equal(reasons.includes("parent-toggle"), true);
  assert.equal(group.parent({ nativeButton: true }).type, "button");
  assert.equal(group.parent({ indeterminate: true })["aria-checked"](), "mixed");
  assert.equal(group.manifest().actions.some((action) => action.name === "toggleAll"), true);
});

test("checkbox, checkbox-group, radio-group, and switch compose exact Field state and relationships", async () => {
  const disabled = signal(false);
  const checkboxField = createField({
    id: "terms-field",
    name: "terms",
    defaultValue: false,
    disabled: () => disabled.value,
    required: true,
    validate: (value) => value === true ? undefined : "Accept the terms.",
  });
  checkboxField.description({ id: "terms-help" });
  checkboxField.error({ id: "terms-error" });
  checkboxField.label();
  const checkbox = createCheckbox({ id: "terms-control", field: checkboxField, value: "accepted" });
  const checkboxRoot = checkbox.root();
  assert.equal(checkboxRoot.id, checkboxField.controlId);
  assert.equal(checkboxRoot["aria-labelledby"](), "terms-field-label");
  assert.equal(checkboxRoot["aria-describedby"](), "terms-help");
  assert.equal(checkbox.input().name, "terms");
  checkboxRoot.onFocus(event());
  assert.equal(checkboxField.focused.value, true);
  checkboxRoot.onClick(event());
  assert.equal(checkboxField.value.value, true);
  assert.equal(checkboxRoot["data-dirty"](), "");
  checkboxRoot.onBlur(event());
  assert.equal(checkboxField.touched.value, true);
  checkbox.reset();
  assert.equal(checkboxField.value.value, false);
  assert.equal(checkboxField.touched.value, false);
  await checkboxField.validate();
  assert.equal(checkboxRoot["aria-invalid"](), true);
  assert.equal(checkboxRoot["aria-errormessage"](), "terms-error");
  disabled.value = true;
  assert.equal(checkboxRoot["aria-disabled"](), true);
  assert.equal(checkbox.input().disabled(), true);

  const featureField = createField({ id: "feature-field", name: "features", defaultValue: ["search"] });
  featureField.description();
  featureField.label();
  const features = createCheckboxGroup({ id: "feature-control", items: ["search", "sync"], field: featureField });
  assert.equal(features.root().id, featureField.controlId);
  assert.equal(features.root()["aria-labelledby"](), "feature-field-label");
  assert.equal(features.root()["aria-describedby"](), featureField.descriptionId);
  assert.equal(features.input("search").name, "features");
  features.item("sync").onClick(event());
  assert.deepEqual(featureField.value.value, ["search", "sync"]);
  assert.equal(features.item("sync")["data-dirty"](), "");

  const planField = createField({ id: "plan-field", name: "plan", defaultValue: "free" });
  planField.label();
  const plans = createRadioGroup({ id: "plan-control", items: ["free", "team"], field: planField });
  assert.equal(plans.root().id, planField.controlId);
  assert.equal(plans.root()["aria-labelledby"](), "plan-field-label");
  assert.equal(plans.input("team").name, "plan");
  plans.item("team").onClick(event());
  assert.equal(planField.value.value, "team");

  const switchField = createField({ id: "alerts-field", name: "alerts", defaultValue: true });
  switchField.label();
  const alerts = createSwitch({ id: "alerts-control", field: switchField });
  assert.equal(alerts.root().id, switchField.controlId);
  assert.equal(alerts.root()["aria-labelledby"](), "alerts-field-label");
  alerts.root().onClick(event());
  assert.equal(switchField.value.value, false);
  assert.equal(alerts.input().name, "alerts");

  assert.throws(() => createCheckbox({ id: "ambiguous-check", field: checkboxField, checked: false }), /both field and checked/);
  assert.throws(() => createCheckboxGroup({ id: "ambiguous-checks", items: ["one"], field: featureField, value: [] }), /both field and value/);
  assert.throws(() => createRadioGroup({ id: "ambiguous-radios", items: ["free"], field: planField, value: "free" }), /both field and value/);
  assert.throws(() => createSwitch({ id: "ambiguous-switch", field: switchField, checked: true }), /both field and checked/);

  checkboxField.dispose();
  featureField.dispose();
  planField.dispose();
  switchField.dispose();
});

test("Field rejection propagates through every choice control and canceled resets preserve metadata", () => {
  const rejectingCheckboxField = createField({
    id: "reject-choice-checkbox-field",
    defaultValue: false,
    onValueChange(_value, details) { details.cancel(); },
  });
  const rejectingGroupField = createField({
    id: "reject-choice-group-field",
    defaultValue: [],
    onValueChange(_value, details) { details.cancel(); },
  });
  const rejectingRadioField = createField({
    id: "reject-choice-radio-field",
    defaultValue: "one",
    onValueChange(_value, details) { details.cancel(); },
  });
  const rejectingSwitchField = createField({
    id: "reject-choice-switch-field",
    defaultValue: false,
    onValueChange(_value, details) { details.cancel(); },
  });
  const rejectingCheckbox = createCheckbox({ id: "reject-choice-checkbox", field: rejectingCheckboxField });
  const rejectingGroup = createCheckboxGroup({ id: "reject-choice-group", items: ["one", "two"], field: rejectingGroupField });
  const rejectingRadio = createRadioGroup({ id: "reject-choice-radio", items: ["one", "two"], field: rejectingRadioField });
  const rejectingSwitch = createSwitch({ id: "reject-choice-switch", field: rejectingSwitchField });
  assert.equal(rejectingCheckbox.setChecked(true), false);
  assert.equal(rejectingGroup.setValue(["one"]), false);
  assert.equal(rejectingRadio.select("two"), false);
  assert.equal(rejectingSwitch.setChecked(true), false);
  assert.equal(rejectingCheckbox.checked.value, false);
  assert.deepEqual(rejectingGroup.value.value, []);
  assert.equal(rejectingRadio.value.value, "one");
  assert.equal(rejectingSwitch.checked.value, false);

  const resetCases = [
    {
      initial: false,
      changed: true,
      create(field) { return createCheckbox({ id: "reset-choice-checkbox", field }); },
      change(control) { return control.setChecked(true); },
    },
    {
      initial: [],
      changed: ["one"],
      create(field) { return createCheckboxGroup({ id: "reset-choice-group", items: ["one", "two"], field }); },
      change(control) { return control.setValue(["one"]); },
    },
    {
      initial: "one",
      changed: "two",
      create(field) { return createRadioGroup({ id: "reset-choice-radio", items: ["one", "two"], field }); },
      change(control) { return control.select("two"); },
    },
    {
      initial: false,
      changed: true,
      create(field) { return createSwitch({ id: "reset-choice-switch", field }); },
      change(control) { return control.setChecked(true); },
    },
  ];
  for (const [index, entry] of resetCases.entries()) {
    const field = createField({
      id: `cancel-reset-choice-field-${index}`,
      defaultValue: entry.initial,
      onValueChange(_value, details) { if (details.reason === "reset") details.cancel(); },
    });
    const control = entry.create(field);
    assert.equal(entry.change(control), true);
    field.touch();
    field.setFocused(true);
    assert.equal(control.reset(), false);
    assert.deepEqual(field.value.value, entry.changed);
    assert.equal(field.touched.value, true);
    assert.equal(field.focused.value, true, "a rejected reset cannot clear unrelated Field metadata");
    field.dispose();
  }

  rejectingCheckboxField.dispose();
  rejectingGroupField.dispose();
  rejectingRadioField.dispose();
  rejectingSwitchField.dispose();
});

test("hidden native choice projections redirect validation focus to their visible controls", () => {
  const focused = [];
  const document = {
    getElementById(id) {
      return { focus() { focused.push(id); } };
    },
  };
  const controls = [
    [createCheckbox({ id: "focus-checkbox", required: true }).input(), "focus-checkbox"],
    [createCheckboxGroup({ id: "focus-group", items: ["one"], required: true }).input("one"), "focus-group-item-one"],
    [createRadioGroup({ id: "focus-radio", items: ["one"], required: true }).input("one"), "focus-radio-item-one"],
    [createSwitch({ id: "focus-switch", required: true }).input(), "focus-switch"],
  ];
  const cleanups = [];
  for (const [props, expectedId] of controls) {
    const input = nativeInput(null);
    input.ownerDocument = document;
    cleanups.push(props.use(input));
    input.dispatch("focus", event());
    assert.equal(focused.at(-1), expectedId);
  }
  for (const cleanup of cleanups.reverse()) cleanup();
});

test("checkbox groups preserve declaration order, validate one-or-more, submit native values, and reset once", () => {
  const form = eventTarget();
  let resetChanges = 0;
  const group = createCheckboxGroup({
    id: "features",
    items: ["search", { value: "sync", readOnly: true }, "export"],
    defaultValue: ["export"],
    name: "features",
    required: true,
    onValueChange(_value, details) { if (details.reason === "reset") resetChanges++; },
  });
  assert.equal(group.root()["data-state"](), "partial");
  assert.equal(group.toggle("sync"), false);
  assert.equal(group.toggle("search"), true);
  assert.deepEqual(group.value.value, ["search", "export"]);
  group.setValue([]);
  assert.equal(group.input("search").required(), true);

  const searchProps = group.input("search");
  const exportProps = group.input("export");
  const search = nativeInput(form);
  const exporting = nativeInput(form);
  const cleanSearch = searchProps.use(search);
  const cleanExport = exportProps.use(exporting);
  search.checked = true;
  search.dispatch("change", event());
  assert.deepEqual(group.value.value, ["search"]);
  form.dispatch("reset", event());
  assert.deepEqual(group.value.value, ["export"]);
  assert.equal(resetChanges, 1);
  assert.equal(exporting.checked, true);
  cleanExport();
  cleanSearch();
});

test("radio groups use roving focus, arrow selection, native radios, required state, and reset", () => {
  const form = eventTarget();
  const focused = [];
  const document = {
    getElementById(id) { return { focus() { focused.push(id); } }; },
  };
  const radio = createRadioGroup({
    id: "plan",
    items: ["free", { value: "team", disabled: true }, "enterprise"],
    defaultValue: "free",
    name: "plan",
    required: true,
  });
  const free = radio.item("free");
  const arrow = keyEvent("ArrowRight", { ownerDocument: document });
  free.onKeyDown(arrow);
  assert.equal(radio.value.value, "enterprise");
  assert.deepEqual(focused, ["plan-item-enterprise"]);
  assert.equal(radio.item("enterprise")["aria-checked"](), true);
  assert.equal(radio.input("free").required(), true);

  const enter = keyEvent("Enter", { ownerDocument: document });
  radio.item("free").onKeyDown(enter);
  assert.equal(radio.value.value, "enterprise", "Enter never selects a radio");

  const enterpriseProps = radio.input("enterprise");
  const enterprise = nativeInput(form);
  const cleanup = enterpriseProps.use(enterprise);
  assert.equal(enterprise.checked, true);
  radio.select("free");
  enterprise.checked = true;
  enterprise.dispatch("change", event());
  assert.equal(radio.value.value, "enterprise");
  form.dispatch("reset", event());
  assert.equal(radio.value.value, "free");
  cleanup();

  const firstDisabled = signal(false);
  const reactive = createRadioGroup({
    id: "reactive-plan",
    items: [{ value: "starter", disabled: () => firstDisabled.value }, "business"],
    defaultValue: "starter",
  });
  assert.equal(reactive.item("starter").tabIndex(), 0);
  firstDisabled.value = true;
  assert.equal(reactive.item("starter").tabIndex(), -1);
  assert.equal(reactive.item("business").tabIndex(), 0, "disabling the checked item recovers the group's one tab stop");

  const canceled = createRadioGroup({
    id: "cancelled-plan",
    items: ["one", "two"],
    defaultValue: "one",
    onValueChange(_value, details) { details.cancel(); },
  });
  const canceledArrow = keyEvent("ArrowRight", { ownerDocument: document });
  canceled.item("one").onKeyDown(canceledArrow);
  assert.equal(canceledArrow.defaultPrevented, false, "a canceled radio transition does not claim the arrow key");
  assert.equal(canceled.value.value, "one");
});

test("radio groups treat roving focus as internal field focus", async () => {
  let blurValidations = 0;
  const field = createField({
    id: "plan-field",
    defaultValue: "starter",
    validationMode: "onBlur",
    validate() { blurValidations++; },
  });
  const radio = createRadioGroup({ id: "field-plan", items: ["starter", "team"], field });
  const second = {};
  const outside = {};
  const root = { contains(target) { return target === second; } };
  const document = { getElementById(id) { return id === field.controlId ? root : null; } };
  const first = { ownerDocument: document };

  radio.item("starter").onFocus({ ...event(), currentTarget: first });
  radio.item("starter").onBlur({ ...event(), currentTarget: first, relatedTarget: second });
  await Promise.resolve();
  assert.equal(field.focused.value, true);
  assert.equal(field.touched.value, false);
  assert.equal(blurValidations, 0, "moving between radio items is not a field blur");

  radio.item("team").onFocus({ ...event(), currentTarget: second });
  radio.item("team").onBlur({ ...event(), currentTarget: first, relatedTarget: outside });
  await Promise.resolve();
  assert.equal(field.focused.value, false);
  assert.equal(field.touched.value, true);
  assert.equal(blurValidations, 1, "leaving the whole radio group performs blur validation once");
});

test("switches expose switch semantics and keep native inputs synchronized while respecting readonly", () => {
  const readOnly = signal(false);
  const form = eventTarget();
  const control = createSwitch({
    id: "notifications",
    defaultChecked: true,
    readOnly: () => readOnly.value,
    name: "notifications",
  });
  const inputProps = control.input();
  const input = nativeInput(form);
  const cleanup = inputProps.use(input);
  assert.equal(control.root().role, "switch");
  assert.equal(input.checked, true);
  control.root().onClick(event());
  assert.equal(control.checked.value, false);
  assert.equal(input.checked, false);
  readOnly.value = true;
  input.checked = true;
  const change = event();
  input.dispatch("change", change);
  assert.equal(change.prevented, true);
  assert.equal(control.checked.value, false);
  assert.equal(input.checked, false);
  cleanup();
});

test("toggles and single/multiple toggle groups handle keyboard, focus, disabled items, and reset", () => {
  const toggle = createToggle({ id: "bold", defaultPressed: false });
  const key = keyEvent("Enter");
  toggle.root().onKeyDown(key);
  assert.equal(toggle.pressed.value, true);
  assert.equal(toggle.root()["aria-pressed"](), true);
  toggle.reset();
  assert.equal(toggle.pressed.value, false);

  const single = createToggleGroup({
    id: "alignment",
    items: ["left", "center", "right"],
    defaultValue: "left",
  });
  assert.equal(single.multiple, false);
  single.toggle("left");
  assert.equal(single.value.value, null, "single groups allow the active item to be cleared");

  const boldDisabled = signal(false);
  const multiple = createToggleGroup({
    id: "format",
    multiple: true,
    items: [{ value: "bold", disabled: () => boldDisabled.value }, { value: "italic", disabled: true }, "underline"],
    defaultValue: ["bold"],
  });
  assert.equal(multiple.toggle("italic"), false);
  multiple.toggle("underline");
  assert.deepEqual(multiple.value.value, ["bold", "underline"]);

  let focused = "";
  const document = { getElementById(id) { return { focus() { focused = id; } }; } };
  const arrow = keyEvent("ArrowRight", { ownerDocument: document });
  multiple.item("bold").onKeyDown(arrow);
  assert.equal(focused, "format-item-underline");
  assert.equal(multiple.item("underline").tabIndex(), 0, "arrow navigation updates the persistent roving tab stop");
  multiple.item("bold").onFocus();
  assert.equal(multiple.item("bold").tabIndex(), 0, "pointer focus also updates the roving tab stop");
  boldDisabled.value = true;
  assert.equal(multiple.item("underline").tabIndex(), 0, "a dynamically disabled tab stop recovers to an enabled item");
  const rtl = createToggleGroup({
    id: "rtl-format",
    items: ["first", "second"],
    direction: "rtl",
  });
  rtl.item("first").onKeyDown(keyEvent("ArrowLeft", { ownerDocument: document }));
  assert.equal(focused, "rtl-format-item-second");
  multiple.reset();
  assert.deepEqual(multiple.value.value, ["bold"]);
});

test("meter and progress clamp ranges, expose percentages, and remain style-free apart from CSS variables", () => {
  const meter = createMeter({ id: "storage", min: 20, max: 120, defaultValue: 70 });
  assert.equal(meter.percentage.value, 50);
  assert.equal(meter.root()["aria-valuenow"](), 70);
  assert.equal(meter.root()["aria-valuetext"](), "50%");
  const meterRoot = meter.root();
  assert.equal(meterRoot["aria-labelledby"](), undefined, "an unmounted label ID is never referenced");
  const meterLabel = meter.label();
  assert.equal(meterRoot["aria-labelledby"](), meterLabel.id);
  const unmountMeterLabel = meterLabel.use({});
  unmountMeterLabel();
  assert.equal(meterRoot["aria-labelledby"](), undefined);
  assert.equal(meter.value().children(), "50%");
  assert.equal(meter.indicator().style["--clank-meter-percentage"](), "50%");
  meter.setValue(1_000);
  assert.equal(meter.current.value, 120);
  assert.equal(meter.root()["data-state"](), "complete");

  const progress = createProgress({ id: "upload", defaultValue: null, min: 50, max: 250 });
  assert.equal(progress.root()["aria-valuenow"](), undefined);
  assert.equal(progress.root()["data-state"](), "indeterminate");
  assert.equal(progress.root()["data-indeterminate"](), "");
  assert.equal(progress.root()["aria-valuetext"](), "indeterminate progress");
  progress.setValue(100);
  assert.equal(progress.percentage.value, 25);
  assert.equal(progress.indicator().style["--clank-progress-percentage"](), "25%");
  assert.equal(progress.manifest().state.status, "progressing");
  assert.equal(progress.root()["data-progressing"](), "");
  const progressRoot = progress.root();
  assert.equal(progressRoot["aria-labelledby"](), undefined);
  const progressLabel = progress.label();
  assert.equal(progressLabel.id, "upload-label");
  assert.equal(progressRoot["aria-labelledby"](), "upload-label");
  assert.equal(progress.value().children(), "25%");
});

test("separators distinguish semantic and decorative usage", () => {
  const semantic = createSeparator({ id: "columns", orientation: "vertical" });
  assert.deepEqual(semantic.root(), {
    id: "columns",
    "data-clank-part": "root",
    role: "separator",
    "aria-orientation": "vertical",
    "data-orientation": "vertical",
  });
  const decorative = createSeparator({ id: "rule", decorative: true });
  assert.equal(decorative.root().role, "presentation");
  assert.equal(decorative.root()["aria-hidden"], true);
  assert.doesNotThrow(() => JSON.stringify(decorative.manifest()));
});

test("control factories reject ambiguous IDs, duplicate values, and invalid ranges", () => {
  assert.throws(() => createToggle({ id: "not valid" }), /id must start/);
  assert.throws(() => createRadioGroup({ id: "radio", items: ["same", "same"] }), /unique/);
  assert.throws(() => createCheckboxGroup({ id: "checks", items: ["a b", "a-b"] }), /DOM-safe/);
  assert.throws(() => createMeter({ id: "bad-meter", min: 5, max: 5 }), /greater than min/);
  assert.throws(() => createProgress({ id: "bad-progress", max: 0 }), /greater than min/);
});

function event() {
  return {
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      this.defaultPrevented = true;
      this.prevented = true;
    },
    stopPropagation() {},
  };
}

function keyEvent(key, currentTarget = {}) {
  return { ...event(), key, currentTarget };
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
      return dispatched;
    },
  };
}

function nativeInput(form) {
  return Object.assign(eventTarget(), {
    form,
    checked: false,
    defaultChecked: false,
    indeterminate: false,
    disabled: false,
  });
}
