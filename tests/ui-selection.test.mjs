import test from "node:test";
import assert from "node:assert/strict";
import { signal } from "../dist/core.js";
import { createField } from "../dist/ui-fields.js";
import { createAutocomplete, createCombobox, createSelect, filterSelectionItems } from "../dist/ui-selection.js";

const items = [
  { value: "apple", label: "Ápple", keywords: ["fruit"] },
  { value: "banana", label: "Banana" },
  { value: "pear", label: "Pear", disabled: true },
];

test("selection filtering is locale and accent insensitive", () => {
  assert.deepEqual(filterSelectionItems(items, "app").map((item) => item.value), ["apple"]);
  assert.deepEqual(filterSelectionItems(items, "fru").map((item) => item.value), ["apple"]);
});

test("Select supports multiple selection, keyboard navigation, form projection, and manifests", () => {
  const select = createSelect({ id: "fruit", items, multiple: true, name: "fruit", defaultValue: ["apple"] });
  const mountedInputs = select.hiddenInputs();
  assert.deepEqual(submittedValues(mountedInputs), ["apple"]);
  assert.equal(select.item("apple")["aria-selected"](), true);
  select.select("banana");
  assert.deepEqual(select.value.value, ["apple", "banana"]);
  assert.deepEqual(submittedValues(mountedInputs), ["apple", "banana"], "mounted native controls stay reactive");
  assert.equal(select.select("pear"), false);
  assert.equal(select.manifest().protocol, "clank-ui/1");
  select.dispose();
});

test("Select closed-trigger typeahead commits single values and ignores closed multiple values", () => {
  const single = createSelect({ id: "closed-typeahead", items, defaultValue: "apple" });
  const singleEvent = keyEvent("b");
  single.trigger().onKeyDown(singleEvent);
  assert.equal(single.value.value, "banana");
  assert.equal(single.highlightedIndex.value, 1);
  assert.equal(singleEvent.defaultPrevented, true);

  const canceled = createSelect({
    id: "canceled-closed-typeahead",
    items,
    defaultValue: "apple",
    onValueChange(_value, details) { details.cancel(); },
  });
  const canceledEvent = keyEvent("b");
  canceled.trigger().onKeyDown(canceledEvent);
  assert.equal(canceled.value.value, "apple");
  assert.equal(canceled.highlightedIndex.value, 0, "a rejected closed selection keeps its prior highlight owner");
  assert.equal(canceledEvent.defaultPrevented, true);

  const multiple = createSelect({ id: "closed-multiple-typeahead", items, multiple: true, defaultValue: ["apple"] });
  const closedMultipleEvent = keyEvent("b");
  multiple.trigger().onKeyDown(closedMultipleEvent);
  assert.deepEqual(multiple.value.value, ["apple"]);
  assert.equal(closedMultipleEvent.defaultPrevented, false, "closed multiple Select does not run typeahead");

  multiple.show();
  const openMultipleEvent = keyEvent("b");
  multiple.trigger().onKeyDown(openMultipleEvent);
  assert.equal(multiple.highlightedIndex.value, 1);
  assert.deepEqual(multiple.value.value, ["apple"], "open typeahead only moves the highlight");
  assert.equal(openMultipleEvent.defaultPrevented, true);
  single.dispose();
  canceled.dispose();
  multiple.dispose();
});

test("Select single values are nullable and expose the complete Base UI anatomy", () => {
  const select = createSelect({ id: "theme", items, name: "theme", required: true, form: "settings", direction: "rtl" });
  assert.equal(select.value.value, null);
  assert.equal(select.valuePart({ placeholder: "Choose" }).children(), "Choose");
  assert.equal(select.label()["data-clank-part"], "label");
  const portal = select.portal();
  assert.equal(portal["data-clank-part"], "portal");
  assert.equal(portal["data-closed"](), "");
  select.show();
  assert.equal(portal["data-open"](), "");
  select.hide();
  assert.equal(select.arrow()["data-clank-part"], "arrow");
  assert.equal(select.popup().role, "presentation");
  assert.equal(select.list().role, "listbox");
  assert.equal(select.list()["aria-labelledby"](), "theme-label");
  assert.equal(select.trigger().dir, "rtl");
  assert.equal(select.select("banana"), true);
  assert.equal(select.value.value, "banana");
  assert.equal(select.clear(), true);
  assert.equal(select.value.value, null);

  const validation = select.hiddenInputs()[0];
  const native = select.hiddenInputs()[1];
  assert.equal(validation["data-clank-part"], "form-control");
  assert.equal(validation.required, true);
  assert.equal(validation.form, "settings");
  assert.equal(validation.value(), "");
  select.select("apple");
  assert.equal(validation.value(), "1");
  assert.equal(native.value(), "apple");
  assert.equal(native.disabled(), false);
  select.clear();
  assert.equal(native.disabled(), true);

  assert.deepEqual(select.manifest().parts.map((part) => part.name), [
    "label", "trigger", "value", "icon", "portal", "backdrop", "positioner", "popup",
    "scroll-up-arrow", "arrow", "list", "item", "item-text", "item-indicator", "separator",
    "group", "group-label", "scroll-down-arrow", "form-control", "hidden-input",
  ]);
  select.dispose();
});

test("Select listens to its associated form, restores defaults on reset, and releases listeners", () => {
  const form = eventTarget();
  const document = { getElementById(id) { return id === "external-form" ? form : null; } };
  const element = { form: null, ownerDocument: document, closest() { return null; } };
  const changes = [];
  const select = createSelect({
    id: "reset-select",
    items,
    form: "external-form",
    defaultValue: "apple",
    onValueChange(value, details) { changes.push([value, details.reason]); },
  });
  const trigger = select.trigger();
  trigger.ref(element);
  select.select("banana");
  form.dispatch("reset", event());
  assert.equal(select.value.value, "apple");
  assert.deepEqual(changes, [["banana", "programmatic"], ["apple", "reset"]]);
  trigger.ref(null);
  select.select("banana");
  form.dispatch("reset", event());
  assert.equal(select.value.value, "banana", "unmounted controls do not retain form listeners");
  select.dispose();
});

test("selection serializers are explicit, deterministic, and reject unsafe output", () => {
  const objectItems = [{ value: { id: 1 }, label: "One" }];
  const displayOnly = createSelect({ id: "objects-display", items: objectItems, defaultValue: objectItems[0].value });
  assert.deepEqual(displayOnly.hiddenInputs(), [], "display-only object values do not require serialization");

  const missing = createSelect({ id: "objects-missing", items: objectItems, name: "object", defaultValue: objectItems[0].value });
  assert.throws(() => missing.hiddenInputs(), /require a serialize option/);
  const nonString = createSelect({ id: "objects-number", items: objectItems, name: "object", defaultValue: objectItems[0].value, serialize: () => 1 });
  assert.throws(() => nonString.hiddenInputs(), /must return a string/);
  const nul = createSelect({ id: "objects-null", items: objectItems, name: "object", defaultValue: objectItems[0].value, serialize: () => "one\0two" });
  assert.throws(() => nul.hiddenInputs(), /null bytes/);
  displayOnly.dispose();
  missing.dispose();
  nonString.dispose();
  nul.dispose();
});

test("selection values reject unknown, duplicate, and mode-incompatible shapes at every boundary", () => {
  assert.throws(
    () => createSelect({ id: "single-array", items, defaultValue: ["apple"] }),
    /cannot be an array in single mode/,
  );
  assert.throws(
    () => createSelect({ id: "multiple-scalar", items, multiple: true, defaultValue: "apple" }),
    /must be an array in multiple mode/,
  );
  assert.throws(
    () => createCombobox({ id: "unknown-default", items, defaultValue: "dragonfruit" }),
    /unknown item value/,
  );
  assert.throws(
    () => createAutocomplete({ id: "duplicate-default", items, multiple: true, defaultValue: ["apple", "apple"] }),
    /duplicate item values/,
  );

  const controlledValue = signal("apple");
  const controlled = createSelect({ id: "strict-controlled", items, value: () => controlledValue.value });
  controlledValue.value = "dragonfruit";
  assert.throws(() => controlled.value.value, /unknown item value/);
  controlledValue.value = "apple";
  assert.throws(() => controlled.select("dragonfruit"), /unknown Select item value/);
  controlled.dispose();

  const box = createCombobox({ id: "strict-programmatic", items });
  assert.throws(() => box.choose("dragonfruit"), /unknown Combobox item value/);
  box.dispose();
});

test("required selection validity mirrors the native controls that actually submit", () => {
  const projected = createSelect({
    id: "projected-required",
    items,
    multiple: true,
    name: "fruit",
    required: true,
    defaultValue: ["apple"],
  });
  const projectedControls = projected.hiddenInputs();
  assert.equal(projectedControls[0].value(), "1");
  assert.deepEqual(submittedValues(projectedControls.slice(1)), ["apple"]);
  projected.clear();
  assert.equal(projectedControls[0].value(), "");
  assert.deepEqual(submittedValues(projectedControls.slice(1)), []);
  projected.dispose();

  const displayOnly = createSelect({
    id: "display-only-required",
    items,
    required: true,
    defaultValue: "apple",
  });
  const validationOnly = displayOnly.hiddenInputs();
  assert.equal(validationOnly.length, 1);
  assert.equal(validationOnly[0].value(), "", "a required proxy cannot claim a value with no submitting control");
  displayOnly.dispose();
});

test("Combobox restricts commits to items and exposes active-descendant results", () => {
  const box = createCombobox({ id: "fruit-box", items, autoHighlight: true });
  box.setInput("ban");
  assert.deepEqual(box.filteredItems.value.map((item) => item.value), ["banana"]);
  assert.equal(box.highlightedIndex.value, 0);
  box.input().onKeyDown({ key: "Enter", preventDefault() {} });
  assert.equal(box.value.value, "banana");
  assert.equal(box.inputValue.value, "Banana");
  box.dispose();
});

test("editable input-click and Autocomplete pointer-leave defaults match their family contracts", () => {
  const box = createCombobox({ id: "click-open-box", items });
  box.input().onClick(event());
  assert.equal(box.open.value, true, "Combobox opens from an empty input click by default");
  box.dispose();

  const optedOut = createCombobox({ id: "no-click-open-box", items, openOnInputClick: false });
  optedOut.input().onClick(event());
  assert.equal(optedOut.open.value, false);
  optedOut.dispose();

  const autocomplete = createAutocomplete({ id: "pointer-autocomplete", items });
  autocomplete.input().onClick(event());
  assert.equal(autocomplete.open.value, false, "Autocomplete keeps its false input-click default");
  const item = autocomplete.item("banana");
  item.onPointerMove(event({ pointerType: "mouse" }));
  assert.equal(autocomplete.highlightedIndex.value, 1);
  item.onPointerLeave(event({ pointerType: "mouse" }));
  assert.equal(autocomplete.highlightedIndex.value, -1, "pointer leave clears highlight by default");
  autocomplete.dispose();

  const kept = createAutocomplete({
    id: "kept-pointer-autocomplete",
    items,
    keepHighlight: true,
    openOnInputClick: true,
  });
  kept.input().onClick(event());
  assert.equal(kept.open.value, true);
  const keptItem = kept.item("banana");
  keptItem.onPointerMove(event({ pointerType: "mouse" }));
  keptItem.onPointerLeave(event({ pointerType: "mouse" }));
  assert.equal(kept.highlightedIndex.value, 1);
  kept.dispose();
});

test("standalone selection labels are referenced only while their parts are requested or mounted", () => {
  const select = createSelect({ id: "optional-label-select", items });
  const trigger = select.trigger();
  const list = select.list();
  assert.equal(trigger["aria-labelledby"](), "optional-label-select-value");
  assert.equal(list["aria-labelledby"](), undefined, "an omitted Select.Label is never referenced");
  const selectLabel = select.label();
  assert.equal(trigger["aria-labelledby"](), "optional-label-select-label optional-label-select-value");
  assert.equal(list["aria-labelledby"](), "optional-label-select-label");
  const cleanupSelectLabel = selectLabel.use({});
  cleanupSelectLabel();
  assert.equal(trigger["aria-labelledby"](), "optional-label-select-value");
  assert.equal(list["aria-labelledby"](), undefined);
  select.dispose();

  const box = createCombobox({ id: "optional-label-box", items });
  const input = box.input();
  const boxList = box.list();
  assert.equal(input["aria-labelledby"](), undefined, "an omitted Combobox.Label is never referenced");
  assert.equal(boxList["aria-labelledby"](), undefined);
  const boxLabel = box.label();
  assert.equal(input["aria-labelledby"](), "optional-label-box-label");
  assert.equal(boxList["aria-labelledby"](), "optional-label-box-label");
  const cleanupBoxLabel = boxLabel.use({});
  cleanupBoxLabel();
  assert.equal(input["aria-labelledby"](), undefined);
  assert.equal(boxList["aria-labelledby"](), undefined);
  box.dispose();
});

test("Combobox exposes all official parts, submits committed values, validates, and resets", () => {
  const form = eventTarget();
  const inputElement = { form, ownerDocument: { getElementById() { return null; } }, closest() { return form; } };
  const changes = [];
  const box = createCombobox({
    id: "language",
    items,
    name: "language",
    form: "profile",
    required: true,
    defaultValue: "apple",
    defaultInputValue: "Ápple",
    onValueChange(value, details) { changes.push([value, details.reason]); },
  });
  const input = box.input();
  input.ref(inputElement);
  assert.equal(input.name, undefined, "combobox display text is not submitted as its committed value");
  assert.equal(box.label().htmlFor, "language-input");
  assert.equal(box.valuePart().children(), "Ápple");
  const portal = box.portal();
  assert.equal(portal["data-clank-part"], "portal");
  assert.equal(portal["data-closed"](), "");
  assert.equal(box.popup().role, "presentation");
  assert.equal(box.list().role, "listbox");
  assert.equal(box.list()["aria-labelledby"](), "language-label");
  const mountedInputs = box.hiddenInputs();
  assert.deepEqual(mountedInputs.map((control) => control["data-clank-part"]), ["form-control", "hidden-input"]);
  assert.equal(mountedInputs[1].value(), "apple");
  box.setInput("ban");
  box.choose("banana");
  assert.equal(mountedInputs[1].value(), "banana", "a mounted single-value control updates reactively");
  form.dispatch("reset", event());
  assert.equal(box.value.value, "apple");
  assert.equal(box.inputValue.value, "Ápple");
  assert.deepEqual(changes, [["banana", "item-press"], ["apple", "reset"]]);
  input.ref(null);
  assert.ok(box.manifest().parts.some((part) => part.name === "chips"));
  box.dispose();
});

test("Combobox multiple selection clears its query and preserves array form values", () => {
  const box = createCombobox({ id: "multi", items, multiple: true, name: "fruit", defaultValue: ["apple"] });
  const mountedInputs = box.hiddenInputs();
  box.setInput("ban");
  box.choose("banana");
  assert.equal(box.inputValue.value, "");
  assert.deepEqual(box.value.value, ["apple", "banana"]);
  assert.deepEqual(submittedValues(mountedInputs), ["apple", "banana"]);
  box.dispose();
});

test("Autocomplete retains free-form text while offering the same suggestion surface", () => {
  const box = createAutocomplete({ id: "tags", items, allowCustomValue: true });
  box.setInput("Dragonfruit");
  assert.equal(box.inputValue.value, "Dragonfruit");
  assert.deepEqual(box.filteredItems.value, []);
  box.input().onKeyDown({ key: "Enter", preventDefault() {} });
  assert.equal(box.inputValue.value, "Dragonfruit");
  box.dispose();
});

test("Autocomplete submits free-form input text through its native input", () => {
  const box = createAutocomplete({
    id: "search",
    items,
    name: "query",
    form: "search-form",
    required: true,
    defaultInputValue: "Dragonfruit",
  });
  const input = box.input();
  assert.equal(input.name, "query");
  assert.equal(input.form, "search-form");
  assert.equal(input.required, true);
  assert.equal(input.value(), "Dragonfruit");
  assert.deepEqual(box.hiddenInputs(), [], "autocomplete text is never duplicated by hidden inputs");
  assert.equal(box.valuePart().children(), "Dragonfruit");
  assert.equal(box.portal()["data-clank-part"], "portal");
  assert.equal(box.manifest().parts.some((part) => part.name === "item-indicator"), false);
  box.dispose();
});

test("inline and both completion modes render and accept a selected suffix", () => {
  const box = createAutocomplete({ id: "inline-tags", items, completionMode: "both" });
  const element = {
    value: "ap",
    form: null,
    ownerDocument: { getElementById() { return null; } },
    closest() { return null; },
    setSelectionRange(start, end, direction) { this.selection = [start, end, direction]; },
  };
  const input = box.input();
  input.ref(element);
  element.value = "ap";
  input.onInput({ ...event(), currentTarget: element });
  assert.equal(box.inputValue.value, "ap");
  assert.equal(element.value, "Ápple");
  assert.deepEqual(element.selection, [2, 5, "forward"]);
  assert.equal(input["aria-autocomplete"], "both");

  input.onKeyDown({ ...keyEvent("Tab"), currentTarget: element });
  assert.equal(box.inputValue.value, "Ápple", "Tab accepts the visible inline completion");
  assert.deepEqual(element.selection, [5, 5, "none"]);
  input.ref(null);
  box.dispose();

  const none = createAutocomplete({ id: "no-completion", items, completionMode: "none" });
  none.setInput("ban");
  assert.equal(none.filteredItems.value.length, items.length, "none mode does not filter or complete");
  assert.throws(() => createCombobox({ id: "bad-mode", items, completionMode: "invalid" }), /Completion mode/);
  none.dispose();
});

test("selection keyboard callbacks run before internal cancellation and canceled events do nothing", () => {
  const observations = [];
  const select = createSelect({
    id: "ordered",
    items,
    onValueChange(_value, details) {
      observations.push(details.event?.defaultPrevented ?? false);
      details.cancel();
    },
  });
  const key = keyEvent("Enter");
  select.list().onKeyDown(key);
  assert.deepEqual(observations, [false]);
  assert.equal(key.defaultPrevented, true);
  assert.equal(select.value.value, null);

  const canceled = keyEvent("ArrowDown", true);
  const before = select.highlightedIndex.value;
  select.list().onKeyDown(canceled);
  assert.equal(select.highlightedIndex.value, before);
  select.dispose();
});

test("editable selections preserve highlighted identity and never expose stale active descendants", () => {
  const query = signal("");
  const reversed = signal(false);
  const box = createCombobox({
    id: "controlled-results",
    items,
    inputValue: () => query.value,
    filter(all, value) {
      const filtered = all.filter((item) => item.value.includes(value));
      return reversed.value && filtered.length > 1
        ? [...filtered.slice(1), filtered[0]]
        : filtered;
    },
  });
  const input = box.input();
  box.highlightedIndex.value = 1;
  assert.equal(input["aria-activedescendant"](), "controlled-results-item-1");

  reversed.value = true;
  assert.deepEqual(box.filteredItems.value.map((item) => item.value), ["banana", "pear", "apple"]);
  assert.equal(box.highlightedIndex.value, 0, "the same highlighted item follows a reordered result set");
  assert.equal(box.item("banana").id, "controlled-results-item-1", "option IDs remain canonical across reorders");

  query.value = "app";
  assert.deepEqual(box.filteredItems.value.map((item) => item.value), ["apple"]);
  assert.equal(box.highlightedIndex.value, -1);
  assert.equal(input["aria-activedescendant"](), undefined);
  box.highlightedIndex.value = 99;
  assert.equal(input["aria-activedescendant"](), undefined, "an externally stale index is never announced");
  box.dispose();

  const highlightedQuery = signal("");
  const auto = createCombobox({
    id: "controlled-auto-results",
    items,
    autoHighlight: true,
    inputValue: () => highlightedQuery.value,
  });
  highlightedQuery.value = "ban";
  assert.equal(auto.highlightedIndex.value, 0);
  assert.equal(auto.input()["aria-activedescendant"](), "controlled-auto-results-item-1");
  auto.dispose();
});

test("Select keeps Field focus internal while focus moves into its popup", async () => {
  let validations = 0;
  const field = createField({
    id: "popup-focus-field",
    defaultValue: null,
    validationMode: "onBlur",
    validate() { validations += 1; return undefined; },
  });
  const select = createSelect({ id: "popup-focus-select", items, field });
  const trigger = select.trigger();
  const list = {};
  const positioner = { contains(target) { return target === list; } };
  select.positioner().ref(positioner);

  trigger.onFocus(event());
  trigger.onBlur(event({ relatedTarget: list }));
  await Promise.resolve();
  assert.equal(field.focused.value, true);
  assert.equal(field.touched.value, false);
  assert.equal(validations, 0);

  select.show();
  select.hide("focus-out", event());
  await Promise.resolve();
  assert.equal(field.focused.value, false);
  assert.equal(field.touched.value, true, "an accepted popup focus-out completes the Field interaction");
  assert.equal(validations, 1);

  field.touch(false);
  trigger.onFocus(event());
  trigger.onBlur(event({ relatedTarget: {} }));
  await Promise.resolve();
  assert.equal(field.focused.value, false);
  assert.equal(field.touched.value, true);
  assert.equal(validations, 2);
  select.positioner().ref(null);
  select.dispose();
  field.dispose();
});

test("Select and Combobox compose Field state, constraints, relationships, validity, and reset", async () => {
  const disabled = signal(true);
  const readOnly = signal(false);
  const form = eventTarget();
  let focused = false;
  const document = {
    getElementById(id) {
      return id === "fruit-field-control" ? { focus() { focused = true; } } : null;
    },
  };
  const field = createField({
    id: "fruit-field",
    name: "fruit",
    defaultValue: null,
    disabled: () => disabled.value,
    readOnly: () => readOnly.value,
    required: true,
    validationMode: "onBlur",
    validate(value) { return value ? undefined : "Choose a fruit."; },
  });
  const unregisterDescription = field.description().use({});
  const unregisterError = field.error().use({});
  const select = createSelect({ id: "field-select", items, field });
  const cleanupLabel = select.label().use({});
  const trigger = select.trigger();
  assert.equal(trigger.id, field.controlId);
  assert.equal(trigger["aria-labelledby"](), "fruit-field-label field-select-value");
  assert.equal(trigger["aria-describedby"](), field.descriptionId);
  assert.equal(trigger.disabled(), true);
  assert.equal(trigger["aria-required"](), true);
  assert.equal(select.select("apple"), false);

  disabled.value = false;
  assert.equal(select.select("banana"), true);
  assert.equal(field.value.value, "banana");
  assert.equal(trigger["data-dirty"](), "");
  field.setValue("apple");
  assert.equal(select.value.value, "apple", "external Field updates drive selection");
  readOnly.value = true;
  assert.equal(select.select("banana"), false);
  readOnly.value = false;

  trigger.onFocus(event());
  assert.equal(field.focused.value, true);
  trigger.onBlur(event());
  await Promise.resolve();
  assert.equal(field.touched.value, true);

  const controls = select.hiddenInputs();
  const proxy = controls[0];
  assert.equal(proxy.required(), true);
  assert.equal(controls[1].name, "fruit");
  const native = nativeInput(form, document);
  const cleanupProxy = proxy.use(native);
  field.setServerErrors("Server rejected this fruit.");
  assert.equal(native.customValidity, "Server rejected this fruit.");
  native.validity = validity({ valueMissing: true });
  proxy.onInvalid(event({ currentTarget: native }));
  assert.equal(field.valid.value, false);
  assert.equal(focused, true, "invalid native projection focuses the visible control");

  field.setValue("banana");
  form.dispatch("reset", event());
  await Promise.resolve();
  assert.equal(field.value.value, null);
  assert.equal(select.value.value, null);
  assert.equal(field.touched.value, false);
  cleanupProxy();
  cleanupLabel();
  assert.equal(trigger["aria-labelledby"](), "field-select-value");
  unregisterDescription();
  unregisterError();
  select.dispose();
  field.dispose();

  const committedField = createField({ id: "committed-fruit", name: "committed", defaultValue: "apple" });
  const box = createCombobox({ id: "field-combobox", items, field: committedField });
  assert.equal(box.input().id, committedField.controlId);
  assert.equal(box.input().name, undefined);
  box.setInput("ban");
  assert.equal(committedField.value.value, "apple", "filter text does not replace the committed Field value");
  box.choose("banana");
  assert.equal(committedField.value.value, "banana");
  assert.equal(box.hiddenInputs().at(-1).name, "committed");
  assert.throws(() => createCombobox({ id: "bad-field-box", items, field: committedField, value: "apple" }), /both field and value/);
  box.dispose();
  committedField.dispose();
});

test("Autocomplete Field semantics distinguish free-form single input from multiple selections", async () => {
  const form = eventTarget();
  const textField = createField({
    id: "search-field",
    name: "query",
    defaultValue: "ap",
    required: true,
  });
  const single = createAutocomplete({ id: "field-autocomplete", items, field: textField });
  const input = single.input();
  assert.equal(single.inputValue.value, "ap");
  assert.equal(input.id, textField.controlId);
  assert.equal(input.name, "query");
  assert.equal(input.required(), true);
  single.setInput("Dragonfruit");
  assert.equal(textField.value.value, "Dragonfruit");
  textField.setValue("external");
  assert.equal(single.inputValue.value, "external");

  const native = nativeInput(form, { getElementById() { return null; } });
  const cleanup = input.use(native);
  assert.equal(native.value, "external");
  textField.setServerErrors("Invalid query.");
  assert.equal(native.customValidity, "Invalid query.");
  form.dispatch("reset", event());
  await Promise.resolve();
  assert.equal(textField.value.value, "ap");
  assert.equal(single.inputValue.value, "ap");
  assert.throws(() => createAutocomplete({ id: "bad-text-field", items, field: textField, inputValue: "ap" }), /both field and inputValue/);
  cleanup();
  single.dispose();
  textField.dispose();

  const valuesField = createField({ id: "tag-values", name: "tags", defaultValue: ["apple"] });
  const multiple = createAutocomplete({ id: "field-tags", items, multiple: true, field: valuesField });
  multiple.setInput("ban");
  assert.deepEqual(valuesField.value.value, ["apple"]);
  multiple.choose("banana");
  assert.deepEqual(valuesField.value.value, ["apple", "banana"]);
  valuesField.setValue(["banana"]);
  assert.deepEqual(multiple.value.value, ["banana"]);
  assert.throws(() => createAutocomplete({ id: "bad-tags-field", items, multiple: true, field: valuesField, value: [] }), /both field and value/);
  const wrongField = createField({ id: "wrong-tags", defaultValue: "apple" });
  assert.throws(() => createAutocomplete({ id: "wrong-tags-box", items, multiple: true, field: wrongField }), /must be an array/);
  multiple.dispose();
  valuesField.dispose();
  wrongField.dispose();
});

test("Field cancellation propagates through Select, Combobox, and Autocomplete without stale native text", () => {
  const selectValue = signal("apple");
  const selectField = createField({
    id: "cancel-select-field",
    value: () => selectValue.value,
    onValueChange(_value, details) { details.cancel(); },
  });
  const select = createSelect({ id: "cancel-field-select", items, field: selectField });
  assert.equal(select.select("banana"), false);
  assert.equal(select.value.value, "apple");
  assert.equal(select.open.value, false);
  const selectForm = eventTarget();
  const selectNative = nativeInput(selectForm, { getElementById() { return null; } });
  const cleanupSelectProxy = select.hiddenInputs()[0].use(selectNative);
  select.trigger().ref(selectNative);
  selectValue.value = "banana";
  selectField.touch();
  selectForm.dispatch("reset", event());
  assert.equal(select.value.value, "banana", "a canceled Field reset retains the controlled value");
  assert.equal(selectField.touched.value, true, "a canceled reset retains interaction state");
  cleanupSelectProxy();
  select.dispose();
  selectField.dispose();

  const committed = signal("apple");
  const comboboxField = createField({
    id: "cancel-combobox-field",
    value: () => committed.value,
    onValueChange(_value, details) { details.cancel(); },
  });
  const box = createCombobox({ id: "cancel-field-combobox", items, field: comboboxField });
  box.setInput("ban");
  assert.equal(box.open.value, true);
  assert.equal(box.choose("banana"), false);
  assert.equal(box.value.value, "apple");
  assert.equal(box.inputValue.value, "ban");
  assert.equal(box.open.value, true, "a rejected commit cannot close the popup");
  box.dispose();
  comboboxField.dispose();

  const text = signal("ap");
  const autocompleteField = createField({
    id: "cancel-autocomplete-field",
    value: () => text.value,
    onValueChange(_value, details) { details.cancel(); },
  });
  const autocomplete = createAutocomplete({ id: "cancel-field-autocomplete", items, field: autocompleteField });
  const element = {
    value: "ap",
    form: null,
    ownerDocument: { getElementById() { return null; } },
    closest() { return null; },
    setSelectionRange() {},
  };
  const input = autocomplete.input();
  input.ref(element);
  element.value = "Dragonfruit";
  input.onInput(event({ currentTarget: element }));
  assert.equal(autocomplete.inputValue.value, "ap");
  assert.equal(element.value, "ap", "a rejected free-form edit restores the controlled native value");
  assert.equal(autocomplete.open.value, false);
  autocomplete.clear().onClick(event({ currentTarget: element }));
  assert.equal(autocomplete.inputValue.value, "ap", "a rejected clear retains the Field value");
  assert.equal(element.value, "ap");
  input.ref(null);
  autocomplete.dispose();
  autocompleteField.dispose();
});

test("editable value and text transitions roll back together when either side cancels", () => {
  const selected = signal("apple");
  const query = signal("Ápple");
  const box = createCombobox({
    id: "atomic-combobox",
    items,
    value: () => selected.value,
    inputValue: () => query.value,
    onValueChange(next) { selected.value = next; },
    onInputValueChange(next, details) {
      if (next === "Banana") details.cancel();
      else query.value = next;
    },
  });
  assert.equal(box.choose("banana"), false);
  assert.equal(selected.value, "apple", "a later text cancellation rolls back the committed signal");
  assert.equal(query.value, "Ápple");
  assert.equal(box.value.value, "apple");
  assert.equal(box.inputValue.value, "Ápple");
  box.dispose();

  const autocomplete = createAutocomplete({
    id: "atomic-autocomplete",
    items,
    defaultValue: "apple",
    defaultInputValue: "Ápple",
    onValueChange(next, details) {
      if (next === null) details.cancel();
    },
  });
  assert.equal(autocomplete.setInput("Dragonfruit"), false);
  assert.equal(autocomplete.value.value, "apple", "a rejected selected-value clear retains the selection");
  assert.equal(autocomplete.inputValue.value, "Ápple", "the paired free-form edit is not partially committed");
  autocomplete.dispose();
});

test("selection popup presence proxies support unmounted defaults and per-portal retention", () => {
  for (const controller of [
    createSelect({ id: "presence-select", items }),
    createCombobox({ id: "presence-combobox", items }),
    createAutocomplete({ id: "presence-autocomplete", items }),
  ]) {
    assert.equal(controller.isMounted(), false);
    assert.equal(controller.portal().hidden(), true);
    assert.equal(controller.isMounted({ keepMounted: true }), true);
    assert.equal(controller.portal({ keepMounted: true })["data-mounted"](), "");
    controller.dispose();
  }
});

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, value) { for (const listener of [...(listeners.get(type) ?? [])]) listener(value); },
  };
}

function event(overrides = {}) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...overrides };
}

function keyEvent(key, defaultPrevented = false) {
  return {
    key,
    defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

function submittedValues(controls) {
  return controls
    .filter((control) => typeof control.disabled === "function" ? !control.disabled() : !control.disabled)
    .map((control) => typeof control.value === "function" ? control.value() : control.value);
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
    valid: true,
    ...overrides,
  };
}

function nativeInput(form, document) {
  return Object.assign(eventTarget(), {
    value: "",
    disabled: false,
    readOnly: false,
    required: false,
    form,
    ownerDocument: document,
    validity: validity(),
    validationMessage: "",
    setCustomValidity(message) { this.customValidity = message; },
    closest() { return form; },
  });
}
