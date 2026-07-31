import test from "node:test";
import assert from "node:assert/strict";
import {
  UiProvider,
  createAutocomplete,
  createOtpField,
  createPopover,
  createScrollArea,
  createSelect,
  createSlider,
  h,
  renderToString,
} from "../dist/index.js";

test("DirectionProvider defaults reach portaled, selection, field, and utility controllers", async () => {
  let observed;
  const disposables = [];

  function Probe() {
    const popup = createPopover({ id: "direction-popup" });
    const select = createSelect({
      id: "direction-select",
      items: [{ value: "one", label: "One" }],
    });
    const autocomplete = createAutocomplete({
      id: "direction-autocomplete",
      items: [{ value: "one", label: "One" }],
    });
    const otp = createOtpField({ id: "direction-otp", length: 4 });
    const slider = createSlider({ id: "direction-slider", defaultValue: 50 });
    const scrollArea = createScrollArea({ id: "direction-scroll" });
    disposables.push(popup, select, autocomplete, scrollArea);

    const sliderThumb = slider.thumb(0);
    const keyboardEvent = {
      key: "ArrowRight",
      currentTarget: {},
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    sliderThumb.onKeyDown(keyboardEvent);

    observed = {
      popupTrigger: popup.trigger().dir,
      popupContent: popup.popup().dir,
      selectTrigger: select.trigger().dir,
      selectList: select.list().dir,
      autocompleteInput: autocomplete.input().dir,
      autocompleteList: autocomplete.list().dir,
      otpRoot: otp.root().dir,
      sliderRoot: slider.root().dir,
      sliderValue: slider.value.value,
      scrollRoot: scrollArea.root().dir(),
      keyboardPrevented: keyboardEvent.defaultPrevented,
    };
    return h("div", { dir: observed.popupContent }, "direction probe");
  }

  const html = await renderToString(h(UiProvider, { direction: "rtl" }, h(Probe, {})));
  assert.match(html, /dir="rtl"/);
  assert.deepEqual(observed, {
    popupTrigger: "rtl",
    popupContent: "rtl",
    selectTrigger: "rtl",
    selectList: "rtl",
    autocompleteInput: "rtl",
    autocompleteList: "rtl",
    otpRoot: "rtl",
    sliderRoot: "rtl",
    sliderValue: 49,
    scrollRoot: "rtl",
    keyboardPrevented: true,
  });
  for (const controller of disposables) controller.dispose();
});

